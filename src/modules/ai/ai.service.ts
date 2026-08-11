import type { AiKind, AiProvider } from "@prisma/client";
import { env } from "../../config/env.js";
import { prisma } from "../../database/prisma.js";
import { ForbiddenError, NotFoundError } from "../../utils/errors.js";
import { chatCompletion } from "../../integrations/llm/llm.client.js";
import {
  heuristicAsk,
  heuristicCycleSummary,
  heuristicIssueSummary,
  heuristicPrSummary,
  type AskContext,
  type CycleContext,
  type IssueContext,
  type PrContext,
} from "../../integrations/llm/heuristic.js";

const SYSTEM = `You are DevFlow AI, an engineering assistant inside a project management product.
Use ONLY the provided workspace context. Do not invent commits, files, or people.
Always reply in clear, professional English (never Hindi, Urdu, or other languages unless the user explicitly asks).
Be concise, use markdown, and focus on actionable engineering insight.`;

async function assertWorkspaceMember(workspaceId: string, userId: string) {
  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  });
  if (!membership) throw new ForbiddenError("Not a workspace member");
  return membership;
}

async function persist(input: {
  workspaceId: string;
  userId: string;
  kind: AiKind;
  targetType?: string;
  targetId?: string;
  prompt?: string;
  response: string;
  provider: AiProvider;
}) {
  return prisma.aiInteraction.create({ data: input });
}

async function generate(promptUser: string, fallback: string) {
  if (!env.llmConfigured) {
    return { text: fallback, provider: "HEURISTIC" as const };
  }
  try {
    const text = await chatCompletion([
      { role: "system", content: SYSTEM },
      { role: "user", content: promptUser },
    ]);
    return { text, provider: "LLM" as const };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    console.error("LLM failed, using heuristic:", detail);
    return {
      text: `${fallback}\n\n_(Real AI unavailable right now — showed built-in summary. Check GEMINI_API_KEY.)_`,
      provider: "HEURISTIC" as const,
    };
  }
}

export async function getAiStatus() {
  if (env.llmProvider === "gemini") {
    return {
      llmConfigured: true,
      model: env.GEMINI_MODEL,
      mode: "llm",
      provider: "gemini",
      message: `Using Google Gemini (${env.GEMINI_MODEL}) — real AI with workspace-only context`,
    };
  }
  if (env.llmProvider === "openai_compatible") {
    return {
      llmConfigured: true,
      model: env.LLM_MODEL,
      mode: "llm",
      provider: "openai_compatible",
      message: `Using ${env.LLM_MODEL} via ${env.LLM_BASE_URL}`,
    };
  }
  return {
    llmConfigured: false,
    model: null,
    mode: "heuristic",
    provider: "heuristic",
    message:
      "Using built-in heuristic summaries (set GEMINI_API_KEY for free Gemini, or LLM_BASE_URL for Ollama)",
  };
}

export async function summarizeIssue(issueId: string, userId: string) {
  const issue = await prisma.issue.findUnique({
    where: { id: issueId },
    include: {
      project: true,
      assignee: { select: { name: true } },
      reporter: { select: { name: true } },
      labels: { include: { label: true } },
      comments: {
        orderBy: { createdAt: "asc" },
        include: { author: { select: { name: true } } },
      },
      pullRequests: {
        select: { number: true, title: true, state: true },
        orderBy: { number: "desc" },
        take: 10,
      },
    },
  });
  if (!issue) throw new NotFoundError("Issue not found");
  await assertWorkspaceMember(issue.project.workspaceId, userId);

  const ctx: IssueContext = {
    key: `${issue.project.key}-${issue.number}`,
    title: issue.title,
    description: issue.description,
    status: issue.status,
    priority: issue.priority,
    assignee: issue.assignee?.name ?? null,
    reporter: issue.reporter.name,
    labels: issue.labels.map((l) => l.label.name),
    comments: issue.comments.map((c) => ({ author: c.author.name, body: c.body })),
    pullRequests: issue.pullRequests,
  };

  const fallback = heuristicIssueSummary(ctx);
  const prompt = `Summarize this engineering issue for a teammate who needs context fast.\n\nCONTEXT:\n${JSON.stringify(ctx, null, 2)}`;
  const { text, provider } = await generate(prompt, fallback);

  const saved = await persist({
    workspaceId: issue.project.workspaceId,
    userId,
    kind: "SUMMARY_ISSUE",
    targetType: "ISSUE",
    targetId: issue.id,
    response: text,
    provider,
  });

  return { summary: text, provider, interactionId: saved.id };
}

export async function summarizePullRequest(pullRequestId: string, userId: string) {
  const pr = await prisma.pullRequest.findUnique({
    where: { id: pullRequestId },
    include: {
      repository: true,
      issue: { include: { project: true } },
    },
  });
  if (!pr) throw new NotFoundError("Pull request not found");
  await assertWorkspaceMember(pr.repository.workspaceId, userId);

  const ctx: PrContext = {
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    draft: pr.draft,
    author: pr.authorLogin,
    repo: pr.repository.fullName,
    issue: pr.issue
      ? {
          key: `${pr.issue.project.key}-${pr.issue.number}`,
          title: pr.issue.title,
          status: pr.issue.status,
        }
      : null,
  };

  const fallback = heuristicPrSummary(ctx);
  const prompt = `Explain in English what this pull request appears to change and what a reviewer should check. Keep it short and practical.\n\nCONTEXT:\n${JSON.stringify(ctx, null, 2)}`;
  const { text, provider } = await generate(prompt, fallback);

  const saved = await persist({
    workspaceId: pr.repository.workspaceId,
    userId,
    kind: "SUMMARY_PR",
    targetType: "PULL_REQUEST",
    targetId: pr.id,
    response: text,
    provider,
  });

  return { summary: text, provider, interactionId: saved.id };
}

export async function summarizeCycle(cycleId: string, userId: string) {
  const cycle = await prisma.cycle.findUnique({
    where: { id: cycleId },
    include: {
      project: true,
      issues: {
        include: {
          project: { select: { key: true } },
        },
      },
    },
  });
  if (!cycle) throw new NotFoundError("Cycle not found");
  await assertWorkspaceMember(cycle.project.workspaceId, userId);

  const byStatus: Record<string, number> = {};
  for (const issue of cycle.issues) {
    byStatus[issue.status] = (byStatus[issue.status] ?? 0) + 1;
  }
  const doneCount = byStatus.DONE ?? 0;
  const issueCount = cycle.issues.length;
  const progress = issueCount === 0 ? 0 : Math.round((doneCount / issueCount) * 100);

  const ctx: CycleContext = {
    name: cycle.name,
    goal: cycle.goal,
    status: cycle.status,
    progress,
    issueCount,
    doneCount,
    byStatus,
    blockers: cycle.issues
      .filter((i) => ["IN_PROGRESS", "IN_REVIEW"].includes(i.status))
      .map((i) => ({
        key: `${i.project.key}-${i.number}`,
        title: i.title,
        status: i.status,
        priority: i.priority,
      })),
    recentTitles: cycle.issues.map((i) => `${i.project.key}-${i.number} ${i.title}`),
  };

  const fallback = heuristicCycleSummary(ctx);
  const prompt = `Summarize cycle delivery health for an engineering manager.\n\nCONTEXT:\n${JSON.stringify(ctx, null, 2)}`;
  const { text, provider } = await generate(prompt, fallback);

  const saved = await persist({
    workspaceId: cycle.project.workspaceId,
    userId,
    kind: "SUMMARY_CYCLE",
    targetType: "CYCLE",
    targetId: cycle.id,
    response: text,
    provider,
  });

  return { summary: text, provider, interactionId: saved.id };
}

export async function askWorkspaceQuestion(
  workspaceId: string,
  userId: string,
  question: string,
  options?: { contextType?: string; contextId?: string },
) {
  await assertWorkspaceMember(workspaceId, userId);

  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) throw new NotFoundError("Workspace not found");

  const [projects, issues, prs, cycles] = await Promise.all([
    prisma.project.findMany({
      where: { workspaceId },
      select: { id: true, key: true, name: true, _count: { select: { issues: true } } },
      take: 20,
    }),
    prisma.issue.findMany({
      where: {
        project: { workspaceId },
        status: { notIn: ["DONE", "CANCELLED"] },
      },
      include: { project: { select: { key: true } } },
      orderBy: { updatedAt: "desc" },
      take: 30,
    }),
    prisma.pullRequest.findMany({
      where: { repository: { workspaceId } },
      include: { repository: { select: { fullName: true } } },
      orderBy: { githubUpdatedAt: "desc" },
      take: 20,
    }),
    prisma.cycle.findMany({
      where: { project: { workspaceId }, status: { in: ["ACTIVE", "PLANNED"] } },
      include: { issues: { select: { status: true } }, project: { select: { key: true } } },
      take: 10,
    }),
  ]);

  let focused: string | null = null;
  if (options?.contextType === "ISSUE" && options.contextId) {
    const issue = await prisma.issue.findUnique({
      where: { id: options.contextId },
      include: {
        project: true,
        comments: { take: 5, orderBy: { createdAt: "desc" }, include: { author: true } },
        pullRequests: { take: 5 },
      },
    });
    if (issue && issue.project.workspaceId === workspaceId) {
      focused = JSON.stringify({
        key: `${issue.project.key}-${issue.number}`,
        title: issue.title,
        description: issue.description,
        status: issue.status,
        comments: issue.comments.map((c) => ({ author: c.author.name, body: c.body })),
        prs: issue.pullRequests.map((p) => ({ number: p.number, title: p.title, state: p.state })),
      });
    }
  } else if (options?.contextType === "PULL_REQUEST" && options.contextId) {
    const pr = await prisma.pullRequest.findUnique({
      where: { id: options.contextId },
      include: { repository: true, issue: { include: { project: true } } },
    });
    if (pr && pr.repository.workspaceId === workspaceId) {
      focused = JSON.stringify({
        number: pr.number,
        title: pr.title,
        body: pr.body,
        state: pr.state,
        repo: pr.repository.fullName,
        issue: pr.issue
          ? { key: `${pr.issue.project.key}-${pr.issue.number}`, title: pr.issue.title }
          : null,
      });
    }
  } else if (options?.contextType === "CYCLE" && options.contextId) {
    const cycle = await prisma.cycle.findUnique({
      where: { id: options.contextId },
      include: { project: true, issues: { take: 40 } },
    });
    if (cycle && cycle.project.workspaceId === workspaceId) {
      focused = JSON.stringify({
        name: cycle.name,
        goal: cycle.goal,
        status: cycle.status,
        issues: cycle.issues.map((i) => ({
          number: i.number,
          title: i.title,
          status: i.status,
          priority: i.priority,
        })),
      });
    }
  }

  const askCtx: AskContext = {
    workspaceName: workspace.name,
    projects: projects.map((p) => ({
      key: p.key,
      name: p.name,
      issueCount: p._count.issues,
    })),
    openIssues: issues.map((i) => ({
      key: `${i.project.key}-${i.number}`,
      title: i.title,
      status: i.status,
      priority: i.priority,
    })),
    openPrs: prs.map((p) => ({
      number: p.number,
      title: p.title,
      repo: p.repository.fullName,
      state: p.state,
    })),
    activeCycles: cycles.map((c) => {
      const done = c.issues.filter((i) => i.status === "DONE").length;
      const total = c.issues.length;
      return {
        name: `${c.project.key} / ${c.name}`,
        progress: total ? Math.round((done / total) * 100) : 0,
        issueCount: total,
      };
    }),
  };

  const fallback = heuristicAsk(question, askCtx);
  const prompt = `Answer the engineering question in English using only this workspace context.\n\nQUESTION:\n${question}\n\nWORKSPACE:\n${JSON.stringify(askCtx, null, 2)}${
    focused ? `\n\nFOCUSED_CONTEXT:\n${focused}` : ""
  }`;
  const { text, provider } = await generate(prompt, fallback);

  const saved = await persist({
    workspaceId,
    userId,
    kind: "ASK",
    targetType: options?.contextType,
    targetId: options?.contextId,
    prompt: question,
    response: text,
    provider,
  });

  return { answer: text, provider, interactionId: saved.id };
}

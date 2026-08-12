import crypto from "node:crypto";
import { Router } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { env } from "../../config/env.js";
import { prisma } from "../../database/prisma.js";
import { requireAuth, requireWorkspaceMember } from "../../middleware/auth.js";
import { AppError, NotFoundError } from "../../utils/errors.js";
import { writeAuditLog } from "../../utils/audit.js";
import { decryptSecret, encryptSecret } from "../../utils/crypto.js";
import {
  assertGithubConfigured,
  exchangeGithubCode,
  fetchGithubUser,
  listGithubBranches,
  listGithubRepos,
} from "../../integrations/github/github.client.js";
import { queueRepositorySync, syncRepositoryPullRequests } from "../../integrations/github/github.sync.js";
import { enqueueRepoSync } from "../../jobs/sync.queue.js";
import { notifyWorkspaceMembers } from "../../realtime/socket.js";

export const githubRouter = Router();

type OauthState = {
  workspaceId: string;
  userId: string;
  nonce: string;
};

type ConnectTicket = {
  workspaceId: string;
  userId: string;
  expiresAt: number;
};

const connectTickets = new Map<string, ConnectTicket>();

function signOauthState(payload: OauthState) {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, { expiresIn: "10m" });
}

function verifyOauthState(token: string) {
  return jwt.verify(token, env.JWT_ACCESS_SECRET) as OauthState;
}

function buildGithubAuthorizeUrl(workspaceId: string, userId: string) {
  const state = signOauthState({
    workspaceId,
    userId,
    nonce: crypto.randomBytes(8).toString("hex"),
  });

  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  url.searchParams.set("redirect_uri", env.GITHUB_CALLBACK_URL);
  url.searchParams.set("scope", "read:user repo");
  url.searchParams.set("state", state);
  return url.toString();
}

githubRouter.get("/integrations/github/status", requireAuth, async (req, res, next) => {
  try {
    const workspaceId = z.string().min(1).parse(req.query.workspaceId);
    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: req.user!.id } },
    });
    if (!membership) throw new AppError("Not a workspace member", 403, "FORBIDDEN");

    const connection = await prisma.githubConnection.findUnique({
      where: { workspaceId },
      select: {
        id: true,
        githubLogin: true,
        scope: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    res.json({
      configured: env.githubConfigured,
      connected: Boolean(connection),
      connection,
    });
  } catch (error) {
    next(error);
  }
});

/** Authenticated: create a one-time ticket, then browser navigates to /start */
githubRouter.post("/integrations/github/prepare", requireAuth, async (req, res, next) => {
  try {
    assertGithubConfigured();
    const workspaceId = z.string().min(1).parse(req.body.workspaceId);
    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: req.user!.id } },
    });
    if (!membership || !["OWNER", "ADMIN", "MANAGER"].includes(membership.role)) {
      throw new AppError("Only managers+ can connect GitHub", 403, "FORBIDDEN");
    }

    const ticket = crypto.randomBytes(24).toString("hex");
    connectTickets.set(ticket, {
      workspaceId,
      userId: req.user!.id,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    res.json({
      startPath: `/api/integrations/github/start?ticket=${ticket}`,
    });
  } catch (error) {
    next(error);
  }
});

/** Browser navigation entry (no Bearer header needed) */
githubRouter.get("/integrations/github/start", async (req, res, next) => {
  try {
    assertGithubConfigured();
    const ticket = z.string().min(1).parse(req.query.ticket);
    const entry = connectTickets.get(ticket);
    connectTickets.delete(ticket);

    if (!entry || entry.expiresAt < Date.now()) {
      throw new AppError("Connect link expired. Try Connect GitHub again.", 400, "TICKET_EXPIRED");
    }

    res.redirect(buildGithubAuthorizeUrl(entry.workspaceId, entry.userId));
  } catch (error) {
    next(error);
  }
});

/** Keep old JSON connect for compatibility */
githubRouter.get("/integrations/github/connect", requireAuth, async (req, res, next) => {
  try {
    assertGithubConfigured();
    const workspaceId = z.string().min(1).parse(req.query.workspaceId);
    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: req.user!.id } },
    });
    if (!membership || !["OWNER", "ADMIN", "MANAGER"].includes(membership.role)) {
      throw new AppError("Only managers+ can connect GitHub", 403, "FORBIDDEN");
    }

    res.json({ url: buildGithubAuthorizeUrl(workspaceId, req.user!.id) });
  } catch (error) {
    next(error);
  }
});

githubRouter.get("/integrations/github/callback", async (req, res) => {
  try {
    const code = z.string().min(1).parse(req.query.code);
    const stateToken = z.string().min(1).parse(req.query.state);
    const state = verifyOauthState(stateToken);

    const { accessToken, scope } = await exchangeGithubCode(code);
    const ghUser = await fetchGithubUser(accessToken);

    await prisma.githubConnection.upsert({
      where: { workspaceId: state.workspaceId },
      create: {
        workspaceId: state.workspaceId,
        userId: state.userId,
        githubUserId: String(ghUser.id),
        githubLogin: ghUser.login,
        accessTokenEnc: encryptSecret(accessToken),
        scope,
      },
      update: {
        userId: state.userId,
        githubUserId: String(ghUser.id),
        githubLogin: ghUser.login,
        accessTokenEnc: encryptSecret(accessToken),
        scope,
      },
    });

    await prisma.auditLog.create({
      data: {
        workspaceId: state.workspaceId,
        actorId: state.userId,
        action: "github.connected",
        metadata: { login: ghUser.login },
      },
    });

    res.redirect(`${env.FRONTEND_URL}/app/repositories?connected=1`);
  } catch (error) {
    const message = error instanceof Error ? encodeURIComponent(error.message) : "oauth_failed";
    res.redirect(`${env.FRONTEND_URL}/app/repositories?error=${message}`);
  }
});

githubRouter.get(
  "/workspaces/:workspaceId/github/repos",
  requireAuth,
  requireWorkspaceMember("MANAGER"),
  async (req, res, next) => {
    try {
      const connection = await prisma.githubConnection.findUnique({
        where: { workspaceId: req.params.workspaceId },
      });
      if (!connection) throw new AppError("Connect GitHub first", 400, "GITHUB_NOT_CONNECTED");

      const token = decryptSecret(connection.accessTokenEnc);
      const repos = await listGithubRepos(token);
      const linked = await prisma.repository.findMany({
        where: { workspaceId: req.params.workspaceId },
        select: { githubRepoId: true },
      });
      const linkedIds = new Set(linked.map((r) => r.githubRepoId));

      res.json({
        repos: repos.map((r) => ({
          githubRepoId: String(r.id),
          name: r.name,
          fullName: r.full_name,
          owner: r.owner.login,
          description: r.description,
          private: r.private,
          defaultBranch: r.default_branch,
          htmlUrl: r.html_url,
          linked: linkedIds.has(String(r.id)),
        })),
      });
    } catch (error) {
      next(error);
    }
  },
);

githubRouter.get(
  "/workspaces/:workspaceId/repositories",
  requireAuth,
  requireWorkspaceMember("GUEST"),
  async (req, res, next) => {
    try {
      const repositories = await prisma.repository.findMany({
        where: { workspaceId: req.params.workspaceId },
        include: { _count: { select: { pullRequests: true } } },
        orderBy: { updatedAt: "desc" },
      });
      res.json({
        repositories: repositories.map((r) => ({
          id: r.id,
          fullName: r.fullName,
          name: r.name,
          owner: r.owner,
          description: r.description,
          private: r.private,
          htmlUrl: r.htmlUrl,
          defaultBranch: r.defaultBranch,
          syncBaseBranch: r.syncBaseBranch,
          syncStatus: r.syncStatus,
          lastSyncedAt: r.lastSyncedAt,
          lastSyncError: r.lastSyncError,
          prCount: r._count.pullRequests,
        })),
      });
    } catch (error) {
      next(error);
    }
  },
);

githubRouter.post(
  "/workspaces/:workspaceId/repositories",
  requireAuth,
  requireWorkspaceMember("MANAGER"),
  async (req, res, next) => {
    try {
      const body = z
        .object({
          githubRepoId: z.string().min(1),
          fullName: z.string().min(1),
          name: z.string().min(1),
          owner: z.string().min(1),
          description: z.string().nullable().optional(),
          private: z.boolean().optional(),
          defaultBranch: z.string().optional(),
          htmlUrl: z.string().url(),
        })
        .parse(req.body);

      const connection = await prisma.githubConnection.findUnique({
        where: { workspaceId: req.params.workspaceId },
      });
      if (!connection) throw new AppError("Connect GitHub first", 400, "GITHUB_NOT_CONNECTED");

      const repository = await prisma.repository.upsert({
        where: {
          workspaceId_githubRepoId: {
            workspaceId: req.params.workspaceId!,
            githubRepoId: body.githubRepoId,
          },
        },
        create: {
          workspaceId: req.params.workspaceId!,
          connectionId: connection.id,
          githubRepoId: body.githubRepoId,
          fullName: body.fullName,
          name: body.name,
          owner: body.owner,
          description: body.description ?? null,
          private: body.private ?? false,
          defaultBranch: body.defaultBranch,
          htmlUrl: body.htmlUrl,
        },
        update: {
          fullName: body.fullName,
          name: body.name,
          owner: body.owner,
          description: body.description ?? null,
          private: body.private ?? false,
          defaultBranch: body.defaultBranch,
          htmlUrl: body.htmlUrl,
        },
      });

      queueRepositorySync(repository.id);

      res.status(201).json({
        repository: {
          id: repository.id,
          fullName: repository.fullName,
          syncStatus: "SYNCING",
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

githubRouter.post(
  "/repositories/:repositoryId/sync",
  requireAuth,
  async (req, res, next) => {
    try {
      const body = z
        .object({
          baseBranch: z.union([z.string().min(1).max(255), z.literal(""), z.null()]).optional(),
          background: z.boolean().optional(),
        })
        .parse(req.body ?? {});

      const repository = await prisma.repository.findUnique({
        where: { id: req.params.repositoryId },
      });
      if (!repository) throw new NotFoundError("Repository not found");

      const membership = await prisma.workspaceMember.findUnique({
        where: {
          workspaceId_userId: { workspaceId: repository.workspaceId, userId: req.user!.id },
        },
      });
      if (!membership || !["OWNER", "ADMIN", "MANAGER", "MEMBER"].includes(membership.role)) {
        throw new AppError("Forbidden", 403, "FORBIDDEN");
      }

      if (body.background) {
        const queued = await enqueueRepoSync(repository.id, {
          baseBranch: body.baseBranch,
          silent: false,
        });
        await writeAuditLog({
          action: "github.repo_sync_queued",
          actorId: req.user!.id,
          workspaceId: repository.workspaceId,
          metadata: {
            repositoryId: repository.id,
            fullName: repository.fullName,
            baseBranch: body.baseBranch ?? repository.syncBaseBranch,
            ...queued,
          },
        });
        res.status(202).json({ ok: true, queued: true, mode: queued.mode });
        return;
      }

      const result = await syncRepositoryPullRequests(repository.id, {
        baseBranch: body.baseBranch,
      });
      await writeAuditLog({
        action: "github.repo_synced",
        actorId: req.user!.id,
        workspaceId: repository.workspaceId,
        metadata: {
          repositoryId: repository.id,
          fullName: repository.fullName,
          ...result,
        },
      });
      res.json({ ok: true, ...result });
    } catch (error) {
      next(error);
    }
  },
);

githubRouter.delete(
  "/repositories/:repositoryId",
  requireAuth,
  async (req, res, next) => {
    try {
      const repository = await prisma.repository.findUnique({
        where: { id: req.params.repositoryId },
      });
      if (!repository) throw new NotFoundError("Repository not found");

      const membership = await prisma.workspaceMember.findUnique({
        where: {
          workspaceId_userId: { workspaceId: repository.workspaceId, userId: req.user!.id },
        },
      });
      if (!membership || !["OWNER", "ADMIN", "MANAGER"].includes(membership.role)) {
        throw new AppError("Forbidden", 403, "FORBIDDEN");
      }

      await prisma.repository.delete({ where: { id: repository.id } });
      await writeAuditLog({
        action: "github.repo_unlinked",
        actorId: req.user!.id,
        workspaceId: repository.workspaceId,
        metadata: { repositoryId: repository.id, fullName: repository.fullName },
      });
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  },
);

githubRouter.get(
  "/repositories/:repositoryId/branches",
  requireAuth,
  async (req, res, next) => {
    try {
      const repository = await prisma.repository.findUnique({
        where: { id: req.params.repositoryId },
        include: { connection: true },
      });
      if (!repository) throw new NotFoundError("Repository not found");

      const membership = await prisma.workspaceMember.findUnique({
        where: {
          workspaceId_userId: { workspaceId: repository.workspaceId, userId: req.user!.id },
        },
      });
      if (!membership) throw new AppError("Forbidden", 403, "FORBIDDEN");

      const token = decryptSecret(repository.connection.accessTokenEnc);
      const branches = await listGithubBranches(token, repository.owner, repository.name);
      const names = branches.map((b) => b.name);
      const preferred = repository.syncBaseBranch || repository.defaultBranch;
      if (preferred && !names.includes(preferred)) {
        names.unshift(preferred);
      }

      res.json({
        defaultBranch: repository.defaultBranch,
        syncBaseBranch: repository.syncBaseBranch,
        branches: names,
      });
    } catch (error) {
      next(error);
    }
  },
);

githubRouter.get(
  "/workspaces/:workspaceId/pull-requests",
  requireAuth,
  requireWorkspaceMember("GUEST"),
  async (req, res, next) => {
    try {
      const query = z
        .object({
          state: z.enum(["OPEN", "MERGED", "CLOSED", "ALL"]).optional(),
          repositoryId: z.string().optional(),
          linked: z.enum(["1", "0", "true", "false"]).optional(),
        })
        .parse(req.query);

      const linked =
        query.linked === "1" || query.linked === "true"
          ? true
          : query.linked === "0" || query.linked === "false"
            ? false
            : undefined;

      const prs = await prisma.pullRequest.findMany({
        where: {
          repository: {
            workspaceId: req.params.workspaceId,
            ...(query.repositoryId ? { id: query.repositoryId } : {}),
          },
          ...(query.state && query.state !== "ALL" ? { state: query.state } : {}),
          ...(linked === true
            ? { issueId: { not: null } }
            : linked === false
              ? { issueId: null }
              : {}),
        },
        include: {
          repository: { select: { id: true, fullName: true, htmlUrl: true } },
          issue: { select: { id: true, number: true, title: true, projectId: true } },
        },
        orderBy: { githubUpdatedAt: "desc" },
        take: 100,
      });
      res.json({ pullRequests: prs });
    } catch (error) {
      next(error);
    }
  },
);

githubRouter.get(
  "/workspaces/:workspaceId/workflow-runs",
  requireAuth,
  requireWorkspaceMember("GUEST"),
  async (req, res, next) => {
    try {
      const query = z
        .object({
          repositoryId: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(100).optional(),
        })
        .parse(req.query);

      const runs = await prisma.workflowRun.findMany({
        where: {
          repository: {
            workspaceId: req.params.workspaceId,
            ...(query.repositoryId ? { id: query.repositoryId } : {}),
          },
        },
        include: {
          repository: { select: { id: true, fullName: true, htmlUrl: true } },
        },
        orderBy: { githubUpdatedAt: "desc" },
        take: query.limit ?? 40,
      });

      res.json({
        workflowRuns: runs.map((r) => ({
          id: r.id,
          name: r.name,
          displayTitle: r.displayTitle,
          status: r.status,
          conclusion: r.conclusion,
          event: r.event,
          branch: r.branch,
          htmlUrl: r.htmlUrl,
          runNumber: r.runNumber,
          githubCreatedAt: r.githubCreatedAt,
          githubUpdatedAt: r.githubUpdatedAt,
          repository: r.repository,
        })),
      });
    } catch (error) {
      next(error);
    }
  },
);

githubRouter.get("/pull-requests/:pullRequestId", requireAuth, async (req, res, next) => {
  try {
    const pr = await prisma.pullRequest.findUnique({
      where: { id: req.params.pullRequestId },
      include: {
        repository: true,
        issue: { select: { id: true, number: true, title: true, projectId: true } },
      },
    });
    if (!pr) throw new NotFoundError("Pull request not found");

    const membership = await prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: { workspaceId: pr.repository.workspaceId, userId: req.user!.id },
      },
    });
    if (!membership) throw new AppError("Forbidden", 403, "FORBIDDEN");

    res.json({ pullRequest: pr });
  } catch (error) {
    next(error);
  }
});

githubRouter.patch("/pull-requests/:pullRequestId", requireAuth, async (req, res, next) => {
  try {
    const body = z.object({ issueId: z.string().nullable() }).parse(req.body);
    const pr = await prisma.pullRequest.findUnique({
      where: { id: req.params.pullRequestId },
      include: { repository: true },
    });
    if (!pr) throw new NotFoundError("Pull request not found");

    const membership = await prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: { workspaceId: pr.repository.workspaceId, userId: req.user!.id },
      },
    });
    if (!membership || membership.role === "GUEST") {
      throw new AppError("Forbidden", 403, "FORBIDDEN");
    }

    if (body.issueId) {
      const issue = await prisma.issue.findUnique({
        where: { id: body.issueId },
        include: { project: true },
      });
      if (!issue || issue.project.workspaceId !== pr.repository.workspaceId) {
        throw new AppError("Issue not in this workspace", 400, "INVALID_ISSUE");
      }
    }

    const updated = await prisma.pullRequest.update({
      where: { id: pr.id },
      data: { issueId: body.issueId },
      include: {
        repository: { select: { id: true, fullName: true, htmlUrl: true, workspaceId: true } },
        issue: {
          select: {
            id: true,
            number: true,
            title: true,
            projectId: true,
            project: { select: { key: true } },
          },
        },
      },
    });

    if (body.issueId && updated.issue) {
      void notifyWorkspaceMembers({
        workspaceId: pr.repository.workspaceId,
        actorId: req.user!.id,
        excludeUserId: req.user!.id,
        type: "PR_LINKED",
        title: `PR #${updated.number} linked to ${updated.issue.project.key}-${updated.issue.number}`,
        body: updated.title,
        link: `/app/pull-requests/${updated.id}`,
      });
    }

    res.json({ pullRequest: updated });
  } catch (error) {
    next(error);
  }
});

githubRouter.post("/webhooks/github", async (req, res, next) => {
  try {
    if (env.GITHUB_WEBHOOK_SECRET) {
      const signature = req.header("x-hub-signature-256");
      const raw = JSON.stringify(req.body);
      const expected =
        "sha256=" +
        crypto.createHmac("sha256", env.GITHUB_WEBHOOK_SECRET).update(raw).digest("hex");
      if (!signature || signature !== expected) {
        // Note: for production prefer raw body verification middleware
        throw new AppError("Invalid webhook signature", 401, "INVALID_SIGNATURE");
      }
    }

    const event = req.header("x-github-event");
    const payload = req.body as {
      action?: string;
      repository?: { id: number; full_name: string };
      pull_request?: {
        id: number;
        number: number;
        title: string;
        body: string | null;
        state: "open" | "closed";
        draft: boolean;
        html_url: string;
        merged_at: string | null;
        created_at: string;
        updated_at: string;
        user: { login: string } | null;
      };
      workflow_run?: {
        id: number;
        name: string;
        display_title?: string;
        status: string;
        conclusion: string | null;
        event: string;
        head_branch: string | null;
        html_url: string;
        run_number: number;
        created_at: string;
        updated_at: string;
      };
    };

    if (!payload.repository?.id) {
      res.status(202).json({ ignored: true });
      return;
    }

    const repositories = await prisma.repository.findMany({
      where: { githubRepoId: String(payload.repository.id) },
    });

    if (repositories.length === 0) {
      res.status(202).json({ ignored: true, reason: "repo_not_linked" });
      return;
    }

    if (event === "pull_request" && payload.pull_request) {
      const pr = payload.pull_request;
      for (const repository of repositories) {
        await prisma.pullRequest.upsert({
          where: {
            repositoryId_githubPrId: {
              repositoryId: repository.id,
              githubPrId: String(pr.id),
            },
          },
          create: {
            repositoryId: repository.id,
            githubPrId: String(pr.id),
            number: pr.number,
            title: pr.title,
            body: pr.body,
            state: pr.merged_at ? "MERGED" : pr.state === "closed" ? "CLOSED" : "OPEN",
            draft: pr.draft,
            authorLogin: pr.user?.login ?? "unknown",
            htmlUrl: pr.html_url,
            githubCreatedAt: new Date(pr.created_at),
            githubUpdatedAt: new Date(pr.updated_at),
            mergedAt: pr.merged_at ? new Date(pr.merged_at) : null,
          },
          update: {
            title: pr.title,
            body: pr.body,
            state: pr.merged_at ? "MERGED" : pr.state === "closed" ? "CLOSED" : "OPEN",
            draft: pr.draft,
            authorLogin: pr.user?.login ?? "unknown",
            htmlUrl: pr.html_url,
            githubUpdatedAt: new Date(pr.updated_at),
            mergedAt: pr.merged_at ? new Date(pr.merged_at) : null,
          },
        });
      }
      res.status(202).json({ ok: true, event, updated: repositories.length });
      return;
    }

    if (event === "workflow_run" && payload.workflow_run) {
      const run = payload.workflow_run;
      for (const repository of repositories) {
        await prisma.workflowRun.upsert({
          where: {
            repositoryId_githubRunId: {
              repositoryId: repository.id,
              githubRunId: String(run.id),
            },
          },
          create: {
            repositoryId: repository.id,
            githubRunId: String(run.id),
            name: run.name,
            displayTitle: run.display_title ?? null,
            status: run.status,
            conclusion: run.conclusion,
            event: run.event,
            branch: run.head_branch,
            htmlUrl: run.html_url,
            runNumber: run.run_number,
            githubCreatedAt: new Date(run.created_at),
            githubUpdatedAt: new Date(run.updated_at),
          },
          update: {
            name: run.name,
            displayTitle: run.display_title ?? null,
            status: run.status,
            conclusion: run.conclusion,
            event: run.event,
            branch: run.head_branch,
            htmlUrl: run.html_url,
            runNumber: run.run_number,
            githubUpdatedAt: new Date(run.updated_at),
          },
        });

        if (run.conclusion === "failure" || run.conclusion === "timed_out") {
          void notifyWorkspaceMembers({
            workspaceId: repository.workspaceId,
            type: "WORKFLOW_FAILED",
            title: `CI failed: ${run.name}`,
            body: `${repository.fullName}${run.head_branch ? ` · ${run.head_branch}` : ""}`,
            link: "/app/actions",
          });
        }
      }
      res.status(202).json({ ok: true, event, updated: repositories.length });
      return;
    }

    // Other events (push, etc.): enqueue a background refresh
    if (event === "push" || event === "create" || event === "delete") {
      for (const repository of repositories) {
        void enqueueRepoSync(repository.id, { silent: true });
      }
      res.status(202).json({ ok: true, event, queued: repositories.length });
      return;
    }

    res.status(202).json({ ignored: true, event });
  } catch (error) {
    next(error);
  }
});

import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireWorkspaceMember } from "../../middleware/auth.js";
import { requireCycleAccess } from "../../middleware/cycleAccess.js";
import { requireIssueAccess } from "../../middleware/resourceAccess.js";
import {
  askWorkspaceQuestion,
  getAiStatus,
  reviewPullRequest,
  summarizeCycle,
  summarizeIssue,
  summarizePullRequest,
} from "./ai.service.js";
import { prisma } from "../../database/prisma.js";
import { ForbiddenError, NotFoundError } from "../../utils/errors.js";
import { writeAuditLog } from "../../utils/audit.js";

export const aiRouter = Router();

aiRouter.use(requireAuth);

aiRouter.get("/ai/status", async (_req, res, next) => {
  try {
    res.json(await getAiStatus());
  } catch (error) {
    next(error);
  }
});

aiRouter.post("/ai/summarize/issues/:issueId", requireIssueAccess("GUEST"), async (req, res, next) => {
  try {
    const result = await summarizeIssue(req.params.issueId, req.user!.id);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

async function requirePrMember(pullRequestId: string, userId: string) {
  const pr = await prisma.pullRequest.findUnique({
    where: { id: pullRequestId },
    include: { repository: { select: { workspaceId: true } } },
  });
  if (!pr) throw new NotFoundError("Pull request not found");
  const membership = await prisma.workspaceMember.findUnique({
    where: {
      workspaceId_userId: { workspaceId: pr.repository.workspaceId, userId },
    },
  });
  if (!membership) throw new ForbiddenError("Not a workspace member");
  return pr;
}

aiRouter.post("/ai/summarize/pull-requests/:pullRequestId", async (req, res, next) => {
  try {
    const pr = await requirePrMember(req.params.pullRequestId, req.user!.id);
    const result = await summarizePullRequest(pr.id, req.user!.id);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

aiRouter.post("/ai/review/pull-requests/:pullRequestId", async (req, res, next) => {
  try {
    const pr = await requirePrMember(req.params.pullRequestId, req.user!.id);
    const result = await reviewPullRequest(pr.id, req.user!.id);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

aiRouter.post(
  "/ai/summarize/cycles/:cycleId",
  requireCycleAccess("GUEST"),
  async (req, res, next) => {
    try {
      const result = await summarizeCycle(req.params.cycleId, req.user!.id);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

aiRouter.post(
  "/workspaces/:workspaceId/ai/ask",
  requireWorkspaceMember("GUEST"),
  async (req, res, next) => {
    try {
      const body = z
        .object({
          question: z.string().min(3).max(2000),
          contextType: z.enum(["ISSUE", "PULL_REQUEST", "CYCLE"]).optional(),
          contextId: z.string().optional(),
        })
        .parse(req.body);

      const result = await askWorkspaceQuestion(
        req.params.workspaceId,
        req.user!.id,
        body.question,
        { contextType: body.contextType, contextId: body.contextId },
      );
      await writeAuditLog({
        action: "ai.ask",
        actorId: req.user!.id,
        workspaceId: req.params.workspaceId,
        metadata: {
          questionLength: body.question.length,
          contextType: body.contextType ?? null,
          contextId: body.contextId ?? null,
          provider: result.provider,
        },
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

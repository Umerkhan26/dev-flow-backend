import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../database/prisma.js";
import { requireAuth, requireWorkspaceMember } from "../../middleware/auth.js";
import { requireIssueAccess, requireProjectAccess } from "../../middleware/resourceAccess.js";
import { ForbiddenError, NotFoundError } from "../../utils/errors.js";

export const issueRouter = Router();

issueRouter.use(requireAuth);

const statusEnum = z.enum([
  "BACKLOG",
  "TODO",
  "IN_PROGRESS",
  "IN_REVIEW",
  "DONE",
  "CANCELLED",
]);
const priorityEnum = z.enum(["NONE", "LOW", "MEDIUM", "HIGH", "URGENT"]);

const createIssueSchema = z.object({
  title: z.string().min(2).max(200),
  description: z.string().max(10000).optional(),
  status: statusEnum.optional(),
  priority: priorityEnum.optional(),
  assigneeId: z.string().nullable().optional(),
  labelIds: z.array(z.string()).optional(),
});

const userSelect = { id: true, name: true, email: true } as const;

function serializeIssue(issue: {
  id: string;
  number: number;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  projectId: string;
  createdAt: Date;
  updatedAt: Date;
  reporter: { id: string; name: string; email: string };
  assignee: { id: string; name: string; email: string } | null;
  labels?: { label: { id: string; name: string; color: string } }[];
  project?: { id: string; name: string; key: string; workspaceId: string };
  _count?: { comments: number };
}) {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    description: issue.description,
    status: issue.status,
    priority: issue.priority,
    projectId: issue.projectId,
    project: issue.project,
    reporter: issue.reporter,
    assignee: issue.assignee,
    labels: issue.labels?.map((l) => l.label) ?? [],
    commentCount: issue._count?.comments,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  };
}

async function nextIssueNumber(projectId: string) {
  const last = await prisma.issue.findFirst({
    where: { projectId },
    orderBy: { number: "desc" },
    select: { number: true },
  });
  return (last?.number ?? 0) + 1;
}

async function assertAssigneeInWorkspace(assigneeId: string | null | undefined, workspaceId: string) {
  if (!assigneeId) return;
  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: assigneeId } },
  });
  if (!member) throw new ForbiddenError("Assignee must be a workspace member");
}

async function assertLabelsInWorkspace(labelIds: string[] | undefined, workspaceId: string) {
  if (!labelIds?.length) return;
  const count = await prisma.label.count({
    where: { workspaceId, id: { in: labelIds } },
  });
  if (count !== labelIds.length) throw new ForbiddenError("Invalid labels for workspace");
}

issueRouter.get(
  "/projects/:projectId/issues",
  requireProjectAccess("GUEST"),
  async (req, res, next) => {
    try {
      const status = typeof req.query.status === "string" ? req.query.status : undefined;
      const issues = await prisma.issue.findMany({
        where: {
          projectId: req.params.projectId,
          ...(status ? { status: status as never } : {}),
        },
        include: {
          reporter: { select: userSelect },
          assignee: { select: userSelect },
          labels: { include: { label: true } },
          _count: { select: { comments: true } },
          project: { select: { id: true, name: true, key: true, workspaceId: true } },
        },
        orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
      });
      res.json({ issues: issues.map(serializeIssue) });
    } catch (error) {
      next(error);
    }
  },
);

issueRouter.post(
  "/projects/:projectId/issues",
  requireProjectAccess("MEMBER"),
  async (req, res, next) => {
    try {
      const body = createIssueSchema.parse(req.body);
      const workspaceId = req.project!.workspaceId;

      await assertAssigneeInWorkspace(body.assigneeId, workspaceId);
      await assertLabelsInWorkspace(body.labelIds, workspaceId);

      const number = await nextIssueNumber(req.params.projectId!);

      const issue = await prisma.issue.create({
        data: {
          projectId: req.params.projectId!,
          number,
          title: body.title,
          description: body.description,
          status: body.status ?? "TODO",
          priority: body.priority ?? "NONE",
          reporterId: req.user!.id,
          assigneeId: body.assigneeId ?? null,
          labels: body.labelIds?.length
            ? { create: body.labelIds.map((labelId) => ({ labelId })) }
            : undefined,
        },
        include: {
          reporter: { select: userSelect },
          assignee: { select: userSelect },
          labels: { include: { label: true } },
          _count: { select: { comments: true } },
          project: { select: { id: true, name: true, key: true, workspaceId: true } },
        },
      });

      await prisma.auditLog.create({
        data: {
          workspaceId,
          actorId: req.user!.id,
          action: "issue.created",
          metadata: { issueId: issue.id, number: issue.number },
        },
      });

      res.status(201).json({ issue: serializeIssue(issue) });
    } catch (error) {
      next(error);
    }
  },
);

issueRouter.get("/issues/:issueId", requireIssueAccess("GUEST"), async (req, res, next) => {
  try {
    const issue = await prisma.issue.findUnique({
      where: { id: req.params.issueId },
      include: {
        reporter: { select: userSelect },
        assignee: { select: userSelect },
        labels: { include: { label: true } },
        _count: { select: { comments: true } },
        project: { select: { id: true, name: true, key: true, workspaceId: true } },
      },
    });
    if (!issue) throw new NotFoundError("Issue not found");
    res.json({ issue: serializeIssue(issue) });
  } catch (error) {
    next(error);
  }
});

issueRouter.patch("/issues/:issueId", requireIssueAccess("MEMBER"), async (req, res, next) => {
  try {
    const body = z
      .object({
        title: z.string().min(2).max(200).optional(),
        description: z.string().max(10000).nullable().optional(),
        status: statusEnum.optional(),
        priority: priorityEnum.optional(),
        assigneeId: z.string().nullable().optional(),
        labelIds: z.array(z.string()).optional(),
      })
      .parse(req.body);

    const workspaceId = req.issue!.project.workspaceId;
    await assertAssigneeInWorkspace(body.assigneeId, workspaceId);
    await assertLabelsInWorkspace(body.labelIds, workspaceId);

    const issue = await prisma.$transaction(async (tx) => {
      if (body.labelIds) {
        await tx.issueLabel.deleteMany({ where: { issueId: req.params.issueId } });
        if (body.labelIds.length) {
          await tx.issueLabel.createMany({
            data: body.labelIds.map((labelId) => ({
              issueId: req.params.issueId!,
              labelId,
            })),
          });
        }
      }

      return tx.issue.update({
        where: { id: req.params.issueId },
        data: {
          title: body.title,
          description: body.description,
          status: body.status,
          priority: body.priority,
          assigneeId: body.assigneeId === undefined ? undefined : body.assigneeId,
        },
        include: {
          reporter: { select: userSelect },
          assignee: { select: userSelect },
          labels: { include: { label: true } },
          _count: { select: { comments: true } },
          project: { select: { id: true, name: true, key: true, workspaceId: true } },
        },
      });
    });

    res.json({ issue: serializeIssue(issue) });
  } catch (error) {
    next(error);
  }
});

issueRouter.delete("/issues/:issueId", requireIssueAccess("MANAGER"), async (req, res, next) => {
  try {
    await prisma.issue.delete({ where: { id: req.params.issueId } });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

issueRouter.get(
  "/issues/:issueId/comments",
  requireIssueAccess("GUEST"),
  async (req, res, next) => {
    try {
      const comments = await prisma.issueComment.findMany({
        where: { issueId: req.params.issueId },
        include: { author: { select: userSelect } },
        orderBy: { createdAt: "asc" },
      });
      res.json({
        comments: comments.map((c) => ({
          id: c.id,
          body: c.body,
          author: c.author,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
        })),
      });
    } catch (error) {
      next(error);
    }
  },
);

issueRouter.post(
  "/issues/:issueId/comments",
  requireIssueAccess("MEMBER"),
  async (req, res, next) => {
    try {
      const body = z.object({ body: z.string().min(1).max(5000) }).parse(req.body);
      const comment = await prisma.issueComment.create({
        data: {
          issueId: req.params.issueId!,
          authorId: req.user!.id,
          body: body.body,
        },
        include: { author: { select: userSelect } },
      });
      res.status(201).json({
        comment: {
          id: comment.id,
          body: comment.body,
          author: comment.author,
          createdAt: comment.createdAt,
          updatedAt: comment.updatedAt,
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

issueRouter.get(
  "/workspaces/:workspaceId/labels",
  requireWorkspaceMember("GUEST"),
  async (req, res, next) => {
    try {
      const labels = await prisma.label.findMany({
        where: { workspaceId: req.params.workspaceId },
        orderBy: { name: "asc" },
      });
      res.json({ labels });
    } catch (error) {
      next(error);
    }
  },
);

issueRouter.post(
  "/workspaces/:workspaceId/labels",
  requireWorkspaceMember("MEMBER"),
  async (req, res, next) => {
    try {
      const body = z
        .object({
          name: z.string().min(1).max(40),
          color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#64748b"),
        })
        .parse(req.body);

      const label = await prisma.label.create({
        data: {
          workspaceId: req.params.workspaceId!,
          name: body.name,
          color: body.color,
        },
      });
      res.status(201).json({ label });
    } catch (error) {
      next(error);
    }
  },
);

issueRouter.get(
  "/workspaces/:workspaceId/issues",
  requireWorkspaceMember("GUEST"),
  async (req, res, next) => {
    try {
      const issues = await prisma.issue.findMany({
        where: { project: { workspaceId: req.params.workspaceId } },
        include: {
          reporter: { select: userSelect },
          assignee: { select: userSelect },
          labels: { include: { label: true } },
          _count: { select: { comments: true } },
          project: { select: { id: true, name: true, key: true, workspaceId: true } },
        },
        orderBy: { updatedAt: "desc" },
        take: 100,
      });
      res.json({ issues: issues.map(serializeIssue) });
    } catch (error) {
      next(error);
    }
  },
);

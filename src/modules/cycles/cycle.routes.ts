import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../database/prisma.js";
import { requireAuth, requireWorkspaceMember } from "../../middleware/auth.js";
import { requireCycleAccess } from "../../middleware/cycleAccess.js";
import { requireProjectAccess } from "../../middleware/resourceAccess.js";
import { notifyWorkspaceMembers } from "../../realtime/socket.js";
import { NotFoundError } from "../../utils/errors.js";

export const cycleRouter = Router();

cycleRouter.use(requireAuth);

const cycleStatusEnum = z.enum(["PLANNED", "ACTIVE", "COMPLETED"]);

const createCycleSchema = z.object({
  name: z.string().min(2).max(80),
  goal: z.string().max(2000).optional(),
  status: cycleStatusEnum.optional(),
  startDate: z.string().datetime().optional().nullable(),
  endDate: z.string().datetime().optional().nullable(),
});

function serializeCycle(cycle: {
  id: string;
  name: string;
  goal: string | null;
  status: string;
  startDate: Date | null;
  endDate: Date | null;
  projectId: string;
  createdAt: Date;
  updatedAt: Date;
  project?: { id: string; name: string; key: string; workspaceId: string };
  _count?: { issues: number };
  issues?: { status: string }[];
}) {
  const issues = cycle.issues ?? [];
  const done = issues.filter((i) => i.status === "DONE").length;
  const total = cycle._count?.issues ?? issues.length;
  return {
    id: cycle.id,
    name: cycle.name,
    goal: cycle.goal,
    status: cycle.status,
    startDate: cycle.startDate,
    endDate: cycle.endDate,
    projectId: cycle.projectId,
    project: cycle.project,
    issueCount: total,
    doneCount: done,
    progress: total ? Math.round((done / total) * 100) : 0,
    createdAt: cycle.createdAt,
    updatedAt: cycle.updatedAt,
  };
}

const cycleInclude = {
  project: { select: { id: true, name: true, key: true, workspaceId: true } },
  _count: { select: { issues: true } },
  issues: { select: { status: true } },
} as const;

cycleRouter.get(
  "/projects/:projectId/cycles",
  requireProjectAccess("GUEST"),
  async (req, res, next) => {
    try {
      const cycles = await prisma.cycle.findMany({
        where: { projectId: req.params.projectId },
        include: cycleInclude,
        orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      });
      res.json({ cycles: cycles.map(serializeCycle) });
    } catch (error) {
      next(error);
    }
  },
);

cycleRouter.post(
  "/projects/:projectId/cycles",
  requireProjectAccess("MEMBER"),
  async (req, res, next) => {
    try {
      const body = createCycleSchema.parse(req.body);
      const cycle = await prisma.cycle.create({
        data: {
          projectId: req.params.projectId!,
          name: body.name,
          goal: body.goal,
          status: body.status ?? "PLANNED",
          startDate: body.startDate ? new Date(body.startDate) : null,
          endDate: body.endDate ? new Date(body.endDate) : null,
          createdById: req.user!.id,
        },
        include: cycleInclude,
      });

      await prisma.auditLog.create({
        data: {
          workspaceId: cycle.project.workspaceId,
          actorId: req.user!.id,
          action: "cycle.created",
          metadata: { cycleId: cycle.id, name: cycle.name },
        },
      });

      void notifyWorkspaceMembers({
        workspaceId: cycle.project.workspaceId,
        actorId: req.user!.id,
        excludeUserId: req.user!.id,
        type: "CYCLE_CREATED",
        title: `Cycle created: ${cycle.name}`,
        body: cycle.goal || `${cycle.project.key} delivery cycle`,
        link: `/app/cycles/${cycle.id}`,
      });

      res.status(201).json({ cycle: serializeCycle(cycle) });
    } catch (error) {
      next(error);
    }
  },
);

cycleRouter.get(
  "/workspaces/:workspaceId/cycles",
  requireWorkspaceMember("GUEST"),
  async (req, res, next) => {
    try {
      const cycles = await prisma.cycle.findMany({
        where: { project: { workspaceId: req.params.workspaceId } },
        include: cycleInclude,
        orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      });
      res.json({ cycles: cycles.map(serializeCycle) });
    } catch (error) {
      next(error);
    }
  },
);

cycleRouter.get("/cycles/:cycleId", requireCycleAccess("GUEST"), async (req, res, next) => {
  try {
    const cycle = await prisma.cycle.findUnique({
      where: { id: req.params.cycleId },
      include: cycleInclude,
    });
    if (!cycle) throw new NotFoundError("Cycle not found");
    res.json({ cycle: serializeCycle(cycle) });
  } catch (error) {
    next(error);
  }
});

cycleRouter.patch("/cycles/:cycleId", requireCycleAccess("MANAGER"), async (req, res, next) => {
  try {
    const body = z
      .object({
        name: z.string().min(2).max(80).optional(),
        goal: z.string().max(2000).nullable().optional(),
        status: cycleStatusEnum.optional(),
        startDate: z.string().datetime().nullable().optional(),
        endDate: z.string().datetime().nullable().optional(),
      })
      .parse(req.body);

    const cycle = await prisma.cycle.update({
      where: { id: req.params.cycleId },
      data: {
        name: body.name,
        goal: body.goal,
        status: body.status,
        startDate:
          body.startDate === undefined
            ? undefined
            : body.startDate
              ? new Date(body.startDate)
              : null,
        endDate:
          body.endDate === undefined ? undefined : body.endDate ? new Date(body.endDate) : null,
      },
      include: cycleInclude,
    });
    res.json({ cycle: serializeCycle(cycle) });
  } catch (error) {
    next(error);
  }
});

cycleRouter.get("/cycles/:cycleId/board", requireCycleAccess("GUEST"), async (req, res, next) => {
  try {
    const issues = await prisma.issue.findMany({
      where: { cycleId: req.params.cycleId },
      include: {
        reporter: { select: { id: true, name: true, email: true } },
        assignee: { select: { id: true, name: true, email: true } },
        labels: { include: { label: true } },
        project: { select: { id: true, name: true, key: true, workspaceId: true } },
        _count: { select: { comments: true } },
      },
      orderBy: [{ priority: "desc" }, { updatedAt: "desc" }],
    });

    const columns = ["BACKLOG", "TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"] as const;
    const board = Object.fromEntries(
      columns.map((status) => [
        status,
        issues
          .filter((i) => i.status === status)
          .map((issue) => ({
            id: issue.id,
            number: issue.number,
            title: issue.title,
            status: issue.status,
            priority: issue.priority,
            projectId: issue.projectId,
            cycleId: issue.cycleId,
            project: issue.project,
            reporter: issue.reporter,
            assignee: issue.assignee,
            labels: issue.labels.map((l) => l.label),
            commentCount: issue._count.comments,
            createdAt: issue.createdAt,
            updatedAt: issue.updatedAt,
          })),
      ]),
    );

    res.json({ board, columns });
  } catch (error) {
    next(error);
  }
});

cycleRouter.post("/cycles/:cycleId/issues", requireCycleAccess("MEMBER"), async (req, res, next) => {
  try {
    const body = z.object({ issueIds: z.array(z.string()).min(1) }).parse(req.body);
    const result = await prisma.issue.updateMany({
      where: {
        id: { in: body.issueIds },
        projectId: req.cycle!.projectId,
      },
      data: { cycleId: req.cycle!.id },
    });

    const workspaceId = req.project?.workspaceId ?? req.workspaceMembership?.workspaceId;
    if (workspaceId && result.count > 0) {
      void notifyWorkspaceMembers({
        workspaceId,
        actorId: req.user!.id,
        excludeUserId: req.user!.id,
        type: "CYCLE_UPDATED",
        title: `${result.count} issue(s) added to ${req.cycle!.name}`,
        body: "Cycle board updated",
        link: `/app/cycles/${req.cycle!.id}`,
      });
    }

    res.json({ updated: result.count });
  } catch (error) {
    next(error);
  }
});

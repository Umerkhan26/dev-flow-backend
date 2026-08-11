import {
  IssuePriority,
  IssueStatus,
  PullRequestState,
  type Prisma,
} from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../database/prisma.js";
import { requireAuth, requireWorkspaceMember } from "../../middleware/auth.js";
import { AppError, NotFoundError } from "../../utils/errors.js";

export const analyticsRouter = Router();

analyticsRouter.use(requireAuth);

const OPEN_STATUSES: IssueStatus[] = [
  "BACKLOG",
  "TODO",
  "IN_PROGRESS",
  "IN_REVIEW",
];

const ALL_STATUSES = Object.values(IssueStatus);
const ALL_PRIORITIES = Object.values(IssuePriority);
const ALL_PR_STATES = Object.values(PullRequestState);

function parseWindow(fromRaw?: string, toRaw?: string) {
  const to = toRaw ? new Date(toRaw) : new Date();
  const from = fromRaw
    ? new Date(fromRaw)
    : new Date(to.getTime() - 14 * 24 * 60 * 60 * 1000);

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new AppError("Invalid from/to date", 400, "VALIDATION_ERROR");
  }

  return { from, to };
}

function zeroMap<T extends string>(keys: readonly T[]): Record<T, number> {
  return Object.fromEntries(keys.map((k) => [k, 0])) as Record<T, number>;
}

analyticsRouter.get(
  "/workspaces/:workspaceId/analytics",
  requireWorkspaceMember("GUEST"),
  async (req, res, next) => {
    try {
      const workspaceId = req.params.workspaceId;
      const query = z
        .object({
          projectId: z.string().optional(),
          from: z.string().optional(),
          to: z.string().optional(),
        })
        .parse(req.query);

      const { from, to } = parseWindow(query.from, query.to);

      if (query.projectId) {
        const project = await prisma.project.findFirst({
          where: { id: query.projectId, workspaceId },
          select: { id: true },
        });
        if (!project) throw new NotFoundError("Project not found in workspace");
      }

      const projectFilter: Prisma.ProjectWhereInput = {
        workspaceId,
        ...(query.projectId ? { id: query.projectId } : {}),
      };

      const issueWhere: Prisma.IssueWhereInput = {
        project: projectFilter,
      };

      const openIssueWhere: Prisma.IssueWhereInput = {
        ...issueWhere,
        status: { in: OPEN_STATUSES },
      };

      const [
        projectsCount,
        membersCount,
        issuesTotal,
        issuesOpen,
        issuesDone,
        issuesUnassigned,
        highUrgentOpen,
        doneInWindow,
        statusGroups,
        priorityGroups,
        assigneeGroups,
        projects,
        activeCycles,
        prStateGroups,
        prsOpen,
        prsMergedInWindow,
        draftOpen,
        linkedOpen,
        unlinkedOpen,
        mergedForAvg,
      ] = await Promise.all([
        prisma.project.count({ where: projectFilter }),
        prisma.workspaceMember.count({ where: { workspaceId } }),
        prisma.issue.count({ where: issueWhere }),
        prisma.issue.count({ where: openIssueWhere }),
        prisma.issue.count({ where: { ...issueWhere, status: "DONE" } }),
        prisma.issue.count({
          where: { ...openIssueWhere, assigneeId: null },
        }),
        prisma.issue.count({
          where: {
            ...openIssueWhere,
            priority: { in: ["HIGH", "URGENT"] },
          },
        }),
        prisma.issue.count({
          where: {
            ...issueWhere,
            status: "DONE",
            updatedAt: { gte: from, lte: to },
          },
        }),
        prisma.issue.groupBy({
          by: ["status"],
          where: issueWhere,
          _count: { _all: true },
        }),
        prisma.issue.groupBy({
          by: ["priority"],
          where: issueWhere,
          _count: { _all: true },
        }),
        prisma.issue.groupBy({
          by: ["assigneeId"],
          where: {
            ...openIssueWhere,
            assigneeId: { not: null },
          },
          _count: { _all: true },
          orderBy: { _count: { assigneeId: "desc" } },
          take: 8,
        }),
        prisma.project.findMany({
          where: projectFilter,
          select: {
            id: true,
            key: true,
            name: true,
            issues: { select: { status: true } },
          },
          orderBy: { name: "asc" },
        }),
        prisma.cycle.findMany({
          where: {
            status: { in: ["ACTIVE", "PLANNED"] },
            project: projectFilter,
          },
          include: {
            _count: { select: { issues: true } },
            issues: { select: { status: true } },
            project: { select: { id: true, key: true, name: true } },
          },
          orderBy: [{ status: "asc" }, { endDate: "asc" }],
          take: 12,
        }),
        prisma.pullRequest.groupBy({
          by: ["state"],
          where: { repository: { workspaceId } },
          _count: { _all: true },
        }),
        prisma.pullRequest.count({
          where: { repository: { workspaceId }, state: "OPEN" },
        }),
        prisma.pullRequest.count({
          where: {
            repository: { workspaceId },
            state: "MERGED",
            mergedAt: { gte: from, lte: to },
          },
        }),
        prisma.pullRequest.count({
          where: {
            repository: { workspaceId },
            state: "OPEN",
            draft: true,
          },
        }),
        prisma.pullRequest.count({
          where: {
            repository: { workspaceId },
            state: "OPEN",
            issueId: { not: null },
          },
        }),
        prisma.pullRequest.count({
          where: {
            repository: { workspaceId },
            state: "OPEN",
            issueId: null,
          },
        }),
        prisma.pullRequest.findMany({
          where: {
            repository: { workspaceId },
            state: "MERGED",
            mergedAt: { not: null },
            githubCreatedAt: { not: null },
          },
          select: { githubCreatedAt: true, mergedAt: true },
          take: 200,
          orderBy: { mergedAt: "desc" },
        }),
      ]);

      const issuesByStatus = zeroMap(ALL_STATUSES);
      for (const row of statusGroups) {
        issuesByStatus[row.status] = row._count._all;
      }

      const issuesByPriority = zeroMap(ALL_PRIORITIES);
      for (const row of priorityGroups) {
        issuesByPriority[row.priority] = row._count._all;
      }

      const assigneeIds = assigneeGroups
        .map((g) => g.assigneeId)
        .filter((id): id is string => Boolean(id));

      const users = assigneeIds.length
        ? await prisma.user.findMany({
            where: { id: { in: assigneeIds } },
            select: { id: true, name: true },
          })
        : [];
      const userName = new Map(users.map((u) => [u.id, u.name]));

      const assigneeWip = assigneeGroups.map((g) => ({
        userId: g.assigneeId!,
        name: userName.get(g.assigneeId!) ?? "Unknown",
        openCount: g._count._all,
      }));

      const now = new Date();
      let cyclesAtRisk = 0;
      const cycles = activeCycles.map((cycle) => {
        const issueCount = cycle._count.issues;
        const doneCount = cycle.issues.filter((i) => i.status === "DONE").length;
        const progress = issueCount ? Math.round((doneCount / issueCount) * 100) : 0;
        const incomplete = issueCount - doneCount;
        const atRisk =
          cycle.status === "ACTIVE" &&
          cycle.endDate != null &&
          cycle.endDate < now &&
          incomplete > 0;
        if (atRisk) cyclesAtRisk += 1;
        return {
          id: cycle.id,
          name: cycle.name,
          status: cycle.status,
          progress,
          issueCount,
          doneCount,
          endDate: cycle.endDate,
          project: cycle.project,
          atRisk,
        };
      });

      const cyclesActive = activeCycles.filter((c) => c.status === "ACTIVE").length;

      const byState = zeroMap(ALL_PR_STATES);
      for (const row of prStateGroups) {
        byState[row.state] = row._count._all;
      }

      let avgMergeHours: number | null = null;
      if (mergedForAvg.length > 0) {
        const hours = mergedForAvg
          .map((pr) => {
            if (!pr.mergedAt || !pr.githubCreatedAt) return null;
            return (pr.mergedAt.getTime() - pr.githubCreatedAt.getTime()) / 3_600_000;
          })
          .filter((h): h is number => h != null && h >= 0);
        if (hours.length) {
          avgMergeHours =
            Math.round((hours.reduce((a, b) => a + b, 0) / hours.length) * 10) / 10;
        }
      }

      const projectRollup = projects.map((p) => {
        const open = p.issues.filter((i) => OPEN_STATUSES.includes(i.status)).length;
        const done = p.issues.filter((i) => i.status === "DONE").length;
        const tracked = open + done;
        return {
          id: p.id,
          key: p.key,
          name: p.name,
          open,
          done,
          completionPct: tracked ? Math.round((done / tracked) * 100) : 0,
        };
      });

      res.json({
        window: { from: from.toISOString(), to: to.toISOString() },
        summary: {
          projects: projectsCount,
          members: membersCount,
          issuesTotal,
          issuesOpen,
          issuesDone,
          issuesUnassigned,
          highUrgentOpen,
          doneInWindow,
          prsOpen,
          prsMergedInWindow,
          cyclesActive,
          cyclesAtRisk,
        },
        issuesByStatus,
        issuesByPriority,
        assigneeWip,
        cycles,
        pullRequests: {
          byState,
          draftOpen,
          linkedOpen,
          unlinkedOpen,
          avgMergeHours,
        },
        projects: projectRollup,
      });
    } catch (error) {
      next(error);
    }
  },
);

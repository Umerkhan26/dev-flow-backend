import type { NextFunction, Request, Response } from "express";
import type { WorkspaceRole } from "@prisma/client";
import { prisma } from "../database/prisma.js";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "../utils/errors.js";

const roleRank: Record<WorkspaceRole, number> = {
  GUEST: 1,
  MEMBER: 2,
  MANAGER: 3,
  ADMIN: 4,
  OWNER: 5,
};

async function assertMembership(userId: string, workspaceId: string, minRole: WorkspaceRole) {
  const membership = await prisma.workspaceMember.findUnique({
    where: {
      workspaceId_userId: { workspaceId, userId },
    },
  });

  if (!membership) throw new ForbiddenError("Not a workspace member");
  if (roleRank[membership.role] < roleRank[minRole]) {
    throw new ForbiddenError("Insufficient permissions");
  }

  return membership;
}

/** Resolve project → workspace and enforce membership. */
export function requireProjectAccess(minRole: WorkspaceRole = "GUEST") {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new UnauthorizedError();

      const projectId = req.params.projectId;
      if (!projectId) throw new ForbiddenError("Project id required");

      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, workspaceId: true, name: true, key: true },
      });
      if (!project) throw new NotFoundError("Project not found");

      const membership = await assertMembership(req.user.id, project.workspaceId, minRole);
      req.project = project;
      req.workspaceMembership = {
        id: membership.id,
        role: membership.role,
        workspaceId: membership.workspaceId,
      };
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Resolve issue → project → workspace and enforce membership. */
export function requireIssueAccess(minRole: WorkspaceRole = "GUEST") {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new UnauthorizedError();

      const issueId = req.params.issueId;
      if (!issueId) throw new ForbiddenError("Issue id required");

      const issue = await prisma.issue.findUnique({
        where: { id: issueId },
        select: {
          id: true,
          projectId: true,
          number: true,
          title: true,
          project: { select: { id: true, workspaceId: true, name: true, key: true } },
        },
      });
      if (!issue) throw new NotFoundError("Issue not found");

      const membership = await assertMembership(
        req.user.id,
        issue.project.workspaceId,
        minRole,
      );
      req.issue = issue;
      req.project = issue.project;
      req.workspaceMembership = {
        id: membership.id,
        role: membership.role,
        workspaceId: membership.workspaceId,
      };
      next();
    } catch (error) {
      next(error);
    }
  };
}

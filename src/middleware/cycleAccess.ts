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

export function requireCycleAccess(minRole: WorkspaceRole = "GUEST") {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new UnauthorizedError();

      const cycleId = req.params.cycleId;
      if (!cycleId) throw new ForbiddenError("Cycle id required");

      const cycle = await prisma.cycle.findUnique({
        where: { id: cycleId },
        select: {
          id: true,
          projectId: true,
          name: true,
          project: { select: { id: true, workspaceId: true, name: true, key: true } },
        },
      });
      if (!cycle) throw new NotFoundError("Cycle not found");

      const membership = await prisma.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: cycle.project.workspaceId,
            userId: req.user.id,
          },
        },
      });
      if (!membership) throw new ForbiddenError("Not a workspace member");
      if (roleRank[membership.role] < roleRank[minRole]) {
        throw new ForbiddenError("Insufficient permissions");
      }

      req.project = cycle.project;
      req.cycle = {
        id: cycle.id,
        projectId: cycle.projectId,
        name: cycle.name,
      };
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

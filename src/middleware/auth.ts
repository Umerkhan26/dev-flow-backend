import type { NextFunction, Request, Response } from "express";
import type { WorkspaceRole } from "@prisma/client";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { prisma } from "../database/prisma.js";
import { ForbiddenError, UnauthorizedError } from "../utils/errors.js";

export type AuthUser = {
  id: string;
  email: string;
  name: string;
};

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      workspaceMembership?: {
        id: string;
        role: WorkspaceRole;
        workspaceId: string;
      };
      project?: {
        id: string;
        workspaceId: string;
        name: string;
        key: string;
      };
      issue?: {
        id: string;
        projectId: string;
        number: number;
        title: string;
        project: {
          id: string;
          workspaceId: string;
          name: string;
          key: string;
        };
      };
    }
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return next(new UnauthorizedError("Missing access token"));
  }

  const token = header.slice("Bearer ".length);
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as {
      sub: string;
      email: string;
      name: string;
    };
    req.user = { id: payload.sub, email: payload.email, name: payload.name };
    return next();
  } catch {
    return next(new UnauthorizedError("Invalid or expired access token"));
  }
}

const roleRank: Record<WorkspaceRole, number> = {
  GUEST: 1,
  MEMBER: 2,
  MANAGER: 3,
  ADMIN: 4,
  OWNER: 5,
};

export function requireWorkspaceMember(minRole: WorkspaceRole = "GUEST") {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new UnauthorizedError();

      const workspaceId = req.params.workspaceId;
      if (!workspaceId) throw new ForbiddenError("Workspace id required");

      const membership = await prisma.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId,
            userId: req.user.id,
          },
        },
      });

      if (!membership) throw new ForbiddenError("Not a workspace member");
      if (roleRank[membership.role] < roleRank[minRole]) {
        throw new ForbiddenError("Insufficient permissions");
      }

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

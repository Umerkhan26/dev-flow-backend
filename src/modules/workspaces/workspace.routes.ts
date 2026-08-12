import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../database/prisma.js";
import { requireAuth, requireWorkspaceMember } from "../../middleware/auth.js";
import { AppError, ConflictError, ForbiddenError, NotFoundError } from "../../utils/errors.js";
import { writeAuditLog } from "../../utils/audit.js";
import { slugify } from "../auth/auth.service.js";
import { encryptSecret } from "../../utils/crypto.js";

export const workspaceRouter = Router();

workspaceRouter.use(requireAuth);

const roleEnum = z.enum(["OWNER", "ADMIN", "MANAGER", "MEMBER", "GUEST"]);
const assignableRoles = z.enum(["ADMIN", "MANAGER", "MEMBER", "GUEST"]);

const createWorkspaceSchema = z.object({
  name: z.string().min(2).max(80),
});

const roleRank: Record<string, number> = {
  GUEST: 1,
  MEMBER: 2,
  MANAGER: 3,
  ADMIN: 4,
  OWNER: 5,
};

workspaceRouter.get("/", async (req, res, next) => {
  try {
    const memberships = await prisma.workspaceMember.findMany({
      where: { userId: req.user!.id },
      include: {
        workspace: {
          select: { id: true, name: true, slug: true, createdAt: true },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    res.json({
      workspaces: memberships.map((m) => ({
        ...m.workspace,
        role: m.role,
      })),
    });
  } catch (error) {
    next(error);
  }
});

workspaceRouter.post("/", async (req, res, next) => {
  try {
    const body = createWorkspaceSchema.parse(req.body);
    const baseSlug = slugify(body.name) || "workspace";
    let slug = baseSlug;
    let attempt = 0;

    while (await prisma.workspace.findUnique({ where: { slug } })) {
      attempt += 1;
      slug = `${baseSlug}-${attempt}`;
    }

    const workspace = await prisma.$transaction(async (tx) => {
      const created = await tx.workspace.create({
        data: {
          name: body.name,
          slug,
          createdById: req.user!.id,
        },
      });

      await tx.workspaceMember.create({
        data: {
          workspaceId: created.id,
          userId: req.user!.id,
          role: "OWNER",
        },
      });

      await tx.auditLog.create({
        data: {
          workspaceId: created.id,
          actorId: req.user!.id,
          action: "workspace.created",
          metadata: { name: created.name, slug: created.slug },
        },
      });

      return created;
    });

    res.status(201).json({
      workspace: {
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        createdAt: workspace.createdAt,
        role: "OWNER",
      },
    });
  } catch (error) {
    next(error);
  }
});

workspaceRouter.get("/:workspaceId", requireWorkspaceMember("GUEST"), async (req, res, next) => {
  try {
    const workspace = await prisma.workspace.findUnique({
      where: { id: req.params.workspaceId },
      select: {
        id: true,
        name: true,
        slug: true,
        createdAt: true,
        updatedAt: true,
        slackWebhookEnc: true,
      },
    });
    if (!workspace) throw new NotFoundError("Workspace not found");

    const { slackWebhookEnc, ...rest } = workspace;
    res.json({
      workspace: {
        ...rest,
        slackConfigured: Boolean(slackWebhookEnc),
        role: req.workspaceMembership!.role,
      },
    });
  } catch (error) {
    next(error);
  }
});

workspaceRouter.patch("/:workspaceId", requireWorkspaceMember("ADMIN"), async (req, res, next) => {
  try {
    const body = z
      .object({
        name: z.string().min(2).max(80).optional(),
        slackWebhookUrl: z.union([z.string().url().max(500), z.literal(""), z.null()]).optional(),
      })
      .refine((v) => v.name !== undefined || v.slackWebhookUrl !== undefined, {
        message: "Provide name and/or slackWebhookUrl",
      })
      .parse(req.body);

    const data: { name?: string; slackWebhookEnc?: string | null } = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.slackWebhookUrl !== undefined) {
      data.slackWebhookEnc =
        body.slackWebhookUrl && body.slackWebhookUrl.length > 0
          ? encryptSecret(body.slackWebhookUrl)
          : null;
    }

    const workspace = await prisma.workspace.update({
      where: { id: req.params.workspaceId },
      data,
      select: { id: true, name: true, slug: true, updatedAt: true, slackWebhookEnc: true },
    });

    await prisma.auditLog.create({
      data: {
        workspaceId: workspace.id,
        actorId: req.user!.id,
        action: "workspace.updated",
        metadata: {
          name: body.name ?? undefined,
          slackUpdated: body.slackWebhookUrl !== undefined,
          slackConfigured: Boolean(workspace.slackWebhookEnc),
        },
      },
    });

    res.json({
      workspace: {
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        updatedAt: workspace.updatedAt,
        slackConfigured: Boolean(workspace.slackWebhookEnc),
      },
    });
  } catch (error) {
    next(error);
  }
});

workspaceRouter.get(
  "/:workspaceId/members",
  requireWorkspaceMember("GUEST"),
  async (req, res, next) => {
    try {
      const members = await prisma.workspaceMember.findMany({
        where: { workspaceId: req.params.workspaceId },
        include: {
          user: { select: { id: true, name: true, email: true } },
        },
        orderBy: { createdAt: "asc" },
      });

      res.json({
        members: members.map((m) => ({
          id: m.id,
          role: m.role,
          user: m.user,
          joinedAt: m.createdAt,
        })),
      });
    } catch (error) {
      next(error);
    }
  },
);

workspaceRouter.post(
  "/:workspaceId/invitations",
  requireWorkspaceMember("ADMIN"),
  async (req, res, next) => {
    try {
      const body = z
        .object({
          email: z.string().email(),
          role: assignableRoles.default("MEMBER"),
        })
        .parse(req.body);

      const user = await prisma.user.findUnique({
        where: { email: body.email.toLowerCase() },
      });
      if (!user) throw new NotFoundError("User must register before being invited (MVP)");

      const existing = await prisma.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: req.params.workspaceId!,
            userId: user.id,
          },
        },
      });
      if (existing) throw new ConflictError("User is already a member");

      const member = await prisma.workspaceMember.create({
        data: {
          workspaceId: req.params.workspaceId!,
          userId: user.id,
          role: body.role,
        },
        include: {
          user: { select: { id: true, name: true, email: true } },
        },
      });

      await writeAuditLog({
        workspaceId: req.params.workspaceId!,
        actorId: req.user!.id,
        action: "workspace.member_invited",
        metadata: { email: user.email, role: body.role },
      });

      res.status(201).json({
        member: {
          id: member.id,
          role: member.role,
          user: member.user,
          joinedAt: member.createdAt,
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

workspaceRouter.patch(
  "/:workspaceId/members/:memberId",
  requireWorkspaceMember("ADMIN"),
  async (req, res, next) => {
    try {
      const body = z.object({ role: roleEnum }).parse(req.body);
      const actorRole = req.workspaceMembership!.role;
      const workspaceId = req.params.workspaceId!;

      const member = await prisma.workspaceMember.findFirst({
        where: { id: req.params.memberId, workspaceId },
        include: { user: { select: { id: true, name: true, email: true } } },
      });
      if (!member) throw new NotFoundError("Member not found");

      if (body.role === "OWNER" && actorRole !== "OWNER") {
        throw new ForbiddenError("Only an owner can assign the owner role");
      }
      if (member.role === "OWNER" && actorRole !== "OWNER") {
        throw new ForbiddenError("Only an owner can change another owner");
      }
      if (roleRank[body.role] > roleRank[actorRole]) {
        throw new ForbiddenError("Cannot assign a role higher than your own");
      }

      if (member.role === "OWNER" && body.role !== "OWNER") {
        const owners = await prisma.workspaceMember.count({
          where: { workspaceId, role: "OWNER" },
        });
        if (owners <= 1) {
          throw new AppError("Cannot demote the last owner", 400, "LAST_OWNER");
        }
      }

      const updated = await prisma.workspaceMember.update({
        where: { id: member.id },
        data: { role: body.role },
        include: { user: { select: { id: true, name: true, email: true } } },
      });

      await writeAuditLog({
        workspaceId,
        actorId: req.user!.id,
        action: "workspace.member_role_changed",
        metadata: {
          memberId: member.id,
          userId: member.userId,
          from: member.role,
          to: body.role,
        },
      });

      res.json({
        member: {
          id: updated.id,
          role: updated.role,
          user: updated.user,
          joinedAt: updated.createdAt,
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

workspaceRouter.delete(
  "/:workspaceId/members/:memberId",
  requireWorkspaceMember("ADMIN"),
  async (req, res, next) => {
    try {
      const actorRole = req.workspaceMembership!.role;
      const workspaceId = req.params.workspaceId!;

      const member = await prisma.workspaceMember.findFirst({
        where: { id: req.params.memberId, workspaceId },
      });
      if (!member) throw new NotFoundError("Member not found");

      if (member.userId === req.user!.id) {
        throw new AppError("Use leave workspace instead of removing yourself", 400, "SELF_REMOVE");
      }
      if (member.role === "OWNER" && actorRole !== "OWNER") {
        throw new ForbiddenError("Only an owner can remove another owner");
      }
      if (roleRank[member.role] >= roleRank[actorRole] && actorRole !== "OWNER") {
        throw new ForbiddenError("Cannot remove a member with equal or higher role");
      }
      if (member.role === "OWNER") {
        const owners = await prisma.workspaceMember.count({
          where: { workspaceId, role: "OWNER" },
        });
        if (owners <= 1) {
          throw new AppError("Cannot remove the last owner", 400, "LAST_OWNER");
        }
      }

      await prisma.workspaceMember.delete({ where: { id: member.id } });

      await writeAuditLog({
        workspaceId,
        actorId: req.user!.id,
        action: "workspace.member_removed",
        metadata: { memberId: member.id, userId: member.userId, role: member.role },
      });

      res.status(204).send();
    } catch (error) {
      next(error);
    }
  },
);

workspaceRouter.get(
  "/:workspaceId/audit-logs",
  requireWorkspaceMember("ADMIN"),
  async (req, res, next) => {
    try {
      const take = Math.min(Number(req.query.limit) || 50, 100);
      const logs = await prisma.auditLog.findMany({
        where: { workspaceId: req.params.workspaceId },
        include: {
          actor: { select: { id: true, name: true, email: true } },
        },
        orderBy: { createdAt: "desc" },
        take,
      });

      res.json({
        logs: logs.map((l) => ({
          id: l.id,
          action: l.action,
          metadata: l.metadata,
          createdAt: l.createdAt,
          actor: l.actor,
        })),
      });
    } catch (error) {
      next(error);
    }
  },
);

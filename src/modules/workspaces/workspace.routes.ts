import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../database/prisma.js";
import { requireAuth, requireWorkspaceMember } from "../../middleware/auth.js";
import { ConflictError, NotFoundError } from "../../utils/errors.js";
import { slugify } from "../auth/auth.service.js";

export const workspaceRouter = Router();

workspaceRouter.use(requireAuth);

const createWorkspaceSchema = z.object({
  name: z.string().min(2).max(80),
});

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
      select: { id: true, name: true, slug: true, createdAt: true, updatedAt: true },
    });
    if (!workspace) throw new NotFoundError("Workspace not found");

    res.json({
      workspace: {
        ...workspace,
        role: req.workspaceMembership!.role,
      },
    });
  } catch (error) {
    next(error);
  }
});

workspaceRouter.patch("/:workspaceId", requireWorkspaceMember("ADMIN"), async (req, res, next) => {
  try {
    const body = z.object({ name: z.string().min(2).max(80) }).parse(req.body);
    const workspace = await prisma.workspace.update({
      where: { id: req.params.workspaceId },
      data: { name: body.name },
      select: { id: true, name: true, slug: true, updatedAt: true },
    });

    await prisma.auditLog.create({
      data: {
        workspaceId: workspace.id,
        actorId: req.user!.id,
        action: "workspace.updated",
        metadata: { name: workspace.name },
      },
    });

    res.json({ workspace });
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
          role: z.enum(["ADMIN", "MANAGER", "MEMBER", "GUEST"]).default("MEMBER"),
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

      await prisma.auditLog.create({
        data: {
          workspaceId: req.params.workspaceId!,
          actorId: req.user!.id,
          action: "workspace.member_invited",
          metadata: { email: user.email, role: body.role },
        },
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

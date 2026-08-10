import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../database/prisma.js";
import { requireAuth, requireWorkspaceMember } from "../../middleware/auth.js";
import { requireProjectAccess } from "../../middleware/resourceAccess.js";
import { ConflictError, NotFoundError } from "../../utils/errors.js";

export const projectRouter = Router();

projectRouter.use(requireAuth);

const createProjectSchema = z.object({
  name: z.string().min(2).max(80),
  key: z
    .string()
    .min(2)
    .max(8)
    .regex(/^[A-Za-z][A-Za-z0-9]*$/, "Key must start with a letter and be alphanumeric"),
  description: z.string().max(2000).optional(),
});

function serializeProject(project: {
  id: string;
  name: string;
  key: string;
  description: string | null;
  workspaceId: string;
  createdAt: Date;
  updatedAt: Date;
  _count?: { issues: number };
}) {
  return {
    id: project.id,
    name: project.name,
    key: project.key,
    description: project.description,
    workspaceId: project.workspaceId,
    issueCount: project._count?.issues ?? undefined,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

projectRouter.get(
  "/workspaces/:workspaceId/projects",
  requireWorkspaceMember("GUEST"),
  async (req, res, next) => {
    try {
      const projects = await prisma.project.findMany({
        where: { workspaceId: req.params.workspaceId },
        include: { _count: { select: { issues: true } } },
        orderBy: { createdAt: "desc" },
      });
      res.json({ projects: projects.map(serializeProject) });
    } catch (error) {
      next(error);
    }
  },
);

projectRouter.post(
  "/workspaces/:workspaceId/projects",
  requireWorkspaceMember("MEMBER"),
  async (req, res, next) => {
    try {
      const body = createProjectSchema.parse(req.body);
      const key = body.key.toUpperCase();

      const existing = await prisma.project.findUnique({
        where: {
          workspaceId_key: {
            workspaceId: req.params.workspaceId!,
            key,
          },
        },
      });
      if (existing) throw new ConflictError("Project key already exists in this workspace");

      const project = await prisma.project.create({
        data: {
          workspaceId: req.params.workspaceId!,
          name: body.name,
          key,
          description: body.description,
          createdById: req.user!.id,
        },
      });

      await prisma.auditLog.create({
        data: {
          workspaceId: project.workspaceId,
          actorId: req.user!.id,
          action: "project.created",
          metadata: { projectId: project.id, key: project.key },
        },
      });

      res.status(201).json({ project: serializeProject({ ...project, _count: { issues: 0 } }) });
    } catch (error) {
      next(error);
    }
  },
);

projectRouter.get("/projects/:projectId", requireProjectAccess("GUEST"), async (req, res, next) => {
  try {
    const project = await prisma.project.findUnique({
      where: { id: req.params.projectId },
      include: { _count: { select: { issues: true } } },
    });
    if (!project) throw new NotFoundError("Project not found");
    res.json({ project: serializeProject(project) });
  } catch (error) {
    next(error);
  }
});

projectRouter.patch(
  "/projects/:projectId",
  requireProjectAccess("MANAGER"),
  async (req, res, next) => {
    try {
      const body = z
        .object({
          name: z.string().min(2).max(80).optional(),
          description: z.string().max(2000).nullable().optional(),
        })
        .parse(req.body);

      const project = await prisma.project.update({
        where: { id: req.params.projectId },
        data: {
          name: body.name,
          description: body.description,
        },
        include: { _count: { select: { issues: true } } },
      });

      res.json({ project: serializeProject(project) });
    } catch (error) {
      next(error);
    }
  },
);

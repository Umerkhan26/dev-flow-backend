import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../database/prisma.js";
import { requireAuth, requireWorkspaceMember } from "../../middleware/auth.js";

export const notificationRouter = Router();

notificationRouter.use(requireAuth);

notificationRouter.get(
  "/workspaces/:workspaceId/notifications",
  requireWorkspaceMember("GUEST"),
  async (req, res, next) => {
    try {
      const unreadOnly = req.query.unread === "1" || req.query.unread === "true";
      const notifications = await prisma.notification.findMany({
        where: {
          workspaceId: req.params.workspaceId,
          userId: req.user!.id,
          ...(unreadOnly ? { readAt: null } : {}),
        },
        include: {
          actor: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 50,
      });

      const unreadCount = await prisma.notification.count({
        where: {
          workspaceId: req.params.workspaceId,
          userId: req.user!.id,
          readAt: null,
        },
      });

      res.json({ notifications, unreadCount });
    } catch (error) {
      next(error);
    }
  },
);

notificationRouter.post(
  "/workspaces/:workspaceId/notifications/read",
  requireWorkspaceMember("GUEST"),
  async (req, res, next) => {
    try {
      const body = z
        .object({
          ids: z.array(z.string()).optional(),
          all: z.boolean().optional(),
        })
        .parse(req.body);

      if (body.all) {
        await prisma.notification.updateMany({
          where: {
            workspaceId: req.params.workspaceId,
            userId: req.user!.id,
            readAt: null,
          },
          data: { readAt: new Date() },
        });
      } else if (body.ids?.length) {
        await prisma.notification.updateMany({
          where: {
            workspaceId: req.params.workspaceId,
            userId: req.user!.id,
            id: { in: body.ids },
            readAt: null,
          },
          data: { readAt: new Date() },
        });
      }

      const unreadCount = await prisma.notification.count({
        where: {
          workspaceId: req.params.workspaceId,
          userId: req.user!.id,
          readAt: null,
        },
      });

      res.json({ ok: true, unreadCount });
    } catch (error) {
      next(error);
    }
  },
);

import type { Server as HttpServer } from "node:http";
import type { NotificationType } from "@prisma/client";
import jwt from "jsonwebtoken";
import { Server } from "socket.io";
import { env } from "../config/env.js";
import { prisma } from "../database/prisma.js";

export type RealtimePayload = {
  type: string;
  title: string;
  body?: string | null;
  link?: string | null;
  workspaceId: string;
  notificationId?: string;
  createdAt?: string;
};

let io: Server | null = null;

export function initSocketServer(httpServer: HttpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: env.corsOrigins,
      credentials: true,
    },
  });

  io.use((socket, next) => {
    const token =
      (socket.handshake.auth?.token as string | undefined) ??
      (typeof socket.handshake.headers.authorization === "string" &&
      socket.handshake.headers.authorization.startsWith("Bearer ")
        ? socket.handshake.headers.authorization.slice(7)
        : undefined);

    if (!token) {
      next(new Error("Unauthorized"));
      return;
    }

    try {
      const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as {
        sub: string;
        email: string;
        name: string;
      };
      socket.data.user = { id: payload.sub, email: payload.email, name: payload.name };
      next();
    } catch {
      next(new Error("Unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    const userId = socket.data.user?.id as string | undefined;
    if (userId) void socket.join(`user:${userId}`);

    socket.on("workspace:join", async (workspaceId: string, ack?: (ok: boolean) => void) => {
      try {
        if (!workspaceId || !socket.data.user?.id) {
          ack?.(false);
          return;
        }
        const membership = await prisma.workspaceMember.findUnique({
          where: {
            workspaceId_userId: {
              workspaceId,
              userId: socket.data.user.id,
            },
          },
        });
        if (!membership) {
          ack?.(false);
          return;
        }

        for (const room of socket.rooms) {
          if (room.startsWith("workspace:") && room !== `workspace:${workspaceId}`) {
            void socket.leave(room);
          }
        }

        await socket.join(`workspace:${workspaceId}`);
        socket.data.workspaceId = workspaceId;
        ack?.(true);
      } catch {
        ack?.(false);
      }
    });

    socket.on("workspace:leave", (workspaceId: string) => {
      if (workspaceId) void socket.leave(`workspace:${workspaceId}`);
    });
  });

  return io;
}

export function getIo() {
  return io;
}

export function emitWorkspaceEvent(workspaceId: string, event: string, payload: RealtimePayload) {
  io?.to(`workspace:${workspaceId}`).emit(event, payload);
}

export async function notifyWorkspaceMembers(input: {
  workspaceId: string;
  actorId?: string | null;
  type: NotificationType;
  title: string;
  body?: string | null;
  link?: string | null;
  excludeUserId?: string | null;
}) {
  const members = await prisma.workspaceMember.findMany({
    where: { workspaceId: input.workspaceId },
    select: { userId: true },
  });

  const recipients = members
    .map((m) => m.userId)
    .filter((id) => id !== input.excludeUserId);

  if (recipients.length === 0) return [];

  await prisma.notification.createMany({
    data: recipients.map((userId) => ({
      workspaceId: input.workspaceId,
      userId,
      actorId: input.actorId ?? null,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      link: input.link ?? null,
    })),
  });

  const recent = await prisma.notification.findMany({
    where: {
      workspaceId: input.workspaceId,
      userId: { in: recipients },
      type: input.type,
      title: input.title,
    },
    orderBy: { createdAt: "desc" },
    take: recipients.length,
  });

  for (const n of recent) {
    io?.to(`user:${n.userId}`).emit("notification:new", {
      id: n.id,
      userId: n.userId,
      type: n.type,
      title: n.title,
      body: n.body,
      link: n.link,
      workspaceId: n.workspaceId,
      createdAt: n.createdAt.toISOString(),
      readAt: null,
    });
  }

  return recent;
}

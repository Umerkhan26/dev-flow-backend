import type { Prisma } from "@prisma/client";
import { prisma } from "../database/prisma.js";

type AuditInput = {
  action: string;
  actorId?: string | null;
  workspaceId?: string | null;
  metadata?: Prisma.InputJsonValue;
};

/** Best-effort audit write — never throws to callers. */
export async function writeAuditLog(input: AuditInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        action: input.action,
        actorId: input.actorId ?? null,
        workspaceId: input.workspaceId ?? null,
        metadata: input.metadata ?? undefined,
      },
    });
  } catch (error) {
    console.error("[audit] failed to write", input.action, error);
  }
}

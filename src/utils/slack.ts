import { env } from "../config/env.js";
import { prisma } from "../database/prisma.js";
import { decryptSecret } from "./crypto.js";

export async function postSlackWebhook(
  webhookUrl: string,
  payload: { text: string; blocks?: unknown[] },
) {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Slack webhook failed (${res.status}): ${text.slice(0, 120)}`);
  }
}

/** Fire-and-forget Slack post for a workspace notification. */
export function notifySlackForWorkspace(input: {
  workspaceId: string;
  title: string;
  body?: string | null;
  link?: string | null;
}) {
  void (async () => {
    try {
      const workspace = await prisma.workspace.findUnique({
        where: { id: input.workspaceId },
        select: { name: true, slackWebhookEnc: true },
      });
      if (!workspace?.slackWebhookEnc) return;

      const webhookUrl = decryptSecret(workspace.slackWebhookEnc);
      const frontend = env.FRONTEND_URL.replace(/\/$/, "");
      const linkLine =
        input.link != null && input.link.length > 0
          ? `\n<${frontend}${input.link.startsWith("/") ? input.link : `/${input.link}`}|Open in DevFlow>`
          : "";

      await postSlackWebhook(webhookUrl, {
        text: `*[${workspace.name}]* ${input.title}${input.body ? `\n${input.body}` : ""}${linkLine}`,
      });
    } catch (err) {
      console.error("Slack notify failed", input.workspaceId, err);
    }
  })();
}

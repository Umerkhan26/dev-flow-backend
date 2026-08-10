import { env } from "../../config/env.js";
import { AppError } from "../../utils/errors.js";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export async function chatCompletion(messages: ChatMessage[]): Promise<string> {
  if (!env.llmConfigured) {
    throw new AppError("LLM is not configured", 503, "LLM_NOT_CONFIGURED");
  }

  const base = env.LLM_BASE_URL.replace(/\/$/, "");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(env.LLM_API_KEY ? { Authorization: `Bearer ${env.LLM_API_KEY}` } : {}),
    },
    body: JSON.stringify({
      model: env.LLM_MODEL,
      messages,
      temperature: 0.2,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new AppError(
      `LLM request failed (${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`,
      502,
      "LLM_ERROR",
    );
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new AppError("LLM returned an empty response", 502, "LLM_EMPTY");
  return content;
}

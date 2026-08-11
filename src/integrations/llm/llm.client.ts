import { GoogleGenAI } from "@google/genai";
import { env } from "../../config/env.js";
import { AppError } from "../../utils/errors.js";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

async function chatGemini(messages: ChatMessage[]): Promise<string> {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const userParts = messages
    .filter((m) => m.role !== "system")
    .map((m) => `${m.role.toUpperCase()}:\n${m.content}`)
    .join("\n\n");

  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  const model = env.GEMINI_MODEL || "gemini-2.5-flash-lite";

  try {
    const result = await ai.models.generateContent({
      model,
      contents: userParts,
      config: {
        systemInstruction: system || undefined,
        temperature: 0.2,
        maxOutputTokens: 2048,
      },
    });

    const text = result.text?.trim();
    if (!text) throw new AppError("Gemini returned an empty response", 502, "LLM_EMPTY");
    return text;
  } catch (error) {
    if (error instanceof AppError) throw error;
    const message = error instanceof Error ? error.message : "Gemini request failed";
    throw new AppError(`Gemini request failed: ${message.slice(0, 280)}`, 502, "LLM_ERROR");
  }
}

async function chatOpenAiCompatible(messages: ChatMessage[]): Promise<string> {
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

export async function chatCompletion(messages: ChatMessage[]): Promise<string> {
  if (!env.llmConfigured) {
    throw new AppError("LLM is not configured", 503, "LLM_NOT_CONFIGURED");
  }

  if (env.GEMINI_API_KEY) {
    return chatGemini(messages);
  }

  return chatOpenAiCompatible(messages);
}

import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  JWT_ACCESS_EXPIRES: z.string().default("12h"),
  JWT_REFRESH_EXPIRES: z.string().default("30d"),
  CORS_ORIGIN: z
    .string()
    .default("http://localhost:5173,http://localhost:5174,http://localhost:5175"),
  FRONTEND_URL: z.string().default("http://localhost:5174"),
  GITHUB_CLIENT_ID: z.string().optional().default(""),
  GITHUB_CLIENT_SECRET: z.string().optional().default(""),
  GITHUB_CALLBACK_URL: z
    .string()
    .default("http://localhost:4000/api/integrations/github/callback"),
  GITHUB_WEBHOOK_SECRET: z.string().optional().default(""),
  LLM_BASE_URL: z.string().optional().default(""),
  LLM_API_KEY: z.string().optional().default(""),
  LLM_MODEL: z.string().optional().default("llama3.2"),
  GEMINI_API_KEY: z.string().optional().default(""),
  GEMINI_MODEL: z.string().optional().default("gemini-2.5-flash-lite"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = {
  ...parsed.data,
  corsOrigins: parsed.data.CORS_ORIGIN.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  githubConfigured: Boolean(parsed.data.GITHUB_CLIENT_ID && parsed.data.GITHUB_CLIENT_SECRET),
  /** Real LLM available via Gemini key and/or OpenAI-compatible base URL */
  llmConfigured: Boolean(parsed.data.GEMINI_API_KEY || parsed.data.LLM_BASE_URL),
  llmProvider: parsed.data.GEMINI_API_KEY
    ? ("gemini" as const)
    : parsed.data.LLM_BASE_URL
      ? ("openai_compatible" as const)
      : ("none" as const),
};

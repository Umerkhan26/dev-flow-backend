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
  FRONTEND_URL: z.string().default("http://localhost:5173"),
  TRUST_PROXY: z
    .string()
    .optional()
    .default("false")
    .transform((v) => v === "1" || v?.toLowerCase() === "true"),
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
  SMTP_HOST: z.string().optional().default("smtp.gmail.com"),
  SMTP_PORT: z.coerce.number().optional().default(587),
  SMTP_USER: z.string().optional().default(""),
  SMTP_PASS: z.string().optional().default(""),
  SMTP_FROM: z.string().optional().default(""),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const data = parsed.data;

if (data.NODE_ENV === "production") {
  const weak = (secret: string) =>
    secret.length < 32 ||
    /change-me|dev-access|dev-refresh|secret-min/i.test(secret);

  if (weak(data.JWT_ACCESS_SECRET) || weak(data.JWT_REFRESH_SECRET)) {
    console.error(
      "Production requires strong JWT_ACCESS_SECRET and JWT_REFRESH_SECRET (min 32 chars, not default placeholders).",
    );
    process.exit(1);
  }

  if (data.JWT_ACCESS_SECRET === data.JWT_REFRESH_SECRET) {
    console.error("Production requires distinct JWT_ACCESS_SECRET and JWT_REFRESH_SECRET.");
    process.exit(1);
  }

  if (!data.CORS_ORIGIN.trim()) {
    console.error("Production requires CORS_ORIGIN to be set.");
    process.exit(1);
  }
}

export const env = {
  ...data,
  corsOrigins: data.CORS_ORIGIN.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  githubConfigured: Boolean(data.GITHUB_CLIENT_ID && data.GITHUB_CLIENT_SECRET),
  /** Real LLM available via Gemini key and/or OpenAI-compatible base URL */
  llmConfigured: Boolean(data.GEMINI_API_KEY || data.LLM_BASE_URL),
  llmProvider: data.GEMINI_API_KEY
    ? ("gemini" as const)
    : data.LLM_BASE_URL
      ? ("openai_compatible" as const)
      : ("none" as const),
  smtpConfigured: Boolean(data.SMTP_USER && data.SMTP_PASS),
};

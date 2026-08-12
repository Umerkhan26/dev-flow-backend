import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import { env } from "./config/env.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { aiRateLimiter, apiRateLimiter, authRateLimiter } from "./middleware/rateLimit.js";
import { aiRouter } from "./modules/ai/ai.routes.js";
import { analyticsRouter } from "./modules/analytics/analytics.routes.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { cycleRouter } from "./modules/cycles/cycle.routes.js";
import { githubRouter } from "./modules/github/github.routes.js";
import { issueRouter } from "./modules/issues/issue.routes.js";
import { notificationRouter } from "./modules/notifications/notification.routes.js";
import { projectRouter } from "./modules/projects/project.routes.js";
import { workspaceRouter } from "./modules/workspaces/workspace.routes.js";

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  if (env.TRUST_PROXY || env.NODE_ENV === "production") {
    app.set("trust proxy", 1);
  }

  app.use(
    helmet({
      contentSecurityPolicy: env.NODE_ENV === "production" ? undefined : false,
      crossOriginResourcePolicy: { policy: "cross-origin" },
    }),
  );
  app.use(
    cors({
      origin(origin, callback) {
        // Allow non-browser tools (no Origin) and configured frontends
        if (!origin || env.corsOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(null, false);
      },
      credentials: true,
    }),
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(morgan(env.NODE_ENV === "development" ? "dev" : "combined"));

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      service: "devflow-ai-api",
      env: env.NODE_ENV,
    });
  });

  app.use("/api", apiRateLimiter);
  app.use("/api/auth", authRateLimiter, authRouter);
  app.use("/api/workspaces", workspaceRouter);
  // GitHub before project/issue/cycle: those routers apply requireAuth to all /api/*
  // and would block OAuth start/callback/webhook (no Bearer header).
  app.use("/api", githubRouter);
  app.use("/api", notificationRouter);
  app.use("/api", analyticsRouter);
  app.use("/api", aiRateLimiter, aiRouter);
  app.use("/api", projectRouter);
  app.use("/api", issueRouter);
  app.use("/api", cycleRouter);

  app.use((_req, res) => {
    res.status(404).json({
      error: { code: "NOT_FOUND", message: "Route not found" },
    });
  });

  app.use(errorHandler);
  return app;
}

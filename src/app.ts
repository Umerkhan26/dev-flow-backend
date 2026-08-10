import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import { env } from "./config/env.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { issueRouter } from "./modules/issues/issue.routes.js";
import { projectRouter } from "./modules/projects/project.routes.js";
import { workspaceRouter } from "./modules/workspaces/workspace.routes.js";

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(
    cors({
      origin(origin, callback) {
        // Allow non-browser tools (no Origin) and configured Vite ports
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
    res.json({ status: "ok", service: "devflow-ai-api" });
  });

  app.use("/api/auth", authRouter);
  app.use("/api/workspaces", workspaceRouter);
  app.use("/api", projectRouter);
  app.use("/api", issueRouter);

  app.use(errorHandler);
  return app;
}

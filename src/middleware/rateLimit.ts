import rateLimit from "express-rate-limit";
import { env } from "../config/env.js";

const isProd = env.NODE_ENV === "production";

/** General API protection — generous in dev, tighter in prod. */
export const apiRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isProd ? 600 : 2000,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: "RATE_LIMITED",
      message: "Too many requests. Please try again later.",
    },
  },
});

/** Auth endpoints — brute-force protection. */
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isProd ? 30 : 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: "RATE_LIMITED",
      message: "Too many auth attempts. Please try again later.",
    },
  },
});

/** AI endpoints — cost / abuse control. */
export const aiRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isProd ? 60 : 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: "RATE_LIMITED",
      message: "AI rate limit reached. Please try again later.",
    },
  },
});

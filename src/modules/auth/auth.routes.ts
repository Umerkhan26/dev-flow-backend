import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../database/prisma.js";
import { requireAuth } from "../../middleware/auth.js";
import { ConflictError, UnauthorizedError } from "../../utils/errors.js";
import {
  hashPassword,
  hashToken,
  issueRefreshToken,
  signAccessToken,
  verifyPassword,
} from "./auth.service.js";

export const authRouter = Router();

const registerSchema = z.object({
  name: z.string().min(2).max(80),
  email: z.string().email(),
  password: z.string().min(8).max(128),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post("/register", async (req, res, next) => {
  try {
    const body = registerSchema.parse(req.body);
    const existing = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } });
    if (existing) throw new ConflictError("Email already registered");

    const user = await prisma.user.create({
      data: {
        name: body.name,
        email: body.email.toLowerCase(),
        passwordHash: await hashPassword(body.password),
      },
    });

    const accessToken = signAccessToken(user);
    const refreshToken = await issueRefreshToken(user.id);

    res.status(201).json({
      user: { id: user.id, name: user.name, email: user.email },
      accessToken,
      refreshToken,
    });
  } catch (error) {
    next(error);
  }
});

authRouter.post("/login", async (req, res, next) => {
  try {
    const body = loginSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } });
    if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
      throw new UnauthorizedError("Invalid email or password");
    }

    const accessToken = signAccessToken(user);
    const refreshToken = await issueRefreshToken(user.id);

    res.json({
      user: { id: user.id, name: user.name, email: user.email },
      accessToken,
      refreshToken,
    });
  } catch (error) {
    next(error);
  }
});

authRouter.post("/refresh", async (req, res, next) => {
  try {
    const refreshToken = z.string().min(1).parse(req.body.refreshToken);
    const tokenHash = hashToken(refreshToken);
    const stored = await prisma.refreshToken.findFirst({
      where: { tokenHash, revokedAt: null, expiresAt: { gt: new Date() } },
      include: { user: true },
    });
    if (!stored) throw new UnauthorizedError("Invalid refresh token");

    await prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });

    const accessToken = signAccessToken(stored.user);
    const nextRefresh = await issueRefreshToken(stored.user.id);

    res.json({
      user: {
        id: stored.user.id,
        name: stored.user.name,
        email: stored.user.email,
      },
      accessToken,
      refreshToken: nextRefresh,
    });
  } catch (error) {
    next(error);
  }
});

authRouter.post("/logout", requireAuth, async (req, res, next) => {
  try {
    const refreshToken = z.string().optional().parse(req.body.refreshToken);
    if (refreshToken) {
      await prisma.refreshToken.updateMany({
        where: { userId: req.user!.id, tokenHash: hashToken(refreshToken), revokedAt: null },
        data: { revokedAt: new Date() },
      });
    } else {
      await prisma.refreshToken.updateMany({
        where: { userId: req.user!.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

authRouter.get("/me", requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { id: true, name: true, email: true, createdAt: true },
    });
    res.json({ user });
  } catch (error) {
    next(error);
  }
});

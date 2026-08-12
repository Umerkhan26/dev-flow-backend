import { Router } from "express";
import { z } from "zod";
import { env } from "../../config/env.js";
import { prisma } from "../../database/prisma.js";
import { requireAuth } from "../../middleware/auth.js";
import { writeAuditLog } from "../../utils/audit.js";
import { sendPasswordResetOtpEmail } from "../../utils/mail.js";
import { ConflictError, UnauthorizedError } from "../../utils/errors.js";
import {
  findValidPasswordReset,
  hashPassword,
  hashToken,
  issuePasswordResetOtp,
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

    await writeAuditLog({
      action: "auth.register",
      actorId: user.id,
      metadata: { email: user.email },
    });

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
      await writeAuditLog({
        action: "auth.login_failed",
        metadata: { email: body.email.toLowerCase() },
      });
      throw new UnauthorizedError("Invalid email or password");
    }

    const accessToken = signAccessToken(user);
    const refreshToken = await issueRefreshToken(user.id);

    await writeAuditLog({
      action: "auth.login",
      actorId: user.id,
      metadata: { email: user.email },
    });

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
    await writeAuditLog({
      action: "auth.logout",
      actorId: req.user!.id,
    });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

authRouter.post("/forgot-password", async (req, res, next) => {
  try {
    const body = z.object({ email: z.string().email() }).parse(req.body);
    const email = body.email.toLowerCase();
    const user = await prisma.user.findUnique({ where: { email } });

    const generic = {
      ok: true,
      message: "If an account exists for that email, a 6-digit code has been sent.",
    };

    if (!user) {
      res.json(generic);
      return;
    }

    const otp = await issuePasswordResetOtp(user.id);
    const mail = await sendPasswordResetOtpEmail(email, otp);

    await writeAuditLog({
      action: "auth.password_reset_requested",
      actorId: user.id,
      metadata: { email, emailed: mail.sent },
    });

    res.json({
      ...generic,
      emailSent: mail.sent,
      // Local/dev convenience when SMTP is not configured
      ...(env.NODE_ENV !== "production" && !mail.sent ? { devCode: otp } : {}),
    });
  } catch (error) {
    next(error);
  }
});

authRouter.post("/verify-reset-otp", async (req, res, next) => {
  try {
    const body = z
      .object({
        email: z.string().email(),
        code: z.string().regex(/^\d{6}$/, "Code must be 6 digits"),
      })
      .parse(req.body);

    const email = body.email.toLowerCase();
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) throw new UnauthorizedError("Invalid or expired code");

    const stored = await findValidPasswordReset(user.id, body.code);
    if (!stored) throw new UnauthorizedError("Invalid or expired code");

    res.json({ ok: true, message: "Code verified. Set your new password." });
  } catch (error) {
    next(error);
  }
});

authRouter.post("/reset-password", async (req, res, next) => {
  try {
    const body = z
      .object({
        email: z.string().email(),
        code: z.string().regex(/^\d{6}$/, "Code must be 6 digits"),
        password: z.string().min(8).max(128),
      })
      .parse(req.body);

    const email = body.email.toLowerCase();
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) throw new UnauthorizedError("Invalid or expired code");

    const stored = await findValidPasswordReset(user.id, body.code);
    if (!stored) throw new UnauthorizedError("Invalid or expired code");

    const passwordHash = await hashPassword(body.password);

    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash },
      });
      await tx.passwordResetToken.update({
        where: { id: stored.id },
        data: { usedAt: new Date() },
      });
      await tx.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      await tx.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });

    await writeAuditLog({
      action: "auth.password_reset_completed",
      actorId: user.id,
    });

    res.json({ ok: true, message: "Password updated. You can sign in now." });
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

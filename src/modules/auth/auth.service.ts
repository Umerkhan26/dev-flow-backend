import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { env } from "../../config/env.js";
import { prisma } from "../../database/prisma.js";

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, passwordHash: string) {
  return bcrypt.compare(password, passwordHash);
}

export function signAccessToken(user: { id: string; email: string; name: string }) {
  return jwt.sign(
    { email: user.email, name: user.name },
    env.JWT_ACCESS_SECRET,
    { subject: user.id, expiresIn: env.JWT_ACCESS_EXPIRES as jwt.SignOptions["expiresIn"] },
  );
}

export function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function issueRefreshToken(userId: string) {
  const token = crypto.randomBytes(48).toString("hex");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await prisma.refreshToken.create({
    data: { userId, tokenHash, expiresAt },
  });

  return token;
}

/** Create a 6-digit OTP for password reset (raw OTP returned once). */
export async function issuePasswordResetOtp(userId: string) {
  await prisma.passwordResetToken.updateMany({
    where: { userId, usedAt: null },
    data: { usedAt: new Date() },
  });

  const otp = String(crypto.randomInt(100000, 999999));
  const tokenHash = hashToken(otp);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await prisma.passwordResetToken.create({
    data: { userId, tokenHash, expiresAt },
  });

  return otp;
}

export async function findValidPasswordReset(userId: string, otp: string) {
  const tokenHash = hashToken(otp);
  return prisma.passwordResetToken.findFirst({
    where: {
      userId,
      tokenHash,
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
  });
}

export function slugify(input: string) {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

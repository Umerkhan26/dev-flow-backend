import nodemailer from "nodemailer";
import { env } from "../config/env.js";

export async function sendPasswordResetOtpEmail(to: string, otp: string) {
  const subject = "DevFlow AI password reset code";
  const text = `Your DevFlow AI password reset code is: ${otp}\n\nThis code expires in 10 minutes. If you did not request it, ignore this email.`;
  const html = `
    <div style="font-family:system-ui,sans-serif;line-height:1.5;color:#0f1b2d">
      <h2 style="margin:0 0 12px">Password reset</h2>
      <p>Your DevFlow AI verification code is:</p>
      <p style="font-size:28px;letter-spacing:6px;font-weight:700;margin:16px 0">${otp}</p>
      <p style="color:#71839a;font-size:14px">This code expires in 10 minutes. If you did not request a reset, you can ignore this email.</p>
    </div>
  `;

  if (!env.smtpConfigured) {
    console.info(`[password-reset-otp] SMTP not configured. Code for ${to}: ${otp}`);
    return { sent: false as const, reason: "smtp_not_configured" as const };
  }

  const transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: {
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
    },
  });

  await transporter.sendMail({
    from: env.SMTP_FROM || env.SMTP_USER,
    to,
    subject,
    text,
    html,
  });

  return { sent: true as const };
}

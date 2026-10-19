import "server-only";

import nodemailer from "nodemailer";

type PasswordResetEmail = { email: string; name: string; token: string };

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function createPasswordResetUrl(token: string, appUrl = process.env.APP_URL) {
  if (!appUrl) throw new Error("APP_URL is required to send password reset emails.");
  const base = new URL(appUrl);
  if (base.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && base.protocol === "http:")) {
    throw new Error("APP_URL must use HTTPS in production.");
  }
  if (base.username || base.password) throw new Error("APP_URL must not contain credentials.");

  const resetUrl = new URL("/reset-password", base);
  resetUrl.searchParams.set("token", token);
  return resetUrl.toString();
}

export async function sendPasswordResetEmail({ email, name, token }: PasswordResetEmail) {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT);
  const from = process.env.EMAIL_FROM;
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || !from) {
    throw new Error("SMTP_HOST, SMTP_PORT, and EMAIL_FROM are required for password reset email delivery.");
  }

  const secureValue = process.env.SMTP_SECURE;
  if (secureValue && secureValue !== "true" && secureValue !== "false") {
    throw new Error("SMTP_SECURE must be true or false.");
  }

  const user = process.env.SMTP_USER;
  const password = process.env.SMTP_PASSWORD;
  if (Boolean(user) !== Boolean(password)) throw new Error("SMTP_USER and SMTP_PASSWORD must both be configured or both omitted.");

  const resetUrl = createPasswordResetUrl(token);
  const safeName = escapeHtml(name);
  const transport = nodemailer.createTransport({
    host,
    port,
    secure: secureValue ? secureValue === "true" : port === 465,
    ...(process.env.NODE_ENV === "production" ? { requireTLS: true } : {}),
    ...(user && password ? { auth: { user, pass: password } } : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 10_000,
  });

  try {
    await transport.sendMail({
      from,
      to: email,
      subject: "Reset your EML – Attendance Management System password",
      text: `Hello ${name},\n\nUse this link to reset your password. It expires in 30 minutes and can only be used once:\n${resetUrl}\n\nIf you did not request a password reset, you can ignore this email.`,
      html: `<p>Hello ${safeName},</p><p>Use the link below to reset your password. It expires in 30 minutes and can only be used once.</p><p><a href="${resetUrl}">Reset password</a></p><p>If you did not request a password reset, you can ignore this email.</p>`,
    });
  } finally {
    transport.close();
  }
}
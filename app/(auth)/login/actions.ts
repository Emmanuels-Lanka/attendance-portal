"use server";

import { z } from "zod";
import { authenticateLogin, loginIdentifierSchema } from "@/lib/auth/login";
import { createSession } from "@/lib/auth/session";
import { passwordWithinBcryptLimit } from "@/lib/auth/password";
import { redirect } from "next/navigation";

export type LoginState = { error: string } | null;

const loginSchema = z.object({
  identifier: loginIdentifierSchema,
  password: z.string().min(1).refine(passwordWithinBcryptLimit),
});

export async function loginAction(_previousState: LoginState, formData: FormData): Promise<LoginState> {
  const result = loginSchema.safeParse({
    identifier: formData.get("identifier"),
    password: formData.get("password"),
  });

  if (!result.success) {
    const passwordTooLong = result.error.issues.some((issue) => issue.code === "custom" && issue.path[0] === "password");
    return { error: passwordTooLong ? "Password must not exceed 72 UTF-8 bytes." : "Enter a valid username or email and password." };
  }

  try {
    const authenticated = await authenticateLogin(result.data.identifier, result.data.password, createSession);
    if (!authenticated) return { error: "Username/email or password is incorrect." };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("SESSION_SECRET")) {
      return { error: "Authentication is not configured. Contact your administrator." };
    }
    console.error("Login failed", error instanceof Error ? error.name : "Unknown error");
    return { error: "Sign in is temporarily unavailable. Try again shortly." };
  }

  redirect("/dashboard");
}
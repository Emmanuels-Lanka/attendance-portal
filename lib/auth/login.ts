import "server-only";

import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { accountIsActive } from "@/lib/auth/account-status";
import { passwordWithinBcryptLimit, verifyPassword } from "@/lib/auth/password";
import { prisma } from "@/lib/prisma";

const usernamePattern = /^[a-z0-9._-]{3,30}$/;

export const loginIdentifierSchema = z.string().trim().max(254).transform((identifier) => identifier.toLowerCase()).superRefine((identifier, context) => {
  const isValid = identifier.includes("@")
    ? z.string().email().max(254).safeParse(identifier).success
    : usernamePattern.test(identifier);

  if (!isValid) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Enter a valid username or email." });
  }
});

type LoginDatabase = Pick<PrismaClient, "user">;
type SessionCreator = (userId: string) => Promise<void>;

export async function authenticateLogin(
  identifier: string,
  password: string,
  createUserSession: SessionCreator,
  database: LoginDatabase = prisma,
) {
  if (!password || !passwordWithinBcryptLimit(password)) return false;
  const normalizedIdentifier = identifier.trim().toLowerCase();

  const matches = await database.user.findMany({
    where: { OR: [{ email: normalizedIdentifier }, { username: normalizedIdentifier }] },
    select: { id: true, passwordHash: true, isActive: true },
  });
  if (matches.length !== 1) return false;

  const user = matches[0];
  if (!accountIsActive(user) || !(await verifyPassword(password, user.passwordHash))) return false;

  await createUserSession(user.id);
  return true;
}

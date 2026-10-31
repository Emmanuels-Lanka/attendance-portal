import "server-only";

import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { accountIsActive } from "@/lib/auth/account-status";
import { measureServerOperation } from "@/lib/diagnostics/server-timing";

type SessionUserDatabase = Pick<PrismaClient, "user">;

export async function findActiveSessionUser(
  userId: string,
  database: SessionUserDatabase = prisma,
  expectedSessionVersion?: number,
  route = "unknown",
) {
  const user = await measureServerOperation(route, "auth.user_lookup", () => database.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      username: true,
      role: true,
      isActive: true,
      sessionVersion: true,
      employeeCode: true,
      countryCode: true,
      timeZone: true,
    },
  }));
  if (!accountIsActive(user) || (expectedSessionVersion !== undefined && user.sessionVersion !== expectedSessionVersion)) return null;

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    username: user.username,
    role: user.role,
    isActive: user.isActive,
    employeeCode: user.employeeCode,
    countryCode: user.countryCode,
    timeZone: user.timeZone,
  };
}
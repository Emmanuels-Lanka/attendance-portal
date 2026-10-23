import type { Prisma } from "@prisma/client";

export async function lockAttendanceUser(transaction: Prisma.TransactionClient, userId: string) {
  await transaction.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
}

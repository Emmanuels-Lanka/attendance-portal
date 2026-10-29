import type { Prisma, PrismaClient } from "@prisma/client";

const employeeTransactionOptions = { timeout: 15_000 };

export function runEmployeeTransaction<T>(
  database: Pick<PrismaClient, "$transaction">,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
) {
  return database.$transaction(operation, employeeTransactionOptions);
}

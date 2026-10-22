import type { Prisma, PrismaClient } from "@prisma/client";

type ManagerScopeReader = Pick<PrismaClient, "employee">;
type ManagerScopeTransaction = Pick<Prisma.TransactionClient, "employee" | "$queryRaw">;

export async function getActiveManagerDepartmentId(database: ManagerScopeReader, userId: string) {
  const manager = await database.employee.findUnique({
    where: { userId },
    select: {
      departmentId: true,
      user: { select: { role: true, isActive: true } },
    },
  });
  if (
    !manager
    || !manager.departmentId
    || manager.user?.role !== "DEPARTMENT_MANAGER"
    || !manager.user.isActive
  ) return null;
  return manager.departmentId;
}

export async function lockActiveManagerDepartmentId(transaction: ManagerScopeTransaction, userId: string) {
  const manager = await transaction.employee.findUnique({
    where: { userId },
    select: {
      id: true,
      departmentId: true,
      user: { select: { role: true, isActive: true } },
    },
  });
  if (
    !manager
    || !manager.departmentId
    || manager.user?.role !== "DEPARTMENT_MANAGER"
    || !manager.user.isActive
  ) return null;

  await transaction.$queryRaw`SELECT "id" FROM "Employee" WHERE "id" = ${manager.id} FOR SHARE`;
  const current = await transaction.employee.findUnique({
    where: { userId },
    select: {
      departmentId: true,
      user: { select: { role: true, isActive: true } },
    },
  });
  if (
    !current
    || !current.departmentId
    || current.user?.role !== "DEPARTMENT_MANAGER"
    || !current.user.isActive
  ) return null;
  return current.departmentId;
}

export async function lockEmployeeForApproval(transaction: ManagerScopeTransaction, employeeId: string) {
  await transaction.$queryRaw`SELECT "id" FROM "Employee" WHERE "id" = ${employeeId} FOR SHARE`;
}

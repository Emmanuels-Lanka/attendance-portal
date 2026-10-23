import type { Prisma, PrismaClient } from "@prisma/client";

type ManagerScopeReader = Pick<PrismaClient, "employee">;
type ManagerScopeTransaction = Pick<Prisma.TransactionClient, "employee" | "$queryRaw">;

export type ActiveManagerDepartmentScope = {
  departmentId: string;
  isHrDepartment: boolean;
};

function isHrDepartment(name: string | null | undefined) {
  const normalizedName = name?.trim().toLowerCase().replace(/\s+/g, " ");
  return normalizedName === "hr"
    || normalizedName === "hr department"
    || normalizedName === "human resources"
    || normalizedName === "human resource"
    || normalizedName === "human resources department"
    || normalizedName === "human resource department";
}

export async function getActiveManagerDepartmentScope(
  database: ManagerScopeReader,
  userId: string,
): Promise<ActiveManagerDepartmentScope | null> {
  const manager = await database.employee.findUnique({
    where: { userId },
    select: {
      departmentId: true,
      department: { select: { name: true } },
      user: { select: { role: true, isActive: true } },
    },
  });
  if (
    !manager
    || !manager.departmentId
    || manager.user?.role !== "DEPARTMENT_MANAGER"
    || !manager.user.isActive
  ) return null;
  return { departmentId: manager.departmentId, isHrDepartment: isHrDepartment(manager.department?.name) };
}

export async function lockActiveManagerDepartmentScope(
  transaction: ManagerScopeTransaction,
  userId: string,
): Promise<ActiveManagerDepartmentScope | null> {
  const manager = await transaction.employee.findUnique({
    where: { userId },
    select: {
      id: true,
      userId: true,
      departmentId: true,
      department: { select: { name: true } },
      user: { select: { role: true, isActive: true } },
    },
  });
  if (
    !manager
    || !manager.departmentId
    || manager.user?.role !== "DEPARTMENT_MANAGER"
    || !manager.user.isActive
  ) return null;

  await transaction.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${manager.userId} FOR SHARE`;
  await transaction.$queryRaw`SELECT "id" FROM "Employee" WHERE "id" = ${manager.id} FOR SHARE`;
  const current = await transaction.employee.findUnique({
    where: { userId },
    select: {
      departmentId: true,
      department: { select: { name: true } },
      user: { select: { role: true, isActive: true } },
    },
  });
  if (
    !current
    || !current.departmentId
    || current.user?.role !== "DEPARTMENT_MANAGER"
    || !current.user.isActive
  ) return null;
  await transaction.$queryRaw`SELECT "id" FROM "Department" WHERE "id" = ${current.departmentId} FOR SHARE`;
  const lockedCurrent = await transaction.employee.findUnique({
    where: { userId },
    select: {
      departmentId: true,
      department: { select: { name: true } },
      user: { select: { role: true, isActive: true } },
    },
  });
  if (
    !lockedCurrent
    || !lockedCurrent.departmentId
    || lockedCurrent.user?.role !== "DEPARTMENT_MANAGER"
    || !lockedCurrent.user.isActive
  ) return null;
  return { departmentId: lockedCurrent.departmentId, isHrDepartment: isHrDepartment(lockedCurrent.department?.name) };
}

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

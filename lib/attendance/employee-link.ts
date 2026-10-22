import "server-only";

import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { EffectiveShiftAssignment } from "./shift-assignment";

export type AttendanceEmployeeIdentity = {
  id: string;
  name: string;
  employeeId: string | null;
  shiftAssignments: EffectiveShiftAssignment[];
};

type EmployeeLookupDatabase = Pick<PrismaClient, "employee">;

export async function resolveAttendanceEmployees(
  userIds: string[],
  database: EmployeeLookupDatabase = prisma,
) {
  const employeesByUserId = new Map<string, AttendanceEmployeeIdentity>();
  const uniqueUserIds = [...new Set(userIds)];
  if (uniqueUserIds.length === 0) return employeesByUserId;

  const employees = await database.employee.findMany({
    where: { userId: { in: uniqueUserIds } },
    select: {
      id: true,
      name: true,
      employeeId: true,
      userId: true,
      shift: { select: { id: true, startTime: true, endTime: true, gracePeriodMinutes: true, workingDays: true } },
      shiftAssignments: {
        select: {
          effectiveFrom: true,
          effectiveTo: true,
          shift: { select: { id: true, startTime: true, endTime: true, gracePeriodMinutes: true, workingDays: true } },
        },
      },
    },
  });

  for (const employee of employees) {
    if (employee.userId !== null) {
      employeesByUserId.set(employee.userId, {
        id: employee.id,
        name: employee.name,
        employeeId: employee.employeeId,
        shiftAssignments: employee.shiftAssignments?.length
          ? employee.shiftAssignments
          : employee.shift
            ? [{
                effectiveFrom: new Date("0001-01-01T00:00:00.000Z"),
                effectiveTo: null,
                shift: employee.shift,
              }]
            : [],
      });
    }
  }

  return employeesByUserId;
}

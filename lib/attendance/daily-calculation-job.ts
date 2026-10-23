import "server-only";

import { Role, type PrismaClient } from "@prisma/client";
import { formatInTimeZone } from "date-fns-tz";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  AttendanceDailyCorrectionProtectedError,
  AttendanceEngineEmployeeError,
  calculateAndPersistDailyAttendanceInTransaction,
} from "./engine-service";
import { AttendanceEngineConfigurationError } from "./engine";
import { lockAttendanceUser } from "./locks";

const maximumEmployeesPerRun = 100;
const transactionTimeoutMs = 45_000;
const transactionMaxWaitMs = 5_000;
const advisoryLockNamespace = 1_096_049_742;

function isCalendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export const dailyCalculationRequestSchema = z.object({
  date: z.string().refine(isCalendarDate, "Date must be a valid YYYY-MM-DD calendar date.").optional(),
}).strict();

export type DailyCalculationRequest = z.infer<typeof dailyCalculationRequestSchema>;
type DailyCalculationDatabase = Pick<PrismaClient, "$transaction">;

export class DailyCalculationRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DailyCalculationRequestError";
  }
}

export class DailyCalculationCapacityError extends Error {
  constructor() {
    super("The employee count exceeds the configured daily calculation batch limit.");
    this.name = "DailyCalculationCapacityError";
  }
}

function shiftCalendarDate(date: string, days: number) {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function failureCategory(error: unknown) {
  if (error instanceof AttendanceEngineConfigurationError || error instanceof AttendanceEngineEmployeeError) {
    return error.name;
  }
  if (error instanceof RangeError) return "InvalidEmployeeTimeZone";
  return null;
}

export async function runDailyAttendanceCalculation(
  input: unknown,
  now: Date = new Date(),
  database: DailyCalculationDatabase = prisma,
) {
  const parsedInput = dailyCalculationRequestSchema.safeParse(input);
  if (!parsedInput.success) {
    throw new DailyCalculationRequestError(parsedInput.error.issues[0]?.message ?? "Invalid calculation request.");
  }
  if (!Number.isFinite(now.getTime())) {
    throw new DailyCalculationRequestError("A valid run timestamp is required.");
  }

  return database.$transaction(async (transaction) => {
    const lock = await transaction.$queryRaw<Array<{ locked: boolean }>>`
      SELECT pg_try_advisory_xact_lock(${advisoryLockNamespace}, 1) AS locked
    `;
    if (!lock[0]?.locked) {
      return {
        lockAcquired: false,
        scanned: 0,
        calculated: 0,
        skippedApprovedCorrections: 0,
        unlinkedEmployees: 0,
        skippedIneligible: 0,
        failed: 0,
        failureCategories: {},
      };
    }

    const employees = await transaction.employee.findMany({
      where: {
        user: {
          is: {
            isActive: true,
            role: { in: [Role.EMPLOYEE, Role.HR_ADMINISTRATOR] },
          },
        },
      },
      orderBy: { id: "asc" },
      take: maximumEmployeesPerRun + 1,
      select: { id: true, user: { select: { id: true, timeZone: true } } },
    });
    if (employees.length > maximumEmployeesPerRun) throw new DailyCalculationCapacityError();
    let unlinkedEmployees = await transaction.employee.count({ where: { userId: null } });

    const plans = employees.map((employee) => {
      if (!employee.user) {
        return { employeeId: employee.id, userId: null, date: null, initialFailure: "AttendanceEngineEmployeeError" };
      }
      try {
        const localToday = formatInTimeZone(now, employee.user.timeZone, "yyyy-MM-dd");
        const yesterday = shiftCalendarDate(localToday, -1);
        const date = parsedInput.data.date ?? yesterday;
        const oldestAllowedDate = shiftCalendarDate(yesterday, -6);
        if (date > yesterday || date < oldestAllowedDate) {
          throw new DailyCalculationRequestError(
            "The requested date must be within the previous seven completed employee-local days.",
          );
        }
        return { employeeId: employee.id, userId: employee.user.id, date, initialFailure: null };
      } catch (error) {
        if (error instanceof DailyCalculationRequestError) throw error;
        return { employeeId: employee.id, userId: employee.user.id, date: null, initialFailure: "InvalidEmployeeTimeZone" };
      }
    });

    let calculated = 0;
    let skippedApprovedCorrections = 0;
    let skippedIneligible = 0;
    let failed = 0;
    const failureCategories: Record<string, number> = {};
    const countFailure = (category: string) => {
      failed += 1;
      failureCategories[category] = (failureCategories[category] ?? 0) + 1;
    };

    for (const plan of plans) {
      if (plan.initialFailure) {
        countFailure(plan.initialFailure);
        continue;
      }
      try {
        if (!plan.userId) {
          countFailure("AttendanceEngineEmployeeError");
          continue;
        }
        await lockAttendanceUser(transaction, plan.userId);
        const currentUser = await transaction.user.findUnique({
          where: { id: plan.userId },
          select: { isActive: true, role: true },
        });
        await transaction.$queryRaw`SELECT "id" FROM "Employee" WHERE "id" = ${plan.employeeId} FOR UPDATE`;
        const currentEmployee = await transaction.employee.findUnique({
          where: { id: plan.employeeId },
          select: { userId: true },
        });
        if (!currentEmployee?.userId) {
          unlinkedEmployees += 1;
          continue;
        }
        if (
          currentEmployee.userId !== plan.userId
          || !currentUser?.isActive
          || (currentUser.role !== Role.EMPLOYEE && currentUser.role !== Role.HR_ADMINISTRATOR)
        ) {
          skippedIneligible += 1;
          continue;
        }
        await calculateAndPersistDailyAttendanceInTransaction(
          plan.employeeId,
          plan.date!,
          transaction,
        );
        calculated += 1;
      } catch (error) {
        if (error instanceof AttendanceDailyCorrectionProtectedError) {
          skippedApprovedCorrections += 1;
          continue;
        }
        const category = failureCategory(error);
        if (!category) throw error;
        countFailure(category);
      }
    }

    return {
      lockAcquired: true,
      scanned: employees.length,
      calculated,
      skippedApprovedCorrections,
      unlinkedEmployees,
      skippedIneligible,
      failed,
      failureCategories,
    };
  }, {
    maxWait: transactionMaxWaitMs,
    timeout: transactionTimeoutMs,
  });
}

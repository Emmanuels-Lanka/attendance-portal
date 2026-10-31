import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { Role, WorkFromHomeRequestStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  submitOwnWorkFromHomeRequest,
  WorkFromHomeRequestConflictError,
} from "./service";

const enabled = process.env.WFH_POSTGRES_INTEGRATION === "1";
const requestInput = {
  date: "2026-10-08",
  startTime: "09:00",
  endTime: "17:30",
  reason: "Integration concurrency test",
  workLocation: "Colombo",
};

it("serializes genuinely concurrent overlapping requests in PostgreSQL", { skip: !enabled }, async () => {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "WFH_POSTGRES_INTEGRATION requires a disposable DATABASE_URL");
  const parsedUrl = new URL(databaseUrl);
  assert.match(parsedUrl.pathname.slice(1), /^attendance_wfh_[a-f0-9]+$/, "integration test requires a disposable WFH database");
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(parsedUrl.hostname), "integration test only permits a loopback database host");

  const unique = randomUUID();
  const userIds: string[] = [];
  const employeeIds: string[] = [];
  let employeeUserId: string | undefined;

  async function createUser(label: string, role: Role) {
    const user = await prisma.user.create({
      data: {
        name: label,
        email: `${label.toLowerCase().replaceAll(" ", "-")}-${unique}@example.invalid`,
        countryCode: "LK",
        timeZone: "Asia/Colombo",
        passwordHash: "integration-test-only",
        role,
      },
      select: { id: true },
    });
    userIds.push(user.id);
    return user;
  }

  try {
    const supervisor = await createUser("WFH test supervisor", Role.SUPERVISOR);
    const manager = await createUser("WFH test manager", Role.DEPARTMENT_MANAGER);
    const employeeUser = await createUser("WFH test employee", Role.EMPLOYEE);
    employeeUserId = employeeUser.id;
    const supervisorEmployee = await prisma.employee.create({
      data: { name: "WFH test supervisor", userId: supervisor.id, employeeId: `WFH-S-${unique}` },
      select: { id: true },
    });
    employeeIds.push(supervisorEmployee.id);
    const managerEmployee = await prisma.employee.create({
      data: { name: "WFH test manager", userId: manager.id, employeeId: `WFH-M-${unique}` },
      select: { id: true },
    });
    employeeIds.push(managerEmployee.id);
    const employee = await prisma.employee.create({
      data: {
        name: "WFH test employee",
        userId: employeeUser.id,
        employeeId: `WFH-E-${unique}`,
        supervisorId: supervisorEmployee.id,
        managerId: managerEmployee.id,
      },
      select: { id: true },
    });
    employeeIds.push(employee.id);

    const results = await Promise.allSettled([
      submitOwnWorkFromHomeRequest({ id: employeeUser.id, role: Role.EMPLOYEE, timeZone: "Asia/Colombo" }, requestInput),
      submitOwnWorkFromHomeRequest({ id: employeeUser.id, role: Role.EMPLOYEE, timeZone: "Asia/Colombo" }, requestInput),
    ]);

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    assert.ok(rejected?.reason instanceof WorkFromHomeRequestConflictError);
    assert.equal(await prisma.workFromHomeRequest.count({
      where: {
        employeeId: employee.id,
        status: { in: [WorkFromHomeRequestStatus.PENDING, WorkFromHomeRequestStatus.APPROVED] },
      },
    }), 1);
  } finally {
    if (employeeUserId) {
      await prisma.workFromHomeRequest.deleteMany({
        where: { employee: { userId: employeeUserId } },
      });
    }
    if (userIds.length > 0) {
      await prisma.attendanceAuditLog.deleteMany({
        where: { OR: [{ employeeId: { in: userIds } }, { actorId: { in: userIds } }] },
      });
      await prisma.employee.updateMany({
        where: { id: { in: employeeIds } },
        data: { supervisorId: null, managerId: null },
      });
      await prisma.employee.deleteMany({ where: { id: { in: employeeIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await prisma.$disconnect();
  }
});

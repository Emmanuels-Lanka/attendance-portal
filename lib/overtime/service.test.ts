import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OvertimeApprovalStage, OvertimeRequestStatus, Role, type Prisma } from "@prisma/client";
import { ZodError } from "zod";
import { hasPermission } from "@/lib/auth/permissions";
import {
  decideOvertimeRequest,
  listOvertimeRequestsForReview,
  listOwnOvertimeRequests,
  OvertimeApprovalScopeError,
  OvertimeApprovalStageError,
  OvertimeApproverNotFoundError,
  OvertimeRequestAccessError,
  OvertimeRequestNotFoundError,
  OvertimeRequestTimeError,
  submitOwnOvertimeRequest,
} from "./service";
import { overtimeDecisionSchema, overtimeRequestInputSchema } from "./validation";

const employeeActor = { id: "employee-user-1", role: Role.EMPLOYEE, timeZone: "Asia/Colombo" };
const supervisorActor = { id: "supervisor-user-1", role: Role.SUPERVISOR, timeZone: "Asia/Colombo" };
const managerActor = { id: "manager-user-1", role: Role.DEPARTMENT_MANAGER, timeZone: "Asia/Colombo" };
const validInput = {
  date: "2026-10-08",
  startTime: "18:00",
  endTime: "20:00",
  reason: "Complete the scheduled release work",
  project: "Portal release",
  expectedHours: "2",
};

type TestOvertimeRequest = {
  id: string;
  employeeId: string;
  date: Date;
  startAt: Date;
  endAt: Date;
  reason: string;
  project: string;
  expectedHours: Prisma.Decimal;
  status: OvertimeRequestStatus;
  currentApprovalStage: OvertimeApprovalStage | null;
  currentApproverId: string | null;
  decisionReason: string | null;
  reviewedById: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
  [key: string]: unknown;
};

function createDatabase(options: {
  supervisor?: "assigned" | "inactive" | "missing";
  manager?: "assigned" | "inactive" | "missing";
  employeeDepartmentId?: string | null;
  managerDepartmentId?: string | null;
} = {}) {
  const supervisorState = options.supervisor ?? "assigned";
  const managerState = options.manager ?? "assigned";
  const employee = {
    id: "employee-record-1",
    userId: employeeActor.id,
    departmentId: options.employeeDepartmentId === undefined ? "department-1" : options.employeeDepartmentId,
    name: "Employee One",
    employeeId: "E-001",
    supervisor: supervisorState === "missing" ? null : {
      userId: supervisorActor.id,
      user: { role: Role.SUPERVISOR, isActive: supervisorState === "assigned" },
    },
    manager: managerState === "missing" ? null : {
      userId: managerActor.id,
      user: { role: Role.DEPARTMENT_MANAGER, isActive: managerState === "assigned" },
    },
    user: { timeZone: employeeActor.timeZone },
  };
  const requests: TestOvertimeRequest[] = [];
  const audits: Record<string, unknown>[] = [];
  const notifications: Record<string, unknown>[] = [];
  const queries: { employees: unknown[]; list: Record<string, unknown>[] } = { employees: [], list: [] };
  let nextId = 1;

  const transaction = {
    employee: {
      findUnique: async ({ where }: { where: { userId: string } }) => {
        queries.employees.push(where);
        if (where.userId === managerActor.id) return {
          id: "manager-record-1",
          departmentId: options.managerDepartmentId === undefined ? "department-1" : options.managerDepartmentId,
          user: { role: Role.DEPARTMENT_MANAGER, isActive: true },
        };
        return where.userId === employeeActor.id ? employee : null;
      },
    },
    $queryRaw: async () => [],
    overtimeRequest: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const request: TestOvertimeRequest = {
          id: `overtime-${nextId++}`,
          ...data,
          employeeId: data.employeeId as string,
          date: data.date as Date,
          startAt: data.startAt as Date,
          endAt: data.endAt as Date,
          reason: data.reason as string,
          project: data.project as string,
          expectedHours: data.expectedHours as Prisma.Decimal,
          status: data.status as OvertimeRequestStatus,
          currentApprovalStage: data.currentApprovalStage as OvertimeApprovalStage,
          currentApproverId: data.currentApproverId as string,
          createdAt: new Date("2026-10-08T08:00:00.000Z"),
          reviewedAt: null,
          decisionReason: null,
          reviewedById: null,
        };
        requests.push(request);
        return { ...request };
      },
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        queries.list.push(where);
        return requests.filter((request) => {
          if (where.employeeId) return request.employeeId === where.employeeId;
          const managerScope = where.employee as { departmentId?: string } | undefined;
          return request.status === where.status
            && request.currentApprovalStage === where.currentApprovalStage
            && request.currentApproverId === where.currentApproverId
            && (managerScope?.departmentId === undefined || managerScope.departmentId === employee.departmentId);
        }).map((request) => ({
          ...request,
          employee: { ...employee },
        }));
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        const request = requests.find((item) => item.id === where.id);
        return request ? { ...request, employee: { ...employee } } : null;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const request = requests.find((item) =>
          item.id === where.id
          && item.status === where.status
          && item.currentApprovalStage === where.currentApprovalStage
          && item.currentApproverId === where.currentApproverId
          && ((where.employee as { departmentId?: string } | undefined)?.departmentId === undefined
            || (where.employee as { departmentId?: string }).departmentId === employee.departmentId),
        );
        if (!request) return { count: 0 };
        Object.assign(request, data);
        return { count: 1 };
      },
    },
    attendanceAuditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        audits.push(structuredClone(data));
        return { id: `audit-${audits.length}` };
      },
    },
    notification: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        notifications.push(structuredClone(data));
        return { id: `notification-${notifications.length}` };
      },
    },
  };
  const database = {
    $transaction: async <T>(callback: (tx: typeof transaction) => Promise<T>) => callback(transaction),
    employee: transaction.employee,
    overtimeRequest: transaction.overtimeRequest,
  } as never;

  return { database, employee, requests, audits, notifications, queries };
}

describe("overtime request validation", () => {
  it("requires all SRS request fields and positive expected hours", () => {
    assert.equal(overtimeRequestInputSchema.safeParse(validInput).success, true);
    for (const field of ["date", "startTime", "endTime", "reason", "project", "expectedHours"] as const) {
      const incomplete = { ...validInput, [field]: "" };
      assert.equal(overtimeRequestInputSchema.safeParse(incomplete).success, false, `${field} is required`);
    }
    assert.equal(overtimeRequestInputSchema.safeParse({ ...validInput, expectedHours: "0" }).success, false);
    assert.equal(overtimeRequestInputSchema.safeParse({ ...validInput, expectedHours: "1.234" }).success, false);
    assert.equal(overtimeRequestInputSchema.safeParse({ ...validInput, date: "2026-02-30" }).success, false);
    assert.equal(overtimeRequestInputSchema.safeParse({ ...validInput, startTime: "25:30" }).success, false);
    assert.equal(overtimeDecisionSchema.safeParse({ action: "CANCEL" }).success, false);
  });

  it("rejects client-supplied employee identifiers", () => {
    assert.equal(overtimeRequestInputSchema.safeParse({ ...validInput, employeeId: "other-employee" }).success, false);
  });

  it("has employee submission and only the SRS approver roles can approve", () => {
    assert.equal(hasPermission(Role.EMPLOYEE, "overtime:submit"), true);
    assert.equal(hasPermission(Role.EMPLOYEE, "overtime:approve"), false);
    assert.equal(hasPermission(Role.SUPERVISOR, "overtime:approve"), true);
    assert.equal(hasPermission(Role.DEPARTMENT_MANAGER, "overtime:approve"), true);
    assert.equal(hasPermission(Role.HR_ADMINISTRATOR, "overtime:approve"), false);
  });
});

describe("employee overtime request submission and history", () => {
  it("submits as the authenticated employee and assigns the first review to their Supervisor", async () => {
    const stub = createDatabase();
    const request = await submitOwnOvertimeRequest(employeeActor, validInput, stub.database);

    assert.equal(stub.requests[0]?.employeeId, stub.employee.id);
    assert.equal(request.date.toISOString(), "2026-10-08T00:00:00.000Z");
    assert.equal(request.startAt.toISOString(), "2026-10-08T12:30:00.000Z");
    assert.equal(request.endAt.toISOString(), "2026-10-08T14:30:00.000Z");
    assert.equal(request.expectedHours.toString(), "2");
    assert.equal(request.status, OvertimeRequestStatus.PENDING);
    assert.equal(request.currentApprovalStage, OvertimeApprovalStage.SUPERVISOR);
    assert.equal(stub.requests[0]?.currentApproverId, supervisorActor.id);
    assert.deepEqual(stub.queries.employees[0], { userId: employeeActor.id });
    assert.equal(stub.audits[0]?.employeeId, employeeActor.id);
    assert.equal(stub.notifications[0]?.userId, supervisorActor.id);
    assert.deepEqual(stub.audits[0]?.newValues, {
      overtimeRequestId: request.id,
      date: "2026-10-08",
      startAt: "2026-10-08T12:30:00.000Z",
      endAt: "2026-10-08T14:30:00.000Z",
      project: validInput.project,
      expectedHours: "2",
      status: "PENDING",
      currentApprovalStage: "SUPERVISOR",
    });
  });

  it("rejects unauthenticated and unauthorized actors before writing", async () => {
    const stub = createDatabase();
    await assert.rejects(submitOwnOvertimeRequest(null, validInput, stub.database), OvertimeRequestAccessError);
    await assert.rejects(
      submitOwnOvertimeRequest(supervisorActor, validInput, stub.database),
      OvertimeRequestAccessError,
    );
    await assert.rejects(
      submitOwnOvertimeRequest({ id: "manager-user", role: Role.DEPARTMENT_MANAGER, timeZone: "UTC" }, validInput, stub.database),
      OvertimeRequestAccessError,
    );
    assert.equal(stub.requests.length, 0);
  });

  it("rejects forged employee identity and never writes a request for another employee", async () => {
    const stub = createDatabase();
    await assert.rejects(
      submitOwnOvertimeRequest(employeeActor, { ...validInput, employeeId: "employee-record-2" }, stub.database),
      ZodError,
    );
    assert.equal(stub.requests.length, 0);
  });

  it("rejects invalid local time intervals and daylight-saving gaps", async () => {
    const stub = createDatabase();
    await assert.rejects(
      submitOwnOvertimeRequest(employeeActor, { ...validInput, startTime: "20:00", endTime: "19:00" }, stub.database),
      OvertimeRequestTimeError,
    );
    await assert.rejects(
      submitOwnOvertimeRequest(
        { ...employeeActor, timeZone: "America/New_York" },
        { ...validInput, date: "2026-03-08", startTime: "02:30", endTime: "03:30" },
        stub.database,
      ),
      OvertimeRequestTimeError,
    );
    assert.equal(stub.requests.length, 0);
  });

  it("fails closed when the assigned Supervisor or Manager is unavailable", async () => {
    for (const options of [{ supervisor: "missing" as const }, { supervisor: "inactive" as const }, { manager: "missing" as const }, { manager: "inactive" as const }]) {
      const stub = createDatabase(options);
      await assert.rejects(
        submitOwnOvertimeRequest(employeeActor, validInput, stub.database),
        OvertimeApproverNotFoundError,
      );
      assert.equal(stub.requests.length, 0);
    }
  });

  it("allows repeated requests because the SRS defines no duplicate or conflict policy", async () => {
    const stub = createDatabase();
    await submitOwnOvertimeRequest(employeeActor, validInput, stub.database);
    await submitOwnOvertimeRequest(employeeActor, validInput, stub.database);
    assert.equal(stub.requests.length, 2);
  });

  it("lists only the authenticated employee's own requests", async () => {
    const stub = createDatabase();
    const own = await submitOwnOvertimeRequest(employeeActor, validInput, stub.database);
    stub.requests.push({
      ...stub.requests[0]!,
      id: "overtime-owned-by-someone-else",
      employeeId: "employee-record-2",
    });
    const requests = await listOwnOvertimeRequests(employeeActor, stub.database);
    assert.deepEqual(requests.map(({ id }) => id), [own.id]);
    assert.deepEqual(stub.queries.employees.at(-1), { userId: employeeActor.id });
    assert.equal(stub.queries.list.at(-1)?.employeeId, stub.employee.id);
    await assert.rejects(listOwnOvertimeRequests(null, stub.database), OvertimeRequestAccessError);
  });
});

describe("overtime approval workflow", () => {
  async function submitted() {
    const stub = createDatabase();
    const request = await submitOwnOvertimeRequest(employeeActor, validInput, stub.database);
    return { stub, request };
  }

  it("lists the request only for the assigned Supervisor and then the assigned Manager", async () => {
    const { stub, request } = await submitted();
    const supervisorRequests = await listOvertimeRequestsForReview(supervisorActor, stub.database);
    assert.deepEqual(supervisorRequests.map(({ id }) => id), [request.id]);
    assert.equal(stub.queries.list.at(-1)?.currentApproverId, supervisorActor.id);

    const unrelated = { id: "other-supervisor", role: Role.SUPERVISOR, timeZone: "UTC" };
    const otherRequests = await listOvertimeRequestsForReview(unrelated, stub.database);
    assert.deepEqual(otherRequests, []);

    const advanced = await decideOvertimeRequest(supervisorActor, request.id, { action: "APPROVE" }, stub.database);
    assert.equal(advanced.status, OvertimeRequestStatus.PENDING);
    assert.equal(advanced.currentApprovalStage, OvertimeApprovalStage.MANAGER);
    assert.equal(stub.requests[0]?.currentApproverId, managerActor.id);
    assert.equal(stub.notifications.at(-1)?.userId, managerActor.id);
    const managerRequests = await listOvertimeRequestsForReview(managerActor, stub.database);
    assert.deepEqual(managerRequests.map(({ id }) => id), [request.id]);
  });

  it("does not expose or allow Manager approval outside the Manager's department", async () => {
    const stub = createDatabase({ employeeDepartmentId: "department-1", managerDepartmentId: "department-2" });
    const request = await submitOwnOvertimeRequest(employeeActor, validInput, stub.database);
    await decideOvertimeRequest(supervisorActor, request.id, { action: "APPROVE" }, stub.database);

    assert.deepEqual(await listOvertimeRequestsForReview(managerActor, stub.database), []);
    await assert.rejects(
      decideOvertimeRequest(managerActor, request.id, { action: "APPROVE" }, stub.database),
      OvertimeApprovalScopeError,
    );
    assert.equal(stub.requests[0]?.status, OvertimeRequestStatus.PENDING);
    assert.equal(stub.audits.length, 2);
  });

  it("rejects unauthorized roles, unassigned reviewers, and self-approval", async () => {
    const { stub, request } = await submitted();
    await assert.rejects(
      listOvertimeRequestsForReview(employeeActor, stub.database),
      OvertimeRequestAccessError,
    );
    await assert.rejects(
      decideOvertimeRequest({ id: "hr-user", role: Role.HR_ADMINISTRATOR, timeZone: "UTC" }, request.id, { action: "APPROVE" }, stub.database),
      OvertimeRequestAccessError,
    );
    await assert.rejects(
      decideOvertimeRequest({ ...supervisorActor, id: employeeActor.id }, request.id, { action: "APPROVE" }, stub.database),
      OvertimeApprovalScopeError,
    );
    await assert.rejects(
      decideOvertimeRequest({ ...supervisorActor, id: "other-supervisor" }, request.id, { action: "APPROVE" }, stub.database),
      OvertimeApprovalStageError,
    );
    assert.equal(stub.requests[0]?.status, OvertimeRequestStatus.PENDING);
  });

  it("allows the assigned Manager to approve only after Supervisor approval", async () => {
    const { stub, request } = await submitted();
    await assert.rejects(
      decideOvertimeRequest(managerActor, request.id, { action: "APPROVE" }, stub.database),
      OvertimeApprovalStageError,
    );
    await decideOvertimeRequest(supervisorActor, request.id, { action: "APPROVE" }, stub.database);
    const result = await decideOvertimeRequest(managerActor, request.id, { action: "APPROVE" }, stub.database);
    assert.equal(result.status, OvertimeRequestStatus.APPROVED);
    assert.equal(result.currentApprovalStage, null);
    assert.equal(stub.requests[0]?.reviewedById, managerActor.id);
    assert.equal(stub.notifications.at(-1)?.userId, employeeActor.id);
    assert.equal(stub.notifications.at(-1)?.type, "OVERTIME_REQUEST_APPROVED");
  });

  it("allows rejection at either assigned stage and notifies the employee", async () => {
    const supervisorRejected = await submitted();
    const rejectedBySupervisor = await decideOvertimeRequest(
      supervisorActor,
      supervisorRejected.request.id,
      { action: "REJECT", reason: "Please reschedule" },
      supervisorRejected.stub.database,
    );
    assert.equal(rejectedBySupervisor.status, OvertimeRequestStatus.REJECTED);
    assert.equal(supervisorRejected.stub.requests[0]?.decisionReason, "Please reschedule");
    assert.equal(supervisorRejected.stub.notifications.at(-1)?.userId, employeeActor.id);

    const managerRejected = await submitted();
    await decideOvertimeRequest(supervisorActor, managerRejected.request.id, { action: "APPROVE" }, managerRejected.stub.database);
    const rejectedByManager = await decideOvertimeRequest(
      managerActor,
      managerRejected.request.id,
      { action: "REJECT" },
      managerRejected.stub.database,
    );
    assert.equal(rejectedByManager.status, OvertimeRequestStatus.REJECTED);
    assert.equal(managerRejected.stub.notifications.at(-1)?.type, "OVERTIME_REQUEST_REJECTED");
  });

  it("prevents decisions after a terminal status and handles unknown request IDs", async () => {
    const { stub, request } = await submitted();
    await decideOvertimeRequest(supervisorActor, request.id, { action: "REJECT" }, stub.database);
    await assert.rejects(
      decideOvertimeRequest(supervisorActor, request.id, { action: "APPROVE" }, stub.database),
      OvertimeApprovalStageError,
    );
    await assert.rejects(
      decideOvertimeRequest(supervisorActor, "missing", { action: "APPROVE" }, stub.database),
      OvertimeRequestNotFoundError,
    );
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Role, WorkFromHomeApprovalStage, WorkFromHomeRequestStatus } from "@prisma/client";
import { ZodError } from "zod";
import { hasPermission } from "@/lib/auth/permissions";
import {
  decideWorkFromHomeRequest,
  listApprovedWorkFromHomeForAttendance,
  listOwnWorkFromHomeRequests,
  listWorkFromHomeRequestsForReview,
  submitOwnWorkFromHomeRequest,
  WorkFromHomeApprovalScopeError,
  WorkFromHomeApprovalStageError,
  WorkFromHomeApproverNotFoundError,
  WorkFromHomeRequestConflictError,
  WorkFromHomeRequestAccessError,
  WorkFromHomeRequestTimeError,
} from "./service";
import { workFromHomeDecisionSchema, workFromHomeRequestInputSchema } from "./validation";

const employeeActor = { id: "employee-user-1", role: Role.EMPLOYEE, timeZone: "Asia/Colombo" };
const supervisorActor = { id: "supervisor-user-1", role: Role.SUPERVISOR, timeZone: "Asia/Colombo" };
const managerActor = { id: "manager-user-1", role: Role.DEPARTMENT_MANAGER, timeZone: "Asia/Colombo" };
const validInput = {
  date: "2026-10-08",
  startTime: "09:00",
  endTime: "17:30",
  reason: "Home maintenance requires my presence",
  workLocation: "Colombo",
};

type TestRequest = {
  id: string;
  employeeId: string;
  date: Date;
  startAt: Date;
  endAt: Date;
  reason: string;
  workLocation: string;
  status: WorkFromHomeRequestStatus;
  currentApprovalStage: WorkFromHomeApprovalStage | null;
  currentApproverId: string | null;
  decisionReason: string | null;
  reviewedById: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
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
  const requests: TestRequest[] = [];
  const audits: Record<string, unknown>[] = [];
  const notifications: Record<string, unknown>[] = [];
  const queries: { employee: unknown[]; list: Record<string, unknown>[]; attendance: Record<string, unknown>[] } = {
    employee: [],
    list: [],
    attendance: [],
  };
  let nextId = 1;
  let lockTail = Promise.resolve();

  const transaction = {
    employee: {
      findUnique: async ({ where }: { where: { userId: string } }) => {
        queries.employee.push(where);
        if (where.userId === managerActor.id) return {
          id: "manager-record-1",
          departmentId: options.managerDepartmentId === undefined ? "department-1" : options.managerDepartmentId,
          user: { role: Role.DEPARTMENT_MANAGER, isActive: true },
        };
        return where.userId === employeeActor.id ? employee : null;
      },
    },
    $queryRaw: async () => [],
    workFromHomeRequest: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const request: TestRequest = {
          id: `wfh-${nextId++}`,
          employeeId: data.employeeId as string,
          date: data.date as Date,
          startAt: data.startAt as Date,
          endAt: data.endAt as Date,
          reason: data.reason as string,
          workLocation: data.workLocation as string,
          status: data.status as WorkFromHomeRequestStatus,
          currentApprovalStage: data.currentApprovalStage as WorkFromHomeApprovalStage,
          currentApproverId: data.currentApproverId as string,
          decisionReason: null,
          reviewedById: null,
          reviewedAt: null,
          createdAt: new Date("2026-10-08T08:00:00.000Z"),
        };
        requests.push(request);
        return { ...request };
      },
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const status = where.status as { in: WorkFromHomeRequestStatus[] };
        const startAt = (where.startAt as { lt: Date }).lt;
        const endAt = (where.endAt as { gt: Date }).gt;
        return requests.find((request) =>
          request.employeeId === where.employeeId
          && status.in.includes(request.status)
          && request.startAt < startAt
          && request.endAt > endAt,
        ) ?? null;
      },
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        queries.list.push(where);
        if (where.status === WorkFromHomeRequestStatus.APPROVED) {
          queries.attendance.push(where);
          return [];
        }
        return requests.filter((request) => {
          if (where.employeeId) return request.employeeId === where.employeeId;
          const managerScope = where.employee as { departmentId?: string } | undefined;
          return request.status === where.status
            && request.currentApprovalStage === where.currentApprovalStage
            && request.currentApproverId === where.currentApproverId
            && (managerScope?.departmentId === undefined || managerScope.departmentId === employee.departmentId);
        }).map((request) => ({ ...request, employee: { ...employee } }));
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
    $transaction: async <T>(callback: (tx: typeof transaction) => Promise<T>) => {
      let releaseLock: (() => void) | undefined;
      const tx = {
        ...transaction,
        $queryRaw: async () => {
          if (!releaseLock) {
            const previous = lockTail;
            let release: () => void = () => {};
            lockTail = new Promise<void>((resolve) => {
              release = resolve;
            });
            await previous;
            releaseLock = release;
          }
          return [];
        },
      };
      try {
        return await callback(tx);
      } finally {
        releaseLock?.();
      }
    },
    employee: transaction.employee,
    workFromHomeRequest: transaction.workFromHomeRequest,
  } as never;

  return { database, employee, requests, audits, notifications, queries };
}

describe("work from home request validation and permissions", () => {
  it("requires every SRS field and validates calendar dates and local times", () => {
    assert.equal(workFromHomeRequestInputSchema.safeParse(validInput).success, true);
    for (const field of ["date", "startTime", "endTime", "reason", "workLocation"] as const) {
      assert.equal(workFromHomeRequestInputSchema.safeParse({ ...validInput, [field]: "" }).success, false, `${field} is required`);
    }
    assert.equal(workFromHomeRequestInputSchema.safeParse({ ...validInput, date: "2026-02-30" }).success, false);
    assert.equal(workFromHomeRequestInputSchema.safeParse({ ...validInput, startTime: "25:30" }).success, false);
    assert.equal(workFromHomeDecisionSchema.safeParse({ action: "CANCEL" }).success, false);
  });

  it("rejects client-supplied employee or manager identifiers", () => {
    assert.equal(workFromHomeRequestInputSchema.safeParse({ ...validInput, employeeId: "other-employee" }).success, false);
    assert.equal(workFromHomeRequestInputSchema.safeParse({ ...validInput, managerId: "other-manager" }).success, false);
  });

  it("grants submit only to employees and approval only to the assigned workflow roles", () => {
    assert.equal(hasPermission(Role.EMPLOYEE, "wfh:submit"), true);
    assert.equal(hasPermission(Role.EMPLOYEE, "wfh:approve"), false);
    assert.equal(hasPermission(Role.SUPERVISOR, "wfh:approve"), true);
    assert.equal(hasPermission(Role.DEPARTMENT_MANAGER, "wfh:approve"), true);
    assert.equal(hasPermission(Role.HR_ADMINISTRATOR, "wfh:approve"), false);
  });
});

describe("employee work from home requests", () => {
  it("submits using the authenticated employee and assigns the linked Supervisor", async () => {
    const stub = createDatabase();
    await assert.rejects(
      () => submitOwnWorkFromHomeRequest(employeeActor, { ...validInput, employeeId: "ignored" }, stub.database),
      ZodError,
    );
    assert.equal(stub.requests.length, 0);

    const request = await submitOwnWorkFromHomeRequest(employeeActor, validInput, stub.database);
    assert.equal(stub.queries.employee[0] && (stub.queries.employee[0] as { userId: string }).userId, employeeActor.id);
    assert.equal(stub.requests[0]?.employeeId, stub.employee.id);
    assert.equal(request.date.toISOString(), "2026-10-08T00:00:00.000Z");
    assert.equal(request.startAt.toISOString(), "2026-10-08T03:30:00.000Z");
    assert.equal(request.endAt.toISOString(), "2026-10-08T12:00:00.000Z");
    assert.equal(stub.requests[0]?.currentApproverId, supervisorActor.id);
    assert.equal(stub.requests[0]?.currentApprovalStage, WorkFromHomeApprovalStage.SUPERVISOR);
    assert.equal(stub.notifications[0]?.userId, supervisorActor.id);
    assert.equal(stub.notifications[0]?.type, "WFH_REQUEST_PENDING");
    assert.equal(stub.audits[0]?.actionType, "WFH_REQUEST_SUBMITTED");
  });

  it("rejects identical retries and overlapping active requests but permits adjacent intervals", async () => {
    const stub = createDatabase();
    await submitOwnWorkFromHomeRequest(employeeActor, validInput, stub.database);
    await assert.rejects(
      submitOwnWorkFromHomeRequest(employeeActor, validInput, stub.database),
      WorkFromHomeRequestConflictError,
    );
    await assert.rejects(
      submitOwnWorkFromHomeRequest(employeeActor, {
        ...validInput,
        startTime: "17:00",
        endTime: "18:00",
        reason: "Different reason",
      }, stub.database),
      WorkFromHomeRequestConflictError,
    );

    const adjacent = await submitOwnWorkFromHomeRequest(employeeActor, {
      ...validInput,
      startTime: "17:30",
      endTime: "18:30",
    }, stub.database);
    assert.equal(stub.requests.length, 2);
    assert.equal(adjacent.startAt.toISOString(), "2026-10-08T12:00:00.000Z");
  });

  it("blocks overlaps while pending or approved and permits resubmission after a terminal decision", async () => {
    const stub = createDatabase();
    await submitOwnWorkFromHomeRequest(employeeActor, validInput, stub.database);
    stub.requests[0]!.status = WorkFromHomeRequestStatus.APPROVED;
    await assert.rejects(
      submitOwnWorkFromHomeRequest(employeeActor, validInput, stub.database),
      WorkFromHomeRequestConflictError,
    );

    stub.requests[0]!.status = WorkFromHomeRequestStatus.REJECTED;
    await submitOwnWorkFromHomeRequest(employeeActor, validInput, stub.database);
    assert.equal(stub.requests.length, 2);
  });

  it("serializes concurrent submissions for one employee before checking for overlaps", async () => {
    const stub = createDatabase();
    const results = await Promise.allSettled([
      submitOwnWorkFromHomeRequest(employeeActor, validInput, stub.database),
      submitOwnWorkFromHomeRequest(employeeActor, validInput, stub.database),
    ]);

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.equal(
      rejected?.status === "rejected" && rejected.reason instanceof WorkFromHomeRequestConflictError,
      true,
    );
    assert.equal(stub.requests.length, 1);
    assert.equal(stub.audits.length, 1);
    assert.equal(stub.notifications.length, 1);
  });

  it("rejects unauthenticated users, unauthorized roles, and invalid local date/time ranges", async () => {
    const stub = createDatabase();
    await assert.rejects(() => submitOwnWorkFromHomeRequest(null, validInput, stub.database), WorkFromHomeRequestAccessError);
    await assert.rejects(() => submitOwnWorkFromHomeRequest(supervisorActor, validInput, stub.database), WorkFromHomeRequestAccessError);
    await assert.rejects(() => submitOwnWorkFromHomeRequest(employeeActor, { ...validInput, endTime: "08:00" }, stub.database), WorkFromHomeRequestTimeError);
    await assert.rejects(
      () => submitOwnWorkFromHomeRequest({ ...employeeActor, timeZone: "Not/A-Timezone" }, validInput, stub.database),
      WorkFromHomeRequestTimeError,
    );
    await assert.rejects(
      () => submitOwnWorkFromHomeRequest(
        { ...employeeActor, timeZone: "America/New_York" },
        { ...validInput, date: "2026-03-08", startTime: "02:30", endTime: "04:00" },
        stub.database,
      ),
      WorkFromHomeRequestTimeError,
    );
    assert.equal(stub.requests.length, 0);
  });

  it("requires an active assigned Supervisor and Manager before submission", async () => {
    await assert.rejects(
      () => submitOwnWorkFromHomeRequest(employeeActor, validInput, createDatabase({ supervisor: "missing" }).database),
      WorkFromHomeApproverNotFoundError,
    );
    await assert.rejects(
      () => submitOwnWorkFromHomeRequest(employeeActor, validInput, createDatabase({ manager: "inactive" }).database),
      WorkFromHomeApproverNotFoundError,
    );
  });

  it("restricts request history and approved attendance entries to the authenticated employee", async () => {
    const stub = createDatabase();
    await submitOwnWorkFromHomeRequest(employeeActor, validInput, stub.database);
    await listOwnWorkFromHomeRequests(employeeActor, stub.database);
    assert.deepEqual(stub.queries.list[0], { employeeId: stub.employee.id });

    await listApprovedWorkFromHomeForAttendance(employeeActor, stub.database);
    assert.deepEqual(stub.queries.attendance[0], {
      employee: { userId: employeeActor.id },
      status: WorkFromHomeRequestStatus.APPROVED,
    });
    await assert.rejects(() => listOwnWorkFromHomeRequests(supervisorActor, stub.database), WorkFromHomeRequestAccessError);
  });
});

describe("work from home approvals", () => {
  it("lists only the current approver's assigned stage", async () => {
    const stub = createDatabase();
    await submitOwnWorkFromHomeRequest(employeeActor, validInput, stub.database);
    const listed = await listWorkFromHomeRequestsForReview(supervisorActor, stub.database);
    assert.equal(listed.length, 1);
    assert.deepEqual(stub.queries.list[0], {
      status: WorkFromHomeRequestStatus.PENDING,
      currentApprovalStage: WorkFromHomeApprovalStage.SUPERVISOR,
      currentApproverId: supervisorActor.id,
      employee: { supervisor: { userId: supervisorActor.id, user: { role: "SUPERVISOR", isActive: true } } },
    });
    await assert.rejects(() => listWorkFromHomeRequestsForReview(employeeActor, stub.database), WorkFromHomeRequestAccessError);
  });

  it("forwards the assigned Supervisor approval to the assigned Manager, then approves and notifies the employee", async () => {
    const stub = createDatabase();
    const request = await submitOwnWorkFromHomeRequest(employeeActor, validInput, stub.database);

    const forwarded = await decideWorkFromHomeRequest(supervisorActor, request.id, { action: "APPROVE" }, stub.database);
    assert.equal(forwarded.currentApprovalStage, WorkFromHomeApprovalStage.MANAGER);
    assert.equal(stub.requests[0]?.currentApproverId, managerActor.id);
    assert.equal(stub.notifications[1]?.userId, managerActor.id);

    const approved = await decideWorkFromHomeRequest(managerActor, request.id, { action: "APPROVE" }, stub.database);
    assert.equal(approved.status, WorkFromHomeRequestStatus.APPROVED);
    assert.equal(approved.currentApprovalStage, null);
    assert.equal(stub.notifications[2]?.userId, employeeActor.id);
    assert.equal(stub.notifications[2]?.type, "WFH_REQUEST_APPROVED");
    assert.equal(stub.audits.at(-1)?.actionType, "WFH_REQUEST_APPROVED");
  });

  it("does not expose or allow Manager approval outside the Manager's department", async () => {
    const stub = createDatabase({ employeeDepartmentId: "department-1", managerDepartmentId: "department-2" });
    const request = await submitOwnWorkFromHomeRequest(employeeActor, validInput, stub.database);
    await decideWorkFromHomeRequest(supervisorActor, request.id, { action: "APPROVE" }, stub.database);

    assert.deepEqual(await listWorkFromHomeRequestsForReview(managerActor, stub.database), []);
    await assert.rejects(
      () => decideWorkFromHomeRequest(managerActor, request.id, { action: "APPROVE" }, stub.database),
      WorkFromHomeApprovalScopeError,
    );
    assert.equal(stub.requests[0]?.status, WorkFromHomeRequestStatus.PENDING);
    assert.equal(stub.audits.length, 2);
  });

  it("rejects unrelated approvers, employee self-approval, and invalid stage transitions", async () => {
    const stub = createDatabase();
    const request = await submitOwnWorkFromHomeRequest(employeeActor, validInput, stub.database);
    await assert.rejects(() => decideWorkFromHomeRequest(managerActor, request.id, { action: "APPROVE" }, stub.database), WorkFromHomeApprovalStageError);
    await assert.rejects(
      () => decideWorkFromHomeRequest({ ...supervisorActor, id: "unassigned-supervisor" }, request.id, { action: "APPROVE" }, stub.database),
      WorkFromHomeApprovalStageError,
    );
    stub.employee.userId = supervisorActor.id;
    await assert.rejects(
      () => decideWorkFromHomeRequest(supervisorActor, request.id, { action: "APPROVE" }, stub.database),
      WorkFromHomeApprovalScopeError,
    );
    stub.employee.userId = employeeActor.id;
    await assert.rejects(() => decideWorkFromHomeRequest(employeeActor, request.id, { action: "APPROVE" }, stub.database), WorkFromHomeRequestAccessError);
    await decideWorkFromHomeRequest(supervisorActor, request.id, { action: "APPROVE" }, stub.database);
    await assert.rejects(() => decideWorkFromHomeRequest(supervisorActor, request.id, { action: "APPROVE" }, stub.database), WorkFromHomeApprovalStageError);
    await decideWorkFromHomeRequest(managerActor, request.id, { action: "REJECT", reason: "Coverage required on site" }, stub.database);
    await assert.equal(stub.requests[0]?.status, WorkFromHomeRequestStatus.REJECTED);
    await assert.equal(stub.requests[0]?.decisionReason, "Coverage required on site");
    await assert.equal(stub.notifications.at(-1)?.type, "WFH_REQUEST_REJECTED");
    await assert.rejects(() => decideWorkFromHomeRequest(managerActor, request.id, { action: "APPROVE" }, stub.database), WorkFromHomeApprovalStageError);
  });

  it("does not advance if the next assigned Manager is unavailable", async () => {
    const stub = createDatabase();
    const request = await submitOwnWorkFromHomeRequest(employeeActor, validInput, stub.database);
    if (stub.employee.manager) stub.employee.manager.user.isActive = false;
    await assert.rejects(
      () => decideWorkFromHomeRequest(supervisorActor, request.id, { action: "APPROVE" }, stub.database),
      WorkFromHomeApproverNotFoundError,
    );
    assert.equal(stub.requests[0]?.currentApprovalStage, WorkFromHomeApprovalStage.SUPERVISOR);
  });
});

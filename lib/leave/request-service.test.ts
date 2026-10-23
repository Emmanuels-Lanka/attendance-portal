import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LeaveRequestStatus, Role } from "@prisma/client";
import {
  getOwnLeaveRequest,
  LeaveRequestAccessError,
  LeaveRequestAttachmentNotFoundError,
  LeaveRequestEmployeeNotFoundError,
  LeaveRequestLeaveTypeNotFoundError,
  LeaveRequestNotFoundError,
  listOwnLeaveRequests,
  submitOwnLeaveRequest,
} from "@/lib/leave/request-service";
import {
  decideSupervisorLeaveRequest,
  decideManagerLeaveRequest,
  LeaveApprovalAccessError,
  LeaveApprovalScopeError,
  LeaveApprovalStageError,
  listSupervisorLeaveRequests,
  listManagerLeaveRequests,
} from "@/lib/leave/approval-service";
import { leaveRequestInputSchema } from "@/lib/leave/validation";

const employeeActor = { id: "employee-user-1", role: Role.EMPLOYEE };
const requestInput = {
  leaveTypeId: "leave-type-1",
  startDate: "2026-10-12",
  endDate: "2026-10-13",
  reason: "Personal appointment",
  attachmentDocumentId: null,
};

function createRequestDatabaseStub(options: {
  supervisor?: "assigned" | "missing" | "inactive";
  manager?: "assigned" | "missing" | "inactive";
  forceDecisionRace?: boolean;
  employeeDepartmentId?: string | null;
  managerDepartmentId?: string | null;
  hrEmployeeLinked?: boolean;
} = {}) {
  const supervisorStatus = options.supervisor ?? "assigned";
  const managerStatus = options.manager ?? "missing";
  const assignedManager = managerStatus === "missing" ? null : {
    userId: "manager-user-1",
    user: { role: Role.DEPARTMENT_MANAGER, isActive: managerStatus !== "inactive" },
  };
  const employees = new Map([
    ["employee-user-1", {
      id: "employee-1",
      userId: "employee-user-1",
      departmentId: options.employeeDepartmentId === undefined ? "department-1" : options.employeeDepartmentId,
      name: "Employee One",
      employeeId: "E-001",
      supervisor: supervisorStatus === "missing" ? null : {
        userId: "supervisor-user-1",
        user: { role: Role.SUPERVISOR, isActive: supervisorStatus !== "inactive" },
      },
      manager: assignedManager,
    }],
    ["employee-user-2", {
      id: "employee-2",
      userId: "employee-user-2",
      departmentId: "department-1",
      name: "Employee Two",
      employeeId: "E-002",
      supervisor: {
        userId: "supervisor-user-2",
        user: { role: Role.SUPERVISOR, isActive: true },
      },
      manager: null,
    }],
  ]);
  if (options.hrEmployeeLinked) {
    employees.set("hr-user", {
      ...employees.get("employee-user-1")!,
      id: "hr-employee-1",
      userId: "hr-user",
      name: "HR Administrator",
      employeeId: "E-HR",
    });
  }
  const leaveTypes = new Set(["leave-type-1"]);
  const documents = new Map([
    ["document-1", { id: "document-1", employeeId: "employee-1" }],
    ["document-2", { id: "document-2", employeeId: "employee-2" }],
  ]);
  const requests: Record<string, unknown>[] = [];
  const audits: Record<string, unknown>[] = [];
  const notifications: Record<string, unknown>[] = [];
  const attendanceAndBalanceWrites: string[] = [];
  const leaveRequestQueries: { operation: "findMany" | "count"; where: Record<string, unknown> }[] = [];
  let nextId = 1;
  const tx = {
    employee: {
      findUnique: async ({ where }: { where: { userId: string } }) => where.userId === "manager-user-1"
        ? {
            id: "manager-employee-1",
            departmentId: options.managerDepartmentId === undefined ? "department-1" : options.managerDepartmentId,
            user: { role: Role.DEPARTMENT_MANAGER, isActive: true },
          }
        : employees.get(where.userId) ?? null,
    },
    $queryRaw: async () => [],
    leaveType: {
      findUnique: async ({ where }: { where: { id: string } }) => leaveTypes.has(where.id) ? { id: where.id } : null,
    },
    employeeDocument: {
      findFirst: async ({ where }: { where: { id: string; employeeId: string } }) => {
        const document = documents.get(where.id);
        return document?.employeeId === where.employeeId ? { id: document.id } : null;
      },
    },
    attendanceDaily: {
      update: async () => { attendanceAndBalanceWrites.push("attendanceDaily"); },
      updateMany: async () => { attendanceAndBalanceWrites.push("attendanceDaily"); },
    },
    attendanceRaw: {
      create: async () => { attendanceAndBalanceWrites.push("attendanceRaw"); },
      update: async () => { attendanceAndBalanceWrites.push("attendanceRaw"); },
      delete: async () => { attendanceAndBalanceWrites.push("attendanceRaw"); },
    },
    leaveEntitlement: {
      update: async () => { attendanceAndBalanceWrites.push("leaveEntitlement"); },
      upsert: async () => { attendanceAndBalanceWrites.push("leaveEntitlement"); },
    },
    leaveRequest: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const created = {
          id: `leave-request-${nextId++}`,
          ...data,
          decisionReason: null,
          reviewedById: null,
          reviewedAt: null,
          createdAt: new Date("2026-10-05T10:00:00.000Z"),
          updatedAt: new Date("2026-10-05T10:00:00.000Z"),
          leaveType: { id: data.leaveTypeId, name: "Annual Leave" },
        };
        requests.push(created);
        return created;
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        const request = requests.find((candidate) => candidate.id === where.id);
        if (!request) return null;
        const employee = [...employees.values()].find((candidate) => candidate.id === request.employeeId);
        return {
          ...request,
          employee: employee ? {
            userId: employee.userId,
            departmentId: employee.departmentId,
            supervisor: employee.supervisor,
            manager: employee.manager,
          } : null,
          leaveType: { name: "Annual Leave" },
        };
      },
      findMany: async ({ where, skip, take }: {
        where: {
          employeeId?: string;
          currentApproverId?: string;
          status?: LeaveRequestStatus;
          currentApprovalStage?: string;
          employee?: { departmentId?: string };
        };
        skip?: number;
        take?: number;
      }) => {
        leaveRequestQueries.push({ operation: "findMany", where });
        return requests.filter((request) => {
          const employee = [...employees.values()].find((candidate) => candidate.id === request.employeeId);
          const scopeMatches = where.currentApproverId === undefined || (where.currentApprovalStage === "MANAGER"
            ? employee?.manager?.userId === where.currentApproverId
              && employee.manager.user?.role === Role.DEPARTMENT_MANAGER
              && employee.manager.user.isActive
              && where.employee?.departmentId === employee.departmentId
            : employee?.supervisor?.userId === where.currentApproverId
              && employee.supervisor.user?.role === Role.SUPERVISOR
              && employee.supervisor.user.isActive);
          return scopeMatches
          && (where.employeeId === undefined || request.employeeId === where.employeeId)
          && (where.currentApproverId === undefined || request.currentApproverId === where.currentApproverId)
          && (where.status === undefined || request.status === where.status)
          && (where.currentApprovalStage === undefined || request.currentApprovalStage === where.currentApprovalStage);
        }).sort((a, b) => (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime())
        .slice(skip ?? 0, take === undefined ? undefined : (skip ?? 0) + take)
        .map((request) => {
          const employee = [...employees.values()].find((candidate) => candidate.id === request.employeeId);
          return {
            ...request,
            employee: employee ? {
              id: employee.id,
              name: employee.name,
              employeeId: employee.employeeId,
              userId: employee.userId,
              departmentId: employee.departmentId,
              supervisor: employee.supervisor,
              manager: employee.manager,
            } : null,
            leaveType: { id: request.leaveTypeId, name: "Annual Leave" },
          };
        });
      },
      updateMany: async ({ where, data }: {
        where: {
          id: string;
          status: LeaveRequestStatus;
          currentApprovalStage: string;
          currentApproverId: string;
          employee?: { departmentId?: string };
        };
        data: Record<string, unknown>;
      }) => {
        if (options.forceDecisionRace) {
          const concurrentlyDecided = requests.find((candidate) => candidate.id === where.id);
          if (concurrentlyDecided) Object.assign(concurrentlyDecided, {
            status: LeaveRequestStatus.REJECTED,
            currentApprovalStage: null,
            currentApproverId: null,
            reviewedById: "other-reviewer",
            reviewedAt: new Date("2026-10-05T11:00:00.000Z"),
          });
          return { count: 0 };
        }
        const request = requests.find((candidate) =>
          candidate.id === where.id
          && candidate.status === where.status
          && candidate.currentApprovalStage === where.currentApprovalStage
          && candidate.currentApproverId === where.currentApproverId,
        );
        const employee = request && [...employees.values()].find((candidate) => candidate.id === request.employeeId);
        const reviewerAssigned = employee && (where.currentApprovalStage === "MANAGER"
          ? employee.manager?.userId === where.currentApproverId
            && employee.manager.user?.role === Role.DEPARTMENT_MANAGER
            && employee.manager.user.isActive
            && where.employee?.departmentId === employee.departmentId
          : employee.supervisor?.userId === where.currentApproverId
            && employee.supervisor.user?.role === Role.SUPERVISOR
            && employee.supervisor.user.isActive);
        if (!request || !employee || !reviewerAssigned) return { count: 0 };
        Object.assign(request, data);
        return { count: 1 };
      },
      count: async ({ where }: { where: { employeeId: string } }) => {
        leaveRequestQueries.push({ operation: "count", where });
        return requests.filter((request) => request.employeeId === where.employeeId).length;
      },
      findFirst: async ({ where }: { where: { id: string; employeeId: string } }) => requests
        .find((request) => request.id === where.id && request.employeeId === where.employeeId) ?? null,
    },
    attendanceAuditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        audits.push(data);
        return { id: `audit-${audits.length}` };
      },
    },
    notification: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        notifications.push(data);
        return { id: `notification-${notifications.length}` };
      },
    },
  };
  const database = {
    ...tx,
    $transaction: async <T>(operation: (transaction: typeof tx) => Promise<T>) => operation(tx),
  } as never;
  const seedLeaveRequest = (employeeId: string) => {
    const request = {
      id: `leave-request-${nextId++}`,
      employeeId,
      leaveTypeId: "leave-type-1",
      startDate: new Date("2026-10-12T00:00:00.000Z"),
      endDate: new Date("2026-10-13T00:00:00.000Z"),
      reason: "Test request",
      attachmentDocumentId: null,
      status: LeaveRequestStatus.PENDING,
      currentApprovalStage: "SUPERVISOR",
      currentApproverId: "supervisor-user-1",
      decisionReason: null,
      reviewedById: null,
      reviewedAt: null,
      createdAt: new Date("2026-10-05T10:00:00.000Z"),
      updatedAt: new Date("2026-10-05T10:00:00.000Z"),
      leaveType: { id: "leave-type-1", name: "Annual Leave" },
    };
    requests.push(request);
    return request;
  };
  return { database, requests, audits, notifications, attendanceAndBalanceWrites, leaveRequestQueries, seedLeaveRequest };
}

describe("Leave request validation", () => {
  it("requires a Leave Type, valid date range, and nonblank reason", () => {
    assert.equal(leaveRequestInputSchema.safeParse(requestInput).success, true);
    assert.equal(leaveRequestInputSchema.safeParse({ ...requestInput, leaveTypeId: "" }).success, false);
    assert.equal(leaveRequestInputSchema.safeParse({ ...requestInput, startDate: "2026-02-30" }).success, false);
    assert.equal(leaveRequestInputSchema.safeParse({ ...requestInput, endDate: "2026-10-11" }).success, false);
    assert.equal(leaveRequestInputSchema.safeParse({ ...requestInput, reason: "   " }).success, false);
  });
});

describe("Leave request submission and self-service history", () => {
  it("submits a PENDING request for the actor's linked Employee and audits without reason or attachment details", async () => {
    const stub = createRequestDatabaseStub();
    const request = await submitOwnLeaveRequest(employeeActor, {
      ...requestInput,
      employeeId: "employee-2",
    }, stub.database);
    assert.equal(stub.requests[0]?.employeeId, "employee-1");
    assert.equal(request.status, LeaveRequestStatus.PENDING);
    assert.equal(request.currentApprovalStage, "SUPERVISOR");
    assert.equal(request.currentApproverId, "supervisor-user-1");
    assert.equal(stub.audits.length, 1);
    assert.equal(stub.audits[0]?.employeeId, "employee-user-1");
    assert.equal(stub.audits[0]?.actionType, "LEAVE_REQUEST_SUBMITTED");
    assert.equal(JSON.stringify(stub.audits).includes("Personal appointment"), false);
    assert.equal(JSON.stringify(stub.audits).includes("employee-2"), false);
    assert.deepEqual(stub.notifications[0], {
      userId: "supervisor-user-1",
      title: "Leave request pending",
      message: "A Leave request for 2026-10-12 to 2026-10-13 is awaiting your review.",
      type: "LEAVE_REQUEST_PENDING",
    });
  });

  it("rejects unauthorized roles and accounts without a linked Employee", async () => {
    const stub = createRequestDatabaseStub();
    await assert.rejects(
      submitOwnLeaveRequest({ id: "admin-user", role: Role.ADMIN }, requestInput, stub.database),
      LeaveRequestAccessError,
    );
    await assert.rejects(
      listOwnLeaveRequests({ id: "admin-user", role: Role.ADMIN }, {}, stub.database),
      LeaveRequestAccessError,
    );
    await assert.rejects(
      getOwnLeaveRequest({ id: "admin-user", role: Role.ADMIN }, "leave-request-1", stub.database),
      LeaveRequestAccessError,
    );
    await assert.rejects(
      submitOwnLeaveRequest({ id: "unlinked-user", role: Role.EMPLOYEE }, requestInput, stub.database),
      LeaveRequestEmployeeNotFoundError,
    );
    assert.equal(stub.requests.length, 0);
  });

  it("fails closed if the employee has no active assigned Supervisor", async () => {
    for (const supervisor of ["missing", "inactive"] as const) {
      const stub = createRequestDatabaseStub({ supervisor });
      await assert.rejects(
        submitOwnLeaveRequest(employeeActor, requestInput, stub.database),
        { name: "LeaveRequestSupervisorNotFoundError" },
      );
      assert.equal(stub.requests.length, 0);
    }
  });

  it("rejects nonexistent Leave Types and attachments belonging to another Employee", async () => {
    const stub = createRequestDatabaseStub();
    await assert.rejects(
      submitOwnLeaveRequest(employeeActor, { ...requestInput, leaveTypeId: "missing" }, stub.database),
      LeaveRequestLeaveTypeNotFoundError,
    );
    await assert.rejects(
      submitOwnLeaveRequest(employeeActor, { ...requestInput, attachmentDocumentId: "document-2" }, stub.database),
      LeaveRequestAttachmentNotFoundError,
    );
    const withAttachment = await submitOwnLeaveRequest(employeeActor, {
      ...requestInput,
      attachmentDocumentId: "document-1",
    }, stub.database);
    assert.equal(withAttachment.attachmentDocumentId, "document-1");
    assert.equal(stub.requests.length, 1);
  });

  it("lists and reads only the actor's own Leave requests", async () => {
    const stub = createRequestDatabaseStub();
    const first = await submitOwnLeaveRequest(employeeActor, requestInput, stub.database);
    await submitOwnLeaveRequest({ id: "employee-user-2", role: Role.EMPLOYEE }, requestInput, stub.database);
    const history = await listOwnLeaveRequests(employeeActor, { page: 1, pageSize: 10 }, stub.database);
    assert.equal(history.total, 1);
    assert.equal(history.items[0]?.id, first.id);
    assert.equal((await getOwnLeaveRequest(employeeActor, first.id, stub.database)).id, first.id);
    await assert.rejects(
      getOwnLeaveRequest(employeeActor, "leave-request-2", stub.database),
      LeaveRequestNotFoundError,
    );
  });

  it("allows a linked HR Administrator to read only their own Leave request history", async () => {
    const stub = createRequestDatabaseStub({ hrEmployeeLinked: true });
    const ownRequest = stub.seedLeaveRequest("hr-employee-1");
    stub.seedLeaveRequest("employee-2");

    const history = await listOwnLeaveRequests(
      { id: "hr-user", role: Role.HR_ADMINISTRATOR },
      {},
      stub.database,
    );

    assert.equal(history.total, 1);
    assert.deepEqual(history.items.map((request) => request.id), [ownRequest.id]);
    assert.deepEqual(stub.leaveRequestQueries, [
      { operation: "findMany", where: { employeeId: "hr-employee-1" } },
      { operation: "count", where: { employeeId: "hr-employee-1" } },
    ]);
  });

  it("returns the existing controlled error for an HR Administrator without a linked Employee", async () => {
    const stub = createRequestDatabaseStub();

    await assert.rejects(
      listOwnLeaveRequests({ id: "hr-user", role: Role.HR_ADMINISTRATOR }, {}, stub.database),
      LeaveRequestEmployeeNotFoundError,
    );
    assert.deepEqual(stub.leaveRequestQueries, []);
  });
});

describe("Supervisor Leave approval workflow", () => {
  async function submittedRequest() {
    const stub = createRequestDatabaseStub();
    const request = await submitOwnLeaveRequest(employeeActor, requestInput, stub.database);
    return { stub, request };
  }

  it("lists only pending requests assigned to the authenticated Supervisor", async () => {
    const { stub, request } = await submittedRequest();
    await submitOwnLeaveRequest({ id: "employee-user-2", role: Role.EMPLOYEE }, requestInput, stub.database);
    const assigned = await listSupervisorLeaveRequests(
      { id: "supervisor-user-1", role: Role.SUPERVISOR },
      stub.database,
    );
    const other = await listSupervisorLeaveRequests(
      { id: "supervisor-user-2", role: Role.SUPERVISOR },
      stub.database,
    );
    assert.deepEqual(assigned.map((item) => item.id), [request.id]);
    assert.deepEqual(other.map((item) => item.id), ["leave-request-2"]);
  });

  it("rejects non-Supervisor reviewers and an unrelated Supervisor", async () => {
    const { stub, request } = await submittedRequest();
    await assert.rejects(
      listSupervisorLeaveRequests({ id: "hr-user", role: Role.HR_ADMINISTRATOR }, stub.database),
      LeaveApprovalAccessError,
    );
    await assert.rejects(
      decideSupervisorLeaveRequest(
        { id: "hr-user", role: Role.HR_ADMINISTRATOR },
        request.id,
        { action: "APPROVE" },
        stub.database,
      ),
      LeaveApprovalAccessError,
    );
    await assert.rejects(
      decideSupervisorLeaveRequest(
        { id: "supervisor-user-2", role: Role.SUPERVISOR },
        request.id,
        { action: "APPROVE" },
        stub.database,
      ),
      LeaveApprovalScopeError,
    );
    assert.equal(stub.requests[0]?.status, LeaveRequestStatus.PENDING);
  });

  it("approves a pending request, records reviewer/time and audit, and preserves the employee subject", async () => {
    const { stub, request } = await submittedRequest();
    const result = await decideSupervisorLeaveRequest(
      { id: "supervisor-user-1", role: Role.SUPERVISOR },
      request.id,
      { action: "APPROVE" },
      stub.database,
    );
    const saved = stub.requests[0];
    assert.equal(result.status, LeaveRequestStatus.APPROVED);
    assert.equal(saved?.status, LeaveRequestStatus.APPROVED);
    assert.equal(saved?.reviewedById, "supervisor-user-1");
    assert.ok(saved?.reviewedAt instanceof Date);
    assert.equal(saved?.currentApprovalStage, null);
    assert.equal(saved?.currentApproverId, null);
    assert.equal(saved?.employeeId, "employee-1");
    assert.equal(stub.audits.at(-1)?.employeeId, "employee-user-1");
    assert.equal(stub.audits.at(-1)?.actorId, "supervisor-user-1");
    assert.equal(stub.audits.at(-1)?.actionType, "LEAVE_REQUEST_APPROVED");
    assert.deepEqual(stub.attendanceAndBalanceWrites, []);
    assert.deepEqual(stub.audits.at(-1)?.previousValues, {
      leaveRequestId: request.id,
      status: "PENDING",
      currentApprovalStage: "SUPERVISOR",
      currentApproverId: "supervisor-user-1",
    });
    assert.equal((stub.audits.at(-1)?.newValues as Record<string, unknown>)?.status, "APPROVED");
    assert.equal(stub.notifications.length, 2);
    assert.equal(stub.notifications[0]?.userId, "supervisor-user-1");
    assert.deepEqual(stub.notifications[1], {
      userId: "employee-user-1",
      title: "Leave request approved",
      message: "Your Annual Leave request for 2026-10-12 to 2026-10-13 was approved.",
      type: "LEAVE_REQUEST_APPROVED",
    });
  });

  it("rejects a pending request, records the rejection note and audit", async () => {
    const { stub, request } = await submittedRequest();
    await decideSupervisorLeaveRequest(
      { id: "supervisor-user-1", role: Role.SUPERVISOR },
      request.id,
      { action: "REJECT", reason: "Insufficient supporting details" },
      stub.database,
    );
    assert.equal(stub.requests[0]?.status, LeaveRequestStatus.REJECTED);
    assert.equal(stub.requests[0]?.reviewedById, "supervisor-user-1");
    assert.ok(stub.requests[0]?.reviewedAt instanceof Date);
    assert.equal(stub.requests[0]?.decisionReason, "Insufficient supporting details");
    assert.equal(stub.audits.at(-1)?.actionType, "LEAVE_REQUEST_REJECTED");
    assert.equal(stub.audits.at(-1)?.reason, "Insufficient supporting details");
    assert.equal((stub.audits.at(-1)?.newValues as Record<string, unknown>)?.status, "REJECTED");
    assert.deepEqual(stub.attendanceAndBalanceWrites, []);
    assert.equal(stub.notifications.length, 2);
    assert.equal(stub.notifications[0]?.userId, "supervisor-user-1");
    assert.deepEqual(stub.notifications[1], {
      userId: "employee-user-1",
      title: "Leave request rejected",
      message: "Your Annual Leave request for 2026-10-12 to 2026-10-13 was rejected.",
      type: "LEAVE_REQUEST_REJECTED",
    });
    assert.equal(stub.notifications[1]?.userId, "employee-user-1");
  });

  it("does not permit a second decision and preserves leave request subject identity", async () => {
    const { stub, request } = await submittedRequest();
    const actor = { id: "supervisor-user-1", role: Role.SUPERVISOR };
    await decideSupervisorLeaveRequest(actor, request.id, { action: "APPROVE" }, stub.database);
    await assert.rejects(
      decideSupervisorLeaveRequest(actor, request.id, { action: "REJECT" }, stub.database),
      LeaveApprovalStageError,
    );
    assert.equal(stub.requests[0]?.employeeId, "employee-1");
    assert.equal(stub.audits.length, 2);
    assert.equal(stub.notifications.length, 2);
  });

  it("does not overwrite a concurrent decision or create a duplicate audit", async () => {
    const stub = createRequestDatabaseStub({ forceDecisionRace: true });
    const request = await submitOwnLeaveRequest(employeeActor, requestInput, stub.database);
    await assert.rejects(
      decideSupervisorLeaveRequest(
        { id: "supervisor-user-1", role: Role.SUPERVISOR },
        request.id,
        { action: "APPROVE" },
        stub.database,
      ),
      LeaveApprovalStageError,
    );
    assert.equal(stub.requests[0]?.status, LeaveRequestStatus.REJECTED);
    assert.equal(stub.requests[0]?.reviewedById, "other-reviewer");
    assert.equal(stub.audits.length, 1);
    assert.equal(stub.notifications.length, 1);
  });

  it("forwards an assigned employee's approved request to their Manager for final review", async () => {
    const stub = createRequestDatabaseStub({ manager: "assigned" });
    const request = await submitOwnLeaveRequest(employeeActor, requestInput, stub.database);

    const supervisorResult = await decideSupervisorLeaveRequest(
      { id: "supervisor-user-1", role: Role.SUPERVISOR },
      request.id,
      { action: "APPROVE" },
      stub.database,
    );

    assert.equal(supervisorResult.status, LeaveRequestStatus.PENDING);
    assert.equal(supervisorResult.currentApprovalStage, "MANAGER");
    assert.equal(stub.requests[0]?.currentApproverId, "manager-user-1");
    assert.deepEqual((await listManagerLeaveRequests({ id: "manager-user-1", role: Role.DEPARTMENT_MANAGER }, stub.database)).map(({ id }) => id), [request.id]);
    assert.equal(stub.notifications[1]?.userId, "manager-user-1");
    assert.equal(stub.audits.at(-1)?.actionType, "LEAVE_REQUEST_SUPERVISOR_APPROVED");
    await assert.rejects(
      decideManagerLeaveRequest({ id: "other-manager", role: Role.DEPARTMENT_MANAGER }, request.id, { action: "APPROVE" }, stub.database),
      LeaveApprovalScopeError,
    );

    const managerResult = await decideManagerLeaveRequest(
      { id: "manager-user-1", role: Role.DEPARTMENT_MANAGER },
      request.id,
      { action: "APPROVE" },
      stub.database,
    );

    assert.equal(managerResult.status, LeaveRequestStatus.APPROVED);
    assert.equal(stub.requests[0]?.currentApprovalStage, null);
    assert.equal(stub.audits.at(-1)?.actionType, "LEAVE_REQUEST_APPROVED");
    assert.equal(stub.notifications[2]?.userId, "employee-user-1");
    assert.deepEqual(stub.attendanceAndBalanceWrites, []);
    await assert.rejects(
      decideManagerLeaveRequest({ id: "manager-user-1", role: Role.DEPARTMENT_MANAGER }, request.id, { action: "REJECT" }, stub.database),
      LeaveApprovalStageError,
    );
  });

  it("does not expose or allow Manager approval for an assigned employee outside the Manager's department", async () => {
    const stub = createRequestDatabaseStub({
      manager: "assigned",
      employeeDepartmentId: "department-1",
      managerDepartmentId: "department-2",
    });
    const request = await submitOwnLeaveRequest(employeeActor, requestInput, stub.database);
    await decideSupervisorLeaveRequest(
      { id: "supervisor-user-1", role: Role.SUPERVISOR },
      request.id,
      { action: "APPROVE" },
      stub.database,
    );

    assert.deepEqual(
      await listManagerLeaveRequests({ id: "manager-user-1", role: Role.DEPARTMENT_MANAGER }, stub.database),
      [],
    );
    await assert.rejects(
      decideManagerLeaveRequest(
        { id: "manager-user-1", role: Role.DEPARTMENT_MANAGER },
        request.id,
        { action: "APPROVE" },
        stub.database,
      ),
      LeaveApprovalScopeError,
    );
    assert.equal(stub.requests[0]?.status, LeaveRequestStatus.PENDING);
    assert.equal(stub.audits.length, 2);
  });

  it("rejects Manager review unless the request is at that Manager's assigned stage", async () => {
    const { stub, request } = await submittedRequest();
    assert.deepEqual(await listManagerLeaveRequests({ id: "manager-user-1", role: Role.DEPARTMENT_MANAGER }, stub.database), []);
    await assert.rejects(
      decideManagerLeaveRequest({ id: "manager-user-1", role: Role.DEPARTMENT_MANAGER }, request.id, { action: "APPROVE" }, stub.database),
      LeaveApprovalStageError,
    );
    await assert.rejects(
      listManagerLeaveRequests({ id: "hr-user", role: Role.HR_ADMINISTRATOR }, stub.database),
      LeaveApprovalAccessError,
    );
  });
});

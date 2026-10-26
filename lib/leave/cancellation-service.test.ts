import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LeaveCancellationStatus, LeaveRequestStatus, Role } from "@prisma/client";
import {
  decideManagerLeaveCancellation,
  decideSupervisorLeaveCancellation,
  LeaveCancellationScopeError,
  LeaveCancellationStageError,
  requestOwnLeaveCancellation,
} from "./cancellation-service";

function createDatabase(
  status: LeaveRequestStatus,
  employeeUserId = "employee-user",
  managerUserId: string | null = null,
) {
  const request = {
    id: "leave-request-1",
    employeeId: "employee-record-1",
    startDate: new Date("2026-10-27T00:00:00.000Z"),
    endDate: new Date("2026-10-27T00:00:00.000Z"),
    status,
    cancellationStatus: null as LeaveCancellationStatus | null,
    cancellationReason: null as string | null,
    cancellationApprovalStage: null as string | null,
    cancellationCurrentApproverId: null as string | null,
    cancellationRequestedById: null as string | null,
    cancellationRequestedAt: null as Date | null,
    cancellationReviewedById: null as string | null,
    cancellationReviewedAt: null as Date | null,
    cancellationDecisionReason: null as string | null,
  };
  const audits: Array<Record<string, unknown>> = [];
  const notifications: Array<Record<string, unknown>> = [];
  const attendanceRows: Array<Record<string, unknown>> = [];
  const transaction = {
    $queryRaw: async () => [],
    employee: {
      findUnique: async ({ where }: { where: { id?: string; userId?: string } }) => {
        if (where.userId === "manager-user") {
          return {
            id: "manager-record",
            userId: "manager-user",
            departmentId: "department-1",
            user: { role: Role.DEPARTMENT_MANAGER, isActive: true },
          };
        }
        if (where.id === "employee-record-1") return {
          id: "employee-record-1",
          userId: employeeUserId,
          user: { timeZone: "Asia/Colombo", countryCode: "LK" },
          shift: {
            id: "shift-1",
            startTime: new Date("1970-01-01T08:00:00.000Z"),
            endTime: new Date("1970-01-01T17:30:00.000Z"),
            breakStartTime: new Date("1970-01-01T12:30:00.000Z"),
            breakDurationMinutes: 60,
            gracePeriodMinutes: 10,
            lateThresholdMinutes: 10,
            earlyDepartureThresholdMinutes: 10,
            minimumWorkingHours: 8.5,
            overtimeEligible: false,
            roundingRules: null,
            workingDays: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"],
          },
          shiftAssignments: [],
          supervisor: {
            userId: "supervisor-user",
            user: { role: Role.SUPERVISOR, isActive: true },
          },
        };
        return {
          id: "employee-record-1",
          userId: employeeUserId,
          user: { timeZone: "Asia/Colombo", countryCode: "LK" },
          supervisor: {
            userId: "supervisor-user",
            user: { role: Role.SUPERVISOR, isActive: true },
          },
        };
      },
    },
    leaveRequest: {
      findMany: async () => [],
      findFirst: async () => request,
      findUnique: async () => ({
        ...request,
        reason: "Original reason",
        cancellationReason: request.cancellationReason,
        employee: {
          userId: employeeUserId,
          name: "Employee",
          employeeId: "E-001",
          departmentId: "department-1",
          user: { timeZone: "Asia/Colombo" },
          supervisor: {
            userId: "supervisor-user",
            user: { role: Role.SUPERVISOR, isActive: true },
          },
          manager: managerUserId
            ? {
                userId: managerUserId,
                user: { role: Role.DEPARTMENT_MANAGER, isActive: true },
              }
            : null,
        },
        leaveType: { name: "Annual" },
      }),
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(request, data);
        return { count: 1 };
      },
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
    attendanceDaily: {
      findMany: async () => [],
      create: async ({ data }: { data: Record<string, unknown> }) => {
        attendanceRows.push(data);
        return { id: `attendance-${attendanceRows.length}`, ...data };
      },
    },
    attendanceRaw: { findMany: async () => [] },
    workSession: { findMany: async () => [] },
    holiday: { findFirst: async () => null },
  };
  const database = {
    $transaction: async <T>(operation: (tx: typeof transaction) => Promise<T>) => operation(transaction),
    employee: transaction.employee,
    leaveRequest: transaction.leaveRequest,
  };
  return { database: database as never, request, audits, notifications, attendanceRows };
}

const employee = { id: "employee-user", role: Role.EMPLOYEE };
const supervisor = { id: "supervisor-user", role: Role.SUPERVISOR };
const manager = { id: "manager-user", role: Role.DEPARTMENT_MANAGER };

describe("Leave cancellation workflow", () => {
  it("immediately cancels a pending request and records the cancellation", async () => {
    const stub = createDatabase(LeaveRequestStatus.PENDING);

    const result = await requestOwnLeaveCancellation(employee, "leave-request-1", { reason: "Plans changed" }, stub.database);

    assert.equal(result.status, LeaveRequestStatus.CANCELLED);
    assert.equal(result.cancellationStatus, LeaveCancellationStatus.APPROVED);
    assert.equal(stub.request.status, LeaveRequestStatus.CANCELLED);
    assert.equal(stub.audits[0]?.actionType, "LEAVE_REQUEST_CANCELLED");
    assert.equal(stub.notifications[0]?.userId, employee.id);
  });

  it("keeps approved leave active while cancellation is pending, and rejection preserves it", async () => {
    const stub = createDatabase(LeaveRequestStatus.APPROVED);

    const requested = await requestOwnLeaveCancellation(employee, "leave-request-1", { reason: "Plans changed" }, stub.database);
    assert.equal(requested.status, LeaveRequestStatus.APPROVED);
    assert.equal(requested.cancellationStatus, LeaveCancellationStatus.PENDING);
    assert.equal(stub.request.status, LeaveRequestStatus.APPROVED);
    assert.equal(stub.request.cancellationCurrentApproverId, supervisor.id);

    const result = await decideSupervisorLeaveCancellation(
      supervisor,
      "leave-request-1",
      { action: "REJECT", reason: "Please retain the approved leave" },
      stub.database,
    );

    assert.equal(result.status, LeaveRequestStatus.APPROVED);
    assert.equal(result.cancellationStatus, LeaveCancellationStatus.REJECTED);
    assert.equal(stub.request.status, LeaveRequestStatus.APPROVED);
    assert.equal(stub.notifications.at(-1)?.userId, employee.id);
  });

  it("blocks a supervisor from approving their own cancellation", async () => {
    const stub = createDatabase(LeaveRequestStatus.APPROVED, supervisor.id);
    stub.request.cancellationStatus = LeaveCancellationStatus.PENDING;
    stub.request.cancellationReason = "Plans changed";
    stub.request.cancellationApprovalStage = "SUPERVISOR";
    stub.request.cancellationCurrentApproverId = supervisor.id;

    await assert.rejects(
      decideSupervisorLeaveCancellation(supervisor, "leave-request-1", { action: "APPROVE" }, stub.database),
      LeaveCancellationScopeError,
    );
    assert.equal(stub.request.status, LeaveRequestStatus.APPROVED);
    assert.equal(stub.request.cancellationStatus, LeaveCancellationStatus.PENDING);
  });

  it("forwards an approved cancellation to the assigned manager without cancelling the leave", async () => {
    const stub = createDatabase(LeaveRequestStatus.APPROVED, "employee-user", "manager-user");
    await requestOwnLeaveCancellation(employee, "leave-request-1", { reason: "Plans changed" }, stub.database);

    const result = await decideSupervisorLeaveCancellation(
      supervisor,
      "leave-request-1",
      { action: "APPROVE" },
      stub.database,
    );

    assert.equal(result.status, LeaveRequestStatus.APPROVED);
    assert.equal(result.cancellationStatus, LeaveCancellationStatus.PENDING);
    assert.equal(result.cancellationApprovalStage, "MANAGER");
    assert.equal(stub.request.status, LeaveRequestStatus.APPROVED);
    assert.equal(stub.request.cancellationCurrentApproverId, "manager-user");
    assert.equal(stub.notifications.at(-1)?.userId, "manager-user");
  });

  it("cancels approved leave and recalculates attendance once after manager approval", async () => {
    const stub = createDatabase(LeaveRequestStatus.APPROVED, "employee-user", "manager-user");
    await requestOwnLeaveCancellation(employee, "leave-request-1", { reason: "Plans changed" }, stub.database);
    await decideSupervisorLeaveCancellation(
      supervisor,
      "leave-request-1",
      { action: "APPROVE" },
      stub.database,
    );

    const result = await decideManagerLeaveCancellation(
      manager,
      "leave-request-1",
      { action: "APPROVE" },
      stub.database,
    );

    assert.equal(result.status, LeaveRequestStatus.CANCELLED);
    assert.equal(result.cancellationStatus, LeaveCancellationStatus.APPROVED);
    assert.equal(stub.request.status, LeaveRequestStatus.CANCELLED);
    assert.equal(stub.attendanceRows.length, 1);
    assert.equal(stub.attendanceRows[0]?.date instanceof Date, true);
    await assert.rejects(
      decideManagerLeaveCancellation(manager, "leave-request-1", { action: "APPROVE" }, stub.database),
      LeaveCancellationStageError,
    );
    assert.equal(stub.attendanceRows.length, 1);
  });
});

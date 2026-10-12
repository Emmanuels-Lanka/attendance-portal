import { Prisma } from "@prisma/client";
import { z } from "zod";

export const leaveTypeNameSchema = z.string().trim().min(1, "Name is required.").max(120);
export const leaveTypeRecordSchema = z.object({ name: leaveTypeNameSchema });

export const leaveTypeListQuerySchema = z.object({
  query: z.string().trim().default(""),
  page: z.coerce.number().int().min(1).catch(1),
  pageSize: z.coerce.number().int().min(1).max(50).catch(20),
});

const leaveQuantitySchema = z.preprocess(
  (value) => {
    if (value instanceof Prisma.Decimal) return value.toString();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return value;
  },
  z.string()
    .trim()
    .regex(/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/, "Enter a non-negative quantity with at most two decimal places.")
    .transform((value) => new Prisma.Decimal(value)),
);

const leaveDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "Enter a valid date.");

export const leaveEntitlementSchema = z.object({
  employeeId: z.string().trim().min(1, "Choose an employee."),
  leaveTypeId: z.string().trim().min(1, "Choose a Leave Type."),
  periodStart: leaveDateSchema,
  periodEnd: leaveDateSchema,
  openingBalance: leaveQuantitySchema,
  entitlement: leaveQuantitySchema,
  carryForward: leaveQuantitySchema,
  reason: z.string().trim().min(1, "Enter a reason for the entitlement change.").max(500),
}).refine((period) => period.periodEnd >= period.periodStart, {
  path: ["periodEnd"],
  message: "The entitlement period end must be on or after its start.",
});

export const leaveRequestedAmountSchema = leaveQuantitySchema.refine(
  (amount) => amount.greaterThan(0),
  "Requested Leave amount must be greater than zero.",
);

export const leaveEntitlementLookupSchema = z.object({
  employeeId: z.string().trim().min(1, "Choose an employee."),
  leaveTypeId: z.string().trim().min(1, "Choose a Leave Type."),
  periodStart: leaveDateSchema,
  periodEnd: leaveDateSchema,
}).refine((period) => period.periodEnd >= period.periodStart, {
  path: ["periodEnd"],
  message: "The entitlement period end must be on or after its start.",
});

export const approvedLeaveUsageInputSchema = z.array(z.object({
  sourceId: z.string().trim().min(1),
  employeeId: z.string().trim().min(1),
  leaveTypeId: z.string().trim().min(1),
  status: z.enum(["PENDING", "APPROVED", "REJECTED", "CANCELLED"]),
  startDate: leaveDateSchema,
  endDate: leaveDateSchema,
}).refine((item) => item.endDate >= item.startDate, {
  path: ["endDate"],
  message: "Leave end date must be on or after its start date.",
}));

export const leaveRequestInputSchema = z.object({
  leaveTypeId: z.string().trim().min(1, "Choose a Leave Type."),
  startDate: leaveDateSchema,
  endDate: leaveDateSchema,
  reason: z.string().trim().min(1, "Enter a reason for your Leave request.").max(500),
  attachmentDocumentId: z.preprocess(
    (value) => value === "" || value === undefined || value === null ? null : value,
    z.union([z.string().trim().min(1), z.null()]),
  ),
}).refine((request) => request.endDate >= request.startDate, {
  path: ["endDate"],
  message: "Leave end date must be on or after its start date.",
});

export const leaveRequestListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).catch(1),
  pageSize: z.coerce.number().int().min(1).max(50).catch(20),
});

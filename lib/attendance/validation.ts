import { z } from "zod";

export const attendanceActionTypeSchema = z.enum(["IN", "OUT", "WFH_IN", "WFH_OUT"]);

export const attendanceCoordinatesSchema = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
});

export const attendanceLocationSchema = attendanceCoordinatesSchema.extend({
  accuracy: z.number().finite().nonnegative(),
});

export const attendanceActionSchema = z.object({
  action: attendanceActionTypeSchema,
  location: attendanceLocationSchema,
});

export type AttendanceAction = z.infer<typeof attendanceActionTypeSchema>;
export type AttendanceCoordinates = z.infer<typeof attendanceCoordinatesSchema>;
export type AttendanceLocation = z.infer<typeof attendanceLocationSchema>;
export type AttendanceLocationDetails = AttendanceCoordinates & { accuracy: number | null };

export function parseAttendanceLocationDetails(value: unknown): AttendanceLocationDetails | null {
  const coordinates = attendanceCoordinatesSchema.safeParse(value);
  if (!coordinates.success) return null;

  const completeLocation = attendanceLocationSchema.safeParse(value);
  return {
    ...coordinates.data,
    accuracy: completeLocation.success ? completeLocation.data.accuracy : null,
  };
}
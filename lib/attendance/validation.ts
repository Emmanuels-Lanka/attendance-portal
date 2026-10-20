import { z } from "zod";

export const attendanceActionTypeSchema = z.enum(["IN", "OUT", "WFH_IN", "WFH_OUT"]);

export const attendanceLocationSchema = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  accuracy: z.number().finite().nonnegative(),
});

export const attendanceActionSchema = z.object({
  action: attendanceActionTypeSchema,
  location: attendanceLocationSchema,
});

export type AttendanceAction = z.infer<typeof attendanceActionTypeSchema>;
export type AttendanceLocation = z.infer<typeof attendanceLocationSchema>;
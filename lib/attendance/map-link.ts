import { attendanceCoordinatesSchema } from "./validation";

export function createAttendanceMapLink(location: unknown): string | null {
  const coordinates = attendanceCoordinatesSchema.safeParse(location);
  if (!coordinates.success) return null;

  const url = new URL("https://www.google.com/maps/search/");
  url.searchParams.set("api", "1");
  url.searchParams.set("query", `${coordinates.data.latitude},${coordinates.data.longitude}`);
  return url.toString();
}

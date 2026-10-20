import { createElement } from "react";
import { createAttendanceMapLink } from "@/lib/attendance/map-link";

export function AttendanceMapLink({ location }: { location: unknown }) {
  const href = createAttendanceMapLink(location);
  if (!href) return null;

  return createElement(
    "a",
    {
      href,
      target: "_blank",
      rel: "noopener noreferrer",
      className: "mt-1 inline-block font-sans text-xs font-medium text-[var(--blue)] underline underline-offset-2",
    },
    "Open map",
  );
}

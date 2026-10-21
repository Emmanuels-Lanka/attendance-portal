import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isValidElement, type ReactNode } from "react";
import {
  AttendanceLocationAccuracy,
  AttendanceLocationPunchLabel,
} from "../../components/attendance-location-values";

function textContent(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textContent).join("");
  if (isValidElement<{ children?: ReactNode }>(value)) return textContent(value.props.children);
  return "";
}

describe("admin attendance location display", () => {
  it("renders all supported punch labels without collapsing WFH direction", () => {
    const labels = [
      AttendanceLocationPunchLabel({ direction: "IN", workMode: "OFFICE" }),
      AttendanceLocationPunchLabel({ direction: "OUT", workMode: "OFFICE" }),
      AttendanceLocationPunchLabel({ direction: "IN", workMode: "WFH" }),
      AttendanceLocationPunchLabel({ direction: "OUT", workMode: "WFH" }),
      AttendanceLocationPunchLabel({ direction: "IN", workMode: null }),
    ];

    assert.deepEqual(labels.map(textContent), [
      "IN",
      "OUT",
      "WFH-IN",
      "WFH-OUT",
      "IN",
    ]);
  });

  it("keeps exact reported accuracy and warns only above the documented threshold", () => {
    const ordinary = textContent(AttendanceLocationAccuracy({ accuracy: 12.5 }));
    const poor = textContent(AttendanceLocationAccuracy({ accuracy: 3798.125 }));
    const unavailable = textContent(AttendanceLocationAccuracy({ accuracy: null }));

    assert.equal(ordinary, "12.5 m");
    assert.doesNotMatch(ordinary, /Low accuracy/);
    assert.match(poor, /3798\.125 m/);
    assert.match(poor, /Low accuracy/);
    assert.equal(unavailable, "—");
  });
});

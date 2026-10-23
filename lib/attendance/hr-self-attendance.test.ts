import assert from "node:assert/strict";
import { Children, createElement, isValidElement } from "react";
import { describe, it } from "node:test";
import { HrSelfAttendance } from "@/components/hr-self-attendance";

describe("HR Administrator self-attendance dashboard", () => {
  it("renders the shared attendance controls when an Employee record is linked", () => {
    const controls = createElement("div", { "data-attendance-controls": true });
    const section = HrSelfAttendance({ employeeRecordFound: true, controls });
    const renderedControls = Children.toArray(section.props.children).find((child) =>
      isValidElement<{ "data-attendance-controls"?: boolean }>(child)
      && child.props["data-attendance-controls"] === true,
    );

    assert.ok(isValidElement<{ "data-attendance-controls": boolean }>(renderedControls));
    assert.equal(renderedControls.type, "div");
    assert.equal(renderedControls.props["data-attendance-controls"], true);
  });

  it("shows an actionable status without punch controls when Employee linkage is missing", () => {
    const section = HrSelfAttendance({
      employeeRecordFound: false,
      controls: createElement("div", { "data-attendance-controls": true }),
    });
    const children = Children.toArray(section.props.children);
    const message = children
      .filter(isValidElement)
      .find((child) => child.type === "p");

    assert.ok(isValidElement<{ children: string }>(message));
    assert.match(message.props.children, /no linked Employee record/i);
    assert.match(message.props.children, /Ask an administrator to link your account/i);
    assert.equal(children.some((child) =>
      isValidElement<{ "data-attendance-controls"?: boolean }>(child)
      && child.props["data-attendance-controls"] === true,
    ), false);
  });
});

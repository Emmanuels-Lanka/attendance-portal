import assert from "node:assert/strict";
import { it } from "node:test";
import { LeaveRequestFeedback } from "./leave-request-feedback";

type RenderedNode = { props?: { children?: unknown; role?: unknown } };

function findStatusMessages(node: unknown): string[] {
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  if (Array.isArray(node)) return node.flatMap(findStatusMessages);
  if (!node || typeof node !== "object") return [];
  const element = node as RenderedNode;
  const messages = findStatusMessages(element.props?.children);
  return element.props?.role === "status" ? [messages.join("")] : messages;
}

it("renders leave submission success and refresh failure at the same time", () => {
  const rendered = LeaveRequestFeedback({
    success: "request-submitted",
    refreshStatus: "failed",
  });
  const statusMessages = findStatusMessages(rendered);

  assert.equal(statusMessages.length, 2);
  assert.ok(statusMessages.some((message) => message.includes("Your Leave request was submitted and is pending review.")));
  assert.ok(statusMessages.some((message) => message.includes("The change was saved, but the page could not refresh.")));
});

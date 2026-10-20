import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AttendanceMapLink } from "@/components/attendance-map-link";
import { createAttendanceMapLink } from "./map-link";

describe("attendance map links", () => {
  it("builds a trusted, encoded map URL for valid coordinates", () => {
    const link = createAttendanceMapLink({ latitude: 6.9271, longitude: 79.8612 });
    assert.ok(link);
    const url = new URL(link);
    assert.equal(url.origin, "https://www.google.com");
    assert.equal(url.pathname, "/maps/search/");
    assert.equal(url.searchParams.get("api"), "1");
    assert.equal(url.searchParams.get("query"), "6.9271,79.8612");
    assert.match(url.search, /%2C/);
  });

  it("rejects missing, malformed, non-finite, and out-of-range coordinates", () => {
    for (const value of [
      null,
      undefined,
      {},
      { latitude: 6.9 },
      { latitude: Number.NaN, longitude: 79.8 },
      { latitude: Number.POSITIVE_INFINITY, longitude: 79.8 },
      { latitude: 91, longitude: 79.8 },
      { latitude: 6.9, longitude: -181 },
      "6.9,79.8",
    ]) {
      assert.equal(createAttendanceMapLink(value), null);
    }
  });

  it("renders links with new-tab opener protections and omits links for unavailable locations", () => {
    const valid = AttendanceMapLink({
      location: { latitude: 6.9271, longitude: 79.8612, accuracy: null },
    });
    assert.ok(valid);
    assert.equal(valid.props.target, "_blank");
    assert.equal(valid.props.rel, "noopener noreferrer");
    assert.match(valid.props.href, /https:\/\/www\.google\.com\/maps\/search\//);

    const unavailable = AttendanceMapLink({ location: null });
    assert.equal(unavailable, null);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AttendanceGeolocationError,
  captureAttendanceLocation,
} from "./geolocation";

type GeolocationSuccess = Parameters<Geolocation["getCurrentPosition"]>[0];
type GeolocationFailure = NonNullable<Parameters<Geolocation["getCurrentPosition"]>[1]>;

function fakeGeolocation(
  respond: (success: GeolocationSuccess, failure: GeolocationFailure) => void,
) {
  return {
    getCurrentPosition: (success: GeolocationSuccess, failure?: GeolocationFailure | null) => {
      if (failure) respond(success, failure);
    },
  } as Pick<Geolocation, "getCurrentPosition">;
}

describe("attendance geolocation capture", () => {
  it("requests a fresh high-accuracy position and returns coordinates with accuracy", async () => {
    let options: PositionOptions | undefined;
    const location = await captureAttendanceLocation({
      getCurrentPosition: (success, _failure, requestedOptions) => {
        options = requestedOptions;
        success({
          coords: {
            latitude: 6.9271,
            longitude: 79.8612,
            accuracy: 10.25,
            altitude: null,
            altitudeAccuracy: null,
            heading: null,
            speed: null,
            toJSON: () => ({}),
          },
          timestamp: 0,
          toJSON: () => ({}),
        });
      },
    });

    assert.deepEqual(location, { latitude: 6.9271, longitude: 79.8612, accuracy: 10.25 });
    assert.deepEqual(options, { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 });
  });

  it("maps permission, unavailable position, and timeout errors to useful retryable messages", async () => {
    const errorCases = [
      [1, "Location permission is denied."],
      [2, "Your location is unavailable."],
      [3, "Getting your location took too long."],
    ] as const;

    for (const [code, expectedMessage] of errorCases) {
      const geolocation = fakeGeolocation((_success, failure) => {
        failure({
          code,
          message: "browser-specific detail",
          PERMISSION_DENIED: 1,
          POSITION_UNAVAILABLE: 2,
          TIMEOUT: 3,
        });
      });
      await assert.rejects(captureAttendanceLocation(geolocation), (error: Error) => {
        assert.ok(error instanceof AttendanceGeolocationError);
        assert.match(error.message, new RegExp(expectedMessage));
        assert.doesNotMatch(error.message, /browser-specific detail/);
        return true;
      });
    }
  });

  it("rejects unsupported geolocation with a clear message", async () => {
    await assert.rejects(captureAttendanceLocation(undefined), {
      name: "AttendanceGeolocationError",
      message: /cannot provide a location/,
    });
  });
});

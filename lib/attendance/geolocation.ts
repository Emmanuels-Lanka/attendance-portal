import type { AttendanceLocation } from "@/lib/attendance/validation";

export class AttendanceGeolocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttendanceGeolocationError";
  }
}

type GeolocationSource = Pick<Geolocation, "getCurrentPosition">;

export function captureAttendanceLocation(geolocation: GeolocationSource | null | undefined) {
  if (!geolocation) {
    return Promise.reject(new AttendanceGeolocationError(
      "This browser cannot provide a location. Enable device location and use a supported secure browser to clock in or out.",
    ));
  }

  return new Promise<AttendanceLocation>((resolve, reject) => {
    geolocation.getCurrentPosition(
      ({ coords }) => resolve({
        latitude: coords.latitude,
        longitude: coords.longitude,
        accuracy: coords.accuracy,
      }),
      (error) => {
        const message = error.code === error.PERMISSION_DENIED
          ? "Location permission is denied. Enable location access, then try again. A location is required to clock in or out."
          : error.code === error.POSITION_UNAVAILABLE
            ? "Your location is unavailable. Make sure location access is enabled and your device can obtain a location, then try again."
            : error.code === error.TIMEOUT
              ? "Getting your location took too long. Make sure location access is enabled and try again when your device can obtain a location."
              : "A location could not be obtained. Enable location access and try again.";
        reject(new AttendanceGeolocationError(message));
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 },
    );
  });
}

import { timingSafeEqual } from "node:crypto";

export function matchesCronBearerSecret(header: string | null, secret: string) {
  const token = header?.match(/^Bearer ([^\s]+)$/i)?.[1];
  if (!token) return false;
  const expectedBytes = Buffer.from(secret, "utf8");
  const tokenBytes = Buffer.from(token, "utf8");
  return expectedBytes.length === tokenBytes.length && timingSafeEqual(expectedBytes, tokenBytes);
}

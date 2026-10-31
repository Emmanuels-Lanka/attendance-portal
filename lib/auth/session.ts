import "server-only";

import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { findActiveSessionUser } from "@/lib/auth/session-user";
import {
  getEmployeeProfileOnboardingStatus,
  requiresProfileCompletion,
} from "@/lib/employees/profile-service";
import { hasPermission, type Permission } from "@/lib/auth/permissions";
import { measureServerOperation } from "@/lib/diagnostics/server-timing";

const cookieName = "attendance_session";
const sessionDurationSeconds = 60 * 60 * 24 * 7;

function getSessionKey() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 characters.");
  }
  return new TextEncoder().encode(secret);
}

export class AuthenticationError extends Error {
  constructor() {
    super("Please sign in to continue.");
    this.name = "AuthenticationError";
  }
}

export class AuthorizationError extends Error {
  constructor() {
    super("You do not have permission to access this resource.");
    this.name = "AuthorizationError";
  }
}

export class ProfileCompletionRequiredError extends Error {
  constructor() {
    super("Complete your employee profile before continuing.");
    this.name = "ProfileCompletionRequiredError";
  }
}

export async function createSession(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { sessionVersion: true },
  });
  if (!user) throw new AuthenticationError();

  const token = await new SignJWT({ sessionVersion: user.sessionVersion })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuer("attendance-system")
    .setAudience("attendance-app")
    .setIssuedAt()
    .setExpirationTime(`${sessionDurationSeconds}s`)
    .sign(getSessionKey());

  const cookieStore = await cookies();
  cookieStore.set(cookieName, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: sessionDurationSeconds,
  });
}

export async function destroySession() {
  const cookieStore = await cookies();
  cookieStore.delete(cookieName);
}

export async function getCurrentUser(route = "unknown") {
  return measureServerOperation(route, "auth.session_lookup", async () => {
    const cookieStore = await cookies();
    const token = cookieStore.get(cookieName)?.value;
    if (!token) return null;

    let userId: string;
    let sessionVersion: number;
    try {
      const { payload } = await jwtVerify(token, getSessionKey(), {
        issuer: "attendance-system",
        audience: "attendance-app",
        algorithms: ["HS256"],
      });
      if (!payload.sub) return null;
      userId = payload.sub;
      const versionClaim = (payload as typeof payload & { sessionVersion?: unknown }).sessionVersion ?? 0;
      if (typeof versionClaim !== "number" || !Number.isSafeInteger(versionClaim) || versionClaim < 0) return null;
      sessionVersion = versionClaim;
    } catch {
      return null;
    }

    return findActiveSessionUser(userId, undefined, sessionVersion, route);
  });
}

export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) throw new AuthenticationError();
  if (requiresProfileCompletion(user.role, (await getEmployeeProfileOnboardingStatus(user.id)).required)) {
    throw new ProfileCompletionRequiredError();
  }
  return user;
}

export async function requireAdmin() {
  const user = await requireUser();
  if (user.role !== "ADMIN") throw new AuthorizationError();
  return user;
}

export async function requirePermission(permission: Permission) {
  const user = await requireUser();
  if (!hasPermission(user.role, permission)) throw new AuthorizationError();
  return user;
}

export async function requirePageUser(route = "unknown") {
  const user = await getCurrentUser(route);
  if (!user) redirect("/login");
  const profileStatus = await measureServerOperation(route, "auth.profile_status_lookup", () => (
    getEmployeeProfileOnboardingStatus(user.id)
  ));
  if (requiresProfileCompletion(user.role, profileStatus.required)) {
    redirect("/complete-profile");
  }
  return user;
}

export async function requirePagePermission(permission: Permission, route = "unknown") {
  const user = await requirePageUser(route);
  const allowed = await measureServerOperation(route, "auth.permission_check", () => hasPermission(user.role, permission));
  if (!allowed) redirect("/dashboard");
  return user;
}

export async function requirePageAdmin() {
  const user = await requirePageUser();
  if (user.role !== "ADMIN") redirect("/dashboard");
  return user;
}
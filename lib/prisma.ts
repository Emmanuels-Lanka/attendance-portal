import { Prisma, PrismaClient } from "@prisma/client";
import { logPrismaQueryTiming, serverTimingEnabled } from "@/lib/diagnostics/server-timing";

type PrismaWithQueryEvents = PrismaClient<{
  log: Array<Prisma.LogLevel | Prisma.LogDefinition>;
}>;

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaWithQueryEvents;
  prismaQueryTimingAttached?: boolean;
};
const queryTimingEnabled = serverTimingEnabled;
const prismaLogLevels: Array<Prisma.LogLevel | Prisma.LogDefinition> = [
  ...(process.env.NODE_ENV === "development" ? ["warn", "error"] as const : ["error"] as const),
  ...(queryTimingEnabled ? [{ emit: "event", level: "query" } as const] : []),
];

export const prisma: PrismaWithQueryEvents =
  globalForPrisma.prisma ??
  new PrismaClient<{ log: Array<Prisma.LogLevel | Prisma.LogDefinition> }>({
    log: prismaLogLevels,
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

if (queryTimingEnabled && !globalForPrisma.prismaQueryTimingAttached) {
  prisma.$on("query", (event) => {
    logPrismaQueryTiming(event.duration);
  });
  globalForPrisma.prismaQueryTimingAttached = true;
}
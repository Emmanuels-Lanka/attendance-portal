let prisma;
const legacyEmail = "admin@example.com";
const usernamePattern = /^[a-z0-9._-]{3,30}$/;

function normalizeAdminUsername(username) {
  if (typeof username !== "string") {
    throw new Error("ADMIN_USERNAME is required to create the initial administrator.");
  }
  const normalized = username.trim().toLowerCase();
  if (!usernamePattern.test(normalized)) {
    throw new Error("ADMIN_USERNAME must be 3-30 characters using letters, numbers, periods, underscores, or hyphens.");
  }
  return normalized;
}

function planAdminSeed(existingAdmin, legacyAccount, existingAdminAccount) {
  if (existingAdmin) {
    if (existingAdmin.role === "ADMIN" && existingAdmin.isActive) {
      if (legacyAccount?.role === "ADMIN" && legacyAccount.isActive) {
        throw new Error("An active legacy administrator also exists. Resolve it manually; no changes were made.");
      }
      return existingAdmin.username ? "unchanged" : "assign-username";
    }
    throw new Error("The configured admin email belongs to an inactive or non-admin account. No changes were made.");
  }
  if (legacyAccount) {
    throw new Error("A legacy admin account exists. Resolve it manually before seeding; no changes were made.");
  }
  if (existingAdminAccount) {
    throw new Error("An administrator account already exists. Seed will not create another administrator.");
  }
  return "create";
}

function planAdminUsernameAssignment(existingAdmin, usernameOwner) {
  if (existingAdmin.username || usernameOwner?.id === existingAdmin.id) return "unchanged";
  if (usernameOwner) throw new Error("ADMIN_USERNAME is already assigned to another account. No changes were made.");
  return "assign";
}

function isUniqueConstraintError(error) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

async function ensureExistingAdminUsername(database, existingAdmin, username) {
  const usernameOwner = await database.user.findFirst({ where: { username }, select: { id: true } });
  if (planAdminUsernameAssignment(existingAdmin, usernameOwner) === "unchanged") return false;

  try {
    await database.user.update({ where: { id: existingAdmin.id }, data: { username } });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new Error("ADMIN_USERNAME is already assigned to another account. No changes were made.");
    }
    throw error;
  }
  return true;
}

module.exports = {
  ensureExistingAdminUsername,
  isUniqueConstraintError,
  normalizeAdminUsername,
  planAdminSeed,
  planAdminUsernameAssignment,
};

async function main() {
  const [{ PrismaClient }, { default: bcrypt }] = await Promise.all([
    import("@prisma/client"),
    import("bcryptjs"),
  ]);
  prisma = new PrismaClient();
  const name = process.env.ADMIN_NAME?.trim();
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const username = process.env.ADMIN_USERNAME;
  const countryCode = process.env.ADMIN_COUNTRY_CODE?.trim().toUpperCase();
  const timeZone = process.env.ADMIN_TIME_ZONE?.trim();
  const password = process.env.ADMIN_PASSWORD;

  if (!name || !email || !username || !countryCode || !timeZone || !password) {
    throw new Error("Set ADMIN_NAME, ADMIN_EMAIL, ADMIN_USERNAME, ADMIN_COUNTRY_CODE, ADMIN_TIME_ZONE, and ADMIN_PASSWORD before seeding.");
  }
  const normalizedUsername = normalizeAdminUsername(username);
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    throw new Error("ADMIN_COUNTRY_CODE must be a two-letter country code.");
  }

  const countryTimeZones = { LK: "Asia/Colombo", BD: "Asia/Dhaka" };
  if (countryTimeZones[countryCode] && countryTimeZones[countryCode] !== timeZone) {
    throw new Error(`${countryCode} employees must use ${countryTimeZones[countryCode]}.`);
  }
  if (timeZone !== "UTC" && !Intl.supportedValuesOf("timeZone").includes(timeZone)) {
    throw new Error("ADMIN_TIME_ZONE must be a supported IANA timezone.");
  }

  if (bcrypt.truncates(password)) {
    throw new Error("ADMIN_PASSWORD must not exceed 72 UTF-8 bytes.");
  }

  const existingAdmin = await prisma.user.findUnique({
    where: { email },
    select: { id: true, role: true, isActive: true, username: true },
  });
  const legacyAccount = email === legacyEmail
    ? null
    : await prisma.user.findUnique({ where: { email: legacyEmail }, select: { id: true, role: true, isActive: true } });
  const existingAdminAccount = existingAdmin
    ? null
    : await prisma.user.findFirst({ where: { role: "ADMIN" }, select: { id: true } });
  const action = planAdminSeed(existingAdmin, legacyAccount, existingAdminAccount);

  if (action === "unchanged") {
    console.info("Configured administrator already exists; no changes were made.");
    return;
  }

  if (action === "assign-username") {
    const assigned = await ensureExistingAdminUsername(prisma, existingAdmin, normalizedUsername);
    if (!assigned) {
      console.info("Configured administrator already has a username; no changes were made.");
      return;
    }
    console.info("Username assigned to the existing configured administrator.");
    return;
  }
  const existingUsername = await prisma.user.findFirst({ where: { username: normalizedUsername }, select: { id: true } });
  if (existingUsername) throw new Error("ADMIN_USERNAME is already assigned to an account. No changes were made.");

  const passwordHash = await bcrypt.hash(password, 12);
  await prisma.user.create({
    data: { name, email, username: normalizedUsername, countryCode, timeZone, passwordHash, role: "ADMIN", isActive: true },
  });
  console.info("Initial administrator account created.");
}

if (require.main === module) {
  main()
    .catch((error) => {
      const errorName = error instanceof Error ? error.name : "UnknownError";
      console.error(`Database seed failed (${errorName}).`);
      process.exitCode = 1;
    })
    .finally(async () => prisma?.$disconnect());
}
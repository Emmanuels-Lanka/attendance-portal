# Deployment Preparation Report

Date: 2026-10-02

Historical snapshot of the earlier Vercel/Neon preparation. It does not describe the current AWS Amplify deployment; use `DEPLOYMENT.md` for current hosting guidance.

## Summary

Prepared the repository for Vercel and Neon without logging into either service or changing any database. Prisma is configured for a pooled runtime URL and a direct CLI/migration URL. The Prisma model now matches the checked-in operational migration for audit attribution and correction-request uniqueness. A local database still has both migrations pending despite already containing the migrated tables; do not run migrations against that database until its history is reconciled.

This work does not claim that the application has been deployed or is production-ready. Neon, Vercel, and migration behavior on a disposable PostgreSQL target remain unverified.

## Configuration Reviewed

- `package.json` and `package-lock.json`: Next.js 15, Prisma 6, npm scripts. `npm run build` runs Prisma Client generation before `next build`; `db:migrate:deploy` is the production migration command; `db:migrate` is `prisma migrate dev` and must not be used in production.
- `next.config.ts`: empty standard Next.js config. No `vercel.json` was present or added.
- `prisma.config.ts`, `prisma/schema.prisma`, `prisma/migrations/`, and migration lock: PostgreSQL provider and two checked-in migrations.
- `lib/prisma.ts`: module-scoped Prisma client, development-only global reuse, production error-only Prisma logging.
- Authentication: JWT session uses `SESSION_SECRET`, issuer/audience and HS256 verification; seven-day `httpOnly`, `SameSite=Lax` cookie with `Secure` in production. Page and action paths enforce employee/admin authorization.
- Server actions and route handlers use Next.js server APIs. PDF exports use Node/PDFKit and the production route traces include `public/eml-company-logo.png` for the export handlers.
- Environment references: `DATABASE_URL`, `DIRECT_URL`, `SESSION_SECRET`, five one-time `ADMIN_*` seed variables, plus `NODE_ENV`. No application base URL or other integration variable is read.
- `.gitignore` excludes `.env` and `.env.*`, with `.env.example` explicitly allowed. Local `.env` values were not displayed or committed.
- Current branch was `main`, initially equal to `origin/main`. No unrelated worktree changes were present.

## Files Changed

- `.env.example`: added a placeholder `DIRECT_URL`.
- `prisma/schema.prisma`: added `directUrl = env("DIRECT_URL")`; aligned audit fields/relation and correction uniqueness with the operational migration.
- `README.md`: replaced conditional migration-baselining instructions with the deployment guide link and both connection URLs.
- `DEPLOYMENT.md`: added Neon, Vercel, migration, environment, and post-deployment procedures.
- `DEPLOYMENT_PREPARATION_REPORT.md`: this report.

No changes were made to migration SQL, application attendance logic, authentication behavior, package scripts, Next configuration, or the database.

## Vercel Preparation

- Standard Next.js deployment settings are sufficient; no custom Vercel config is required.
- Production build completed locally. It generated Prisma Client, compiled Next.js, generated static pages, and collected route traces.
- Both PDF export route traces include the public logo asset. No persistent filesystem writes or server-local state requirement was found.
- Redirects are relative (`/login`, `/dashboard`); no absolute app URL variable is used.
- Recommend a supported Node.js 22.x runtime in Vercel settings. Local verification used Node.js 24.19.0; Node 22 was not available for a separate runtime test.
- The build does not apply migrations or run seed data. Keep both actions outside Vercel's automatic build.

## Neon and Prisma

- Installed versions: Prisma CLI and client 6.19.3; Next.js 15.5.26.
- `DATABASE_URL` is the Neon pooled URL for application queries. `DIRECT_URL` is the direct, non-pooler URL for Prisma CLI and migrations. Prisma generation/build requires both schema datasource variables to be configured.
- Prisma Client generation and final schema validation passed with placeholder-only direct URL input. No production endpoint was contacted.
- The existing `db:migrate:deploy` script is appropriate only after target state is confirmed. `db:migrate` (`prisma migrate dev`) is development-only. Never use `db push`, reset, seeding, or automatic migration hooks on an existing production database.

## Migration Findings

The initial migration creates `User`, `AttendanceRecord`, and `WorkSession`. The operational migration adds correction requests, audit logs, notifications, and settings. It drops `AttendanceCorrectionRequest_employeeId_sessionId_status_key`, makes audit `employeeId` nullable with `ON DELETE SET NULL`, and adds `settingKey` with its index.

The former Prisma model conflicted with those committed migration operations and with the settings service, which writes `settingKey` without an employee ID. The model has now been aligned: audit employee attribution is optional with `SetNull`, `settingKey` and its index are represented, and the dropped correction-request unique constraint is no longer declared. The correction-request workflow itself was not found in current app/service code; confirm the intended duplicate-request behavior before implementing that workflow.

Read-only local findings:

- Before the model alignment, the local physical schema diff against the old Prisma model was empty.
- `prisma migrate status` reported both checked-in migrations pending on that local database.
- Against the updated model, a read-only diff showed the operational changes listed above: drop the old audit foreign key and correction unique index, make audit `employeeId` nullable, add `settingKey` and its index, and add the `SET NULL` audit foreign key.
- The local database already has the operational tables while migration history is pending. The initial migration creates tables without `IF NOT EXISTS`; blindly running `migrate deploy` there is unsafe and is expected to encounter existing relations. No migration, baseline, seed, `db push`, reset, or SQL write was run.

This local finding does not establish the state of a new Neon database or another existing database. For a verified-empty Neon database, rehearse both migrations on an empty disposable PostgreSQL target, verify the resulting schema, then run `npm run db:migrate:deploy` against production from a controlled operator environment. For an existing database, take/test a backup, inspect `_prisma_migrations`, compare the physical schema with the migration sequence and current model, and stop for owner-reviewed reconciliation if anything differs. Do not blindly apply migrations or use `migrate resolve` to baseline based only on a model diff.

## Environment Variables

- `DATABASE_URL`: Neon pooled PostgreSQL URL; build and runtime.
- `DIRECT_URL`: Neon direct PostgreSQL URL; build and Prisma CLI/migrations.
- `SESSION_SECRET`: runtime-only session key, unique per environment, at least 32 characters.
- `ADMIN_NAME`, `ADMIN_EMAIL`, `ADMIN_COUNTRY_CODE`, `ADMIN_TIME_ZONE`, `ADMIN_PASSWORD`: one-time controlled seed operation only; not required in Vercel builds.
- No app base URL or other integrations are currently required.

The session module produces a clear configuration error for a missing/short session secret. Prisma reports when datasource environment values are missing. `.env.example` contains placeholders only.

## Production Readiness Findings

- Authentication and authorization: server-verified signed sessions, active-account lookup, secure production cookie flags, generic incorrect-credential response, and admin checks on protected pages/actions. These controls were inspected but not penetration-tested.
- Password handling: existing bcrypt-based verification and seed hashing; public employee selections avoid returning password hashes.
- Audit/correction integrity: admin attendance correction is transactional, validates employee-local wall times, and writes an audit entry. The operational migration preserves audit rows on employee deletion by setting `employeeId` to null.
- Timezones: timestamps are instants; employee-local day/month windows use validated IANA zones. Existing tests cover Colombo, Dhaka, and daylight-saving cases.
- Error handling/logging: login logs the error type rather than submitted credentials; production Prisma logging is errors only. External error monitoring is not configured.
- Rate limiting: no login rate limiting or account lockout was found. Decide on an edge/WAF or application-level control before broad exposure.
- Database connection behavior: module-scoped Prisma client is appropriate for reused serverless modules; use Neon pooling for runtime and direct connection for migration work.
- Sensitive data: employee and attendance reports are behind employee/admin authorization; no secrets were found in tracked env examples. Operational log review and least-privilege Neon/Vercel access remain deployment responsibilities.
- No broad architecture, attendance-rule, or UI changes were made.

## Verification Results

- `npm test`: **82 tests**, 15 suites; **81 passed, 0 failed, 1 skipped**. The skipped test is the PostgreSQL concurrency integration test, which is opt-in and requires an explicitly configured integration database.
- `npm run typecheck`: passed after Prisma Client regeneration.
- `npm run lint`: passed.
- `npm run db:validate`: passed against the final schema.
- `npm run db:generate`: passed with Prisma 6.19.3.
- `npm run build`: passed with Next.js 15.5.26; production route traces include the PDF logo.
- Local schema diff and migration status: inspection only; results are detailed above.
- Vercel deployment, Neon connection, disposable-database migration rehearsal, production database backup/restore, and production browser flows: not run; require user-owned services/credentials or a separately provisioned test database.

## Commits

- `bc9ee18` — `configure prisma for neon` (pushed to `origin/main`).
- `8c28c64` — `add deployment guide` (pushed to `origin/main`; includes this report).

## Manual Steps

1. Create a Neon PostgreSQL project and keep the pooled and direct connection strings private.
2. Import the GitHub repository into Vercel, set `main` as the production branch, and select the repository's standard Next.js build.
3. Configure `DATABASE_URL`, `DIRECT_URL`, and a unique `SESSION_SECRET` in the appropriate Vercel environments. Use separate Neon branches and secrets for preview deployments.
4. Rehearse migration deployment on an empty disposable PostgreSQL database/Neon branch. Confirm production is actually empty before following the fresh-database procedure; otherwise follow the existing-database reconciliation procedure.
5. Run the initial administrator seed once from a controlled private environment only after the target schema is ready.
6. Review Vercel build/runtime logs, verify login, employee attendance, admin review, reports/PDFs and timezone boundaries, and configure monitoring plus backup/restore checks.

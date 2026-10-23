# Deployment Guide

This project uses Next.js 15, Prisma 6, and PostgreSQL. `vercel.json` configures the production daily attendance calculation cron. The production build runs `prisma generate` before `next build`; it does not run database migrations or seed data.

> **Migration caution:** The Prisma model now reflects the checked-in migration sequence. A fresh, verified-empty database can use that sequence after a disposable-database rehearsal. An existing database with unrecorded migrations is a different case and must be reconciled before applying anything.

## Neon Setup

1. Create a Neon project and select PostgreSQL. Choose the region closest to the Vercel deployment region, subject to your data residency needs.
2. In Neon, open the connection details for the database/branch you intend to use. Keep TLS enabled and copy both connection strings without sharing or committing them.
3. Use the pooled connection (the host typically contains `-pooler`) for `DATABASE_URL`. It is used by the deployed application for Prisma queries and is suited to serverless connection reuse.
4. Use the direct, non-pooler connection for `DIRECT_URL`. Prisma 6 uses this for schema and migration operations that need a direct PostgreSQL connection. Do not use the pooled URL for migration commands.
5. Set `DATABASE_URL` and `DIRECT_URL` independently in each environment. They may point at the same Neon database and differ only by pooler endpoint. Verify that both target the intended branch/database before any migration.

Do not put credentials in Git, screenshots, issue text, build output, or this guide. Rotate credentials if they are exposed. `.env` and `.env.*` are gitignored; only the placeholder `.env.example` is tracked.

## Vercel Setup

1. Import `kavithz/eliot-portal-attendance` from GitHub in Vercel and grant only the required repository access.
2. Set `main` as the Production Branch. Leave Preview deployments enabled only if you provide them with separate Neon preview branches and separate secrets.
3. Confirm the framework is detected as Next.js. Use the repository root, default install command (`npm install` or `npm ci`), and the package build command (`npm run build`). No custom output directory is needed. The build command generates Prisma Client and builds Next.js.
4. Select a supported Node.js 22.x runtime in the Vercel project settings (or a newer version supported by this project and Prisma 6).
5. Add these Production Environment Variables:
   - `DATABASE_URL`: Neon pooled connection string.
   - `DIRECT_URL`: Neon direct connection string.
   - `SESSION_SECRET`: a unique random value with at least 32 characters. Generate a different value for Preview and Development; never use the example value.
6. Add `CRON_SECRET` as a unique, high-entropy Production Environment Variable. Vercel sends it as a Bearer token to the configured cron route. Do not put it in client variables, URLs, or logs. The endpoint returns `503` until this is configured.
7. `ADMIN_NAME`, `ADMIN_EMAIL`, `ADMIN_USERNAME`, `ADMIN_COUNTRY_CODE`, `ADMIN_TIME_ZONE`, and `ADMIN_PASSWORD` are only required when running the one-time initial-admin seed. Do not run seeding from the Vercel build. Prefer a controlled, private operator environment for that one-time command and remove/unset those secrets afterward.
8. Deploy and inspect the build log and deployment status. Confirm the build has completed Prisma Client generation and Next.js compilation, and verify the production cron is listed in Vercel Cron Jobs. A successful build does not prove that the database is migrated, reachable, or safe to use.

## Daily Attendance Calculation

`vercel.json` schedules `GET /api/attendance/calculate-daily` once daily at **00:15 UTC** in the Production deployment. This job remains separate from punch reconciliation. Both cron endpoints require `CRON_SECRET`; Vercel sends it as a bearer authorization value when configured for Cron. Do not add this secret to `NEXT_PUBLIC_*` variables or expose it in browser code.

With no query parameters, the job calculates the previous completed calendar day separately in each eligible linked employee's IANA timezone. Eligible users are active accounts with `EMPLOYEE` or `HR_ADMINISTRATOR` role. For an authorized operator rerun, append one `date=YYYY-MM-DD` parameter; the selected date must be within the previous seven completed days for every processed employee. The endpoint rejects unsupported query parameters, repeated dates, invalid dates, future/current employee-local dates, and dates outside that window.

Processing is capped at 100 eligible linked Employee records per invocation and uses bounded reads, a PostgreSQL transaction-level advisory lock to reject overlapping jobs, and the existing per-employee row lock. Unlinked Employee records are excluded from calculation and the cap, and returned in a separate count. Inactive users and other roles are not recalculated. If eligible work exceeds the cap, the invocation fails before calculating any employee. The transaction has a 45-second timeout and the route requests a 60-second Vercel function duration, so confirm the deployed runtime supports it. A concurrent invocation receives HTTP 409. Approved correction rows are skipped to preserve the final reviewed values. Invalid timezone, missing applicable shift, or invalid shift configuration are reported as failures; the job does not invent statuses or create shifts.

The existing engine does not define an `ABSENT` result for a scheduled workday with no punches: with a configured shift it produces `UNDETERMINED`. A lone unmatched IN or OUT is classified using the existing `MISSING_PUNCH` rule. A day with no applicable Shift fails calculation unless it qualifies for the engine's existing optional-workday behavior. The job does not assign shifts or add new status semantics; resolve configuration failures before retrying.

The response contains counts and error categories only, not employee identities. Any employee-level failure causes HTTP 500 with the partial calculation summary; valid rows are committed and can be safely recalculated. An infrastructure failure rolls the transaction back and returns HTTP 500 without claiming success. Check Vercel Function logs and Cron Job invocation history after deployment. Resolve the reported configuration or infrastructure issue and rerun the affected date using the protected `date` parameter. Do not retry by changing raw punches or approved corrections.

## Durable Punch Reconciliation

Punch/session writes and one outbox task per Employee/local date commit in the same database transaction. If that transaction cannot commit, neither the punch nor its task is guaranteed; the punch request must fail rather than claim success. Once committed, later calculation failures cannot roll back the punch.

`GET /api/attendance/reconcile-daily` is a separate, secret-protected worker scheduled every five minutes by `vercel.json`. Confirm the live Vercel plan supports this schedule: [current Vercel Cron documentation](https://vercel.com/docs/cron-jobs/usage-and-pricing) says Hobby is limited to once-daily schedules, while Pro and Enterprise support minute-level schedules. The route requests a 60-second duration; [current Function limits](https://vercel.com/docs/functions/limitations) list 300 seconds for Hobby and 300 seconds default/800 maximum for Pro and Enterprise. Confirm the live project/runtime configuration before relying on either limit; this repository cannot establish the deployed plan. Do not deploy this schedule on an unsupported plan.

The worker claims at most two due tasks per invocation using `FOR UPDATE SKIP LOCKED`, commits those short-lived claims, then processes each task in its own transaction (8-second timeout; 2-second max wait). A lease lasts 90 seconds and is recovered after expiry. This bounds claim plus calculation/retry transactions to approximately 50 seconds at their configured maxima, below the route's requested 60-second function duration. The nominal schedule can attempt up to 576 tasks per day when every five-minute invocation runs once; failures and invocation delays reduce that capacity. Alert on growing pending/retry counts and provide a supported external scheduling capacity before organizations can exceed this rate. Processing acquires locks in User → Employee → task-row order; the worker never holds a task-row lock while waiting for User or Employee locks. It reads raw punches afresh in the IANA timezone stored with the task and uses the existing attendance engine. Daily-row persistence and completion of the claimed version are atomic. A newer punch serializes on the User lock and leaves a newer requested version pending for a subsequent calculation. Approved corrections transition tasks to `PROTECTED` and are never overwritten.

Retries use capped exponential backoff starting at one minute (doubling per attempt, capped at six hours), with eight total claims. Exhausted work remains recoverable in `DEAD_LETTER`; it is not deleted. Worker logs contain aggregate counts and error class names only. Monitor the reconciliation Function logs and Cron invocation history for retries, dead letters, and tasks skipped because their Employee record became unlinked.

### Dead-letter inspection and requeue runbook

Only an authorized database operator may inspect or update the queue. Use the approved production access path, record the task ID and reason in the operational ticket, and do not copy employee or punch data into logs or tickets. Inspect only the minimum columns:

```sql
SELECT "id", "status", "attempts", "lastErrorCategory", "updatedAt"
FROM "attendance_daily_calculation_tasks"
WHERE "status" = 'DEAD_LETTER'
ORDER BY "updatedAt" ASC
LIMIT 50;
```

After resolving the reported configuration or infrastructure issue, requeue one reviewed task by its exact ID:

```sql
UPDATE "attendance_daily_calculation_tasks"
SET "status" = 'PENDING',
    "attempts" = 0,
    "availableAt" = CURRENT_TIMESTAMP,
    "leaseToken" = NULL,
    "leaseExpiresAt" = NULL,
    "claimedVersion" = NULL,
    "lastErrorCategory" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = '<reviewed-task-id>'
  AND "status" = 'DEAD_LETTER';
```

Verify exactly one row was updated, then confirm the worker completes the task or it is dead-lettered again. Do not requeue using broad employee/date predicates, bypass approved-correction protection, or edit raw punches as a recovery action.

For local verification, set `CRON_SECRET` only in the ignored local `.env`, start PostgreSQL and the app using the normal local setup, and invoke the endpoint with a local HTTP client:

```sh
curl -i -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/attendance/calculate-daily
curl -i -H "Authorization: Bearer $CRON_SECRET" "http://localhost:3000/api/attendance/calculate-daily?date=YYYY-MM-DD"
```

Invoke the local reconciliation worker with `curl -i -H 'Authorization: Bearer <CRON_SECRET>' http://localhost:3000/api/attendance/reconcile-daily` and verify it returns aggregate queue counts. Use a disposable/local database with representative employees, shifts, punches, and an approved correction. Verify the daily page, then repeat the same date to confirm recalculation updates rather than duplicates the row. Verify missing/invalid credentials are rejected. Never use production attendance data for local tests.

No application base URL variable is currently read by the code. Redirects are relative paths, and production cookies are marked `Secure` based on `NODE_ENV=production`; HTTPS should remain enabled at the hosting edge.

## Prisma Production Migrations

### Before any migration

- Confirm the target Neon project, branch, and database from both URLs. Ensure `DIRECT_URL` is the direct endpoint and points to the same target as `DATABASE_URL`.
- Take a recoverable backup or Neon restore point, and verify the recovery procedure. For an existing database, test restoration to a separate branch/database before proceeding.
- Review `_prisma_migrations` and run `npx prisma migrate status` against the target using `DIRECT_URL`. This is an inspection step; do not run migration resolution based only on a pending status.
- Compare the live schema with the Prisma model using the read-only diff command below. Review its output as SQL; never pipe it into `psql` or apply it automatically.

```sh
npx prisma migrate status
npx prisma migrate diff --from-url "$DIRECT_URL" --to-schema-datamodel prisma/schema.prisma --script
```

### Migration sequence and observed local database

The migration chain begins with the initial attendance schema and the operational audit/workflow migrations; later migrations add user sessions, employee data, shifts, approvals, corrections, and other application features. The operational migration:

- drops `AttendanceCorrectionRequest_employeeId_sessionId_status_key`;
- makes `AttendanceAuditLog.employeeId` nullable with `ON DELETE SET NULL`;
- adds `AttendanceAuditLog.settingKey` and its index.

This feature adds `20261023000000_attendance_daily_calculation_tasks`, which creates the durable versioned outbox and punch-event idempotency tables plus their indexes/foreign keys. It must be applied through the reviewed migration process described below; the only application during development was to an isolated disposable local test database.

An observed local database had both migrations pending even though its physical schema already contained the operational tables. Before this model update, its schema diff was empty; against the current model, the read-only diff reports the expected operational changes: drop the old employee foreign key and correction-request unique index, make audit `employeeId` nullable, add `settingKey` and its index, then add the `SET NULL` employee foreign key. This evidence applies only to that local database, not to Neon. Since the initial migration creates tables without `IF NOT EXISTS`, do not run `migrate deploy` against a database where those tables already exist but migration history says both are pending.

Preserve the committed migration files and any target's migration history. Review correction-request duplicates and audit-log employee deletion behavior before executing the operational migration on existing records. Rehearse the complete migration sequence against a disposable PostgreSQL database/Neon branch first.

### Empty Neon database

For a genuinely empty Neon database, first verify the target is empty and rehearse the full migration chain on a disposable empty PostgreSQL database or Neon branch. Confirm the resulting schema matches the current Prisma model and run application tests against the disposable target. Back up/confirm the actual production target is empty, then run `npm run db:migrate:deploy` from a controlled environment. Do not run this command in a Vercel build or as an automatic deployment hook.

After the schema is migrated, create the first administrator once from a controlled environment by configuring all five `ADMIN_*` values and running `npm run db:seed`. The seed is create-only and deliberately refuses ambiguous existing administrator states. Do not rerun it to update or reactivate accounts.

### Existing database with attendance records

Do not treat an existing database as fresh, even if it was originally created with `prisma db push`. Freeze or coordinate writes, make and test a backup, inspect the migration table and physical schema, and compare them independently with both the checked-in migration sequence and current Prisma model. Have a database owner review constraints, nullability, indexes, foreign keys, and representative data. If any of those states disagree, stop for a reviewed reconciliation plan and staging rehearsal. Do not blindly run `migrate deploy`, `db push`, `migrate resolve`, `migrate reset`, or a seed command; do not baseline by marking a migration applied merely because a model diff is empty.

The production command, only after the migration chain has been reconciled and rehearsed, is:

```sh
npm run db:migrate:deploy
```

Run it once from an operator-controlled environment with production credentials, confirm its exit status, then inspect migration status and application health. Never use `npm run db:migrate` (`prisma migrate dev`) against production. No database-changing command was run as part of this preparation.

## Environment Variables

| Variable | Required where | Source / purpose |
| --- | --- | --- |
| `DATABASE_URL` | Build and runtime | Neon pooled PostgreSQL URL; Prisma runtime connection |
| `DIRECT_URL` | Build and Prisma CLI | Neon direct PostgreSQL URL; Prisma migration/schema connection |
| `SESSION_SECRET` | Runtime | Unique session-signing secret, minimum 32 characters |
| `ADMIN_NAME` | One-time seed only | Initial administrator name |
| `ADMIN_EMAIL` | One-time seed only | Initial administrator email |
| `ADMIN_USERNAME` | One-time seed only | Initial administrator username (3–30 letters, numbers, periods, underscores, or hyphens) |
| `ADMIN_COUNTRY_CODE` | One-time seed only | Two-letter country code |
| `ADMIN_TIME_ZONE` | One-time seed only | Supported IANA timezone |
| `ADMIN_PASSWORD` | One-time seed only | Strong initial password, at most 72 UTF-8 bytes |

The code has no configured OAuth, email, analytics, or other external integration variables. No application base URL is currently required. Authentication reports a clear configuration error when `SESSION_SECRET` is missing or too short; Prisma reports datasource configuration errors if either database URL is absent.

## Post-deployment Checks

After migrations and first-admin setup are safely complete:

- Sign in as the initial administrator; verify unauthenticated users are sent to `/login` and non-admin users cannot access admin pages/actions.
- Create or use a test employee and verify office/WFH attendance start, stop, and history.
- Review attendance in the admin area and test a correction on non-production test data; confirm the audit record is present.
- Verify employee and admin reports, including PDF downloads.
- Check date boundaries and displayed times for employees in their configured IANA timezones, including daylight-saving transitions where applicable.
- Inspect Vercel function/build logs for errors without logging secrets or attendance contents. Add external error monitoring and alerting if required; none is configured in this repository.
- Confirm Neon backup/restore retention and periodically test recovery to a separate branch.

Login rate limiting is not implemented in this application. Decide whether to add an edge/WAF or application-level control before exposing accounts broadly. Keep this decision separate from the deployment preparation so it can be threat-modeled and tested.

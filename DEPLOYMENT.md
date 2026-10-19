# Deployment Guide

This project uses Next.js 15, Prisma 6, and PostgreSQL. No `vercel.json` is required. The production build runs `prisma generate` before `next build`; it does not run database migrations or seed data.

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
3. Confirm the framework is detected as Next.js. Use the repository root, default install command (`npm install` or `npm ci`), and the package build command (`npm run build`). No custom output directory or `vercel.json` is needed. The build command generates Prisma Client and builds Next.js.
4. Select a supported Node.js 22.x runtime in the Vercel project settings (or a newer version supported by this project and Prisma 6).
5. Add these Production Environment Variables:
   - `DATABASE_URL`: Neon pooled connection string.
   - `DIRECT_URL`: Neon direct connection string.
   - `SESSION_SECRET`: a unique random value with at least 32 characters. Generate a different value for Preview and Development; never use the example value.
6. `ADMIN_NAME`, `ADMIN_EMAIL`, `ADMIN_USERNAME`, `ADMIN_COUNTRY_CODE`, `ADMIN_TIME_ZONE`, and `ADMIN_PASSWORD` are only required when running the one-time initial-admin seed. Do not run seeding from the Vercel build. Prefer a controlled, private operator environment for that one-time command and remove/unset those secrets afterward.
7. Deploy and inspect the build log and deployment status. Confirm the build has completed Prisma Client generation and Next.js compilation. A successful build does not prove that the database is migrated, reachable, or safe to use.

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

The repository has two migration files. The initial migration creates `User`, `AttendanceRecord`, and `WorkSession`. The operational migration creates correction requests, audit logs, notifications, and settings. The operational migration:

- drops `AttendanceCorrectionRequest_employeeId_sessionId_status_key`;
- makes `AttendanceAuditLog.employeeId` nullable with `ON DELETE SET NULL`;
- adds `AttendanceAuditLog.settingKey` and its index.

The Prisma model now matches those operational decisions. This also matches the settings audit implementation, which writes `settingKey` without an employee relation. The correction-request composite uniqueness behavior is therefore removed; no correction-request workflow was found in the current app/services, so confirm that behavior before implementing one.

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

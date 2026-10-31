# Deployment Guide

This project uses Next.js 15, Prisma 6, and PostgreSQL. The production build runs `prisma generate` before `next build`; it does not run database migrations or seed data.

> **Migration caution:** The Prisma model now reflects the checked-in migration sequence. A fresh, verified-empty database can use that sequence after a disposable-database rehearsal. An existing database with unrecorded migrations is a different case and must be reconciled before applying anything.

## PostgreSQL Database

The application requires PostgreSQL. The following connection guidance is specific to Neon; verify the actual production database provider and target independently before changing either connection string.

1. Create a Neon project and select PostgreSQL. Choose a region that meets your latency and data-residency needs.
2. In Neon, open the connection details for the database/branch you intend to use. Keep TLS enabled and copy both connection strings without sharing or committing them.
3. Use the pooled connection (the host typically contains `-pooler`) for `DATABASE_URL`. It is used by the deployed application for Prisma queries and is suited to serverless connection reuse.
4. Use the direct, non-pooler connection for `DIRECT_URL`. Prisma 6 uses this for schema and migration operations that need a direct PostgreSQL connection. Do not use the pooled URL for migration commands.
5. Set `DATABASE_URL` and `DIRECT_URL` independently in each environment. They may point at the same Neon database and differ only by pooler endpoint. Verify that both target the intended branch/database before any migration.

Do not put credentials in Git, screenshots, issue text, build output, or this guide. Rotate credentials if they are exposed. `.env` and `.env.*` are gitignored; only the placeholder `.env.example` is tracked.

## AWS Amplify Hosting

1. Connect the intended GitHub repository and verify which branch Amplify deploys to the production domain. Do not infer the deployed branch from the local checkout.
2. Select the Next.js SSR framework/runtime supported by AWS Amplify Hosting. This project uses the App Router and server actions; do not configure it as a static export.
3. Use the repository root, npm with the committed `package-lock.json`, `npm ci`, and `npm run build`. The build generates Prisma Client and builds Next.js; it does not apply migrations or seed data. No `amplify.yml` is tracked, so inspect the build specification configured in the Amplify Console before relying on defaults.
4. Verify the Node.js version in the Amplify build and SSR runtime logs. The lockfile resolves Next.js 15.5.27 and Prisma 6.19.3; both packages declare Node.js >=18.18, but this repository does not pin an Amplify Node.js version.
5. Configure `DATABASE_URL` and `SESSION_SECRET` for the deployed SSR runtime. `DIRECT_URL` is used by Prisma schema/CLI operations and should only be configured in build/operator environments that need it. Keep distinct environment values for production and preview branches.
6. AWS documents that Amplify build environment variables are not automatically available to Next.js SSR code. Inspect the active build specification and verify the required runtime variables are made available without printing their values. AWS's documented `.env.production` approach can place values in deployment artifacts; review artifact access and secret exposure risk before using it. Never add secrets to Git or build logs.
7. Keep `ADMIN_*` values out of automated builds; they are for a controlled one-time seed only. Deploy and inspect build/runtime logs. A successful build does not prove that the database is reachable or its schema is current.

No application base URL variable is currently read by the code. Redirects are relative paths, and production cookies are marked `Secure` based on `NODE_ENV=production`; HTTPS should remain enabled at the hosting edge.

## Temporary server timing diagnostics

Production server rendering emits structured `server_timing` and `prisma_query_timing` JSON logs by default. Set `SERVER_TIMING_ENABLED=false` in the SSR runtime to disable them; set it to `true` in non-production environments to enable them there. Logs include an opaque request ID, a route label, stage duration, and sanitized runtime/database region labels. Prisma query logs intentionally exclude SQL text and parameters.

The Prisma query duration is the client-observed query round trip; it does not separate connection-pool acquisition from PostgreSQL execution. Use the same time window in Amplify/CloudWatch and Neon metrics to distinguish runtime cold starts, connection waits, and database execution. Remove this instrumentation after the diagnosis is complete.

## Prisma Production Migrations

### Before any migration

- Confirm the actual database provider and target from both URLs. Ensure `DIRECT_URL` is the direct endpoint and points to the same target as `DATABASE_URL`.
- Take a recoverable backup or provider restore point, and verify the recovery procedure. For an existing database, test restoration to a separate target before proceeding.
- Review `_prisma_migrations` and run `npx prisma migrate status` against the target using `DIRECT_URL`. This is an inspection step; do not run migration resolution based only on a pending status.
- Compare the live schema with the Prisma model using the read-only diff command below. Review its output as SQL; never pipe it into `psql` or apply it automatically.

```sh
npx prisma migrate status
npx prisma migrate diff --from-url "$DIRECT_URL" --to-schema-datamodel prisma/schema.prisma --script
```

### Migration sequence and observed local database

The repository currently has 29 checked-in migrations. The initial migration creates the core user and attendance tables; subsequent migrations add attendance evidence, employee records, shifts, leave, corrections, WFH workflows, and other features. Review the complete ordered sequence under `prisma/migrations` against the target database; do not apply only a subset based on this summary.


Historical migration notes below describe an earlier local database state only; they do not establish the current production database's schema or migration status.

An observed local database had both migrations pending even though its physical schema already contained the operational tables. Before this model update, its schema diff was empty; against the current model, the read-only diff reports the expected operational changes: drop the old employee foreign key and correction-request unique index, make audit `employeeId` nullable, add `settingKey` and its index, then add the `SET NULL` employee foreign key. This evidence applies only to that local database, not to Neon. Since the initial migration creates tables without `IF NOT EXISTS`, do not run `migrate deploy` against a database where those tables already exist but migration history says both are pending.

Preserve all committed migration files and the target's migration history. Rehearse the complete sequence against a disposable PostgreSQL database before applying it to an existing target.

### Empty PostgreSQL database

For a genuinely empty PostgreSQL database, first verify the target is empty and rehearse the full migration chain on a disposable empty target. Confirm the resulting schema matches the current Prisma model and run application tests against the disposable target. Back up/confirm the actual production target is empty, then run `npm run db:migrate:deploy` from a controlled environment. Do not run this command in an Amplify build or as an automatic deployment hook.

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
| `DATABASE_URL` | Runtime (and build only if a build-time operation requires it) | PostgreSQL URL used by Prisma runtime queries |
| `DIRECT_URL` | Prisma CLI/build operations that need it | Direct PostgreSQL URL for schema and migration operations |
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
- Inspect Amplify build and SSR runtime logs for errors without logging secrets or attendance contents. Add external error monitoring and alerting if required; none is configured in this repository.
- Confirm backup/restore retention with the actual database provider and periodically test recovery to a separate target.

Login rate limiting is not implemented in this application. Decide whether to add an edge/WAF or application-level control before exposing accounts broadly. Keep this decision separate from the deployment preparation so it can be threat-modeled and tested.

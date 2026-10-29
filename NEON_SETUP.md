# Neon Setup

This project uses Prisma 6 with `DATABASE_URL` for application queries and `DIRECT_URL` for direct Prisma CLI and migration connections. The project already declares both values in `prisma/schema.prisma`; no Neon URL or credential belongs in source control.

> The Neon connection URL shared while requesting this setup included a password. Rotate that password in Neon before using the database, then use the newly issued connection strings only in private environment settings.

## Connection URLs

In Neon, open the connection details for the intended project, branch, and database. Keep TLS enabled and obtain both connection strings:

- `DATABASE_URL`: choose the pooled connection (the hostname commonly contains `-pooler`). This is for application runtime connections and is suited to serverless workloads.
- `DIRECT_URL`: choose the direct/non-pooled connection. Prisma uses it for migrations and other schema operations that should connect directly.

Both URLs must identify the same Neon project, branch, and database. Do not infer or hand-edit the direct hostname from the pooled URL; copy each from Neon and verify the target. Do not paste either credential into source files, documentation, screenshots, issues, or logs.

## Local Development

Use a dedicated local or test PostgreSQL database for local operations that can write data. Do not assume the existing private `.env` targets a local database; verify the target without exposing its connection value before running the application or database commands. Never use production or shared database credentials for tests or local write operations.

For local Prisma CLI operations, set `DIRECT_URL` in the private environment to the direct endpoint for the same dedicated local/test database used by `DATABASE_URL`. Do not mix endpoints that point to different databases.

For a deliberate local Neon test, configure both Neon URLs together in a private, ignored environment and verify the target branch before running the app. Do not mix a local `DATABASE_URL` with a Neon `DIRECT_URL`, or vice versa. Keep `.env.example` as a placeholder template; never copy real Neon credentials into it.

`.gitignore` excludes `.env` and `.env.*` while explicitly allowing `.env.example`. Verify with `git check-ignore -v .env .env.local` if needed.

## Hosting Environment Variables

Configure these values in the hosting provider's production environment. For AWS Amplify, first verify the connected production branch and active build specification:

- `DATABASE_URL`: Neon pooled connection URL.
- `DIRECT_URL`: Neon direct/non-pooled URL.
- `SESSION_SECRET`: a newly generated, unique secret of at least 32 characters.

Add corresponding values separately for preview branches only when they should connect to separate Neon branches. Prefer separate database branches and secrets per environment. Do not configure the one-time `ADMIN_*` seed values for builds; seed the initial admin from a controlled private environment after the schema is ready. Redeploy after changing environment configuration so the deployment receives it.

`npm run build` generates Prisma Client and builds Next.js; it does not apply migrations or seed data. AWS Amplify documents that build variables are not automatically available to Next.js SSR code. Verify runtime access to `DATABASE_URL` and `SESSION_SECRET` in the active Amplify build specification and deployment, without printing their values. Review the security implications before using a build step that writes secrets into `.env.production` or deployable artifacts.

## Fresh Neon Migration Procedure

The repository currently contains 29 ordered migration directories. Review the complete sequence under `prisma/migrations`; do not assume production is empty or that its migration history matches the repository. Before a production migration:

1. Confirm both connection URLs target the same intended Neon project, branch, and database; confirm the target is empty.
2. Create a disposable empty PostgreSQL database or Neon branch and rehearse the complete migration chain there. Inspect the result against `prisma/schema.prisma` and run relevant tests.
3. Take or confirm a recoverable backup/restore point for the actual target, even if you expect it to be empty.
4. From a controlled operator environment with `DIRECT_URL` set, inspect migration status and the schema diff. These inspection commands do not apply migrations:

   ```sh
   npx prisma migrate status
   npx prisma migrate diff --from-url "$DIRECT_URL" --to-schema-datamodel prisma/schema.prisma --script
   ```

5. Only after the target is confirmed empty and the rehearsal succeeds, run the production migration command manually from that controlled environment:

   ```sh
   npm run db:migrate:deploy
   ```

Do not run `prisma migrate dev`, `prisma db push`, `prisma migrate reset`, `prisma migrate resolve`, or seed commands against production during setup. Do not put migrations in an automatic build/deploy hook. If migration status or schema inspection shows existing tables, pending/unrecorded history, or any mismatch, stop and reconcile the target; do not treat it as fresh or baseline it from a model diff alone.

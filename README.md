# Attendance System

Phase 1 foundation for employee authentication, office/WFH work sessions, attendance history, and protected admin routes.

## Local setup

Requirements: Node.js 20.9 or later, npm, and a reachable PostgreSQL database.

1. Copy `.env.example` to `.env` and replace the placeholders. Set `DATABASE_URL` and `DIRECT_URL` to your database URLs, generate a unique random `SESSION_SECRET` of at least 32 characters (for example, `openssl rand -base64 48`), and set the initial admin's name, email, country code, IANA timezone, and strong password. The example intentionally has no usable database credentials, session secret, or admin password. Keep `.env` private; it is gitignored.
2. Install dependencies with `npm ci`.
3. Generate the Prisma client with `npm run db:generate`.
4. On an empty local database, apply the committed migrations with `npm run db:migrate:deploy`. For any database with existing tables or attendance records, inspect its migration history and schema first; follow [DEPLOYMENT.md](DEPLOYMENT.md) rather than applying migrations blindly.
5. Create the initial admin with `npm run db:seed`. Seeding is create-only; it does not reset an existing account.
6. Start the app with `npm run dev` and open `http://localhost:3000`.

Use `npm run db:migrate -- --name <migration_name>` while developing schema changes. `npm run db:push` is for disposable local prototyping only; do not use it to deploy production schema changes.

## Password reset email

Password reset delivery uses SMTP. Configure `APP_URL`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, and `EMAIL_FROM`; configure `SMTP_USER` and `SMTP_PASSWORD` together when the SMTP server requires authentication. Production `APP_URL` must use HTTPS. Reset messages are not written to application logs.

For local testing, point the SMTP settings at a local mail catcher such as Mailpit and inspect the message in its inbox. Set `APP_URL` to the local address used to open the app. The reset link expires after 30 minutes and can be used once. Requests are limited to three per normalized email address and twenty per client IP in a one-hour window.

## Production deployment

See [DEPLOYMENT.md](DEPLOYMENT.md) for the Vercel and Neon setup, environment variables, and migration procedure. The Prisma model is aligned with the checked-in migration sequence, but an existing database with pending or unrecorded migrations must be inspected and reconciled before applying migrations; never baseline it from a schema diff alone.

## System boundaries

- Session timestamps are server-generated instants stored in PostgreSQL `timestamptz` columns. Local dates, classifications, and displayed times use each employee's validated IANA timezone.
- The existing schedule is 08:30–17:30 employee-local time and is shared by Office and WFH sessions.
- Each session receives its own attendance record. Its date-only `workDate` remains unset; the schema intentionally has no one-record-per-day constraint.
- Admin attendance review, corrections, employee management, and reports operate on existing attendance data. Leave requests use Supervisor review followed by an assigned Manager when one is active; otherwise Supervisor approval currently completes the request, a behavior that still needs HR confirmation. Attendance corrections use Supervisor-to-HR review, while overtime and WFH requests use Supervisor-to-Manager review. Payroll is not configured.
- The saved company name is used on login and workspace branding, password-reset emails, and PDF/XLSX report branding; the checked-in EML logo remains the logo fallback.
- The Employee foundation is linked to User through a unique optional User ID; attendance continues to reference User.id. Existing User.name and User.employeeCode remain for Phase 1 session, employee-admin, and attendance-report compatibility. The employee create/update service writes both copies together; future profile/read paths should move to Employee before either User field is removed.
- Profile completion is required only when `Employee.profileOnboardingRequired` is true. Existing records default to false during migration and receive no fabricated profile data; newly created employee accounts are explicitly flagged for completion.

## Admin employee management

Super Administrators and HR Administrators can search and page through Employee records, inspect linked profile information, and update employee identity/statutory IDs and profile fields. HR access is limited to accounts with the existing `employee:manage` permission; only Super Administrators can create or modify administrator accounts. Login email remains on `User`; profile contact email remains on `EmployeeProfile`. Attendance continues to reference `User.id`, and audit events record changed field names without storing personal values. This increment adds no migration; the existing Employee and EmployeeProfile migrations must already be applied for these screens to work.

## Employee document management

Employee documents are managed by administrators from **Admin → Employees → employee → Documents**. The page lists each document's type, original filename, size, upload time, optional expiry date, and uploader, and offers a protected download. The document API and service enforce administrator access for employee records; service-level employee ownership checks remain in place for any authenticated employee API use. There is no employee-facing documents page.

Uploads pass through a private storage interface (`PrivateDocumentStorage`). The S3 adapter stores bytes under opaque, generated object keys and uses the AWS SDK default credential provider chain; the application does not return storage keys, bucket details, or public object URLs. Files are streamed from multipart requests with configured byte and part limits, checked against the configured extension allowlist and detected content, and given a normalized safe filename. DOCX files are additionally checked for required package entries. Invalid types, mismatched contents, empty files, unsafe filenames, and oversized files are rejected server-side. The database metadata and privacy-safe audit event are committed together; if that transaction fails, the newly stored object is removed.

Configure these values in the server environment before enabling uploads; the application intentionally does not invent a size limit or extension allowlist:

| Name | Purpose |
| --- | --- |
| `EMPLOYEE_DOCUMENT_MAX_BYTES` | Required maximum permitted upload size in bytes. |
| `EMPLOYEE_DOCUMENT_ALLOWED_EXTENSIONS` | Required comma-separated extension allowlist (set only extensions approved by your organization). |
| `EMPLOYEE_DOCUMENTS_S3_BUCKET` | Required name of the private S3 bucket. |
| `AWS_REGION` | Required AWS region for the bucket and SDK client. |

When the S3 bucket or policy configuration is missing, the page reports uploads as unavailable and the API rejects uploads rather than reporting success. AWS credentials are resolved by the SDK default provider chain. Tests use `MockPrivateDocumentStorage` and do not require AWS:

```sh
node --conditions=react-server --import tsx --test lib/documents/*.test.ts
npm test
```

The `20261003000004_employee_documents` Prisma migration must be applied through the deployment's reviewed migration process before the feature can read or write its metadata. AWS deployment work remains: provision a private bucket with public access blocked, grant the runtime identity least-privilege access to the intended bucket/prefix, configure its region and credentials/identity, and establish organization-approved retention, backup, monitoring, and recovery procedures. AWS integration has not been deployment-tested here.
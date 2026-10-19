ALTER TABLE "User"
ADD COLUMN "username" TEXT;

ALTER TABLE "User"
ADD CONSTRAINT "User_username_format_check"
CHECK ("username" IS NULL OR "username" ~ '^[a-z0-9._-]{3,30}$');

CREATE UNIQUE INDEX "User_username_lower_key"
ON "User" (LOWER("username"))
WHERE "username" IS NOT NULL;

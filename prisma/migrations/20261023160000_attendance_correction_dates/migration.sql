ALTER TABLE public."AttendanceCorrectionRequest"
ADD COLUMN IF NOT EXISTS "attendanceDate" DATE;

DO $$
DECLARE
  column_type TEXT;
  column_nullable TEXT;
BEGIN
  SELECT data_type, is_nullable
  INTO column_type, column_nullable
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'AttendanceCorrectionRequest'
    AND column_name = 'attendanceDate';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expected public."AttendanceCorrectionRequest"."attendanceDate" column was not created';
  END IF;

  IF column_type <> 'date' OR column_nullable <> 'YES' THEN
    RAISE EXCEPTION 'Existing public."AttendanceCorrectionRequest"."attendanceDate" must be a nullable DATE (found type %, nullable %)',
      column_type, column_nullable;
  END IF;
END $$;

UPDATE public."AttendanceCorrectionRequest" AS correction
SET "attendanceDate" = daily."date"
FROM public."attendance_daily" AS daily
WHERE correction."dailyAttendanceId" = daily."id"
  AND correction."dailyAttendanceId" IS NOT NULL
  AND correction."attendanceDate" IS NULL;

CREATE INDEX IF NOT EXISTS "AttendanceCorrectionRequest_employeeId_attendanceDate_status_idx"
ON public."AttendanceCorrectionRequest"("employeeId", "attendanceDate", "status");

DO $$
DECLARE
  index_access_method TEXT;
  index_is_unique BOOLEAN;
  index_is_valid BOOLEAN;
  index_is_ready BOOLEAN;
  index_has_predicate BOOLEAN;
  index_has_expressions BOOLEAN;
  index_key_count SMALLINT;
  index_attribute_count SMALLINT;
  index_columns TEXT[];
BEGIN
  SELECT access_method.amname,
         index_info.indisunique,
         index_info.indisvalid,
         index_info.indisready,
         index_info.indpred IS NOT NULL,
         index_info.indexprs IS NOT NULL,
         index_info.indnkeyatts,
         index_info.indnatts,
         ARRAY(
           SELECT attribute.attname::TEXT
           FROM unnest(index_info.indkey) WITH ORDINALITY AS key_column(attnum, ordinality)
           JOIN pg_attribute AS attribute
             ON attribute.attrelid = index_info.indrelid
            AND attribute.attnum = key_column.attnum
           ORDER BY key_column.ordinality
         )
  INTO index_access_method,
       index_is_unique,
       index_is_valid,
       index_is_ready,
       index_has_predicate,
       index_has_expressions,
       index_key_count,
       index_attribute_count,
       index_columns
  FROM pg_class AS index_relation
  JOIN pg_namespace AS index_schema
    ON index_schema.oid = index_relation.relnamespace
  JOIN pg_index AS index_info
    ON index_info.indexrelid = index_relation.oid
  JOIN pg_class AS indexed_table
    ON indexed_table.oid = index_info.indrelid
  JOIN pg_namespace AS table_schema
    ON table_schema.oid = indexed_table.relnamespace
  JOIN pg_am AS access_method
    ON access_method.oid = index_relation.relam
  WHERE index_schema.nspname = 'public'
    AND index_relation.relname = 'AttendanceCorrectionRequest_employeeId_attendanceDate_status_idx'
    AND table_schema.nspname = 'public'
    AND indexed_table.relname = 'AttendanceCorrectionRequest';

  IF NOT FOUND
     OR index_access_method <> 'btree'
     OR index_is_unique
     OR NOT index_is_valid
     OR NOT index_is_ready
     OR index_has_predicate
     OR index_has_expressions
     OR index_key_count <> 3
     OR index_attribute_count <> 3
     OR index_columns IS DISTINCT FROM ARRAY['employeeId', 'attendanceDate', 'status']::TEXT[] THEN
    RAISE EXCEPTION 'Existing index public."AttendanceCorrectionRequest_employeeId_attendanceDate_status_idx" does not match the expected non-unique btree index on (employeeId, attendanceDate, status)';
  END IF;
END $$;

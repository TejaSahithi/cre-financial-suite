-- Migration: 20260609000001_add_owner_columns_to_critical_dates.sql
-- Adds owner_email and owner_name to lease_critical_dates if not already present.
-- The original create migration (20260514130000) uses CREATE TABLE IF NOT EXISTS,
-- so if the table was created by an older schema snapshot those columns may be absent.

ALTER TABLE public.lease_critical_dates
  ADD COLUMN IF NOT EXISTS owner_email TEXT,
  ADD COLUMN IF NOT EXISTS owner_name  TEXT;

-- Re-create the partial index on owner_email (safe to run even if it existed).
DROP INDEX IF EXISTS idx_lease_critical_dates_owner;
CREATE INDEX IF NOT EXISTS idx_lease_critical_dates_owner
  ON public.lease_critical_dates (owner_email)
  WHERE owner_email IS NOT NULL;

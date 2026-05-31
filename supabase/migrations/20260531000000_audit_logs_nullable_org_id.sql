-- Migration: allow audit_logs.org_id to be NULL
-- Reason: super-admin actions (user approvals, org creation) must be recorded
-- even when the actor has not selected an acting org. Previously the NOT NULL
-- constraint silently caused audit inserts to fail for super-admins, leaving no
-- trail for the highest-privilege operations.
--
-- Existing rows are unaffected (they all have an org_id already).
-- RLS policies that filter by org_id still work — they simply exclude
-- these cross-org super-admin rows from org-scoped queries, which is correct.

ALTER TABLE audit_logs
  ALTER COLUMN org_id DROP NOT NULL;

-- Add an index so super-admin audit queries (org_id IS NULL) are fast.
CREATE INDEX IF NOT EXISTS idx_audit_logs_null_org
  ON audit_logs (id)
  WHERE org_id IS NULL;

COMMENT ON COLUMN audit_logs.org_id IS
  'The organisation that owns the audited record.
   NULL is allowed for super-admin actions that span organisations
   (e.g. approving a new org, managing global settings).';

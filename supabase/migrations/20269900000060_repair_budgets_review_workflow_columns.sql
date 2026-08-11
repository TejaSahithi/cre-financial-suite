

-- Repairs live schema drift discovered during Budget V1 UAT: the linked
-- remote project's `budgets` table never actually received the columns
-- 20260410000000_budget_review_workflow_metadata.sql adds (reviewed_at,
-- reviewed_by, rejected_at, rejected_by, rejection_comment), despite that
-- migration showing as applied in the migration ledger -- confirmed via a
-- direct information_schema.columns query against the live table, the same
-- "ledger says applied, DDL missing live" class of drift already documented
-- for other tables in this project's history.
--
-- Consequence: fn_on_budget_changed (trigger tr_budget_changed, AFTER
-- INSERT OR UPDATE ON budgets) unconditionally references
-- NEW.rejection_comment/OLD.rejection_comment in its current, correct
-- source (20260709010000_budget_trigger_audit_reconciliation.sql) -- with
-- the column missing live, EVERY insert or update to budgets crashes with
-- `record "old" has no field "rejection_comment"`, blocking budget
-- generation entirely (both the legacy and planning generate paths, and by
-- extension mark_reviewed/reject/approve/lock, which are also UPDATEs).
--
-- Forward-only repair: does not touch 20260410000000's own file (which
-- already correctly declares these columns -- it simply never executed
-- live). ADD COLUMN IF NOT EXISTS makes this idempotent and safe to run
-- against an environment (e.g. a fresh local reset replaying every
-- migration in order) where 20260410000000 DID run correctly and these
-- columns already exist.
-- Column definitions reproduced byte-for-byte from 20260410000000's own
-- (correct, never-executed-live) DDL, including the ON DELETE SET NULL
-- clause on both FKs.
ALTER TABLE public.budgets
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejected_at timestamptz,
  ADD COLUMN IF NOT EXISTS rejected_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejection_comment text;

NOTIFY pgrst, 'reload schema';

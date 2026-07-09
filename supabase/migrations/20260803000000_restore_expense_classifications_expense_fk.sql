-- Enterprise hardening Phase 6X-7B: repair local/remote drift on
-- expense_classifications.expense_id's foreign key.
--
-- Confirmed via direct schema inspection (local: docker exec psql;
-- remote: supabase db dump --linked --schema public, read-only):
--   * Local has expense_classifications_expense_id_fkey: FOREIGN KEY
--     (expense_id) REFERENCES expenses(id) ON DELETE CASCADE (restored in
--     Phase 6X-6 alongside making expense_id nullable -- the ALTER COLUMN
--     ... DROP NOT NULL in that phase never touched this FK).
--   * Remote has NO foreign key constraint on expense_id at all -- absent
--     in both the pre- and post-Phase-6X-6 remote dumps. This predates
--     this repo's migration history entirely: the original migration
--     (20260512090000_lease_workflow_foundation.sql:34) declares
--     "expense_id UUID NOT NULL REFERENCES public.expenses(id) ON DELETE
--     CASCADE" as a single column definition from day one -- remote's
--     current shape (nullable, no FK) was never produced by any tracked
--     migration, so this is untracked drift on both properties at once,
--     matching the same class of pre-existing manual-dashboard-drift this
--     session has repeatedly found (get_my_org_ids, audit_logs.user_id,
--     budgets_all, fn_on_expense_added).
--
-- Pre-migration read-only safety check (Phase 6X-7B, against remote via
-- `supabase db query --linked`, aggregate counts only, no row-level data
-- ever printed):
--   * expense_classifications rows with expense_id IS NOT NULL: 7
--   * orphaned rows (expense_id set but no matching expenses.id): 0
--   * org-mismatch rows (linked expense's org_id differs from the
--     classification's own org_id): 0
-- Both required-zero counts are zero, so per the approved decision rule
-- this migration proceeds. Had either been nonzero, this migration would
-- not have been written; a separate cleanup/remediation plan would have
-- been proposed instead.
--
-- This migration is idempotent and safe on both environments:
--   * Local already has this exact constraint -- the guard below no-ops.
--   * Remote is missing it -- added as NOT VALID first (fast, no
--     upfront full-table scan under a heavy lock) then validated
--     immediately after (the required full-table scan, but under a
--     lighter lock than a plain ADD CONSTRAINT would take). Since the
--     orphan/org-mismatch counts above are both zero, VALIDATE CONSTRAINT
--     is guaranteed to succeed without needing any data cleanup first.
--
-- Explicitly NOT touched: nullability (unchanged from Phase 6X-6, on
-- both environments), any other column, any RLS policy,
-- delete_expenses_workflow, persist_expense_classification, no data is
-- read, deleted, or updated by this migration beyond the constraint
-- validation scan itself.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.expense_classifications'::regclass
      AND conname = 'expense_classifications_expense_id_fkey'
  ) THEN
    ALTER TABLE public.expense_classifications
      ADD CONSTRAINT expense_classifications_expense_id_fkey
      FOREIGN KEY (expense_id) REFERENCES public.expenses(id) ON DELETE CASCADE
      NOT VALID;

    ALTER TABLE public.expense_classifications
      VALIDATE CONSTRAINT expense_classifications_expense_id_fkey;
  END IF;
END $$;

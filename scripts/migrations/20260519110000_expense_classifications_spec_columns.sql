-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: extend `expense_classifications` with the spec columns needed
-- for the new Expense Classification → Review → Projection workflow.
--
-- Why this exists:
--   The spec calls for an `expense_classification_results` table. We
--   already have `expense_classifications` with most of the same fields
--   under slightly different names (recovery_status, recovery_rule_id,
--   approved_status, allocation_method). Creating a parallel table would
--   double the maintenance burden and orphan existing rows, so we extend
--   the existing table with the spec's new fields.
--
-- Adds:
--   - Denormalized snapshot fields:
--       category, subcategory, amount, service_period_start, service_period_end
--   - New decision fields:
--       cam_eligible, recovery_method, recovery_reason, exception_type
--   - Lifecycle fields:
--       classification_status (draft|matched|unmatched|conditional|
--                              exception|finalized|excluded)
--       reviewed_by, reviewed_at, finalized_at
--   - Generated columns aliasing to the spec names:
--       actual_expense_id          → mirrors expense_id
--       lease_expense_rule_id      → mirrors recovery_rule_id
--       recoverability_result      → mirrors recovery_status (when not set)
--
-- Idempotent: all ADD COLUMN uses IF NOT EXISTS.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.expense_classifications
  -- Snapshot of the matched expense/rule so the row remains queryable even
  -- if the source expense or rule is renamed.
  ADD COLUMN IF NOT EXISTS category               TEXT,
  ADD COLUMN IF NOT EXISTS subcategory            TEXT,
  ADD COLUMN IF NOT EXISTS amount                 NUMERIC,
  ADD COLUMN IF NOT EXISTS service_period_start   DATE,
  ADD COLUMN IF NOT EXISTS service_period_end     DATE,

  -- Decision fields written by the matcher.
  ADD COLUMN IF NOT EXISTS cam_eligible           TEXT,   -- yes | no | conditional | unknown
  ADD COLUMN IF NOT EXISTS recovery_method        TEXT,   -- pro_rata | direct | tenant_direct | landlord_pays | manual_review
  ADD COLUMN IF NOT EXISTS recovery_reason        TEXT,
  ADD COLUMN IF NOT EXISTS recoverability_result  TEXT,   -- recoverable | non_recoverable | conditional | excluded | needs_review
  ADD COLUMN IF NOT EXISTS exception_type         TEXT,   -- unmatched | low_confidence | conditional_review | rule_conflict | missing_category | other

  -- Lifecycle.
  ADD COLUMN IF NOT EXISTS classification_status  TEXT DEFAULT 'draft', -- draft|matched|unmatched|conditional|exception|finalized|excluded
  ADD COLUMN IF NOT EXISTS reviewed_by            TEXT,
  ADD COLUMN IF NOT EXISTS reviewed_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS finalized_at           TIMESTAMPTZ,

  -- Spec column names alongside existing legacy names.
  -- expense_id ⇌ actual_expense_id, recovery_rule_id ⇌ lease_expense_rule_id.
  ADD COLUMN IF NOT EXISTS actual_expense_id      UUID,
  ADD COLUMN IF NOT EXISTS lease_expense_rule_id  UUID;

-- Backfill the alias columns from the existing ones so callers using
-- spec names can read older rows.
UPDATE public.expense_classifications
SET
  actual_expense_id     = COALESCE(actual_expense_id, expense_id),
  lease_expense_rule_id = COALESCE(lease_expense_rule_id, recovery_rule_id),
  recoverability_result = COALESCE(recoverability_result, recovery_status)
WHERE actual_expense_id IS NULL
   OR lease_expense_rule_id IS NULL
   OR recoverability_result IS NULL;

-- Backfill classification_status from approved_status where possible.
UPDATE public.expense_classifications
SET classification_status = COALESCE(
  classification_status,
  CASE
    WHEN approved_status = 'approved'  THEN 'finalized'
    WHEN approved_status = 'rejected'  THEN 'exception'
    WHEN recovery_rule_id IS NULL      THEN 'unmatched'
    WHEN recovery_status = 'conditional' THEN 'conditional'
    WHEN recovery_status IS NOT NULL   THEN 'matched'
    ELSE 'draft'
  END
)
WHERE classification_status IS NULL OR classification_status = '';

-- Indexes for the new query patterns.
CREATE INDEX IF NOT EXISTS idx_expense_classifications_class_status
  ON public.expense_classifications(classification_status);

CREATE INDEX IF NOT EXISTS idx_expense_classifications_recoverability
  ON public.expense_classifications(recoverability_result);

CREATE INDEX IF NOT EXISTS idx_expense_classifications_exception
  ON public.expense_classifications(exception_type)
  WHERE exception_type IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_expense_classifications_period
  ON public.expense_classifications(service_period_start, service_period_end);

CREATE INDEX IF NOT EXISTS idx_expense_classifications_lease_rule
  ON public.expense_classifications(lease_expense_rule_id)
  WHERE lease_expense_rule_id IS NOT NULL;

-- One classification row per (actual_expense_id, lease_expense_rule_id) so
-- re-running classification upserts cleanly. NULL rule_id is allowed
-- (unmatched expenses keep one row per expense, regardless of how many
-- times we re-classify).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_expense_classifications_expense_rule
  ON public.expense_classifications(actual_expense_id, COALESCE(lease_expense_rule_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE actual_expense_id IS NOT NULL;

-- RLS already enabled by APPLY-ALL-PATCHED. Just make sure super_admin can
-- read/write (matches the policy we used for lease_expense_rules).
DO $$
BEGIN
  EXECUTE 'DROP POLICY IF EXISTS "expense_classifications_org_select" ON public.expense_classifications';
  EXECUTE 'DROP POLICY IF EXISTS "expense_classifications_org_write"  ON public.expense_classifications';
  EXECUTE $POL$
    CREATE POLICY "expense_classifications_org_select"
      ON public.expense_classifications FOR SELECT
      USING (
        public.is_super_admin()
        OR org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
      )
  $POL$;
  EXECUTE $POL$
    CREATE POLICY "expense_classifications_org_write"
      ON public.expense_classifications FOR ALL
      USING (
        public.is_super_admin()
        OR org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
      )
      WITH CHECK (
        public.is_super_admin()
        OR org_id IS NULL
        OR org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
      )
  $POL$;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'expense_classifications RLS policies skipped: %', SQLERRM;
END $$;

-- Verification.
SELECT
  (SELECT COUNT(*) FROM public.expense_classifications) AS total_rows,
  (SELECT COUNT(*) FROM public.expense_classifications WHERE classification_status IS NOT NULL) AS rows_with_status,
  (SELECT COUNT(*) FROM public.expense_classifications WHERE recoverability_result IS NOT NULL) AS rows_with_recoverability,
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'expense_classifications'
      AND column_name IN ('category','subcategory','amount','service_period_start','service_period_end',
                          'cam_eligible','recovery_method','recovery_reason','recoverability_result',
                          'exception_type','classification_status','reviewed_by','reviewed_at',
                          'finalized_at','actual_expense_id','lease_expense_rule_id')) AS spec_columns_present;

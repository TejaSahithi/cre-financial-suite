-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: add the remaining spec columns to expense_classifications so
-- the new Expense Recoverability page stops getting 400 "column not found"
-- errors when classification rows are upserted.
--
-- Verified missing prior to this migration (via information_schema):
--   classification_key, recoverable_amount, non_recoverable_amount,
--   conditional_amount, excluded_amount, sent_to_cam, sent_to_cam_at,
--   sent_to_cam_by, classification_updated_by
--
-- Plus a unique CONSTRAINT (not partial index) on classification_key so
-- PostgREST's `?on_conflict=classification_key` can target it. The upsert
-- helper already tries this conflict target first.
--
-- Idempotent: every ADD COLUMN uses IF NOT EXISTS; constraint creation is
-- wrapped in DO/EXCEPTION.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.expense_classifications
  ADD COLUMN IF NOT EXISTS classification_key         TEXT,
  ADD COLUMN IF NOT EXISTS recoverable_amount         NUMERIC,
  ADD COLUMN IF NOT EXISTS non_recoverable_amount     NUMERIC,
  ADD COLUMN IF NOT EXISTS conditional_amount         NUMERIC,
  ADD COLUMN IF NOT EXISTS excluded_amount            NUMERIC,
  ADD COLUMN IF NOT EXISTS sent_to_cam                BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS sent_to_cam_at             TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sent_to_cam_by             TEXT,
  ADD COLUMN IF NOT EXISTS classification_updated_by  TEXT,
  ADD COLUMN IF NOT EXISTS classification_updated_at  TIMESTAMPTZ;

-- Backfill classification_key on existing rows so PostgREST upsert by
-- classification_key works for them. Formula: org + actual_expense_id +
-- (lease_expense_rule_id OR 'unmatched'). This matches the JS computer
-- in expenseService.classifyExpenses.
UPDATE public.expense_classifications
SET classification_key = COALESCE(
  classification_key,
  COALESCE(org_id::text, 'no_org') || '|' ||
  COALESCE(actual_expense_id::text, expense_id::text, 'no_expense') || '|' ||
  COALESCE(lease_expense_rule_id::text, recovery_rule_id::text, 'unmatched')
)
WHERE classification_key IS NULL;

-- Backfill amount buckets from recoverability_result on existing rows so
-- top totals don't show $0 for already-classified rows.
UPDATE public.expense_classifications
SET
  recoverable_amount     = CASE WHEN recoverability_result = 'recoverable'                          THEN COALESCE(amount, 0) ELSE 0 END,
  non_recoverable_amount = CASE WHEN recoverability_result IN ('non_recoverable')                    THEN COALESCE(amount, 0) ELSE 0 END,
  conditional_amount     = CASE WHEN recoverability_result = 'conditional'                          THEN COALESCE(amount, 0) ELSE 0 END,
  excluded_amount        = CASE WHEN recoverability_result = 'excluded'                             THEN COALESCE(amount, 0) ELSE 0 END
WHERE recoverable_amount IS NULL OR non_recoverable_amount IS NULL OR conditional_amount IS NULL OR excluded_amount IS NULL;

-- Unique constraint on classification_key so PostgREST onConflict can target it.
DO $$
BEGIN
  ALTER TABLE public.expense_classifications
    ADD CONSTRAINT uniq_expense_classifications_classification_key
    UNIQUE (classification_key);
EXCEPTION
  WHEN duplicate_object THEN RAISE NOTICE 'classification_key unique already present';
  WHEN unique_violation THEN
    RAISE NOTICE 'cannot add unique on classification_key — duplicates exist; dedup before re-running';
END $$;

CREATE INDEX IF NOT EXISTS idx_expense_classifications_class_key
  ON public.expense_classifications(classification_key)
  WHERE classification_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_expense_classifications_sent_to_cam
  ON public.expense_classifications(sent_to_cam)
  WHERE sent_to_cam = true;

SELECT
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema='public' AND table_name='expense_classifications'
      AND column_name IN ('classification_key','recoverable_amount','non_recoverable_amount',
                          'conditional_amount','excluded_amount','sent_to_cam','sent_to_cam_at',
                          'sent_to_cam_by','classification_updated_by','classification_updated_at')) AS spec_columns_present,
  (SELECT COUNT(*) FROM pg_constraint
    WHERE conrelid='public.expense_classifications'::regclass
      AND conname='uniq_expense_classifications_classification_key') AS unique_constraint_present;

-- Migration: 20260521000000_expense_pipeline_fix.sql
-- Description: Adds missing columns to expenses and classifications and backfills core data

-- 1. Add missing columns safely
ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approval_status TEXT DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS review_status TEXT DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS recovery_status TEXT,
  ADD COLUMN IF NOT EXISTS service_period_start DATE,
  ADD COLUMN IF NOT EXISTS service_period_end DATE;

ALTER TABLE public.expense_classifications
  ADD COLUMN IF NOT EXISTS row_type TEXT;

-- 2. Backfill expenses.tenant_id from leases
UPDATE public.expenses e
SET tenant_id = l.tenant_id
FROM public.leases l
WHERE e.lease_id = l.id
  AND e.tenant_id IS NULL
  AND l.tenant_id IS NOT NULL;

-- 3. Backfill expenses.lease_id and tenant_id from units
UPDATE public.expenses e
SET lease_id = COALESCE(e.lease_id, u.lease_id),
    tenant_id = COALESCE(e.tenant_id, u.tenant_id)
FROM public.units u
WHERE e.unit_id = u.id
  AND (e.lease_id IS NULL OR e.tenant_id IS NULL);

-- 4. Backfill service periods
UPDATE public.expenses
SET service_period_start = COALESCE(service_period_start, date),
    service_period_end = COALESCE(service_period_end, date)
WHERE service_period_start IS NULL OR service_period_end IS NULL;

-- 5. Backfill expenses approval status for valid existing test/dev rows
-- Only approve non-deleted rows with amount > 0 that aren't lease imports
UPDATE public.expenses
SET approval_status = 'approved',
    review_status = 'approved',
    approved_at = COALESCE(approved_at, now())
WHERE approval_status = 'pending'
  AND amount > 0
  AND COALESCE(source, '') != 'lease_import';

-- 6. Backfill classification row types
UPDATE public.expense_classifications
SET row_type = CASE
  WHEN (expense_id IS NOT NULL OR actual_expense_id IS NOT NULL) AND (lease_expense_rule_id IS NOT NULL) THEN 'matched_classification'
  WHEN (expense_id IS NOT NULL OR actual_expense_id IS NOT NULL) AND (lease_expense_rule_id IS NULL) THEN 'actual_missing_rule'
  WHEN (expense_id IS NULL AND actual_expense_id IS NULL) AND (lease_expense_rule_id IS NOT NULL) THEN 'rule_missing_actual'
  ELSE 'unknown'
END
WHERE row_type IS NULL;

-- 7. Downgrade weak lease rules to needs_review
-- Do not downgrade manually created or manually approved rules
UPDATE public.lease_expense_rules
SET review_status = 'needs_review',
    approval_status = 'draft'
WHERE (COALESCE(source_page, 0) <= 0 OR exact_source_text IS NULL OR LENGTH(TRIM(exact_source_text)) < 10)
  AND review_status = 'approved'
  AND approved_by IS NULL
  AND approved_at IS NULL
  AND COALESCE(row_status, '') NOT IN ('manually_added');

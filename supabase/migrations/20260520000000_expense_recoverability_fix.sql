-- Migration: 20260520000000_expense_recoverability_fix.sql
-- Description: Adds missing columns to expense_classifications required by the UI and API queries

ALTER TABLE public.expense_classifications
  ADD COLUMN IF NOT EXISTS recoverability_result TEXT,
  ADD COLUMN IF NOT EXISTS recovery_reason TEXT,
  ADD COLUMN IF NOT EXISTS review_status TEXT,
  ADD COLUMN IF NOT EXISTS classification_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS classification_updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rule_source TEXT,
  ADD COLUMN IF NOT EXISTS cam_pool_id UUID;

-- Backfill recoverability_result from recovery_status if not set
UPDATE public.expense_classifications
SET recoverability_result = COALESCE(recoverability_result, recovery_status)
WHERE recoverability_result IS NULL AND recovery_status IS NOT NULL;

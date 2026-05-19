-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: add the missing columns saveRuleSet writes to
-- lease_expense_values so the value rows can be persisted.
--
-- Symptoms before this migration:
--   PGRST204 "Could not find the 'base_year_amount' column of
--   'lease_expense_values' in the schema cache"
--   → values rows silently fail; rules persist without their dollar
--   amounts / base-year amounts / value source provenance.
--
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.lease_expense_values
  ADD COLUMN IF NOT EXISTS base_year_amount NUMERIC,
  ADD COLUMN IF NOT EXISTS value_source     TEXT;     -- manual | extracted | calculated | inferred

SELECT 'lease_expense_values_columns_added' AS result;

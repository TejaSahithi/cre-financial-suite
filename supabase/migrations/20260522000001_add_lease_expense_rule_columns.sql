-- Migration: Add extra detail columns to lease_expense_rules

ALTER TABLE lease_expense_rules
  ADD COLUMN IF NOT EXISTS rule_type text,
  ADD COLUMN IF NOT EXISTS estimated_annual_amount numeric,
  ADD COLUMN IF NOT EXISTS estimated_monthly_amount numeric,
  ADD COLUMN IF NOT EXISTS tenant_share_percent numeric,
  ADD COLUMN IF NOT EXISTS created_from text,
  ADD COLUMN IF NOT EXISTS generation_source text,
  ADD COLUMN IF NOT EXISTS source_field_key text;

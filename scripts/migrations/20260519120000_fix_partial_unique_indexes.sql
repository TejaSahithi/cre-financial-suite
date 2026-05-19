-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: replace partial unique indexes with proper unique constraints.
--
-- Why this exists:
--   PostgREST's `?on_conflict=col1,col2` requires a unique constraint or a
--   non-partial unique index. Partial unique indexes (with a WHERE clause)
--   are NOT used for ON CONFLICT inference, even if all the indexed rows
--   satisfy the predicate. This caused every saveRuleSet upsert and every
--   classifyExpenses upsert to fail with:
--     400 Bad Request — "there is no unique or exclusion constraint
--                        matching the ON CONFLICT specification"
--   Result: 0 rules persisted in the user's last extract attempts.
--
-- Fix:
--   - Drop the partial unique indexes from 20260519101000 and
--     20260519110000 (the COALESCE/WHERE versions and the simple ones
--     with WHERE clauses).
--   - Add proper unique CONSTRAINTs without WHERE clauses. We verified all
--     existing rows have non-null values for the unique columns, so this
--     is a safe upgrade.
-- ─────────────────────────────────────────────────────────────────────────────

DROP INDEX IF EXISTS public.uniq_lease_expense_rules_rule_set_rule_key;
DROP INDEX IF EXISTS public.uniq_expense_classifications_org_expense;
DROP INDEX IF EXISTS public.uniq_expense_classifications_expense_rule;

DO $$
BEGIN
  ALTER TABLE public.lease_expense_rules
    ADD CONSTRAINT uniq_lease_expense_rules_rule_set_rule_key
    UNIQUE (rule_set_id, rule_key);
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'lease_expense_rules unique constraint already exists';
END $$;

DO $$
BEGIN
  ALTER TABLE public.expense_classifications
    ADD CONSTRAINT uniq_expense_classifications_org_expense
    UNIQUE (org_id, expense_id);
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'expense_classifications unique constraint already exists';
END $$;

SELECT
  (SELECT count(*) FROM pg_constraint
    WHERE conrelid='public.lease_expense_rules'::regclass
      AND conname='uniq_lease_expense_rules_rule_set_rule_key') AS rules_constraint,
  (SELECT count(*) FROM pg_constraint
    WHERE conrelid='public.expense_classifications'::regclass
      AND conname='uniq_expense_classifications_org_expense') AS classifications_constraint;

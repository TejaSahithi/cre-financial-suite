-- Drop the partial index
DROP INDEX IF EXISTS uq_lease_expense_rules_lease_rule_key;

-- Add a full unique constraint instead so PostgREST upsert works
ALTER TABLE public.lease_expense_rules 
  ADD CONSTRAINT uq_lease_expense_rules_lease_rule_key UNIQUE (lease_id, rule_key);

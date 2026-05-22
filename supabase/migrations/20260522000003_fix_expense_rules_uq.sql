-- Clean up duplicates before applying unique constraint
WITH duplicates AS (
  SELECT id,
         ROW_NUMBER() OVER(PARTITION BY lease_id, rule_key ORDER BY created_at DESC, id DESC) as rn
  FROM public.lease_expense_rules
  WHERE lease_id IS NOT NULL AND rule_key IS NOT NULL
)
DELETE FROM public.lease_expense_rules
WHERE id IN (SELECT id FROM duplicates WHERE rn > 1);

-- Drop the partial index if it exists
DROP INDEX IF EXISTS uq_lease_expense_rules_lease_rule_key;

-- Create the full unique index as requested (compatible with upsert)
CREATE UNIQUE INDEX IF NOT EXISTS uq_lease_expense_rules_lease_rule_key
ON public.lease_expense_rules (lease_id, rule_key);

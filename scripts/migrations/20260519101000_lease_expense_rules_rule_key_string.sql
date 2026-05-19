-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: rebuild rule_key using deterministic string concatenation
-- instead of md5, so JS and SQL can produce identical keys without needing
-- an md5 library in the browser bundle.
--
-- Format:
--   rule_key = lower(trim(category))     || '|' ||
--              lower(trim(subcategory))  || '|' ||
--              lower(trim(payment))      || '|' ||
--              lower(trim(recoverable))  || '|' ||
--              lower(trim(recovery))     || '|' ||
--              coalesce(source_page::text, '') || '|' ||
--              lower(trim(substring(exact_source_text from 1 for 80)))
--
-- Scoped per rule_set, so the UNIQUE index (rule_set_id, rule_key) does
-- not collide across versions.
--
-- Length cap: 80 chars from source_text → rule_key stays under ~200 chars.
-- Re-runnable: regenerates rule_key for every row, then re-dedupes, then
-- re-adds the unique index if it was dropped.
-- ─────────────────────────────────────────────────────────────────────────────

-- Drop the existing unique index so we can rewrite keys without conflicts.
DROP INDEX IF EXISTS public.uniq_lease_expense_rules_rule_set_rule_key;

UPDATE public.lease_expense_rules
SET rule_key =
  COALESCE(LOWER(TRIM(expense_category)),       '')        || '|' ||
  COALESCE(LOWER(TRIM(expense_subcategory)),    '')        || '|' ||
  COALESCE(LOWER(TRIM(payment_treatment)),      '')        || '|' ||
  COALESCE(LOWER(TRIM(recoverable_from_tenant)),'')        || '|' ||
  COALESCE(LOWER(TRIM(recovery_method)),        '')        || '|' ||
  COALESCE(source_page::text,                   '')        || '|' ||
  COALESCE(LOWER(TRIM(SUBSTRING(exact_source_text FROM 1 FOR 80))), '');

-- Re-dedup: collapse duplicate rule_keys per rule_set, keep highest-priority.
WITH ranked AS (
  SELECT
    id,
    rule_set_id,
    rule_key,
    ROW_NUMBER() OVER (
      PARTITION BY rule_set_id, rule_key
      ORDER BY
        CASE WHEN approval_status = 'approved' THEN 0 ELSE 1 END,
        CASE WHEN review_status   = 'approved' THEN 0 ELSE 1 END,
        CASE WHEN exact_source_text IS NOT NULL AND LENGTH(exact_source_text) > 30 THEN 0 ELSE 1 END,
        COALESCE(confidence_score, 0) DESC,
        created_at ASC
    ) AS rn
  FROM public.lease_expense_rules
  WHERE rule_set_id IS NOT NULL AND rule_key IS NOT NULL
)
DELETE FROM public.lease_expense_rules r
USING ranked
WHERE r.id = ranked.id
  AND ranked.rn > 1;

-- Re-create the unique index.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_lease_expense_rules_rule_set_rule_key
  ON public.lease_expense_rules(rule_set_id, rule_key)
  WHERE rule_set_id IS NOT NULL AND rule_key IS NOT NULL;

-- Verification.
SELECT
  (SELECT COUNT(*) FROM public.lease_expense_rules) AS total_rules,
  (SELECT COUNT(DISTINCT (rule_set_id, rule_key)) FROM public.lease_expense_rules WHERE rule_set_id IS NOT NULL) AS distinct_keys,
  (SELECT COUNT(*) FROM public.lease_expense_rule_sets) AS rule_sets;

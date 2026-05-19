-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: deterministic rule_key for lease_expense_rules.
--
-- Why this exists:
--   Today, every "Extract rules" click can produce a different rule count
--   (92 → 152 → other) because rows are upserted by `id` (random UUID),
--   not by the rule's content. If the LLM returns a slightly different
--   shape, a new row appears next to the old one instead of replacing it.
--
--   This migration adds a content-derived `rule_key` so the same lease +
--   same canonical category + same payment/recovery shape always upserts
--   to the same row. Spec formula:
--     rule_key = md5(
--       org_id, lease_id, approved_lease_abstract_id,
--       canonical_expense_category, canonical_expense_subcategory,
--       payment_treatment, recoverable_from_tenant, recovery_method,
--       source_page, md5(exact_source_text)
--     )
--
--   Also adds:
--     - extraction_version  TEXT  — which extractor build produced this row
--     - source_hash         TEXT  — hash of the exact_source_text for fast diff
--     - generation_source   TEXT  — workflow | llm | text_fallback | manual
--
--   And a UNIQUE INDEX on (rule_set_id, rule_key) so PostgREST can use it
--   in `.upsert({onConflict: 'rule_set_id,rule_key'})`.
--
-- Idempotent: every ADD COLUMN uses IF NOT EXISTS. Backfill uses COALESCE
-- so re-running does not overwrite already-computed keys. Pre-dedup step
-- removes duplicates before adding the UNIQUE index so the constraint can
-- be applied even on dirty data.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.lease_expense_rules
  ADD COLUMN IF NOT EXISTS rule_key            TEXT,
  ADD COLUMN IF NOT EXISTS extraction_version  TEXT,
  ADD COLUMN IF NOT EXISTS source_hash         TEXT,
  ADD COLUMN IF NOT EXISTS generation_source   TEXT;

ALTER TABLE public.lease_expense_rule_sets
  ADD COLUMN IF NOT EXISTS extraction_version  TEXT,
  ADD COLUMN IF NOT EXISTS rule_generation_hash TEXT;

-- ── Backfill rule_key for existing rows ─────────────────────────────────
-- Only sets rule_key where it's currently NULL. Uses md5 of the spec
-- fields. NULL fields normalize to '' so the hash stays stable.
UPDATE public.lease_expense_rules
SET rule_key = md5(
  COALESCE(org_id::text, '') || '|' ||
  COALESCE(lease_id::text, '') || '|' ||
  COALESCE(approved_lease_abstract_id::text, '') || '|' ||
  COALESCE(LOWER(TRIM(expense_category)), '') || '|' ||
  COALESCE(LOWER(TRIM(expense_subcategory)), '') || '|' ||
  COALESCE(LOWER(TRIM(payment_treatment)), '') || '|' ||
  COALESCE(LOWER(TRIM(recoverable_from_tenant)), '') || '|' ||
  COALESCE(LOWER(TRIM(recovery_method)), '') || '|' ||
  COALESCE(source_page::text, '') || '|' ||
  COALESCE(md5(LOWER(TRIM(exact_source_text))), '')
),
source_hash = COALESCE(
  source_hash,
  CASE WHEN exact_source_text IS NOT NULL AND LENGTH(TRIM(exact_source_text)) > 0
       THEN md5(LOWER(TRIM(exact_source_text)))
       ELSE NULL END
),
generation_source = COALESCE(generation_source, 'workflow')
WHERE rule_key IS NULL;

-- ── Dedup pass ───────────────────────────────────────────────────────────
-- Within each rule_set, if multiple rows now share the same rule_key (which
-- they will after backfill — that's the whole point), keep ONE and delete
-- the others. Keep the row with the highest review/approval score so we
-- don't lose user-approved rules.
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

-- ── UNIQUE index ─────────────────────────────────────────────────────────
-- Partial index — only rows with both rule_set_id and rule_key. Old rows
-- that somehow lack either are left untouched but won't be uniquely indexed.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_lease_expense_rules_rule_set_rule_key
  ON public.lease_expense_rules(rule_set_id, rule_key)
  WHERE rule_set_id IS NOT NULL AND rule_key IS NOT NULL;

-- Also index rule_key alone for fast lookup by content across sets.
CREATE INDEX IF NOT EXISTS idx_lease_expense_rules_rule_key
  ON public.lease_expense_rules(rule_key)
  WHERE rule_key IS NOT NULL;

-- Verification block — counts before/after for sanity.
SELECT
  (SELECT COUNT(*) FROM public.lease_expense_rules) AS total_rules,
  (SELECT COUNT(*) FROM public.lease_expense_rules WHERE rule_key IS NOT NULL) AS with_rule_key,
  (SELECT COUNT(DISTINCT (rule_set_id, rule_key)) FROM public.lease_expense_rules WHERE rule_set_id IS NOT NULL AND rule_key IS NOT NULL) AS distinct_keys,
  (SELECT COUNT(*) FROM public.lease_expense_rule_sets) AS rule_sets;

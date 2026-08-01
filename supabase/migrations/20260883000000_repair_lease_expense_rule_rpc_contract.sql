-- Repair the canonical lease-expense-rule persistence contract.
--
-- Root cause seen in production:
-- sync-approved-lease-expense-rules reached save_lease_expense_rule_set, but
-- the deployed lease_expense_rule_sets table was missing created_by. That
-- proves extraction/publication reached the database boundary and then failed
-- before any rule rows could be materialized for the UI.
--
-- This migration repairs the full RPC/table contract rather than only the
-- first failing column. Some environments have these tables from an older
-- CREATE TABLE IF NOT EXISTS shape and missed later additive columns.

ALTER TABLE public.lease_expense_rule_sets
  ADD COLUMN IF NOT EXISTS property_id UUID REFERENCES public.properties(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS version INT DEFAULT 1,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS extraction_version TEXT,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

ALTER TABLE public.lease_expense_rules
  ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS lease_id UUID,
  ADD COLUMN IF NOT EXISTS tenant_id UUID,
  ADD COLUMN IF NOT EXISTS property_id UUID,
  ADD COLUMN IF NOT EXISTS building_id UUID,
  ADD COLUMN IF NOT EXISTS unit_id UUID,
  ADD COLUMN IF NOT EXISTS expense_category TEXT,
  ADD COLUMN IF NOT EXISTS expense_subcategory TEXT,
  ADD COLUMN IF NOT EXISTS responsibility TEXT,
  ADD COLUMN IF NOT EXISTS included_in_base_rent BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS recoverable_from_tenant TEXT DEFAULT 'no',
  ADD COLUMN IF NOT EXISTS recovery_method TEXT,
  ADD COLUMN IF NOT EXISTS allocation_basis TEXT,
  ADD COLUMN IF NOT EXISTS cap_amount NUMERIC,
  ADD COLUMN IF NOT EXISTS cap_percent NUMERIC,
  ADD COLUMN IF NOT EXISTS gross_up_percent NUMERIC,
  ADD COLUMN IF NOT EXISTS base_year TEXT,
  ADD COLUMN IF NOT EXISTS base_year_amount NUMERIC,
  ADD COLUMN IF NOT EXISTS expense_stop_amount NUMERIC,
  ADD COLUMN IF NOT EXISTS billing_frequency TEXT,
  ADD COLUMN IF NOT EXISTS reconciliation_required BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS reconciliation_frequency TEXT,
  ADD COLUMN IF NOT EXISTS source_page INT,
  ADD COLUMN IF NOT EXISTS exact_source_text TEXT,
  ADD COLUMN IF NOT EXISTS confidence_score NUMERIC,
  ADD COLUMN IF NOT EXISTS extraction_status TEXT DEFAULT 'extracted',
  ADD COLUMN IF NOT EXISTS review_status TEXT DEFAULT 'needs_review',
  ADD COLUMN IF NOT EXISTS approval_status TEXT DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS published_to_cam BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS operational_responsibility TEXT DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS payment_treatment TEXT DEFAULT 'not_applicable',
  ADD COLUMN IF NOT EXISTS cam_eligible TEXT DEFAULT 'no',
  ADD COLUMN IF NOT EXISTS billing_treatment TEXT DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rule_key TEXT,
  ADD COLUMN IF NOT EXISTS rule_type TEXT,
  ADD COLUMN IF NOT EXISTS estimated_annual_amount NUMERIC,
  ADD COLUMN IF NOT EXISTS estimated_monthly_amount NUMERIC,
  ADD COLUMN IF NOT EXISTS tenant_share_percent NUMERIC,
  ADD COLUMN IF NOT EXISTS created_from TEXT,
  ADD COLUMN IF NOT EXISTS generation_source TEXT,
  ADD COLUMN IF NOT EXISTS source_field_key TEXT,
  ADD COLUMN IF NOT EXISTS extraction_version TEXT,
  ADD COLUMN IF NOT EXISTS source_hash TEXT,
  ADD COLUMN IF NOT EXISTS approved_lease_abstract_id UUID;

-- Older databases may still have recoverable_from_tenant as boolean. The
-- current RPC writes yes/no/conditional text, so align the column type.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'lease_expense_rules'
      AND column_name = 'recoverable_from_tenant'
      AND data_type = 'boolean'
  ) THEN
    ALTER TABLE public.lease_expense_rules
      ALTER COLUMN recoverable_from_tenant DROP DEFAULT,
      ALTER COLUMN recoverable_from_tenant TYPE TEXT
      USING (
        CASE
          WHEN recoverable_from_tenant IS TRUE THEN 'yes'
          WHEN recoverable_from_tenant IS FALSE THEN 'no'
          ELSE NULL
        END
      ),
      ALTER COLUMN recoverable_from_tenant SET DEFAULT 'no';
  END IF;
END $$;

-- Production drift found on the linked project: base_year was integer even
-- though the RPC/client contract sends textual values like "base_year" or a
-- year label. Store it as text so non-numeric lease language does not break
-- rule persistence.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'lease_expense_rules'
      AND column_name = 'base_year'
      AND data_type <> 'text'
  ) THEN
    ALTER TABLE public.lease_expense_rules
      ALTER COLUMN base_year TYPE TEXT USING base_year::TEXT;
  END IF;
END $$;

-- Production drift found on the linked project: approved_by was text. The
-- canonical workflow writes auth user ids, so keep only valid UUID strings
-- when converting and null out any legacy free-text values.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'lease_expense_rules'
      AND column_name = 'approved_by'
      AND udt_name <> 'uuid'
  ) THEN
    ALTER TABLE public.lease_expense_rules
      ALTER COLUMN approved_by TYPE UUID
      USING (
        CASE
          WHEN approved_by ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN approved_by::uuid
          ELSE NULL
        END
      );
  END IF;
END $$;

-- The text category is the source of truth for lease-derived rules. The
-- expense_categories FK improves joins but must not block source-backed lease
-- clauses from being saved.
ALTER TABLE public.lease_expense_rules
  ALTER COLUMN expense_category_id DROP NOT NULL;

ALTER TABLE public.lease_expense_values
  ADD COLUMN IF NOT EXISTS base_year_amount NUMERIC,
  ADD COLUMN IF NOT EXISTS extracted_value NUMERIC,
  ADD COLUMN IF NOT EXISTS manual_value NUMERIC,
  ADD COLUMN IF NOT EXISTS final_value NUMERIC,
  ADD COLUMN IF NOT EXISTS frequency TEXT DEFAULT 'yearly',
  ADD COLUMN IF NOT EXISTS value_source TEXT,
  ADD COLUMN IF NOT EXISTS mapped_expense_id UUID REFERENCES public.expenses(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS mapped_gl_account_id UUID,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

ALTER TABLE public.lease_expense_rule_clauses
  ADD COLUMN IF NOT EXISTS lease_expense_rule_id UUID REFERENCES public.lease_expense_rules(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS lease_id UUID REFERENCES public.leases(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS page_number INT,
  ADD COLUMN IF NOT EXISTS clause_type TEXT,
  ADD COLUMN IF NOT EXISTS clause_text TEXT,
  ADD COLUMN IF NOT EXISTS confidence NUMERIC,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();

UPDATE public.lease_expense_rules AS rules
SET
  org_id = COALESCE(rules.org_id, sets.org_id),
  lease_id = COALESCE(rules.lease_id, sets.lease_id),
  property_id = COALESCE(rules.property_id, sets.property_id),
  exact_source_text = COALESCE(rules.exact_source_text, rules.notes, rules.source),
  confidence_score = COALESCE(rules.confidence_score, rules.confidence),
  operational_responsibility = COALESCE(rules.operational_responsibility, rules.responsibility, 'unknown'),
  payment_treatment = COALESCE(rules.payment_treatment, 'not_applicable'),
  cam_eligible = COALESCE(rules.cam_eligible, 'no'),
  billing_treatment = COALESCE(rules.billing_treatment, 'none'),
  review_status = CASE
    WHEN rules.review_status = 'reviewed' THEN 'approved'
    ELSE COALESCE(rules.review_status, 'needs_review')
  END,
  approval_status = COALESCE(rules.approval_status, CASE WHEN sets.status = 'approved' THEN 'approved' ELSE 'draft' END)
FROM public.lease_expense_rule_sets AS sets
WHERE rules.rule_set_id = sets.id;

UPDATE public.lease_expense_rules AS rules
SET
  expense_category = COALESCE(rules.expense_category, categories.category_name),
  expense_subcategory = COALESCE(rules.expense_subcategory, categories.subcategory_name)
FROM public.expense_categories AS categories
WHERE rules.expense_category_id = categories.id;

-- The save RPC upserts on (lease_id, rule_key). Remove exact duplicate keys
-- left by older direct-write paths before enforcing the contract.
WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY lease_id, rule_key
      ORDER BY
        CASE WHEN approval_status = 'approved' OR review_status = 'approved' THEN 0 ELSE 1 END,
        updated_at DESC NULLS LAST,
        created_at DESC NULLS LAST,
        id
    ) AS rn
  FROM public.lease_expense_rules
  WHERE lease_id IS NOT NULL
    AND rule_key IS NOT NULL
)
DELETE FROM public.lease_expense_rules r
USING ranked
WHERE r.id = ranked.id
  AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_lease_expense_rules_lease_rule_key_contract
  ON public.lease_expense_rules (lease_id, rule_key);

CREATE INDEX IF NOT EXISTS idx_lease_expense_rule_sets_created_by
  ON public.lease_expense_rule_sets(created_by);

CREATE INDEX IF NOT EXISTS idx_lease_expense_rule_sets_approved_by
  ON public.lease_expense_rule_sets(approved_by);

CREATE INDEX IF NOT EXISTS idx_lease_expense_rule_sets_lease_status
  ON public.lease_expense_rule_sets(lease_id, status);

CREATE INDEX IF NOT EXISTS idx_lease_expense_rules_lease_id
  ON public.lease_expense_rules(lease_id);

CREATE INDEX IF NOT EXISTS idx_lease_expense_rules_scope
  ON public.lease_expense_rules(property_id, building_id, unit_id);

CREATE INDEX IF NOT EXISTS idx_lease_expense_rules_semantics
  ON public.lease_expense_rules(approval_status, review_status, cam_eligible, payment_treatment, published_to_cam);


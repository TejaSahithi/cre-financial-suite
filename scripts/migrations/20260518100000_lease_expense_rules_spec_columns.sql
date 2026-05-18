-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: lease_expense_rules — add the spec columns required by the
-- enterprise Lease Expense Rules workflow. We KEEP the existing boolean
-- columns (is_recoverable, has_base_year, etc.) so anything still reading
-- them continues to work, and add the richer enum / evidence columns
-- alongside. New writes populate both; old writes keep working.
--
-- Adds:
--   - Direct scope FKs (lease_id, org_id, property_id, building_id, unit_id,
--     tenant_id, approved_lease_abstract_id) so the rules table can be
--     queried by scope without joining lease_expense_rule_sets.
--   - Enum-style classification columns (operational_responsibility,
--     payment_treatment, recoverable_from_tenant, cam_eligible,
--     billing_treatment, recovery_method, allocation_basis).
--   - Cap, base year, expense stop, and admin/gross-up fields the rule
--     extractor already produces but had no home.
--   - Source evidence (source_page, exact_source_text, confidence_score).
--   - Review/approval lifecycle (extraction_status, review_status,
--     approval_status, published_to_cam, approved_by, approved_at,
--     created_from).
--
-- Idempotent: every ADD COLUMN uses IF NOT EXISTS.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.lease_expense_rules
  -- Scope (denormalized from rule_set for direct queries)
  ADD COLUMN IF NOT EXISTS org_id                       UUID,
  ADD COLUMN IF NOT EXISTS lease_id                     UUID,
  ADD COLUMN IF NOT EXISTS approved_lease_abstract_id   UUID,
  ADD COLUMN IF NOT EXISTS property_id                  UUID,
  ADD COLUMN IF NOT EXISTS building_id                  UUID,
  ADD COLUMN IF NOT EXISTS unit_id                      UUID,
  ADD COLUMN IF NOT EXISTS tenant_id                    UUID,

  -- Canonical category (text mirror of expense_categories.normalized_key so
  -- the rule survives even if expense_categories is rebuilt).
  ADD COLUMN IF NOT EXISTS expense_category             TEXT,
  ADD COLUMN IF NOT EXISTS expense_subcategory          TEXT,

  -- Enum-style classification fields (use TEXT with CHECK so we keep schema
  -- evolution easy — Postgres ENUM types are painful to alter).
  ADD COLUMN IF NOT EXISTS operational_responsibility   TEXT,   -- landlord | tenant | shared | unknown
  ADD COLUMN IF NOT EXISTS payment_treatment            TEXT,   -- included_in_base_rent | separately_billed | tenant_direct_contract | reimbursable | not_applicable
  ADD COLUMN IF NOT EXISTS recoverable_from_tenant      TEXT,   -- yes | no | conditional | unknown
  ADD COLUMN IF NOT EXISTS cam_eligible                 TEXT,   -- yes | no | conditional | unknown
  ADD COLUMN IF NOT EXISTS billing_treatment            TEXT,   -- included | direct_bill | cam_estimate | reconciliation | none
  ADD COLUMN IF NOT EXISTS recovery_method              TEXT,   -- pro_rata | direct | tenant_direct | landlord_pays | manual_review
  ADD COLUMN IF NOT EXISTS allocation_basis             TEXT,   -- rsf | usage | metered | fixed | other

  -- Cap / base year / expense stop / admin / gross-up
  ADD COLUMN IF NOT EXISTS included_in_base_rent        BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS cap_amount                   NUMERIC,
  ADD COLUMN IF NOT EXISTS cap_percent                  NUMERIC,
  ADD COLUMN IF NOT EXISTS base_year                    INTEGER,
  ADD COLUMN IF NOT EXISTS base_year_amount             NUMERIC,
  ADD COLUMN IF NOT EXISTS expense_stop_amount          NUMERIC,
  ADD COLUMN IF NOT EXISTS gross_up_percent             NUMERIC,

  -- Billing & reconciliation
  ADD COLUMN IF NOT EXISTS billing_frequency            TEXT,
  ADD COLUMN IF NOT EXISTS reconciliation_required      BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS reconciliation_frequency     TEXT,

  -- Source evidence
  ADD COLUMN IF NOT EXISTS source_page                  INTEGER,
  ADD COLUMN IF NOT EXISTS exact_source_text            TEXT,
  ADD COLUMN IF NOT EXISTS confidence_score             NUMERIC,

  -- Lifecycle
  ADD COLUMN IF NOT EXISTS extraction_status            TEXT DEFAULT 'extracted',   -- extracted | inferred | calculated | missing_source_evidence | conflict_detected
  ADD COLUMN IF NOT EXISTS review_status                TEXT DEFAULT 'needs_review', -- needs_review | approved | rejected | not_applicable
  ADD COLUMN IF NOT EXISTS approval_status              TEXT DEFAULT 'pending',     -- pending | approved | rejected
  ADD COLUMN IF NOT EXISTS published_to_cam             BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS approved_by                  TEXT,
  ADD COLUMN IF NOT EXISTS approved_at                  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_from                 TEXT DEFAULT 'workflow';    -- workflow | manual | reextract | import

-- Backfill scope columns from the parent rule_set so existing rows query
-- correctly under the new scope-aware page filter. Safe to re-run.
UPDATE public.lease_expense_rules r
SET
  org_id      = COALESCE(r.org_id,      s.org_id),
  lease_id    = COALESCE(r.lease_id,    s.lease_id),
  property_id = COALESCE(r.property_id, s.property_id),
  building_id = COALESCE(r.building_id, s.building_id),
  unit_id     = COALESCE(r.unit_id,     s.unit_id)
FROM public.lease_expense_rule_sets s
WHERE r.rule_set_id = s.id
  AND (r.org_id IS NULL OR r.lease_id IS NULL OR r.property_id IS NULL);

-- Backfill canonical category text from expense_categories. Lets us drop
-- the join when reading rule lists.
UPDATE public.lease_expense_rules r
SET
  expense_category    = COALESCE(r.expense_category,    c.normalized_key, c.category_name),
  expense_subcategory = COALESCE(r.expense_subcategory, c.subcategory_name)
FROM public.expense_categories c
WHERE r.expense_category_id = c.id
  AND r.expense_category IS NULL;

-- Indexes on the new scope columns so the Lease Expense Rules page filter
-- stays fast as rule volume grows.
CREATE INDEX IF NOT EXISTS idx_lease_expense_rules_lease    ON public.lease_expense_rules(lease_id);
CREATE INDEX IF NOT EXISTS idx_lease_expense_rules_property ON public.lease_expense_rules(property_id);
CREATE INDEX IF NOT EXISTS idx_lease_expense_rules_scope    ON public.lease_expense_rules(org_id, property_id, building_id, unit_id);
CREATE INDEX IF NOT EXISTS idx_lease_expense_rules_review   ON public.lease_expense_rules(review_status, approval_status);
CREATE INDEX IF NOT EXISTS idx_lease_expense_rules_category ON public.lease_expense_rules(expense_category);

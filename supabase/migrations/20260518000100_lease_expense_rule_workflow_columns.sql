-- Persist richer lease-derived expense rule metadata directly on
-- lease_expense_rules so the expense workflow can survive taxonomy joins,
-- scope filtering, CAM publishing, and approved-abstract handoff.

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
  ADD COLUMN IF NOT EXISTS recoverable_from_tenant BOOLEAN DEFAULT false,
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
  ADD COLUMN IF NOT EXISTS published_to_cam BOOLEAN DEFAULT false;

UPDATE public.lease_expense_rules AS rules
SET
  org_id = COALESCE(rules.org_id, rule_sets.org_id),
  lease_id = COALESCE(rules.lease_id, rule_sets.lease_id),
  property_id = COALESCE(rules.property_id, rule_sets.property_id),
  recoverable_from_tenant = COALESCE(rules.recoverable_from_tenant, rules.is_recoverable, false),
  responsibility = COALESCE(
    rules.responsibility,
    CASE
      WHEN rules.is_excluded THEN 'tenant_direct'
      WHEN rules.is_recoverable THEN 'landlord_recoverable'
      ELSE 'landlord_non_recoverable'
    END
  ),
  review_status = COALESCE(
    rules.review_status,
    CASE
      WHEN rules.row_status IN ('mapped', 'manually_added') THEN 'reviewed'
      WHEN rules.row_status = 'not_mentioned' THEN 'not_found'
      ELSE 'needs_review'
    END
  ),
  approval_status = COALESCE(
    rules.approval_status,
    CASE
      WHEN rule_sets.status = 'approved' THEN 'approved'
      ELSE 'draft'
    END
  ),
  confidence_score = COALESCE(rules.confidence_score, rules.confidence),
  exact_source_text = COALESCE(rules.exact_source_text, rules.notes, rules.source)
FROM public.lease_expense_rule_sets AS rule_sets
WHERE rules.rule_set_id = rule_sets.id;

UPDATE public.lease_expense_rules AS rules
SET
  expense_category = COALESCE(rules.expense_category, categories.category_name),
  expense_subcategory = COALESCE(rules.expense_subcategory, categories.subcategory_name)
FROM public.expense_categories AS categories
WHERE rules.expense_category_id = categories.id;

CREATE INDEX IF NOT EXISTS idx_lease_expense_rules_lease_id
  ON public.lease_expense_rules (lease_id);

CREATE INDEX IF NOT EXISTS idx_lease_expense_rules_scope
  ON public.lease_expense_rules (property_id, building_id, unit_id);

CREATE INDEX IF NOT EXISTS idx_lease_expense_rules_approval_status
  ON public.lease_expense_rules (approval_status, published_to_cam);

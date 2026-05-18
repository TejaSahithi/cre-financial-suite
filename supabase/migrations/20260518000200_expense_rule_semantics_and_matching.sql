-- Align lease expense rule semantics with the CAM / Actual Expense workflow.
-- Lease expense rules remain lease-derived policy rows.
-- Actual expenses remain invoice/import/manual rows that link back to approved rules.

ALTER TABLE public.lease_expense_rules
  ADD COLUMN IF NOT EXISTS operational_responsibility TEXT DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS payment_treatment TEXT DEFAULT 'not_applicable',
  ADD COLUMN IF NOT EXISTS cam_eligible TEXT DEFAULT 'no',
  ADD COLUMN IF NOT EXISTS billing_treatment TEXT DEFAULT 'none';

ALTER TABLE public.lease_expense_rules
  ALTER COLUMN recoverable_from_tenant DROP DEFAULT;

ALTER TABLE public.lease_expense_rules
  ALTER COLUMN recoverable_from_tenant TYPE TEXT
  USING (
    CASE
      WHEN recoverable_from_tenant IS TRUE THEN 'yes'
      WHEN recoverable_from_tenant IS FALSE THEN 'no'
      ELSE NULL
    END
  );

ALTER TABLE public.lease_expense_rules
  ALTER COLUMN recoverable_from_tenant SET DEFAULT 'no';

UPDATE public.lease_expense_rules
SET
  operational_responsibility = COALESCE(
    operational_responsibility,
    CASE
      WHEN included_in_base_rent IS TRUE THEN 'landlord'
      WHEN is_excluded IS TRUE THEN 'tenant'
      WHEN recoverable_from_tenant IN ('yes', 'conditional') THEN 'landlord'
      ELSE 'unknown'
    END
  ),
  payment_treatment = COALESCE(
    payment_treatment,
    CASE
      WHEN included_in_base_rent IS TRUE THEN 'included_in_base_rent'
      WHEN is_excluded IS TRUE THEN 'tenant_direct_contract'
      WHEN recoverable_from_tenant IN ('yes', 'conditional') THEN 'reimbursable'
      ELSE 'not_applicable'
    END
  ),
  cam_eligible = COALESCE(
    cam_eligible,
    CASE
      WHEN included_in_base_rent IS TRUE THEN 'no'
      WHEN is_excluded IS TRUE THEN 'no'
      WHEN recoverable_from_tenant = 'conditional' THEN 'conditional'
      WHEN recoverable_from_tenant = 'yes' THEN 'yes'
      ELSE 'no'
    END
  ),
  billing_treatment = COALESCE(
    billing_treatment,
    CASE
      WHEN included_in_base_rent IS TRUE THEN 'included'
      WHEN recovery_method IN ('direct_bill', 'actual_usage', 'tenant_direct_contract') THEN 'direct_bill'
      WHEN recovery_method IN ('base_year', 'expense_stop', 'base_year_excess', 'expense_stop_excess', 'reconciliation') THEN 'reconciliation'
      WHEN recovery_method IN ('fixed_monthly', 'pro_rata_share', 'monthly_reimbursement', 'pass_through') THEN 'cam_estimate'
      ELSE 'none'
    END
  ),
  review_status = CASE
    WHEN review_status IN ('reviewed') THEN 'approved'
    ELSE COALESCE(review_status, 'needs_review')
  END;

ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS linked_expense_rule_id UUID REFERENCES public.lease_expense_rules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS recoverability_result TEXT DEFAULT 'needs_review',
  ADD COLUMN IF NOT EXISTS cam_pool_id UUID,
  ADD COLUMN IF NOT EXISTS recovery_reason TEXT,
  ADD COLUMN IF NOT EXISTS cam_eligible TEXT DEFAULT 'conditional',
  ADD COLUMN IF NOT EXISTS recovery_method TEXT;

ALTER TABLE public.expense_classifications
  ADD COLUMN IF NOT EXISTS linked_expense_rule_id UUID REFERENCES public.lease_expense_rules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS recoverability_result TEXT DEFAULT 'needs_review',
  ADD COLUMN IF NOT EXISTS cam_pool_id UUID,
  ADD COLUMN IF NOT EXISTS recovery_reason TEXT,
  ADD COLUMN IF NOT EXISTS cam_eligible TEXT DEFAULT 'conditional',
  ADD COLUMN IF NOT EXISTS recovery_method TEXT;

UPDATE public.expenses
SET
  linked_expense_rule_id = COALESCE(linked_expense_rule_id, recovery_rule_id),
  recoverability_result = COALESCE(recoverability_result, recovery_status, classification, 'needs_review');

UPDATE public.expense_classifications
SET
  linked_expense_rule_id = COALESCE(linked_expense_rule_id, recovery_rule_id),
  recoverability_result = COALESCE(recoverability_result, recovery_status, 'needs_review');

CREATE INDEX IF NOT EXISTS idx_lease_expense_rules_semantics
  ON public.lease_expense_rules (approval_status, review_status, cam_eligible, payment_treatment, published_to_cam);

CREATE INDEX IF NOT EXISTS idx_expenses_linked_expense_rule
  ON public.expenses (linked_expense_rule_id, recoverability_result, approved_status);

CREATE INDEX IF NOT EXISTS idx_expense_classifications_linked_rule
  ON public.expense_classifications (linked_expense_rule_id, recoverability_result, approved_status);

-- Consolidate the expense classification workflow columns used by the
-- client-side CAM eligibility lifecycle. This is intentionally additive and
-- safe to run on databases that already applied the earlier split migrations.

ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS recoverability_result TEXT,
  ADD COLUMN IF NOT EXISTS cam_pool_id UUID,
  ADD COLUMN IF NOT EXISTS recovery_reason TEXT,
  ADD COLUMN IF NOT EXISTS cam_eligible TEXT,
  ADD COLUMN IF NOT EXISTS recovery_method TEXT,
  ADD COLUMN IF NOT EXISTS rule_source TEXT,
  ADD COLUMN IF NOT EXISTS linked_expense_rule_id UUID REFERENCES public.lease_expense_rules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS recovery_meta JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS classification_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS classification_updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_status TEXT DEFAULT 'draft';

ALTER TABLE public.expense_classifications
  ADD COLUMN IF NOT EXISTS recoverability_result TEXT,
  ADD COLUMN IF NOT EXISTS recovery_reason TEXT,
  ADD COLUMN IF NOT EXISTS cam_eligible TEXT,
  ADD COLUMN IF NOT EXISTS recovery_method TEXT,
  ADD COLUMN IF NOT EXISTS linked_expense_rule_id UUID REFERENCES public.lease_expense_rules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cam_pool_id UUID,
  ADD COLUMN IF NOT EXISTS classification_key TEXT,
  ADD COLUMN IF NOT EXISTS actual_expense_id UUID,
  ADD COLUMN IF NOT EXISTS lease_expense_rule_id UUID REFERENCES public.lease_expense_rules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS category TEXT,
  ADD COLUMN IF NOT EXISTS subcategory TEXT,
  ADD COLUMN IF NOT EXISTS amount NUMERIC,
  ADD COLUMN IF NOT EXISTS service_period_start DATE,
  ADD COLUMN IF NOT EXISTS service_period_end DATE,
  ADD COLUMN IF NOT EXISTS classification_status TEXT,
  ADD COLUMN IF NOT EXISTS exception_type TEXT,
  ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS recoverable_amount NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS non_recoverable_amount NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS conditional_amount NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS excluded_amount NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sent_to_cam BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS sent_to_cam_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sent_to_cam_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cam_status TEXT,
  ADD COLUMN IF NOT EXISTS cam_source TEXT,
  ADD COLUMN IF NOT EXISTS cam_input_type TEXT,
  ADD COLUMN IF NOT EXISTS manual_cam_reviewed BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS manual_cam_reason TEXT,
  ADD COLUMN IF NOT EXISTS manual_cam_reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS manual_cam_reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS allocation_basis TEXT,
  ADD COLUMN IF NOT EXISTS next_step TEXT,
  ADD COLUMN IF NOT EXISTS row_type TEXT;

UPDATE public.expense_classifications
SET
  actual_expense_id = COALESCE(actual_expense_id, expense_id),
  lease_expense_rule_id = COALESCE(lease_expense_rule_id, linked_expense_rule_id, recovery_rule_id),
  recoverability_result = COALESCE(recoverability_result, recovery_status, 'needs_review'),
  allocation_basis = COALESCE(allocation_basis, allocation_method),
  classification_key = COALESCE(
    classification_key,
    CONCAT_WS(':', COALESCE(org_id::text, ''), COALESCE(actual_expense_id::text, expense_id::text, ''), COALESCE(lease_expense_rule_id::text, linked_expense_rule_id::text, recovery_rule_id::text, 'unmatched'))
  ),
  row_type = COALESCE(
    row_type,
    CASE
      WHEN (expense_id IS NOT NULL OR actual_expense_id IS NOT NULL) AND COALESCE(lease_expense_rule_id, linked_expense_rule_id, recovery_rule_id) IS NOT NULL THEN 'matched_classification'
      WHEN (expense_id IS NOT NULL OR actual_expense_id IS NOT NULL) THEN 'actual_missing_rule'
      WHEN COALESCE(lease_expense_rule_id, linked_expense_rule_id, recovery_rule_id) IS NOT NULL THEN 'rule_missing_actual'
      ELSE 'unknown'
    END
  )
WHERE actual_expense_id IS NULL
   OR lease_expense_rule_id IS NULL
   OR recoverability_result IS NULL
   OR allocation_basis IS NULL
   OR classification_key IS NULL
   OR row_type IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_expense_classifications_org_expense
  ON public.expense_classifications(org_id, expense_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_expense_classifications_classification_key
  ON public.expense_classifications(classification_key)
  WHERE classification_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_expense_classifications_scope_status
  ON public.expense_classifications(org_id, property_id, building_id, unit_id, lease_id, tenant_id, classification_status);

CREATE INDEX IF NOT EXISTS idx_expense_classifications_cam_status
  ON public.expense_classifications(sent_to_cam, cam_status);

ALTER TABLE public.cam_expense_inputs
  ADD COLUMN IF NOT EXISTS cam_source TEXT,
  ADD COLUMN IF NOT EXISTS cam_input_type TEXT,
  ADD COLUMN IF NOT EXISTS manual_cam_reviewed BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS manual_cam_reason TEXT,
  ADD COLUMN IF NOT EXISTS fiscal_year INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cam_expense_inputs_rule_amount
  ON public.cam_expense_inputs(lease_expense_rule_id, fiscal_year)
  WHERE lease_expense_rule_id IS NOT NULL
    AND fiscal_year IS NOT NULL
    AND cam_input_type = 'lease_rule_amount';

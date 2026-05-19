ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS review_status TEXT,
  ADD COLUMN IF NOT EXISTS approved_by UUID,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;

ALTER TABLE public.expense_classifications
  ADD COLUMN IF NOT EXISTS classification_key TEXT,
  ADD COLUMN IF NOT EXISTS actual_expense_id UUID,
  ADD COLUMN IF NOT EXISTS lease_expense_rule_id UUID,
  ADD COLUMN IF NOT EXISTS category TEXT,
  ADD COLUMN IF NOT EXISTS subcategory TEXT,
  ADD COLUMN IF NOT EXISTS amount NUMERIC,
  ADD COLUMN IF NOT EXISTS service_period_start DATE,
  ADD COLUMN IF NOT EXISTS service_period_end DATE,
  ADD COLUMN IF NOT EXISTS classification_status TEXT DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS exception_type TEXT,
  ADD COLUMN IF NOT EXISTS reviewed_by UUID,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS recoverable_amount NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS non_recoverable_amount NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS conditional_amount NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS excluded_amount NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sent_to_cam BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS sent_to_cam_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sent_to_cam_by UUID,
  ADD COLUMN IF NOT EXISTS cam_status TEXT,
  ADD COLUMN IF NOT EXISTS allocation_basis TEXT,
  ADD COLUMN IF NOT EXISTS next_step TEXT;

UPDATE public.expense_classifications
SET
  actual_expense_id = COALESCE(actual_expense_id, expense_id),
  lease_expense_rule_id = COALESCE(lease_expense_rule_id, linked_expense_rule_id, recovery_rule_id),
  classification_key = COALESCE(
    classification_key,
    CONCAT_WS(':', COALESCE(org_id::text, ''), COALESCE(actual_expense_id::text, expense_id::text, ''), COALESCE(lease_expense_rule_id::text, linked_expense_rule_id::text, recovery_rule_id::text, 'unmatched'))
  ),
  allocation_basis = COALESCE(allocation_basis, allocation_method),
  classification_status = COALESCE(
    NULLIF(classification_status, ''),
    CASE
      WHEN approved_status = 'approved' AND COALESCE(recoverability_result, recovery_status) = 'recoverable' THEN 'finalized'
      WHEN COALESCE(recoverability_result, recovery_status) = 'conditional' THEN 'conditional'
      WHEN COALESCE(recoverability_result, recovery_status) = 'needs_review' THEN 'exception'
      WHEN COALESCE(recoverability_result, recovery_status) IN ('excluded', 'non_recoverable') THEN 'excluded'
      WHEN COALESCE(actual_expense_id, expense_id) IS NOT NULL AND COALESCE(lease_expense_rule_id, linked_expense_rule_id, recovery_rule_id) IS NULL THEN 'unmatched'
      WHEN COALESCE(actual_expense_id, expense_id) IS NOT NULL THEN 'matched'
      ELSE 'draft'
    END
  )
WHERE actual_expense_id IS NULL
   OR lease_expense_rule_id IS NULL
   OR classification_key IS NULL
   OR classification_status IS NULL
   OR classification_status = ''
   OR allocation_basis IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_expense_classifications_classification_key
  ON public.expense_classifications(classification_key)
  WHERE classification_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_expense_classifications_scope_status
  ON public.expense_classifications(org_id, property_id, building_id, unit_id, lease_id, tenant_id, classification_status);

CREATE INDEX IF NOT EXISTS idx_expense_classifications_cam_status
  ON public.expense_classifications(sent_to_cam, cam_status);

CREATE TABLE IF NOT EXISTS public.cam_expense_inputs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID,
  property_id UUID,
  building_id UUID,
  unit_id UUID,
  lease_id UUID,
  tenant_id UUID,
  actual_expense_id UUID,
  classification_result_id UUID,
  lease_expense_rule_id UUID,
  category TEXT,
  amount NUMERIC NOT NULL DEFAULT 0,
  recovery_method TEXT,
  allocation_basis TEXT,
  source TEXT NOT NULL DEFAULT 'expense_classification',
  status TEXT NOT NULL DEFAULT 'pending_cam_review',
  sent_to_cam_at TIMESTAMPTZ,
  sent_to_cam_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cam_expense_inputs_classification
  ON public.cam_expense_inputs(classification_result_id)
  WHERE classification_result_id IS NOT NULL;

ALTER TABLE public.cam_expense_inputs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  EXECUTE 'DROP POLICY IF EXISTS "cam_expense_inputs_org_select" ON public.cam_expense_inputs';
  EXECUTE 'DROP POLICY IF EXISTS "cam_expense_inputs_org_write" ON public.cam_expense_inputs';
  EXECUTE $POL$
    CREATE POLICY "cam_expense_inputs_org_select"
      ON public.cam_expense_inputs FOR SELECT
      USING (
        public.is_super_admin()
        OR org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
      )
  $POL$;
  EXECUTE $POL$
    CREATE POLICY "cam_expense_inputs_org_write"
      ON public.cam_expense_inputs FOR ALL
      USING (
        public.is_super_admin()
        OR org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
      )
      WITH CHECK (
        public.is_super_admin()
        OR org_id IS NULL
        OR org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
      )
  $POL$;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'cam_expense_inputs policies skipped: %', SQLERRM;
END $$;

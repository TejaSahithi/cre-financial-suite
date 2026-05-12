-- Migration: 20260512090000_lease_workflow_foundation.sql
-- Description: Adds workflow tables and enrichment columns for lease -> expense -> CAM -> budget orchestration

ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS tenant_name TEXT,
  ADD COLUMN IF NOT EXISTS vendor_name TEXT,
  ADD COLUMN IF NOT EXISTS expense_subcategory TEXT,
  ADD COLUMN IF NOT EXISTS expense_date DATE,
  ADD COLUMN IF NOT EXISTS billing_period_start DATE,
  ADD COLUMN IF NOT EXISTS billing_period_end DATE,
  ADD COLUMN IF NOT EXISTS source_type TEXT DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS recovery_status TEXT DEFAULT 'needs_review',
  ADD COLUMN IF NOT EXISTS recovery_rule_id UUID REFERENCES public.lease_expense_rules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rule_source TEXT,
  ADD COLUMN IF NOT EXISTS confidence_score NUMERIC,
  ADD COLUMN IF NOT EXISTS evidence_text TEXT,
  ADD COLUMN IF NOT EXISTS evidence_page_number INT,
  ADD COLUMN IF NOT EXISTS approved_status TEXT DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS allocation_method TEXT,
  ADD COLUMN IF NOT EXISTS recovery_meta JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS classification_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS classification_updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_expenses_org_scope_workflow
  ON public.expenses(org_id, property_id, building_id, unit_id, lease_id, fiscal_year);

CREATE INDEX IF NOT EXISTS idx_expenses_recovery_status
  ON public.expenses(org_id, recovery_status, approved_status);

CREATE TABLE IF NOT EXISTS public.expense_classifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  expense_id UUID NOT NULL REFERENCES public.expenses(id) ON DELETE CASCADE,
  property_id UUID REFERENCES public.properties(id) ON DELETE CASCADE,
  building_id UUID REFERENCES public.buildings(id) ON DELETE SET NULL,
  unit_id UUID REFERENCES public.units(id) ON DELETE SET NULL,
  lease_id UUID REFERENCES public.leases(id) ON DELETE SET NULL,
  tenant_id UUID REFERENCES public.tenants(id) ON DELETE SET NULL,
  rule_set_id UUID REFERENCES public.lease_expense_rule_sets(id) ON DELETE SET NULL,
  recovery_rule_id UUID REFERENCES public.lease_expense_rules(id) ON DELETE SET NULL,
  recovery_status TEXT NOT NULL DEFAULT 'needs_review',
  allocation_method TEXT,
  cap_applied BOOLEAN DEFAULT false,
  exclusion_applied BOOLEAN DEFAULT false,
  condition_applied BOOLEAN DEFAULT false,
  condition_reason TEXT,
  rule_source TEXT,
  confidence_score NUMERIC,
  evidence_text TEXT,
  evidence_page_number INT,
  approved_status TEXT NOT NULL DEFAULT 'draft',
  notes TEXT,
  classified_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  classified_at TIMESTAMPTZ DEFAULT now(),
  approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (org_id, expense_id)
);

CREATE INDEX IF NOT EXISTS idx_expense_classifications_scope
  ON public.expense_classifications(org_id, property_id, building_id, unit_id, lease_id, recovery_status);

ALTER TABLE public.expense_classifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "expense_classifications_select" ON public.expense_classifications;
DROP POLICY IF EXISTS "expense_classifications_insert" ON public.expense_classifications;
DROP POLICY IF EXISTS "expense_classifications_update" ON public.expense_classifications;
DROP POLICY IF EXISTS "expense_classifications_delete" ON public.expense_classifications;

CREATE POLICY "expense_classifications_select" ON public.expense_classifications
  FOR SELECT USING (public.is_super_admin() OR org_id IN (SELECT public.get_my_org_ids()));

CREATE POLICY "expense_classifications_insert" ON public.expense_classifications
  FOR INSERT WITH CHECK (public.is_super_admin() OR public.can_write_org_data(org_id));

CREATE POLICY "expense_classifications_update" ON public.expense_classifications
  FOR UPDATE USING (public.is_super_admin() OR public.can_write_org_data(org_id));

CREATE POLICY "expense_classifications_delete" ON public.expense_classifications
  FOR DELETE USING (public.is_super_admin() OR public.can_write_org_data(org_id));

CREATE TABLE IF NOT EXISTS public.budget_line_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  budget_id UUID NOT NULL REFERENCES public.budgets(id) ON DELETE CASCADE,
  property_id UUID REFERENCES public.properties(id) ON DELETE CASCADE,
  building_id UUID REFERENCES public.buildings(id) ON DELETE SET NULL,
  unit_id UUID REFERENCES public.units(id) ON DELETE SET NULL,
  lease_id UUID REFERENCES public.leases(id) ON DELETE SET NULL,
  category TEXT NOT NULL,
  subcategory TEXT,
  line_type TEXT NOT NULL DEFAULT 'expense',
  amount NUMERIC NOT NULL DEFAULT 0,
  source_type TEXT DEFAULT 'system_calculated',
  source_snapshot_id UUID REFERENCES public.computation_snapshots(id) ON DELETE SET NULL,
  notes TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_budget_line_items_budget
  ON public.budget_line_items(org_id, budget_id, line_type, category);

ALTER TABLE public.budget_line_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "budget_line_items_select" ON public.budget_line_items;
DROP POLICY IF EXISTS "budget_line_items_insert" ON public.budget_line_items;
DROP POLICY IF EXISTS "budget_line_items_update" ON public.budget_line_items;
DROP POLICY IF EXISTS "budget_line_items_delete" ON public.budget_line_items;

CREATE POLICY "budget_line_items_select" ON public.budget_line_items
  FOR SELECT USING (public.is_super_admin() OR org_id IN (SELECT public.get_my_org_ids()));

CREATE POLICY "budget_line_items_insert" ON public.budget_line_items
  FOR INSERT WITH CHECK (public.is_super_admin() OR public.can_write_org_data(org_id));

CREATE POLICY "budget_line_items_update" ON public.budget_line_items
  FOR UPDATE USING (public.is_super_admin() OR public.can_write_org_data(org_id));

CREATE POLICY "budget_line_items_delete" ON public.budget_line_items
  FOR DELETE USING (public.is_super_admin() OR public.can_write_org_data(org_id));

CREATE OR REPLACE FUNCTION public.set_workflow_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_expense_classifications_updated_at ON public.expense_classifications;
CREATE TRIGGER set_expense_classifications_updated_at
  BEFORE UPDATE ON public.expense_classifications
  FOR EACH ROW
  EXECUTE FUNCTION public.set_workflow_updated_at();

DROP TRIGGER IF EXISTS set_budget_line_items_updated_at ON public.budget_line_items;
CREATE TRIGGER set_budget_line_items_updated_at
  BEFORE UPDATE ON public.budget_line_items
  FOR EACH ROW
  EXECUTE FUNCTION public.set_workflow_updated_at();

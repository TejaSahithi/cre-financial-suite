-- Migration: 20260424000000_expense_classifications.sql
-- Description: Creates the expense classifications schema

CREATE TABLE IF NOT EXISTS public.expense_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE, -- null for system global
  is_system_default BOOLEAN DEFAULT false,
  category_name TEXT NOT NULL,
  subcategory_name TEXT,
  normalized_key TEXT NOT NULL,
  is_active BOOLEAN DEFAULT true,
  default_gl_account_id UUID,
  display_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.expense_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "expense_categories_select" ON public.expense_categories FOR SELECT USING (org_id IS NULL OR org_id IN (SELECT public.get_my_org_ids()));
CREATE POLICY "expense_categories_insert" ON public.expense_categories FOR INSERT WITH CHECK (public.can_write_org_data(org_id));
CREATE POLICY "expense_categories_update" ON public.expense_categories FOR UPDATE USING (public.can_write_org_data(org_id));

CREATE TABLE IF NOT EXISTS public.scope_expense_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('property', 'building', 'unit')),
  scope_id UUID NOT NULL,
  expense_category_id UUID NOT NULL REFERENCES public.expense_categories(id) ON DELETE CASCADE,
  is_applicable BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.scope_expense_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "scope_expense_categories_select" ON public.scope_expense_categories FOR SELECT USING (org_id IN (SELECT public.get_my_org_ids()));
CREATE POLICY "scope_expense_categories_insert" ON public.scope_expense_categories FOR INSERT WITH CHECK (public.can_write_org_data(org_id));
CREATE POLICY "scope_expense_categories_update" ON public.scope_expense_categories FOR UPDATE USING (public.can_write_org_data(org_id));
CREATE POLICY "scope_expense_categories_delete" ON public.scope_expense_categories FOR DELETE USING (public.can_write_org_data(org_id));

CREATE TABLE IF NOT EXISTS public.lease_expense_rule_sets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lease_id UUID NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  property_id UUID REFERENCES public.properties(id) ON DELETE CASCADE,
  version INT DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft', -- draft, review_required, reviewed, approved, archived
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.lease_expense_rule_sets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "lease_expense_rule_sets_select" ON public.lease_expense_rule_sets FOR SELECT USING (org_id IN (SELECT public.get_my_org_ids()));
CREATE POLICY "lease_expense_rule_sets_insert" ON public.lease_expense_rule_sets FOR INSERT WITH CHECK (public.can_write_org_data(org_id));
CREATE POLICY "lease_expense_rule_sets_update" ON public.lease_expense_rule_sets FOR UPDATE USING (public.can_write_org_data(org_id));

CREATE TABLE IF NOT EXISTS public.lease_expense_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_set_id UUID NOT NULL REFERENCES public.lease_expense_rule_sets(id) ON DELETE CASCADE,
  expense_category_id UUID NOT NULL REFERENCES public.expense_categories(id) ON DELETE CASCADE,
  row_status TEXT DEFAULT 'needs_review', -- not_mentioned, uncertain, unmapped, mapped, needs_review, missing_value, manually_added
  mentioned_in_lease BOOLEAN DEFAULT false,
  is_recoverable BOOLEAN DEFAULT false,
  is_excluded BOOLEAN DEFAULT false,
  is_controllable BOOLEAN DEFAULT false,
  is_subject_to_cap BOOLEAN DEFAULT false,
  cap_type TEXT,
  cap_value NUMERIC,
  has_base_year BOOLEAN DEFAULT false,
  base_year_type TEXT,
  gross_up_applicable BOOLEAN DEFAULT false,
  admin_fee_applicable BOOLEAN DEFAULT false,
  admin_fee_percent NUMERIC,
  notes TEXT,
  confidence NUMERIC,
  source TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.lease_expense_rules ENABLE ROW LEVEL SECURITY;
-- Using rule_set_id -> org_id for RLS check
CREATE POLICY "lease_expense_rules_select" ON public.lease_expense_rules FOR SELECT USING (
  rule_set_id IN (SELECT id FROM public.lease_expense_rule_sets WHERE org_id IN (SELECT public.get_my_org_ids()))
);
CREATE POLICY "lease_expense_rules_insert" ON public.lease_expense_rules FOR INSERT WITH CHECK (
  rule_set_id IN (SELECT id FROM public.lease_expense_rule_sets WHERE public.can_write_org_data(org_id))
);
CREATE POLICY "lease_expense_rules_update" ON public.lease_expense_rules FOR UPDATE USING (
  rule_set_id IN (SELECT id FROM public.lease_expense_rule_sets WHERE public.can_write_org_data(org_id))
);

CREATE TABLE IF NOT EXISTS public.lease_expense_values (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id UUID NOT NULL REFERENCES public.lease_expense_rules(id) ON DELETE CASCADE,
  base_year_amount NUMERIC,
  extracted_value NUMERIC,
  manual_value NUMERIC,
  final_value NUMERIC,
  frequency TEXT DEFAULT 'yearly', -- yearly, monthly, quarterly
  value_source TEXT,
  mapped_expense_id UUID REFERENCES public.expenses(id) ON DELETE SET NULL,
  mapped_gl_account_id UUID,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.lease_expense_values ENABLE ROW LEVEL SECURITY;
CREATE POLICY "lease_expense_values_select" ON public.lease_expense_values FOR SELECT USING (
  rule_id IN (SELECT id FROM public.lease_expense_rules WHERE rule_set_id IN (SELECT id FROM public.lease_expense_rule_sets WHERE org_id IN (SELECT public.get_my_org_ids())))
);
CREATE POLICY "lease_expense_values_insert" ON public.lease_expense_values FOR INSERT WITH CHECK (
  rule_id IN (SELECT id FROM public.lease_expense_rules WHERE rule_set_id IN (SELECT id FROM public.lease_expense_rule_sets WHERE public.can_write_org_data(org_id)))
);
CREATE POLICY "lease_expense_values_update" ON public.lease_expense_values FOR UPDATE USING (
  rule_id IN (SELECT id FROM public.lease_expense_rules WHERE rule_set_id IN (SELECT id FROM public.lease_expense_rule_sets WHERE public.can_write_org_data(org_id)))
);

CREATE TABLE IF NOT EXISTS public.lease_expense_rule_clauses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_expense_rule_id UUID NOT NULL REFERENCES public.lease_expense_rules(id) ON DELETE CASCADE,
  lease_id UUID NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  page_number INT,
  clause_type TEXT,
  clause_text TEXT,
  confidence NUMERIC,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.lease_expense_rule_clauses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "lease_expense_rule_clauses_select" ON public.lease_expense_rule_clauses FOR SELECT USING (
  lease_id IN (SELECT id FROM public.leases WHERE org_id IN (SELECT public.get_my_org_ids()))
);
CREATE POLICY "lease_expense_rule_clauses_insert" ON public.lease_expense_rule_clauses FOR INSERT WITH CHECK (
  lease_id IN (SELECT id FROM public.leases WHERE public.can_write_org_data(org_id))
);

-- Template Tables
CREATE TABLE IF NOT EXISTS public.expense_classification_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  template_name TEXT NOT NULL,
  based_on_lease_id UUID REFERENCES public.leases(id) ON DELETE SET NULL,
  based_on_property_id UUID REFERENCES public.properties(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.expense_classification_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "expense_classification_templates_select" ON public.expense_classification_templates FOR SELECT USING (org_id IN (SELECT public.get_my_org_ids()));
CREATE POLICY "expense_classification_templates_insert" ON public.expense_classification_templates FOR INSERT WITH CHECK (public.can_write_org_data(org_id));
CREATE POLICY "expense_classification_templates_update" ON public.expense_classification_templates FOR UPDATE USING (public.can_write_org_data(org_id));

CREATE TABLE IF NOT EXISTS public.expense_classification_template_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID NOT NULL REFERENCES public.expense_classification_templates(id) ON DELETE CASCADE,
  expense_category_id UUID NOT NULL REFERENCES public.expense_categories(id) ON DELETE CASCADE,
  is_recoverable BOOLEAN DEFAULT false,
  is_excluded BOOLEAN DEFAULT false,
  is_controllable BOOLEAN DEFAULT false,
  is_subject_to_cap BOOLEAN DEFAULT false,
  cap_type TEXT,
  cap_value NUMERIC,
  has_base_year BOOLEAN DEFAULT false,
  gross_up_applicable BOOLEAN DEFAULT false,
  admin_fee_applicable BOOLEAN DEFAULT false,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.expense_classification_template_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "expense_classification_template_items_select" ON public.expense_classification_template_items FOR SELECT USING (
  template_id IN (SELECT id FROM public.expense_classification_templates WHERE org_id IN (SELECT public.get_my_org_ids()))
);
CREATE POLICY "expense_classification_template_items_insert" ON public.expense_classification_template_items FOR INSERT WITH CHECK (
  template_id IN (SELECT id FROM public.expense_classification_templates WHERE public.can_write_org_data(org_id))
);
CREATE POLICY "expense_classification_template_items_update" ON public.expense_classification_template_items FOR UPDATE USING (
  template_id IN (SELECT id FROM public.expense_classification_templates WHERE public.can_write_org_data(org_id))
);

-- Seed System Default Expense Categories
INSERT INTO public.expense_categories (is_system_default, category_name, subcategory_name, normalized_key, display_order)
VALUES
  (true, 'Taxes', 'Real Estate Taxes', 'taxes_real_estate', 10),
  (true, 'Taxes', 'Personal Property Taxes', 'taxes_personal_property', 20),
  (true, 'Insurance', 'Property Insurance', 'insurance_property', 30),
  (true, 'Insurance', 'Liability Insurance', 'insurance_liability', 40),
  (true, 'Utilities', 'Electricity', 'utilities_electricity', 50),
  (true, 'Utilities', 'Water/Sewer', 'utilities_water_sewer', 60),
  (true, 'Utilities', 'Gas', 'utilities_gas', 70),
  (true, 'Maintenance', 'HVAC Maintenance', 'maint_hvac', 80),
  (true, 'Maintenance', 'Elevator Maintenance', 'maint_elevator', 90),
  (true, 'Maintenance', 'Roof Maintenance', 'maint_roof', 100),
  (true, 'Services', 'Janitorial', 'services_janitorial', 110),
  (true, 'Services', 'Landscaping', 'services_landscaping', 120),
  (true, 'Services', 'Snow Removal', 'services_snow_removal', 130),
  (true, 'Services', 'Security', 'services_security', 140),
  (true, 'Services', 'Trash Removal', 'services_trash', 150),
  (true, 'Management', 'Management Fees', 'mgmt_fees', 160),
  (true, 'Management', 'Admin Fees', 'mgmt_admin', 170),
  (true, 'Capital Expenditures', 'Amortized Repairs', 'capex_amortized', 180);

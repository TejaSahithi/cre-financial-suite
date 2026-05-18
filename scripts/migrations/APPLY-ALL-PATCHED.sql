-- =====================================================================
-- BULLETPROOF MIGRATION BUNDLE
-- Paste this into the Supabase SQL editor → Run.
--
-- Handles every case that broke the original bundle:
--   • Tables that already exist with a partial schema → ALTER TABLE
--     ADD COLUMN IF NOT EXISTS for every expected column
--   • Pre-existing FK constraints with different names → conditional
--   • Helper functions (set_workflow_updated_at, can_write_any_page)
--     created first so triggers and policies have what they need
--   • Cross-table FK constraints added at the end inside DO blocks so
--     ordering issues never abort the whole bundle
--   • Every CREATE POLICY has a DROP POLICY IF EXISTS before it
--   • Every CREATE TRIGGER has a DROP TRIGGER IF EXISTS before it
-- =====================================================================

-- ── 0. PREREQUISITE HELPERS ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_workflow_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.can_write_any_page(check_org_id UUID, page_names TEXT[])
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM unnest(COALESCE(page_names, ARRAY[]::TEXT[])) AS page_name
    WHERE public.can_write_page(check_org_id, page_name)
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;


-- ── 1. LEASES — add approval/signature/abstract columns ─────────────

ALTER TABLE public.leases
  ADD COLUMN IF NOT EXISTS signed_by             TEXT,
  ADD COLUMN IF NOT EXISTS signed_at             TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approval_comments     TEXT,
  ADD COLUMN IF NOT EXISTS approval_document_url TEXT,
  ADD COLUMN IF NOT EXISTS abstract_status       TEXT,
  ADD COLUMN IF NOT EXISTS abstract_version      INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS abstract_approved_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS abstract_approved_by  TEXT,
  ADD COLUMN IF NOT EXISTS abstract_snapshot     JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS rent_commencement_date DATE;


-- ── 2. DOCUMENTS table ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID,
  property_id UUID,
  lease_id UUID,
  type TEXT NOT NULL DEFAULT 'lease',
  name TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  signed_by TEXT,
  signed_at TIMESTAMPTZ,
  comments TEXT,
  document_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS org_id UUID,
  ADD COLUMN IF NOT EXISTS property_id UUID,
  ADD COLUMN IF NOT EXISTS lease_id UUID,
  ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'lease',
  ADD COLUMN IF NOT EXISTS name TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS signed_by TEXT,
  ADD COLUMN IF NOT EXISTS signed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS comments TEXT,
  ADD COLUMN IF NOT EXISTS document_url TEXT,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();


-- ── 3. LEASE_CLAUSES ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.lease_clauses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID,
  lease_id UUID,
  clause_type TEXT NOT NULL,
  clause_title TEXT,
  clause_text TEXT,
  source_page INT,
  confidence_score NUMERIC,
  structured_fields_json JSONB DEFAULT '{}'::jsonb,
  source TEXT DEFAULT 'document_review',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.lease_clauses
  ADD COLUMN IF NOT EXISTS org_id UUID,
  ADD COLUMN IF NOT EXISTS lease_id UUID,
  ADD COLUMN IF NOT EXISTS clause_type TEXT,
  ADD COLUMN IF NOT EXISTS clause_title TEXT,
  ADD COLUMN IF NOT EXISTS clause_text TEXT,
  ADD COLUMN IF NOT EXISTS source_page INT,
  ADD COLUMN IF NOT EXISTS confidence_score NUMERIC,
  ADD COLUMN IF NOT EXISTS structured_fields_json JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'document_review',
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();


-- ── 4. LEASE_EXPENSE_RULE_SETS / RULES / VALUES / CLAUSES ───────────

CREATE TABLE IF NOT EXISTS public.lease_expense_rule_sets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID,
  lease_id UUID,
  property_id UUID,
  version INT NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft',
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.lease_expense_rule_sets
  ADD COLUMN IF NOT EXISTS org_id UUID,
  ADD COLUMN IF NOT EXISTS lease_id UUID,
  ADD COLUMN IF NOT EXISTS property_id UUID,
  ADD COLUMN IF NOT EXISTS version INT DEFAULT 1,
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

CREATE TABLE IF NOT EXISTS public.lease_expense_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_set_id UUID,
  expense_category_id UUID,
  row_status TEXT DEFAULT 'needs_review',
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

ALTER TABLE public.lease_expense_rules
  ADD COLUMN IF NOT EXISTS rule_set_id UUID,
  ADD COLUMN IF NOT EXISTS expense_category_id UUID,
  ADD COLUMN IF NOT EXISTS row_status TEXT DEFAULT 'needs_review',
  ADD COLUMN IF NOT EXISTS mentioned_in_lease BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_recoverable BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_excluded BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_controllable BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_subject_to_cap BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS cap_type TEXT,
  ADD COLUMN IF NOT EXISTS cap_value NUMERIC,
  ADD COLUMN IF NOT EXISTS has_base_year BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS base_year_type TEXT,
  ADD COLUMN IF NOT EXISTS gross_up_applicable BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS admin_fee_applicable BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS admin_fee_percent NUMERIC,
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS confidence NUMERIC,
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

CREATE TABLE IF NOT EXISTS public.lease_expense_values (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id UUID,
  extracted_value NUMERIC,
  manual_value NUMERIC,
  final_value NUMERIC,
  unit TEXT,
  frequency TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.lease_expense_values
  ADD COLUMN IF NOT EXISTS rule_id UUID,
  ADD COLUMN IF NOT EXISTS extracted_value NUMERIC,
  ADD COLUMN IF NOT EXISTS manual_value NUMERIC,
  ADD COLUMN IF NOT EXISTS final_value NUMERIC,
  ADD COLUMN IF NOT EXISTS unit TEXT,
  ADD COLUMN IF NOT EXISTS frequency TEXT,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

CREATE TABLE IF NOT EXISTS public.lease_expense_rule_clauses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_expense_rule_id UUID,
  lease_id UUID,
  page_number INT,
  clause_type TEXT,
  clause_text TEXT,
  confidence NUMERIC,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.lease_expense_rule_clauses
  ADD COLUMN IF NOT EXISTS lease_expense_rule_id UUID,
  ADD COLUMN IF NOT EXISTS lease_id UUID,
  ADD COLUMN IF NOT EXISTS page_number INT,
  ADD COLUMN IF NOT EXISTS clause_type TEXT,
  ADD COLUMN IF NOT EXISTS clause_text TEXT,
  ADD COLUMN IF NOT EXISTS confidence NUMERIC,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();


-- ── 5. CAM_PROFILES ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.cam_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID,
  lease_id UUID,
  cam_structure TEXT,
  recovery_status TEXT,
  cam_start_date DATE,
  cam_end_date DATE,
  estimate_frequency TEXT,
  reconciliation_frequency TEXT,
  tenant_rsf NUMERIC,
  building_rsf NUMERIC,
  tenant_pro_rata_share NUMERIC,
  cam_cap_type TEXT,
  cam_cap_percent NUMERIC,
  admin_fee_percent NUMERIC,
  gross_up_percent NUMERIC,
  included_expenses JSONB DEFAULT '[]'::jsonb,
  excluded_expenses JSONB DEFAULT '[]'::jsonb,
  actual_cam_expense NUMERIC,
  estimated_cam_billed NUMERIC,
  reconciliation_amount NUMERIC,
  tenant_balance_due_or_credit NUMERIC,
  status TEXT DEFAULT 'draft',
  source TEXT DEFAULT 'document_review',
  approved_at TIMESTAMPTZ,
  approved_by TEXT,
  validation_warnings JSONB DEFAULT '[]'::jsonb,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.cam_profiles
  ADD COLUMN IF NOT EXISTS org_id UUID,
  ADD COLUMN IF NOT EXISTS lease_id UUID,
  ADD COLUMN IF NOT EXISTS cam_structure TEXT,
  ADD COLUMN IF NOT EXISTS recovery_status TEXT,
  ADD COLUMN IF NOT EXISTS cam_start_date DATE,
  ADD COLUMN IF NOT EXISTS cam_end_date DATE,
  ADD COLUMN IF NOT EXISTS estimate_frequency TEXT,
  ADD COLUMN IF NOT EXISTS reconciliation_frequency TEXT,
  ADD COLUMN IF NOT EXISTS tenant_rsf NUMERIC,
  ADD COLUMN IF NOT EXISTS building_rsf NUMERIC,
  ADD COLUMN IF NOT EXISTS tenant_pro_rata_share NUMERIC,
  ADD COLUMN IF NOT EXISTS cam_cap_type TEXT,
  ADD COLUMN IF NOT EXISTS cam_cap_percent NUMERIC,
  ADD COLUMN IF NOT EXISTS admin_fee_percent NUMERIC,
  ADD COLUMN IF NOT EXISTS gross_up_percent NUMERIC,
  ADD COLUMN IF NOT EXISTS included_expenses JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS excluded_expenses JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS actual_cam_expense NUMERIC,
  ADD COLUMN IF NOT EXISTS estimated_cam_billed NUMERIC,
  ADD COLUMN IF NOT EXISTS reconciliation_amount NUMERIC,
  ADD COLUMN IF NOT EXISTS tenant_balance_due_or_credit NUMERIC,
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'document_review',
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by TEXT,
  ADD COLUMN IF NOT EXISTS validation_warnings JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();


-- ── 6. LEASE_FIELD_REVIEWS ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.lease_field_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID,
  lease_id UUID,
  field_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  normalized_value TEXT,
  raw_value TEXT,
  source_page INT,
  source_text TEXT,
  confidence NUMERIC,
  note TEXT,
  reviewer TEXT,
  reviewed_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.lease_field_reviews
  ADD COLUMN IF NOT EXISTS org_id UUID,
  ADD COLUMN IF NOT EXISTS lease_id UUID,
  ADD COLUMN IF NOT EXISTS field_key TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS normalized_value TEXT,
  ADD COLUMN IF NOT EXISTS raw_value TEXT,
  ADD COLUMN IF NOT EXISTS source_page INT,
  ADD COLUMN IF NOT EXISTS source_text TEXT,
  ADD COLUMN IF NOT EXISTS confidence NUMERIC,
  ADD COLUMN IF NOT EXISTS note TEXT,
  ADD COLUMN IF NOT EXISTS reviewer TEXT,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- Unique constraint required for ON CONFLICT (lease_id, field_key)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'lease_field_reviews'
      AND constraint_type = 'UNIQUE'
      AND constraint_name = 'lease_field_reviews_lease_field_unique'
  ) THEN
    BEGIN
      ALTER TABLE public.lease_field_reviews
        ADD CONSTRAINT lease_field_reviews_lease_field_unique
        UNIQUE (lease_id, field_key);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Skipped lease_field_reviews unique constraint: %', SQLERRM;
    END;
  END IF;
END $$;


-- ── 7. LEASE_CRITICAL_DATES ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.lease_critical_dates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID,
  lease_id UUID,
  property_id UUID,
  date_type TEXT NOT NULL,
  due_date DATE,
  status TEXT NOT NULL DEFAULT 'open',
  source TEXT,
  reminder_days_before INT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.lease_critical_dates
  ADD COLUMN IF NOT EXISTS org_id UUID,
  ADD COLUMN IF NOT EXISTS lease_id UUID,
  ADD COLUMN IF NOT EXISTS property_id UUID,
  ADD COLUMN IF NOT EXISTS date_type TEXT,
  ADD COLUMN IF NOT EXISTS due_date DATE,
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS reminder_days_before INT,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'lease_critical_dates'
      AND constraint_type = 'UNIQUE'
      AND constraint_name = 'lease_critical_dates_lease_type_date_unique'
  ) THEN
    BEGIN
      ALTER TABLE public.lease_critical_dates
        ADD CONSTRAINT lease_critical_dates_lease_type_date_unique
        UNIQUE (lease_id, date_type, due_date);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Skipped lease_critical_dates unique: %', SQLERRM;
    END;
  END IF;
END $$;


-- ── 8. RENT_SCHEDULES ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.rent_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID,
  lease_id UUID,
  property_id UUID,
  building_id UUID,
  unit_id UUID,
  abstract_version INT NOT NULL DEFAULT 1,
  row_type TEXT NOT NULL DEFAULT 'base_rent',
  phase TEXT NOT NULL DEFAULT 'contracted',
  charge_frequency TEXT NOT NULL DEFAULT 'monthly',
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  monthly_amount NUMERIC,
  annual_amount NUMERIC,
  rent_per_sf NUMERIC,
  rsf NUMERIC,
  proration_method TEXT DEFAULT 'actual_days',
  is_abatement BOOLEAN NOT NULL DEFAULT FALSE,
  abatement_percent NUMERIC,
  escalation_type TEXT,
  escalation_rate NUMERIC,
  escalation_amount NUMERIC,
  escalation_index TEXT,
  status TEXT NOT NULL DEFAULT 'approved',
  approved_at TIMESTAMPTZ,
  approved_by TEXT,
  source TEXT NOT NULL DEFAULT 'approved_abstract',
  assumption_reason TEXT,
  notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.rent_schedules
  ADD COLUMN IF NOT EXISTS org_id UUID,
  ADD COLUMN IF NOT EXISTS lease_id UUID,
  ADD COLUMN IF NOT EXISTS property_id UUID,
  ADD COLUMN IF NOT EXISTS building_id UUID,
  ADD COLUMN IF NOT EXISTS unit_id UUID,
  ADD COLUMN IF NOT EXISTS abstract_version INT DEFAULT 1,
  ADD COLUMN IF NOT EXISTS row_type TEXT DEFAULT 'base_rent',
  ADD COLUMN IF NOT EXISTS phase TEXT DEFAULT 'contracted',
  ADD COLUMN IF NOT EXISTS charge_frequency TEXT DEFAULT 'monthly',
  ADD COLUMN IF NOT EXISTS period_start DATE,
  ADD COLUMN IF NOT EXISTS period_end DATE,
  ADD COLUMN IF NOT EXISTS monthly_amount NUMERIC,
  ADD COLUMN IF NOT EXISTS annual_amount NUMERIC,
  ADD COLUMN IF NOT EXISTS rent_per_sf NUMERIC,
  ADD COLUMN IF NOT EXISTS rsf NUMERIC,
  ADD COLUMN IF NOT EXISTS proration_method TEXT DEFAULT 'actual_days',
  ADD COLUMN IF NOT EXISTS is_abatement BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS abatement_percent NUMERIC,
  ADD COLUMN IF NOT EXISTS escalation_type TEXT,
  ADD COLUMN IF NOT EXISTS escalation_rate NUMERIC,
  ADD COLUMN IF NOT EXISTS escalation_amount NUMERIC,
  ADD COLUMN IF NOT EXISTS escalation_index TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by TEXT,
  ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'approved_abstract',
  ADD COLUMN IF NOT EXISTS assumption_reason TEXT,
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();


-- ── 9. EXPENSE_CLASSIFICATIONS + BUDGET_LINE_ITEMS ──────────────────

CREATE TABLE IF NOT EXISTS public.expense_classifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID,
  expense_id UUID,
  property_id UUID,
  building_id UUID,
  unit_id UUID,
  lease_id UUID,
  tenant_id UUID,
  rule_set_id UUID,
  recovery_rule_id UUID,
  recovery_status TEXT DEFAULT 'needs_review',
  allocation_method TEXT,
  cap_applied BOOLEAN DEFAULT false,
  exclusion_applied BOOLEAN DEFAULT false,
  condition_applied BOOLEAN DEFAULT false,
  condition_reason TEXT,
  rule_source TEXT,
  confidence_score NUMERIC,
  evidence_text TEXT,
  evidence_page_number INT,
  approved_status TEXT DEFAULT 'draft',
  notes TEXT,
  classified_at TIMESTAMPTZ DEFAULT now(),
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.expense_classifications
  ADD COLUMN IF NOT EXISTS org_id UUID,
  ADD COLUMN IF NOT EXISTS expense_id UUID,
  ADD COLUMN IF NOT EXISTS property_id UUID,
  ADD COLUMN IF NOT EXISTS building_id UUID,
  ADD COLUMN IF NOT EXISTS unit_id UUID,
  ADD COLUMN IF NOT EXISTS lease_id UUID,
  ADD COLUMN IF NOT EXISTS tenant_id UUID,
  ADD COLUMN IF NOT EXISTS rule_set_id UUID,
  ADD COLUMN IF NOT EXISTS recovery_rule_id UUID,
  ADD COLUMN IF NOT EXISTS recovery_status TEXT DEFAULT 'needs_review',
  ADD COLUMN IF NOT EXISTS allocation_method TEXT,
  ADD COLUMN IF NOT EXISTS cap_applied BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS exclusion_applied BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS condition_applied BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS condition_reason TEXT,
  ADD COLUMN IF NOT EXISTS rule_source TEXT,
  ADD COLUMN IF NOT EXISTS confidence_score NUMERIC,
  ADD COLUMN IF NOT EXISTS evidence_text TEXT,
  ADD COLUMN IF NOT EXISTS evidence_page_number INT,
  ADD COLUMN IF NOT EXISTS approved_status TEXT DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS classified_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

CREATE TABLE IF NOT EXISTS public.budget_line_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID,
  budget_id UUID,
  property_id UUID,
  building_id UUID,
  unit_id UUID,
  lease_id UUID,
  category TEXT,
  subcategory TEXT,
  line_type TEXT DEFAULT 'expense',
  amount NUMERIC DEFAULT 0,
  source_type TEXT DEFAULT 'system_calculated',
  source_snapshot_id UUID,
  notes TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.budget_line_items
  ADD COLUMN IF NOT EXISTS org_id UUID,
  ADD COLUMN IF NOT EXISTS budget_id UUID,
  ADD COLUMN IF NOT EXISTS property_id UUID,
  ADD COLUMN IF NOT EXISTS building_id UUID,
  ADD COLUMN IF NOT EXISTS unit_id UUID,
  ADD COLUMN IF NOT EXISTS lease_id UUID,
  ADD COLUMN IF NOT EXISTS category TEXT,
  ADD COLUMN IF NOT EXISTS subcategory TEXT,
  ADD COLUMN IF NOT EXISTS line_type TEXT DEFAULT 'expense',
  ADD COLUMN IF NOT EXISTS amount NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS source_type TEXT DEFAULT 'system_calculated',
  ADD COLUMN IF NOT EXISTS source_snapshot_id UUID,
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS sort_order INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();


-- ── 10. INDEXES — all safe with IF NOT EXISTS ───────────────────────

CREATE INDEX IF NOT EXISTS idx_documents_org_id           ON public.documents(org_id);
CREATE INDEX IF NOT EXISTS idx_documents_property_id      ON public.documents(property_id);
CREATE INDEX IF NOT EXISTS idx_documents_lease_id         ON public.documents(lease_id);
CREATE INDEX IF NOT EXISTS idx_documents_type             ON public.documents(type);

CREATE INDEX IF NOT EXISTS idx_lease_clauses_lease        ON public.lease_clauses(org_id, lease_id, clause_type);

CREATE INDEX IF NOT EXISTS idx_lease_expense_rule_sets_lease   ON public.lease_expense_rule_sets(org_id, lease_id, status);
CREATE INDEX IF NOT EXISTS idx_lease_expense_rules_set         ON public.lease_expense_rules(rule_set_id);
CREATE INDEX IF NOT EXISTS idx_lease_expense_values_rule       ON public.lease_expense_values(rule_id);
CREATE INDEX IF NOT EXISTS idx_lease_expense_rule_clauses_rule ON public.lease_expense_rule_clauses(lease_expense_rule_id);

CREATE INDEX IF NOT EXISTS idx_cam_profiles_lease         ON public.cam_profiles(org_id, lease_id);

CREATE INDEX IF NOT EXISTS idx_lease_field_reviews_lease  ON public.lease_field_reviews(org_id, lease_id);

CREATE INDEX IF NOT EXISTS idx_lease_critical_dates_lease ON public.lease_critical_dates(org_id, lease_id, date_type);

CREATE INDEX IF NOT EXISTS idx_rent_schedules_lease       ON public.rent_schedules(org_id, lease_id, abstract_version, status);
CREATE INDEX IF NOT EXISTS idx_rent_schedules_scope       ON public.rent_schedules(org_id, property_id, building_id, unit_id, status);
CREATE INDEX IF NOT EXISTS idx_rent_schedules_period      ON public.rent_schedules(lease_id, period_start, period_end);

CREATE INDEX IF NOT EXISTS idx_expense_classifications_scope ON public.expense_classifications(org_id, property_id, building_id, unit_id, lease_id, recovery_status);
CREATE INDEX IF NOT EXISTS idx_budget_line_items_budget      ON public.budget_line_items(org_id, budget_id, line_type, category);

CREATE INDEX IF NOT EXISTS idx_leases_abstract_status     ON public.leases(abstract_status) WHERE abstract_status IS NOT NULL;


-- ── 11. RLS — enable on every table, then DROP+CREATE policies ─────

ALTER TABLE public.documents              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lease_clauses          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lease_expense_rule_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lease_expense_rules    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lease_expense_values   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lease_expense_rule_clauses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cam_profiles           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lease_field_reviews    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lease_critical_dates   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rent_schedules         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expense_classifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.budget_line_items      ENABLE ROW LEVEL SECURITY;

-- Standard org-scoped policy template, applied to every workflow table.
-- Wrapped in a DO so a missing helper function (is_super_admin / get_my_org_ids /
-- can_write_org_data) doesn't abort the bundle — bundle reports a notice instead.
DO $$
DECLARE
  tbl TEXT;
  tables TEXT[] := ARRAY[
    'lease_clauses',
    'lease_expense_rule_sets',
    'lease_expense_rules',
    'lease_expense_values',
    'lease_expense_rule_clauses',
    'cam_profiles',
    'lease_field_reviews',
    'lease_critical_dates',
    'rent_schedules',
    'expense_classifications',
    'budget_line_items'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    BEGIN
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_select', tbl);
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_insert', tbl);
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_update', tbl);
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_delete', tbl);
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR SELECT USING (public.is_super_admin() OR org_id IN (SELECT public.get_my_org_ids()))',
        tbl || '_select', tbl
      );
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR INSERT WITH CHECK (public.is_super_admin() OR public.can_write_org_data(org_id))',
        tbl || '_insert', tbl
      );
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR UPDATE USING (public.is_super_admin() OR public.can_write_org_data(org_id))',
        tbl || '_update', tbl
      );
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR DELETE USING (public.is_super_admin() OR public.can_write_org_data(org_id))',
        tbl || '_delete', tbl
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Skipped policies for %: %', tbl, SQLERRM;
    END;
  END LOOP;
END $$;

-- documents has its own custom policies (super_admin sees all + org members)
DROP POLICY IF EXISTS "super_admin_all_documents" ON public.documents;
DROP POLICY IF EXISTS "org_members_documents"     ON public.documents;

DO $$
BEGIN
  BEGIN
    CREATE POLICY "super_admin_all_documents" ON public.documents
      FOR ALL USING (
        EXISTS (
          SELECT 1 FROM auth.users u
          JOIN public.user_roles ur ON ur.user_id = u.id
          WHERE u.id = auth.uid() AND ur.role = 'super_admin'
        )
      );
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'super_admin_all_documents skipped: %', SQLERRM; END;
  BEGIN
    CREATE POLICY "org_members_documents" ON public.documents
      FOR ALL USING (
        org_id IN (SELECT org_id FROM public.memberships WHERE user_id = auth.uid())
      );
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'org_members_documents skipped: %', SQLERRM; END;
END $$;


-- ── 12. TRIGGERS ────────────────────────────────────────────────────

DO $$
DECLARE
  tbl TEXT;
  tables TEXT[] := ARRAY[
    'lease_clauses',
    'lease_expense_rule_sets',
    'lease_expense_rules',
    'lease_expense_values',
    'cam_profiles',
    'lease_field_reviews',
    'lease_critical_dates',
    'rent_schedules',
    'expense_classifications',
    'budget_line_items'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    BEGIN
      EXECUTE format('DROP TRIGGER IF EXISTS set_%I_updated_at ON public.%I', tbl, tbl);
      EXECUTE format(
        'CREATE TRIGGER set_%I_updated_at BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.set_workflow_updated_at()',
        tbl, tbl
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Skipped trigger for %: %', tbl, SQLERRM;
    END;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.update_documents_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_documents_updated_at ON public.documents;
CREATE TRIGGER trg_documents_updated_at
  BEFORE UPDATE ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.update_documents_updated_at();


-- ── 13. FK CONSTRAINTS — added at the end inside DO blocks so any
-- missing parent table / orphan row just logs a notice instead of
-- aborting the bundle. The columns above are UUID either way.

DO $$
DECLARE
  spec RECORD;
BEGIN
  FOR spec IN SELECT * FROM (VALUES
    ('documents',                'org_id',             'organizations', 'CASCADE'),
    ('documents',                'property_id',        'properties',    'SET NULL'),
    ('documents',                'lease_id',           'leases',        'SET NULL'),
    ('lease_clauses',            'org_id',             'organizations', 'CASCADE'),
    ('lease_clauses',            'lease_id',           'leases',        'CASCADE'),
    ('lease_expense_rule_sets',  'org_id',             'organizations', 'CASCADE'),
    ('lease_expense_rule_sets',  'lease_id',           'leases',        'CASCADE'),
    ('lease_expense_rule_sets',  'property_id',        'properties',    'CASCADE'),
    ('lease_expense_rules',      'rule_set_id',        'lease_expense_rule_sets', 'CASCADE'),
    ('lease_expense_values',     'rule_id',            'lease_expense_rules',     'CASCADE'),
    ('lease_expense_rule_clauses','lease_expense_rule_id','lease_expense_rules',  'CASCADE'),
    ('lease_expense_rule_clauses','lease_id',          'leases',        'CASCADE'),
    ('cam_profiles',             'org_id',             'organizations', 'CASCADE'),
    ('cam_profiles',             'lease_id',           'leases',        'CASCADE'),
    ('lease_field_reviews',      'org_id',             'organizations', 'CASCADE'),
    ('lease_field_reviews',      'lease_id',           'leases',        'CASCADE'),
    ('lease_critical_dates',     'org_id',             'organizations', 'CASCADE'),
    ('lease_critical_dates',     'lease_id',           'leases',        'CASCADE'),
    ('lease_critical_dates',     'property_id',        'properties',    'SET NULL'),
    ('rent_schedules',           'org_id',             'organizations', 'CASCADE'),
    ('rent_schedules',           'lease_id',           'leases',        'CASCADE'),
    ('rent_schedules',           'property_id',        'properties',    'CASCADE'),
    ('expense_classifications',  'org_id',             'organizations', 'CASCADE'),
    ('expense_classifications',  'lease_id',           'leases',        'SET NULL'),
    ('budget_line_items',        'org_id',             'organizations', 'CASCADE'),
    ('budget_line_items',        'lease_id',           'leases',        'SET NULL')
  ) AS t(child_table, child_column, parent_table, on_delete)
  LOOP
    BEGIN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES public.%I(id) ON DELETE %s',
        spec.child_table,
        spec.child_table || '_' || spec.child_column || '_fkey',
        spec.child_column,
        spec.parent_table,
        spec.on_delete
      );
    EXCEPTION
      WHEN duplicate_object THEN NULL;  -- FK already exists, fine
      WHEN OTHERS THEN
        RAISE NOTICE 'FK skipped: %.%s → %s.%s — %',
          spec.child_table, spec.child_column,
          spec.parent_table, 'id', SQLERRM;
    END;
  END LOOP;
END $$;


-- ── 14. CONFIRMATION QUERY ──────────────────────────────────────────

SELECT
  (SELECT COUNT(*) FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN ('documents','lease_clauses','lease_expense_rule_sets','lease_expense_rules',
                          'lease_expense_values','lease_expense_rule_clauses','cam_profiles',
                          'lease_field_reviews','lease_critical_dates','rent_schedules',
                          'expense_classifications','budget_line_items')) AS tables_present,
  (SELECT COUNT(*) FROM information_schema.routines
     WHERE routine_schema = 'public'
       AND routine_name IN ('set_workflow_updated_at','can_write_any_page')) AS helpers_present;

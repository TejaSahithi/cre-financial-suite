-- Migration: 20260513133000_lease_workflow_abstraction.sql
-- Description: Expands lease workflow persistence for structured lease fields,
-- clause storage, and CAM profile generation from uploaded leases.

ALTER TABLE public.leases
  ADD COLUMN IF NOT EXISTS lease_date DATE,
  ADD COLUMN IF NOT EXISTS property_name TEXT,
  ADD COLUMN IF NOT EXISTS property_address TEXT,
  ADD COLUMN IF NOT EXISTS landlord_address TEXT,
  ADD COLUMN IF NOT EXISTS tenant_contact_name TEXT,
  ADD COLUMN IF NOT EXISTS tenant_address TEXT,
  ADD COLUMN IF NOT EXISTS suite_number TEXT,
  ADD COLUMN IF NOT EXISTS rentable_area_sqft NUMERIC,
  ADD COLUMN IF NOT EXISTS permitted_use TEXT,
  ADD COLUMN IF NOT EXISTS broker_name TEXT,
  ADD COLUMN IF NOT EXISTS lease_term TEXT,
  ADD COLUMN IF NOT EXISTS commencement_date DATE,
  ADD COLUMN IF NOT EXISTS expiration_date DATE,
  ADD COLUMN IF NOT EXISTS renewal_notice_days INT,
  ADD COLUMN IF NOT EXISTS renewal_escalation_percent NUMERIC,
  ADD COLUMN IF NOT EXISTS holdover_rent_multiplier NUMERIC,
  ADD COLUMN IF NOT EXISTS base_rent_monthly NUMERIC,
  ADD COLUMN IF NOT EXISTS rent_due_day INT,
  ADD COLUMN IF NOT EXISTS rent_frequency TEXT,
  ADD COLUMN IF NOT EXISTS rent_payment_timing TEXT,
  ADD COLUMN IF NOT EXISTS late_fee_grace_days INT,
  ADD COLUMN IF NOT EXISTS late_fee_percent NUMERIC,
  ADD COLUMN IF NOT EXISTS default_interest_rate_formula TEXT,
  ADD COLUMN IF NOT EXISTS building_rsf NUMERIC,
  ADD COLUMN IF NOT EXISTS tenant_rsf NUMERIC,
  ADD COLUMN IF NOT EXISTS tenant_pro_rata_share NUMERIC,
  ADD COLUMN IF NOT EXISTS floor_plan_reference TEXT,
  ADD COLUMN IF NOT EXISTS parking_rights TEXT,
  ADD COLUMN IF NOT EXISTS common_area_description TEXT;

CREATE TABLE IF NOT EXISTS public.lease_clauses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lease_id UUID NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
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

CREATE INDEX IF NOT EXISTS idx_lease_clauses_lease
  ON public.lease_clauses(org_id, lease_id, clause_type);

ALTER TABLE public.lease_clauses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "lease_clauses_select" ON public.lease_clauses;
DROP POLICY IF EXISTS "lease_clauses_insert" ON public.lease_clauses;
DROP POLICY IF EXISTS "lease_clauses_update" ON public.lease_clauses;
DROP POLICY IF EXISTS "lease_clauses_delete" ON public.lease_clauses;

CREATE POLICY "lease_clauses_select" ON public.lease_clauses
  FOR SELECT USING (public.is_super_admin() OR org_id IN (SELECT public.get_my_org_ids()));

CREATE POLICY "lease_clauses_insert" ON public.lease_clauses
  FOR INSERT WITH CHECK (public.is_super_admin() OR public.can_write_org_data(org_id));

CREATE POLICY "lease_clauses_update" ON public.lease_clauses
  FOR UPDATE USING (public.is_super_admin() OR public.can_write_org_data(org_id));

CREATE POLICY "lease_clauses_delete" ON public.lease_clauses
  FOR DELETE USING (public.is_super_admin() OR public.can_write_org_data(org_id));

CREATE TABLE IF NOT EXISTS public.cam_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lease_id UUID NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  property_id UUID REFERENCES public.properties(id) ON DELETE CASCADE,
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
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (lease_id)
);

CREATE INDEX IF NOT EXISTS idx_cam_profiles_lease
  ON public.cam_profiles(org_id, lease_id, property_id);

ALTER TABLE public.cam_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cam_profiles_select" ON public.cam_profiles;
DROP POLICY IF EXISTS "cam_profiles_insert" ON public.cam_profiles;
DROP POLICY IF EXISTS "cam_profiles_update" ON public.cam_profiles;
DROP POLICY IF EXISTS "cam_profiles_delete" ON public.cam_profiles;

CREATE POLICY "cam_profiles_select" ON public.cam_profiles
  FOR SELECT USING (public.is_super_admin() OR org_id IN (SELECT public.get_my_org_ids()));

CREATE POLICY "cam_profiles_insert" ON public.cam_profiles
  FOR INSERT WITH CHECK (public.is_super_admin() OR public.can_write_org_data(org_id));

CREATE POLICY "cam_profiles_update" ON public.cam_profiles
  FOR UPDATE USING (public.is_super_admin() OR public.can_write_org_data(org_id));

CREATE POLICY "cam_profiles_delete" ON public.cam_profiles
  FOR DELETE USING (public.is_super_admin() OR public.can_write_org_data(org_id));

DROP TRIGGER IF EXISTS set_lease_clauses_updated_at ON public.lease_clauses;
CREATE TRIGGER set_lease_clauses_updated_at
  BEFORE UPDATE ON public.lease_clauses
  FOR EACH ROW
  EXECUTE FUNCTION public.set_workflow_updated_at();

DROP TRIGGER IF EXISTS set_cam_profiles_updated_at ON public.cam_profiles;
CREATE TRIGGER set_cam_profiles_updated_at
  BEFORE UPDATE ON public.cam_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.set_workflow_updated_at();

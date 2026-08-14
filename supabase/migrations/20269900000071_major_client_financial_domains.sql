-- Major client financial domains: percentage rent, obligations, CPI/reference data,
-- COI compliance, and vendor credentials. Additive only; does not modify CAM V2,
-- budget posting, or lease abstract approval authority.

CREATE TABLE IF NOT EXISTS public.lease_percentage_rent_terms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lease_id UUID NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  property_id UUID REFERENCES public.properties(id) ON DELETE SET NULL,
  effective_start DATE,
  effective_end DATE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_review','needs_review','approved','active','blocked','resolved','rejected','superseded','archived')),
  gross_sales_definition TEXT,
  reporting_frequency TEXT,
  breakpoint_type TEXT NOT NULL DEFAULT 'natural' CHECK (breakpoint_type IN ('natural','artificial','fixed','none','manual_review')),
  breakpoint_amount NUMERIC,
  percentage_rate NUMERIC,
  exclusions JSONB NOT NULL DEFAULT '[]',
  source_page INT,
  source_text TEXT,
  evidence JSONB NOT NULL DEFAULT '{}',
  approved_at TIMESTAMPTZ,
  approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lease_percentage_rent_terms_org_lease
  ON public.lease_percentage_rent_terms (org_id, lease_id, status);
CREATE INDEX IF NOT EXISTS idx_lease_percentage_rent_terms_effective
  ON public.lease_percentage_rent_terms (org_id, lease_id, effective_start, effective_end);

ALTER TABLE public.lease_percentage_rent_terms ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lease_percentage_rent_terms_select ON public.lease_percentage_rent_terms;
DROP POLICY IF EXISTS lease_percentage_rent_terms_insert ON public.lease_percentage_rent_terms;
DROP POLICY IF EXISTS lease_percentage_rent_terms_update ON public.lease_percentage_rent_terms;
DROP POLICY IF EXISTS lease_percentage_rent_terms_delete ON public.lease_percentage_rent_terms;
CREATE POLICY lease_percentage_rent_terms_select ON public.lease_percentage_rent_terms
  FOR SELECT USING (public.is_member_of_org(org_id));
CREATE POLICY lease_percentage_rent_terms_insert ON public.lease_percentage_rent_terms
  FOR INSERT WITH CHECK (public.is_super_admin() OR public.can_write_org_data(org_id));
CREATE POLICY lease_percentage_rent_terms_update ON public.lease_percentage_rent_terms
  FOR UPDATE USING (public.is_super_admin() OR public.can_write_org_data(org_id));
CREATE POLICY lease_percentage_rent_terms_delete ON public.lease_percentage_rent_terms
  FOR DELETE USING (public.is_super_admin() OR public.can_write_org_data(org_id));
DROP TRIGGER IF EXISTS set_lease_percentage_rent_terms_updated_at ON public.lease_percentage_rent_terms;
CREATE TRIGGER set_lease_percentage_rent_terms_updated_at
  BEFORE UPDATE ON public.lease_percentage_rent_terms
  FOR EACH ROW EXECUTE FUNCTION public.set_workflow_updated_at();

CREATE TABLE IF NOT EXISTS public.tenant_sales_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lease_id UUID NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  property_id UUID REFERENCES public.properties(id) ON DELETE SET NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  gross_sales_amount NUMERIC NOT NULL CHECK (gross_sales_amount >= 0),
  exclusions_amount NUMERIC NOT NULL DEFAULT 0 CHECK (exclusions_amount >= 0),
  net_reportable_sales NUMERIC GENERATED ALWAYS AS (GREATEST(gross_sales_amount - exclusions_amount, 0)) STORED,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('draft','pending_review','submitted','approved','active','blocked','resolved','rejected','superseded')),
  source_document_id UUID REFERENCES public.uploaded_files(id) ON DELETE SET NULL,
  submitted_at TIMESTAMPTZ,
  submitted_by TEXT,
  approved_at TIMESTAMPTZ,
  approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  evidence JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (lease_id, period_start, period_end)
);

CREATE INDEX IF NOT EXISTS idx_tenant_sales_reports_org_lease
  ON public.tenant_sales_reports (org_id, lease_id, status);
CREATE INDEX IF NOT EXISTS idx_tenant_sales_reports_period
  ON public.tenant_sales_reports (org_id, period_start, period_end);

ALTER TABLE public.tenant_sales_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_sales_reports_select ON public.tenant_sales_reports;
DROP POLICY IF EXISTS tenant_sales_reports_insert ON public.tenant_sales_reports;
DROP POLICY IF EXISTS tenant_sales_reports_update ON public.tenant_sales_reports;
DROP POLICY IF EXISTS tenant_sales_reports_delete ON public.tenant_sales_reports;
CREATE POLICY tenant_sales_reports_select ON public.tenant_sales_reports
  FOR SELECT USING (public.is_member_of_org(org_id));
CREATE POLICY tenant_sales_reports_insert ON public.tenant_sales_reports
  FOR INSERT WITH CHECK (public.is_super_admin() OR public.can_write_org_data(org_id));
CREATE POLICY tenant_sales_reports_update ON public.tenant_sales_reports
  FOR UPDATE USING (public.is_super_admin() OR public.can_write_org_data(org_id));
CREATE POLICY tenant_sales_reports_delete ON public.tenant_sales_reports
  FOR DELETE USING (public.is_super_admin() OR public.can_write_org_data(org_id));
DROP TRIGGER IF EXISTS set_tenant_sales_reports_updated_at ON public.tenant_sales_reports;
CREATE TRIGGER set_tenant_sales_reports_updated_at
  BEFORE UPDATE ON public.tenant_sales_reports
  FOR EACH ROW EXECUTE FUNCTION public.set_workflow_updated_at();

CREATE TABLE IF NOT EXISTS public.lease_obligations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lease_id UUID REFERENCES public.leases(id) ON DELETE CASCADE,
  property_id UUID REFERENCES public.properties(id) ON DELETE SET NULL,
  obligation_type TEXT NOT NULL,
  title TEXT NOT NULL,
  source_key TEXT,
  cadence TEXT NOT NULL DEFAULT 'once' CHECK (cadence IN ('once','monthly','quarterly','annual','custom')),
  due_rule JSONB NOT NULL DEFAULT '{}',
  effective_start DATE,
  effective_end DATE,
  responsible_party TEXT NOT NULL DEFAULT 'internal' CHECK (responsible_party IN ('internal','tenant','landlord','vendor','mixed')),
  communication_policy TEXT NOT NULL DEFAULT 'internal_only' CHECK (communication_policy IN ('internal_only','external_allowed','external_requires_approval')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft','pending_review','approved','active','blocked','overdue','resolved','rejected','superseded','paused','completed','archived')),
  source TEXT NOT NULL DEFAULT 'manual',
  evidence JSONB NOT NULL DEFAULT '{}',
  approved_at TIMESTAMPTZ,
  approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lease_obligations_org_lease
  ON public.lease_obligations (org_id, lease_id, status);
CREATE INDEX IF NOT EXISTS idx_lease_obligations_type
  ON public.lease_obligations (org_id, obligation_type, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lease_obligations_source_key
  ON public.lease_obligations (org_id, lease_id, source_key);

ALTER TABLE public.lease_obligations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lease_obligations_select ON public.lease_obligations;
DROP POLICY IF EXISTS lease_obligations_insert ON public.lease_obligations;
DROP POLICY IF EXISTS lease_obligations_update ON public.lease_obligations;
DROP POLICY IF EXISTS lease_obligations_delete ON public.lease_obligations;
CREATE POLICY lease_obligations_select ON public.lease_obligations
  FOR SELECT USING (public.is_member_of_org(org_id));
CREATE POLICY lease_obligations_insert ON public.lease_obligations
  FOR INSERT WITH CHECK (public.is_super_admin() OR public.can_write_org_data(org_id));
CREATE POLICY lease_obligations_update ON public.lease_obligations
  FOR UPDATE USING (public.is_super_admin() OR public.can_write_org_data(org_id));
CREATE POLICY lease_obligations_delete ON public.lease_obligations
  FOR DELETE USING (public.is_super_admin() OR public.can_write_org_data(org_id));
DROP TRIGGER IF EXISTS set_lease_obligations_updated_at ON public.lease_obligations;
CREATE TRIGGER set_lease_obligations_updated_at
  BEFORE UPDATE ON public.lease_obligations
  FOR EACH ROW EXECUTE FUNCTION public.set_workflow_updated_at();

CREATE TABLE IF NOT EXISTS public.lease_obligation_occurrences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  obligation_id UUID NOT NULL REFERENCES public.lease_obligations(id) ON DELETE CASCADE,
  lease_id UUID REFERENCES public.leases(id) ON DELETE CASCADE,
  property_id UUID REFERENCES public.properties(id) ON DELETE SET NULL,
  period_start DATE,
  period_end DATE,
  due_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('draft','pending_review','approved','active','blocked','overdue','resolved','rejected','superseded','open','completed','dismissed')),
  notification_policy TEXT NOT NULL DEFAULT 'internal_only',
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_lease_obligation_occurrences_due
  ON public.lease_obligation_occurrences (org_id, due_date, status);
CREATE INDEX IF NOT EXISTS idx_lease_obligation_occurrences_obligation
  ON public.lease_obligation_occurrences (org_id, obligation_id);

ALTER TABLE public.lease_obligation_occurrences ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lease_obligation_occurrences_select ON public.lease_obligation_occurrences;
DROP POLICY IF EXISTS lease_obligation_occurrences_insert ON public.lease_obligation_occurrences;
DROP POLICY IF EXISTS lease_obligation_occurrences_update ON public.lease_obligation_occurrences;
DROP POLICY IF EXISTS lease_obligation_occurrences_delete ON public.lease_obligation_occurrences;
CREATE POLICY lease_obligation_occurrences_select ON public.lease_obligation_occurrences
  FOR SELECT USING (public.is_member_of_org(org_id));
CREATE POLICY lease_obligation_occurrences_insert ON public.lease_obligation_occurrences
  FOR INSERT WITH CHECK (public.is_super_admin() OR public.can_write_org_data(org_id));
CREATE POLICY lease_obligation_occurrences_update ON public.lease_obligation_occurrences
  FOR UPDATE USING (public.is_super_admin() OR public.can_write_org_data(org_id));
CREATE POLICY lease_obligation_occurrences_delete ON public.lease_obligation_occurrences
  FOR DELETE USING (public.is_super_admin() OR public.can_write_org_data(org_id));
DROP TRIGGER IF EXISTS set_lease_obligation_occurrences_updated_at ON public.lease_obligation_occurrences;
CREATE TRIGGER set_lease_obligation_occurrences_updated_at
  BEFORE UPDATE ON public.lease_obligation_occurrences
  FOR EACH ROW EXECUTE FUNCTION public.set_workflow_updated_at();

CREATE TABLE IF NOT EXISTS public.reference_series_selections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lease_id UUID REFERENCES public.leases(id) ON DELETE CASCADE,
  field_key TEXT,
  provider TEXT NOT NULL,
  series_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  geography TEXT,
  frequency TEXT,
  units TEXT,
  status TEXT NOT NULL DEFAULT 'needs_review' CHECK (status IN ('draft','pending_review','needs_review','approved','active','blocked','resolved','rejected','superseded')),
  evidence JSONB NOT NULL DEFAULT '{}',
  approved_at TIMESTAMPTZ,
  approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reference_series_selections_org_lease
  ON public.reference_series_selections (org_id, lease_id, provider, status);

ALTER TABLE public.reference_series_selections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reference_series_selections_select ON public.reference_series_selections;
DROP POLICY IF EXISTS reference_series_selections_insert ON public.reference_series_selections;
DROP POLICY IF EXISTS reference_series_selections_update ON public.reference_series_selections;
DROP POLICY IF EXISTS reference_series_selections_delete ON public.reference_series_selections;
CREATE POLICY reference_series_selections_select ON public.reference_series_selections
  FOR SELECT USING (public.is_member_of_org(org_id));
CREATE POLICY reference_series_selections_insert ON public.reference_series_selections
  FOR INSERT WITH CHECK (public.is_super_admin() OR public.can_write_org_data(org_id));
CREATE POLICY reference_series_selections_update ON public.reference_series_selections
  FOR UPDATE USING (public.is_super_admin() OR public.can_write_org_data(org_id));
CREATE POLICY reference_series_selections_delete ON public.reference_series_selections
  FOR DELETE USING (public.is_super_admin() OR public.can_write_org_data(org_id));

CREATE TABLE IF NOT EXISTS public.reference_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  series_id TEXT NOT NULL,
  period TEXT NOT NULL,
  value NUMERIC NOT NULL,
  retrieved_at TIMESTAMPTZ NOT NULL,
  source_url TEXT,
  payload_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('draft','pending_review','needs_review','approved','active','blocked','resolved','rejected','superseded')),
  approved_at TIMESTAMPTZ,
  approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, provider, series_id, period)
);

CREATE INDEX IF NOT EXISTS idx_reference_observations_lookup
  ON public.reference_observations (org_id, provider, series_id, period, status);

ALTER TABLE public.reference_observations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reference_observations_select ON public.reference_observations;
DROP POLICY IF EXISTS reference_observations_insert ON public.reference_observations;
DROP POLICY IF EXISTS reference_observations_update ON public.reference_observations;
DROP POLICY IF EXISTS reference_observations_delete ON public.reference_observations;
CREATE POLICY reference_observations_select ON public.reference_observations
  FOR SELECT USING (public.is_member_of_org(org_id));
CREATE POLICY reference_observations_insert ON public.reference_observations
  FOR INSERT WITH CHECK (public.is_super_admin() OR public.can_write_org_data(org_id));
CREATE POLICY reference_observations_update ON public.reference_observations
  FOR UPDATE USING (public.is_super_admin() OR public.can_write_org_data(org_id));
CREATE POLICY reference_observations_delete ON public.reference_observations
  FOR DELETE USING (public.is_super_admin() OR public.can_write_org_data(org_id));

CREATE TABLE IF NOT EXISTS public.coi_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lease_id UUID REFERENCES public.leases(id) ON DELETE CASCADE,
  tenant_id UUID REFERENCES public.tenants(id) ON DELETE SET NULL,
  property_id UUID REFERENCES public.properties(id) ON DELETE SET NULL,
  vendor_id UUID REFERENCES public.vendors(id) ON DELETE SET NULL,
  source_document_id UUID REFERENCES public.uploaded_files(id) ON DELETE SET NULL,
  insurer TEXT,
  policy_number TEXT,
  effective_date DATE,
  expiration_date DATE,
  coverage_limits JSONB NOT NULL DEFAULT '{}',
  additional_insureds JSONB NOT NULL DEFAULT '[]',
  waiver_of_subrogation BOOLEAN,
  status TEXT NOT NULL DEFAULT 'needs_review' CHECK (status IN ('draft','pending_review','needs_review','approved','active','blocked','overdue','resolved','rejected','superseded','expired')),
  evidence JSONB NOT NULL DEFAULT '{}',
  approved_at TIMESTAMPTZ,
  approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coi_documents_org_lease
  ON public.coi_documents (org_id, lease_id, status);
CREATE INDEX IF NOT EXISTS idx_coi_documents_expiration
  ON public.coi_documents (org_id, expiration_date, status);

ALTER TABLE public.coi_documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS coi_documents_select ON public.coi_documents;
DROP POLICY IF EXISTS coi_documents_insert ON public.coi_documents;
DROP POLICY IF EXISTS coi_documents_update ON public.coi_documents;
DROP POLICY IF EXISTS coi_documents_delete ON public.coi_documents;
CREATE POLICY coi_documents_select ON public.coi_documents
  FOR SELECT USING (public.is_member_of_org(org_id));
CREATE POLICY coi_documents_insert ON public.coi_documents
  FOR INSERT WITH CHECK (public.is_super_admin() OR public.can_write_org_data(org_id));
CREATE POLICY coi_documents_update ON public.coi_documents
  FOR UPDATE USING (public.is_super_admin() OR public.can_write_org_data(org_id));
CREATE POLICY coi_documents_delete ON public.coi_documents
  FOR DELETE USING (public.is_super_admin() OR public.can_write_org_data(org_id));
DROP TRIGGER IF EXISTS set_coi_documents_updated_at ON public.coi_documents;
CREATE TRIGGER set_coi_documents_updated_at
  BEFORE UPDATE ON public.coi_documents
  FOR EACH ROW EXECUTE FUNCTION public.set_workflow_updated_at();

CREATE TABLE IF NOT EXISTS public.lease_insurance_compliance_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lease_id UUID NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  coi_document_id UUID REFERENCES public.coi_documents(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','pending_review','needs_review','approved','active','blocked','overdue','resolved','rejected','superseded','compliant','expired')),
  reason_codes TEXT[] NOT NULL DEFAULT '{}',
  requirement_snapshot JSONB NOT NULL DEFAULT '{}',
  coi_snapshot JSONB NOT NULL DEFAULT '{}',
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  evaluated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lease_insurance_compliance_results_lease
  ON public.lease_insurance_compliance_results (org_id, lease_id, evaluated_at DESC);

ALTER TABLE public.lease_insurance_compliance_results ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lease_insurance_compliance_results_select ON public.lease_insurance_compliance_results;
DROP POLICY IF EXISTS lease_insurance_compliance_results_insert ON public.lease_insurance_compliance_results;
CREATE POLICY lease_insurance_compliance_results_select ON public.lease_insurance_compliance_results
  FOR SELECT USING (public.is_member_of_org(org_id));
CREATE POLICY lease_insurance_compliance_results_insert ON public.lease_insurance_compliance_results
  FOR INSERT WITH CHECK (public.is_super_admin() OR public.can_write_org_data(org_id));

CREATE TABLE IF NOT EXISTS public.vendor_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  vendor_id UUID NOT NULL REFERENCES public.vendors(id) ON DELETE CASCADE,
  service_type TEXT NOT NULL,
  jurisdiction TEXT,
  credential_type TEXT NOT NULL,
  credential_number TEXT,
  status TEXT NOT NULL DEFAULT 'needs_review' CHECK (status IN ('draft','pending_review','needs_review','approved','active','blocked','overdue','resolved','rejected','superseded','verified','expired')),
  effective_date DATE,
  expiration_date DATE,
  verification_source TEXT,
  verification_url TEXT,
  verified_at TIMESTAMPTZ,
  verified_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  evidence JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vendor_credentials_vendor
  ON public.vendor_credentials (org_id, vendor_id, status);
CREATE INDEX IF NOT EXISTS idx_vendor_credentials_service
  ON public.vendor_credentials (org_id, service_type, jurisdiction, status);

ALTER TABLE public.vendor_credentials ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS vendor_credentials_select ON public.vendor_credentials;
DROP POLICY IF EXISTS vendor_credentials_insert ON public.vendor_credentials;
DROP POLICY IF EXISTS vendor_credentials_update ON public.vendor_credentials;
DROP POLICY IF EXISTS vendor_credentials_delete ON public.vendor_credentials;
CREATE POLICY vendor_credentials_select ON public.vendor_credentials
  FOR SELECT USING (public.is_member_of_org(org_id));
CREATE POLICY vendor_credentials_insert ON public.vendor_credentials
  FOR INSERT WITH CHECK (public.is_super_admin() OR public.can_write_org_data(org_id));
CREATE POLICY vendor_credentials_update ON public.vendor_credentials
  FOR UPDATE USING (public.is_super_admin() OR public.can_write_org_data(org_id));
CREATE POLICY vendor_credentials_delete ON public.vendor_credentials
  FOR DELETE USING (public.is_super_admin() OR public.can_write_org_data(org_id));
DROP TRIGGER IF EXISTS set_vendor_credentials_updated_at ON public.vendor_credentials;
CREATE TRIGGER set_vendor_credentials_updated_at
  BEFORE UPDATE ON public.vendor_credentials
  FOR EACH ROW EXECUTE FUNCTION public.set_workflow_updated_at();
CREATE TABLE IF NOT EXISTS public.percentage_rent_calculations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lease_id UUID NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  property_id UUID REFERENCES public.properties(id) ON DELETE SET NULL,
  percentage_rent_term_id UUID REFERENCES public.lease_percentage_rent_terms(id) ON DELETE SET NULL,
  tenant_sales_report_id UUID REFERENCES public.tenant_sales_reports(id) ON DELETE SET NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  approved_sales NUMERIC,
  breakpoint_amount NUMERIC,
  excess_sales NUMERIC,
  percentage_rate NUMERIC,
  calculated_amount NUMERIC,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'calculated' CHECK (status IN ('draft','pending_review','approved','active','blocked','overdue','resolved','rejected','superseded','calculated')),
  reason_codes TEXT[] NOT NULL DEFAULT '{}',
  calculation_lines JSONB NOT NULL DEFAULT '[]',
  inputs JSONB NOT NULL DEFAULT '{}',
  evidence JSONB NOT NULL DEFAULT '[]',
  calculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  calculated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, lease_id, period_start, period_end)
);

CREATE INDEX IF NOT EXISTS idx_percentage_rent_calculations_lease
  ON public.percentage_rent_calculations (org_id, lease_id, status, period_start DESC);
ALTER TABLE public.percentage_rent_calculations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS percentage_rent_calculations_select ON public.percentage_rent_calculations;
DROP POLICY IF EXISTS percentage_rent_calculations_insert ON public.percentage_rent_calculations;
DROP POLICY IF EXISTS percentage_rent_calculations_update ON public.percentage_rent_calculations;
DROP POLICY IF EXISTS percentage_rent_calculations_delete ON public.percentage_rent_calculations;
CREATE POLICY percentage_rent_calculations_select ON public.percentage_rent_calculations
  FOR SELECT USING (public.is_member_of_org(org_id));
CREATE POLICY percentage_rent_calculations_insert ON public.percentage_rent_calculations
  FOR INSERT WITH CHECK (public.is_super_admin() OR public.can_write_org_data(org_id));
CREATE POLICY percentage_rent_calculations_update ON public.percentage_rent_calculations
  FOR UPDATE USING (public.is_super_admin() OR public.can_write_org_data(org_id));
CREATE POLICY percentage_rent_calculations_delete ON public.percentage_rent_calculations
  FOR DELETE USING (public.is_super_admin() OR public.can_write_org_data(org_id));
DROP TRIGGER IF EXISTS set_percentage_rent_calculations_updated_at ON public.percentage_rent_calculations;
CREATE TRIGGER set_percentage_rent_calculations_updated_at
  BEFORE UPDATE ON public.percentage_rent_calculations
  FOR EACH ROW EXECUTE FUNCTION public.set_workflow_updated_at();

CREATE TABLE IF NOT EXISTS public.lease_charge_calculations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lease_id UUID NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  property_id UUID REFERENCES public.properties(id) ON DELETE SET NULL,
  charge_type TEXT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  calculated_amount NUMERIC,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'calculated' CHECK (status IN ('draft','pending_review','approved','active','blocked','overdue','resolved','rejected','superseded','calculated')),
  reason_codes TEXT[] NOT NULL DEFAULT '{}',
  calculation_lines JSONB NOT NULL DEFAULT '[]',
  inputs JSONB NOT NULL DEFAULT '{}',
  evidence JSONB NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'edge_function',
  calculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  calculated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, lease_id, charge_type, period_start, period_end)
);

CREATE INDEX IF NOT EXISTS idx_lease_charge_calculations_lease
  ON public.lease_charge_calculations (org_id, lease_id, charge_type, status, period_start DESC);
ALTER TABLE public.lease_charge_calculations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lease_charge_calculations_select ON public.lease_charge_calculations;
DROP POLICY IF EXISTS lease_charge_calculations_insert ON public.lease_charge_calculations;
DROP POLICY IF EXISTS lease_charge_calculations_update ON public.lease_charge_calculations;
DROP POLICY IF EXISTS lease_charge_calculations_delete ON public.lease_charge_calculations;
CREATE POLICY lease_charge_calculations_select ON public.lease_charge_calculations
  FOR SELECT USING (public.is_member_of_org(org_id));
CREATE POLICY lease_charge_calculations_insert ON public.lease_charge_calculations
  FOR INSERT WITH CHECK (public.is_super_admin() OR public.can_write_org_data(org_id));
CREATE POLICY lease_charge_calculations_update ON public.lease_charge_calculations
  FOR UPDATE USING (public.is_super_admin() OR public.can_write_org_data(org_id));
CREATE POLICY lease_charge_calculations_delete ON public.lease_charge_calculations
  FOR DELETE USING (public.is_super_admin() OR public.can_write_org_data(org_id));
DROP TRIGGER IF EXISTS set_lease_charge_calculations_updated_at ON public.lease_charge_calculations;
CREATE TRIGGER set_lease_charge_calculations_updated_at
  BEFORE UPDATE ON public.lease_charge_calculations
  FOR EACH ROW EXECUTE FUNCTION public.set_workflow_updated_at();

CREATE TABLE IF NOT EXISTS public.financial_control_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  property_id UUID NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  fiscal_year INT NOT NULL,
  code TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low','medium','high','critical')),
  budget_amount NUMERIC,
  actual_amount NUMERIC,
  variance_amount NUMERIC,
  variance_percent NUMERIC,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('draft','pending_review','approved','active','blocked','overdue','resolved','rejected','superseded','open','acknowledged','assigned','dismissed')),
  assignee TEXT,
  reason TEXT,
  source TEXT NOT NULL DEFAULT 'run-financial-controls',
  finding_snapshot JSONB NOT NULL DEFAULT '{}',
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, property_id, fiscal_year, code, category)
);

CREATE INDEX IF NOT EXISTS idx_financial_control_findings_property
  ON public.financial_control_findings (org_id, property_id, fiscal_year, status, severity);
ALTER TABLE public.financial_control_findings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS financial_control_findings_select ON public.financial_control_findings;
DROP POLICY IF EXISTS financial_control_findings_insert ON public.financial_control_findings;
DROP POLICY IF EXISTS financial_control_findings_update ON public.financial_control_findings;
DROP POLICY IF EXISTS financial_control_findings_delete ON public.financial_control_findings;
CREATE POLICY financial_control_findings_select ON public.financial_control_findings
  FOR SELECT USING (public.is_member_of_org(org_id));
CREATE POLICY financial_control_findings_insert ON public.financial_control_findings
  FOR INSERT WITH CHECK (public.is_super_admin() OR public.can_write_org_data(org_id));
CREATE POLICY financial_control_findings_update ON public.financial_control_findings
  FOR UPDATE USING (public.is_super_admin() OR public.can_write_org_data(org_id));
CREATE POLICY financial_control_findings_delete ON public.financial_control_findings
  FOR DELETE USING (public.is_super_admin() OR public.can_write_org_data(org_id));
DROP TRIGGER IF EXISTS set_financial_control_findings_updated_at ON public.financial_control_findings;
CREATE TRIGGER set_financial_control_findings_updated_at
  BEFORE UPDATE ON public.financial_control_findings
  FOR EACH ROW EXECUTE FUNCTION public.set_workflow_updated_at();

-- Common read-only lease-charge projection. This is not a financial source of truth;
-- every row points back to its authoritative calculation record.
DROP VIEW IF EXISTS public.lease_charge_read_model;
CREATE VIEW public.lease_charge_read_model
WITH (security_invoker = true)
AS
SELECT
  ('percentage_rent_calculations:' || prc.id::TEXT) AS charge_key,
  prc.id AS source_record_id,
  'percentage_rent_calculations'::TEXT AS authoritative_table,
  prc.org_id,
  prc.property_id,
  prc.lease_id,
  'percentage_rent'::TEXT AS charge_type,
  prc.period_start,
  prc.period_end,
  prc.calculated_amount AS amount,
  prc.currency,
  prc.status,
  prc.reason_codes,
  prc.calculation_lines,
  prc.inputs,
  prc.evidence,
  jsonb_build_object(
    'percentage_rent_term_id', prc.percentage_rent_term_id,
    'tenant_sales_report_id', prc.tenant_sales_report_id,
    'approved_sales', prc.approved_sales,
    'breakpoint_amount', prc.breakpoint_amount,
    'excess_sales', prc.excess_sales,
    'percentage_rate', prc.percentage_rate
  ) AS source_metadata,
  prc.calculated_at,
  prc.calculated_by,
  prc.approved_at,
  prc.approved_by,
  prc.created_at,
  prc.updated_at
FROM public.percentage_rent_calculations prc
UNION ALL
SELECT
  ('lease_charge_calculations:' || lcc.id::TEXT) AS charge_key,
  lcc.id AS source_record_id,
  'lease_charge_calculations'::TEXT AS authoritative_table,
  lcc.org_id,
  lcc.property_id,
  lcc.lease_id,
  lcc.charge_type,
  lcc.period_start,
  lcc.period_end,
  lcc.calculated_amount AS amount,
  lcc.currency,
  lcc.status,
  lcc.reason_codes,
  lcc.calculation_lines,
  lcc.inputs,
  lcc.evidence,
  jsonb_build_object('source', lcc.source) AS source_metadata,
  lcc.calculated_at,
  lcc.calculated_by,
  lcc.approved_at,
  lcc.approved_by,
  lcc.created_at,
  lcc.updated_at
FROM public.lease_charge_calculations lcc;

COMMENT ON VIEW public.lease_charge_read_model IS
  'Read-only projection over authoritative lease charge calculation records for downstream reconciliation/read consumers. Do not write financial authority here.';
-- Operational audit safety net for direct UI/service edits across these domains.
CREATE OR REPLACE FUNCTION public.audit_operational_domain_row_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old JSONB;
  v_new JSONB;
  v_org_id UUID;
  v_property_id UUID;
  v_action TEXT;
  v_entity_id TEXT;
BEGIN
  v_old := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END;
  v_new := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END;
  v_org_id := COALESCE(NULLIF(v_new->>'org_id', '')::UUID, NULLIF(v_old->>'org_id', '')::UUID);
  v_property_id := COALESCE(NULLIF(v_new->>'property_id', '')::UUID, NULLIF(v_old->>'property_id', '')::UUID);
  v_entity_id := COALESCE(v_new->>'id', v_old->>'id');
  v_action := CASE
    WHEN TG_OP = 'INSERT' THEN 'CREATE'
    WHEN TG_OP = 'UPDATE' AND COALESCE(v_new->>'status', '') <> COALESCE(v_old->>'status', '') THEN 'STATUS_CHANGE'
    WHEN TG_OP = 'UPDATE' THEN 'UPDATE'
    WHEN TG_OP = 'DELETE' THEN 'DELETE'
    ELSE TG_OP
  END;

  INSERT INTO public.audit_logs (
    org_id, property_id, entity_type, entity_id, action, old_value, new_value, user_email
  ) VALUES (
    v_org_id,
    v_property_id,
    TG_TABLE_NAME,
    v_entity_id,
    v_action,
    CASE WHEN v_old IS NULL THEN NULL ELSE v_old::TEXT END,
    CASE WHEN v_new IS NULL THEN NULL ELSE jsonb_build_object('value', v_new, 'source', 'db_trigger')::TEXT END,
    current_setting('request.jwt.claim.email', true)
  );

  RETURN COALESCE(NEW, OLD);
END;
$$;
DROP TRIGGER IF EXISTS audit_lease_percentage_rent_terms ON public.lease_percentage_rent_terms;
CREATE TRIGGER audit_lease_percentage_rent_terms
  AFTER INSERT OR UPDATE OR DELETE ON public.lease_percentage_rent_terms
  FOR EACH ROW EXECUTE FUNCTION public.audit_operational_domain_row_change();

DROP TRIGGER IF EXISTS audit_tenant_sales_reports ON public.tenant_sales_reports;
CREATE TRIGGER audit_tenant_sales_reports
  AFTER INSERT OR UPDATE OR DELETE ON public.tenant_sales_reports
  FOR EACH ROW EXECUTE FUNCTION public.audit_operational_domain_row_change();

DROP TRIGGER IF EXISTS audit_lease_obligations ON public.lease_obligations;
CREATE TRIGGER audit_lease_obligations
  AFTER INSERT OR UPDATE OR DELETE ON public.lease_obligations
  FOR EACH ROW EXECUTE FUNCTION public.audit_operational_domain_row_change();

DROP TRIGGER IF EXISTS audit_lease_obligation_occurrences ON public.lease_obligation_occurrences;
CREATE TRIGGER audit_lease_obligation_occurrences
  AFTER INSERT OR UPDATE OR DELETE ON public.lease_obligation_occurrences
  FOR EACH ROW EXECUTE FUNCTION public.audit_operational_domain_row_change();

DROP TRIGGER IF EXISTS audit_reference_series_selections ON public.reference_series_selections;
CREATE TRIGGER audit_reference_series_selections
  AFTER INSERT OR UPDATE OR DELETE ON public.reference_series_selections
  FOR EACH ROW EXECUTE FUNCTION public.audit_operational_domain_row_change();

DROP TRIGGER IF EXISTS audit_reference_observations ON public.reference_observations;
CREATE TRIGGER audit_reference_observations
  AFTER INSERT OR UPDATE OR DELETE ON public.reference_observations
  FOR EACH ROW EXECUTE FUNCTION public.audit_operational_domain_row_change();

DROP TRIGGER IF EXISTS audit_coi_documents ON public.coi_documents;
CREATE TRIGGER audit_coi_documents
  AFTER INSERT OR UPDATE OR DELETE ON public.coi_documents
  FOR EACH ROW EXECUTE FUNCTION public.audit_operational_domain_row_change();

DROP TRIGGER IF EXISTS audit_lease_insurance_compliance_results ON public.lease_insurance_compliance_results;
CREATE TRIGGER audit_lease_insurance_compliance_results
  AFTER INSERT OR UPDATE OR DELETE ON public.lease_insurance_compliance_results
  FOR EACH ROW EXECUTE FUNCTION public.audit_operational_domain_row_change();

DROP TRIGGER IF EXISTS audit_vendor_credentials ON public.vendor_credentials;
CREATE TRIGGER audit_vendor_credentials
  AFTER INSERT OR UPDATE OR DELETE ON public.vendor_credentials
  FOR EACH ROW EXECUTE FUNCTION public.audit_operational_domain_row_change();

DROP TRIGGER IF EXISTS audit_percentage_rent_calculations ON public.percentage_rent_calculations;
CREATE TRIGGER audit_percentage_rent_calculations
  AFTER INSERT OR UPDATE OR DELETE ON public.percentage_rent_calculations
  FOR EACH ROW EXECUTE FUNCTION public.audit_operational_domain_row_change();

DROP TRIGGER IF EXISTS audit_lease_charge_calculations ON public.lease_charge_calculations;
CREATE TRIGGER audit_lease_charge_calculations
  AFTER INSERT OR UPDATE OR DELETE ON public.lease_charge_calculations
  FOR EACH ROW EXECUTE FUNCTION public.audit_operational_domain_row_change();

DROP TRIGGER IF EXISTS audit_financial_control_findings ON public.financial_control_findings;
CREATE TRIGGER audit_financial_control_findings
  AFTER INSERT OR UPDATE OR DELETE ON public.financial_control_findings
  FOR EACH ROW EXECUTE FUNCTION public.audit_operational_domain_row_change();
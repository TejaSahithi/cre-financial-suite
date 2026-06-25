-- ============================================================
-- CRE Financial Suite — Missing Business Entity Tables
-- Date: 2026-04-01
-- Adds all business-logic tables that were missing from prior
-- migrations: CAM, stakeholders, GL accounts, documents,
-- workflows, projections, actuals, variances, reconciliations,
-- revenues, integration_configs, and billings.
-- ============================================================

-- 1. CAM CALCULATIONS
CREATE TABLE IF NOT EXISTS public.cam_calculations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  property_id     UUID REFERENCES public.properties(id) ON DELETE CASCADE,
  fiscal_year     INT,
  year            INT,
  annual_cam      NUMERIC DEFAULT 0,
  cam_per_sf      NUMERIC DEFAULT 0,
  method          TEXT DEFAULT 'pro_rata',  -- pro_rata | fixed | capped
  status          TEXT DEFAULT 'draft',     -- draft | active | finalized
  admin_fee_pct   NUMERIC DEFAULT 10,
  gross_up_pct    NUMERIC DEFAULT 0,
  cap_pct         NUMERIC DEFAULT 0,
  total_recoverable NUMERIC DEFAULT 0,
  total_building_sf NUMERIC DEFAULT 0,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- 2. STAKEHOLDERS
CREATE TABLE IF NOT EXISTS public.stakeholders (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  property_id             UUID REFERENCES public.properties(id) ON DELETE SET NULL,
  name                    TEXT NOT NULL,
  email                   TEXT,
  role                    TEXT DEFAULT 'property_manager',
  notify_lease_expiry     BOOLEAN DEFAULT TRUE,
  notify_budget_approval  BOOLEAN DEFAULT TRUE,
  notify_cam_variance     BOOLEAN DEFAULT TRUE,
  notify_reconciliation   BOOLEAN DEFAULT FALSE,
  notify_audit_anomaly    BOOLEAN DEFAULT FALSE,
  created_at              TIMESTAMPTZ DEFAULT now(),
  updated_at              TIMESTAMPTZ DEFAULT now()
);

-- 3. GL ACCOUNTS (Chart of Accounts)
CREATE TABLE IF NOT EXISTS public.gl_accounts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  category    TEXT,
  type        TEXT DEFAULT 'expense',  -- expense | revenue | asset | liability
  description TEXT,
  is_active   BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- 4. DOCUMENTS
CREATE TABLE IF NOT EXISTS public.documents (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  property_id  UUID REFERENCES public.properties(id) ON DELETE SET NULL,
  lease_id     UUID REFERENCES public.leases(id) ON DELETE SET NULL,
  name         TEXT NOT NULL,
  file_url     TEXT,
  type         TEXT DEFAULT 'other',  -- lease | invoice | report | contract | other
  description  TEXT,
  tenant_name  TEXT,
  vendor_name  TEXT,
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);

-- 5. WORKFLOWS
CREATE TABLE IF NOT EXISTS public.workflows (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  type        TEXT DEFAULT 'notification',  -- notification | approval | automation
  status      TEXT DEFAULT 'active',        -- active | inactive | draft
  trigger     TEXT,
  description TEXT,
  config      JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- 6. REVENUES
CREATE TABLE IF NOT EXISTS public.revenues (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  property_id UUID REFERENCES public.properties(id) ON DELETE SET NULL,
  lease_id    UUID REFERENCES public.leases(id) ON DELETE SET NULL,
  fiscal_year INT,
  month       INT,
  type        TEXT DEFAULT 'base_rent',  -- base_rent | cam_recovery | late_fee | other
  amount      NUMERIC DEFAULT 0,
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- 7. ACTUALS
CREATE TABLE IF NOT EXISTS public.actuals (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  property_id UUID REFERENCES public.properties(id) ON DELETE SET NULL,
  fiscal_year INT,
  month       INT,
  category    TEXT,
  amount      NUMERIC DEFAULT 0,
  source      TEXT,  -- invoice | import | manual
  gl_code     TEXT,
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- 8. VARIANCES
CREATE TABLE IF NOT EXISTS public.variances (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  property_id     UUID REFERENCES public.properties(id) ON DELETE SET NULL,
  fiscal_year     INT,
  month           INT,
  category        TEXT,
  budget_amount   NUMERIC DEFAULT 0,
  actual_amount   NUMERIC DEFAULT 0,
  variance_amount NUMERIC DEFAULT 0,
  variance_pct    NUMERIC DEFAULT 0,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- 9. RECONCILIATIONS
CREATE TABLE IF NOT EXISTS public.reconciliations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  property_id       UUID REFERENCES public.properties(id) ON DELETE SET NULL,
  fiscal_year       INT NOT NULL,
  status            TEXT DEFAULT 'pending',  -- pending | in_progress | completed
  total_recoverable NUMERIC DEFAULT 0,
  total_billed      NUMERIC DEFAULT 0,
  variance          NUMERIC DEFAULT 0,
  completed_at      TIMESTAMPTZ,
  notes             TEXT,
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);

-- 10. RENT PROJECTIONS
CREATE TABLE IF NOT EXISTS public.rent_projections (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                   UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  property_id              UUID REFERENCES public.properties(id) ON DELETE SET NULL,
  lease_id                 UUID REFERENCES public.leases(id) ON DELETE SET NULL,
  fiscal_year              INT,
  base_year                INT,
  projected_annual_rent    NUMERIC DEFAULT 0,
  growth_rate              NUMERIC DEFAULT 3,
  method                   TEXT DEFAULT 'escalation',  -- escalation | market | flat
  notes                    TEXT,
  created_at               TIMESTAMPTZ DEFAULT now(),
  updated_at               TIMESTAMPTZ DEFAULT now()
);

-- 11. EXPENSE PROJECTIONS
CREATE TABLE IF NOT EXISTS public.expense_projections (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  property_id       UUID REFERENCES public.properties(id) ON DELETE SET NULL,
  fiscal_year       INT,
  base_year         INT,
  category          TEXT,
  projected_amount  NUMERIC DEFAULT 0,
  growth_rate       NUMERIC DEFAULT 3,
  method            TEXT DEFAULT 'percentage',  -- percentage | fixed | market
  notes             TEXT,
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);

-- 12. INTEGRATION CONFIGS
CREATE TABLE IF NOT EXISTS public.integration_configs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL,  -- yardi | mri | quickbooks | salesforce | etc.
  label        TEXT,
  description  TEXT,
  status       TEXT DEFAULT 'inactive',  -- active | inactive | error
  credentials  JSONB DEFAULT '{}',
  last_synced  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);

-- 13. BILLINGS
CREATE TABLE IF NOT EXISTS public.billings (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  plan              TEXT DEFAULT 'starter',    -- starter | professional | enterprise
  status            TEXT DEFAULT 'active',     -- active | past_due | cancelled | trialing
  billing_cycle     TEXT DEFAULT 'monthly',    -- monthly | annual
  amount            NUMERIC DEFAULT 0,
  currency          TEXT DEFAULT 'USD',
  stripe_customer_id TEXT,
  stripe_sub_id     TEXT,
  next_billing_date DATE,
  trial_ends_at     TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- RLS POLICIES — apply to all new org-scoped tables
-- ============================================================
DO $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'cam_calculations', 'stakeholders', 'gl_accounts', 'documents',
    'workflows', 'revenues', 'actuals', 'variances', 'reconciliations',
    'rent_projections', 'expense_projections', 'integration_configs', 'billings'
  ])
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS "%s_select" ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%s_insert" ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%s_update" ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%s_delete" ON public.%I', t, t);

    EXECUTE format(
      'CREATE POLICY "%s_select" ON public.%I FOR SELECT USING (org_id IN (SELECT public.get_my_org_ids()))',
      t, t
    );
    EXECUTE format(
      'CREATE POLICY "%s_insert" ON public.%I FOR INSERT WITH CHECK (public.can_write_org_data(org_id))',
      t, t
    );
    EXECUTE format(
      'CREATE POLICY "%s_update" ON public.%I FOR UPDATE USING (public.can_write_org_data(org_id))',
      t, t
    );
    EXECUTE format(
      'CREATE POLICY "%s_delete" ON public.%I FOR DELETE USING (public.is_org_admin(org_id))',
      t, t
    );
  END LOOP;
END $$;

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_cam_calculations_property ON public.cam_calculations(property_id);
CREATE INDEX IF NOT EXISTS idx_cam_calculations_year ON public.cam_calculations(fiscal_year);
CREATE INDEX IF NOT EXISTS idx_stakeholders_org ON public.stakeholders(org_id);
CREATE INDEX IF NOT EXISTS idx_documents_property ON public.documents(property_id);
CREATE INDEX IF NOT EXISTS idx_documents_lease ON public.documents(lease_id);
CREATE INDEX IF NOT EXISTS idx_revenues_property_year ON public.revenues(property_id, fiscal_year);
CREATE INDEX IF NOT EXISTS idx_actuals_property_year ON public.actuals(property_id, fiscal_year);
CREATE INDEX IF NOT EXISTS idx_variances_property_year ON public.variances(property_id, fiscal_year);
CREATE INDEX IF NOT EXISTS idx_reconciliations_property ON public.reconciliations(property_id, fiscal_year);
CREATE INDEX IF NOT EXISTS idx_rent_projections_property ON public.rent_projections(property_id, fiscal_year);
CREATE INDEX IF NOT EXISTS idx_expense_projections_property ON public.expense_projections(property_id, fiscal_year);
CREATE INDEX IF NOT EXISTS idx_billings_org ON public.billings(org_id);

-- ============================================================
-- PATCH: access_requests missing columns
-- The API layer submits these fields but the original schema
-- didn't include them.
-- ============================================================
ALTER TABLE public.access_requests ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE public.access_requests ADD COLUMN IF NOT EXISTS request_type TEXT DEFAULT 'access';
ALTER TABLE public.access_requests ADD COLUMN IF NOT EXISTS billing_cycle TEXT DEFAULT 'monthly';
ALTER TABLE public.access_requests ADD COLUMN IF NOT EXISTS plan TEXT;
ALTER TABLE public.access_requests ADD COLUMN IF NOT EXISTS portfolios TEXT;
ALTER TABLE public.access_requests ADD COLUMN IF NOT EXISTS properties_count TEXT;

-- ============================================================
-- PATCH: vendors missing columns used in seed/pages
-- ============================================================
ALTER TABLE public.vendors ADD COLUMN IF NOT EXISTS contact_name TEXT;
ALTER TABLE public.vendors ADD COLUMN IF NOT EXISTS rating NUMERIC DEFAULT 0;

-- ============================================================
-- STORAGE BUCKET (documents)
-- NOTE: Run this separately via Supabase dashboard or CLI
-- since storage buckets can't be created via SQL migrations.
--
-- supabase storage create documents --public
-- ============================================================

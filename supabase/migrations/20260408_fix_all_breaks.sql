-- ============================================================
-- FIX ALL BREAKS — run this in Supabase SQL Editor
-- Fixes all 400/404 errors visible in the browser console.
-- Safe to run multiple times (all idempotent).
-- ============================================================

-- ── 1. Add missing columns to properties ─────────────────────────────────
ALTER TABLE public.properties ADD COLUMN IF NOT EXISTS structure_type      TEXT DEFAULT 'single';
ALTER TABLE public.properties ADD COLUMN IF NOT EXISTS total_buildings      INT DEFAULT 1;
ALTER TABLE public.properties ADD COLUMN IF NOT EXISTS total_units          INT DEFAULT 0;
ALTER TABLE public.properties ADD COLUMN IF NOT EXISTS occupancy_pct        NUMERIC DEFAULT 0;
ALTER TABLE public.properties ADD COLUMN IF NOT EXISTS address_verified     BOOLEAN DEFAULT FALSE;
ALTER TABLE public.properties ADD COLUMN IF NOT EXISTS address_verification_note TEXT;
ALTER TABLE public.properties ADD COLUMN IF NOT EXISTS property_id_code     TEXT;

-- ── 2. Create all missing business tables ────────────────────────────────

-- cam_calculations
CREATE TABLE IF NOT EXISTS public.cam_calculations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  property_id       UUID REFERENCES public.properties(id) ON DELETE CASCADE,
  fiscal_year       INT,
  annual_cam        NUMERIC DEFAULT 0,
  cam_per_sf        NUMERIC DEFAULT 0,
  method            TEXT DEFAULT 'pro_rata',
  status            TEXT DEFAULT 'draft',
  admin_fee_pct     NUMERIC DEFAULT 10,
  gross_up_pct      NUMERIC DEFAULT 0,
  cap_pct           NUMERIC DEFAULT 0,
  total_recoverable NUMERIC DEFAULT 0,
  total_building_sf NUMERIC DEFAULT 0,
  notes             TEXT,
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);

-- stakeholders
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

-- gl_accounts
CREATE TABLE IF NOT EXISTS public.gl_accounts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  category    TEXT,
  type        TEXT DEFAULT 'expense',
  description TEXT,
  is_active   BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- documents
CREATE TABLE IF NOT EXISTS public.documents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  property_id UUID REFERENCES public.properties(id) ON DELETE SET NULL,
  lease_id    UUID REFERENCES public.leases(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  file_url    TEXT,
  type        TEXT DEFAULT 'other',
  description TEXT,
  tenant_name TEXT,
  vendor_name TEXT,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- workflows
CREATE TABLE IF NOT EXISTS public.workflows (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  type        TEXT DEFAULT 'notification',
  status      TEXT DEFAULT 'active',
  trigger     TEXT,
  description TEXT,
  config      JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- revenues
CREATE TABLE IF NOT EXISTS public.revenues (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  property_id UUID REFERENCES public.properties(id) ON DELETE SET NULL,
  lease_id    UUID REFERENCES public.leases(id) ON DELETE SET NULL,
  fiscal_year INT,
  month       INT,
  type        TEXT DEFAULT 'base_rent',
  amount      NUMERIC DEFAULT 0,
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- actuals
CREATE TABLE IF NOT EXISTS public.actuals (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  property_id UUID REFERENCES public.properties(id) ON DELETE SET NULL,
  fiscal_year INT,
  month       INT,
  category    TEXT,
  amount      NUMERIC DEFAULT 0,
  source      TEXT,
  gl_code     TEXT,
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- variances
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

-- reconciliations
CREATE TABLE IF NOT EXISTS public.reconciliations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  property_id       UUID REFERENCES public.properties(id) ON DELETE SET NULL,
  fiscal_year       INT NOT NULL,
  status            TEXT DEFAULT 'pending',
  total_recoverable NUMERIC DEFAULT 0,
  total_billed      NUMERIC DEFAULT 0,
  variance          NUMERIC DEFAULT 0,
  completed_at      TIMESTAMPTZ,
  notes             TEXT,
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);

-- rent_projections
CREATE TABLE IF NOT EXISTS public.rent_projections (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  property_id           UUID REFERENCES public.properties(id) ON DELETE SET NULL,
  lease_id              UUID REFERENCES public.leases(id) ON DELETE SET NULL,
  fiscal_year           INT,
  base_year             INT,
  projected_annual_rent NUMERIC DEFAULT 0,
  growth_rate           NUMERIC DEFAULT 3,
  method                TEXT DEFAULT 'escalation',
  notes                 TEXT,
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now()
);

-- expense_projections
CREATE TABLE IF NOT EXISTS public.expense_projections (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  property_id      UUID REFERENCES public.properties(id) ON DELETE SET NULL,
  fiscal_year      INT,
  base_year        INT,
  category         TEXT,
  projected_amount NUMERIC DEFAULT 0,
  growth_rate      NUMERIC DEFAULT 3,
  method           TEXT DEFAULT 'percentage',
  notes            TEXT,
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now()
);

-- integration_configs
CREATE TABLE IF NOT EXISTS public.integration_configs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL,
  label       TEXT,
  description TEXT,
  status      TEXT DEFAULT 'inactive',
  credentials JSONB DEFAULT '{}',
  last_synced TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- billings
CREATE TABLE IF NOT EXISTS public.billings (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  plan               TEXT DEFAULT 'starter',
  status             TEXT DEFAULT 'active',
  billing_cycle      TEXT DEFAULT 'monthly',
  amount             NUMERIC DEFAULT 0,
  currency           TEXT DEFAULT 'USD',
  stripe_customer_id TEXT,
  stripe_sub_id      TEXT,
  next_billing_date  DATE,
  trial_ends_at      TIMESTAMPTZ,
  created_at         TIMESTAMPTZ DEFAULT now(),
  updated_at         TIMESTAMPTZ DEFAULT now()
);

-- ── 3. access_requests missing columns ───────────────────────────────────
ALTER TABLE public.access_requests ADD COLUMN IF NOT EXISTS phone             TEXT;
ALTER TABLE public.access_requests ADD COLUMN IF NOT EXISTS request_type      TEXT DEFAULT 'access';
ALTER TABLE public.access_requests ADD COLUMN IF NOT EXISTS billing_cycle     TEXT DEFAULT 'monthly';
ALTER TABLE public.access_requests ADD COLUMN IF NOT EXISTS plan              TEXT;
ALTER TABLE public.access_requests ADD COLUMN IF NOT EXISTS portfolios        TEXT;
ALTER TABLE public.access_requests ADD COLUMN IF NOT EXISTS properties_count  TEXT;

-- vendors missing columns
ALTER TABLE public.vendors ADD COLUMN IF NOT EXISTS contact_name TEXT;
ALTER TABLE public.vendors ADD COLUMN IF NOT EXISTS rating       NUMERIC DEFAULT 0;

-- ── 4. RLS on all new tables — super_admin bypass ─────────────────────────
DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'cam_calculations','stakeholders','gl_accounts','documents','workflows',
    'revenues','actuals','variances','reconciliations','rent_projections',
    'expense_projections','integration_configs','billings'
  ])
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS "%s_select" ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%s_insert" ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%s_update" ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%s_delete" ON public.%I', t, t);

    -- Use EXISTS subquery (not ANY(SETOF)) to avoid the set-returning error
    EXECUTE format(
      'CREATE POLICY "%s_select" ON public.%I FOR SELECT USING (
        public.is_super_admin()
        OR EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id = auth.uid() AND m.org_id = %I.org_id)
      )', t, t, t);

    EXECUTE format(
      'CREATE POLICY "%s_insert" ON public.%I FOR INSERT WITH CHECK (public.can_write_org_data(org_id))',
      t, t);

    EXECUTE format(
      'CREATE POLICY "%s_update" ON public.%I FOR UPDATE USING (public.can_write_org_data(org_id))',
      t, t);

    EXECUTE format(
      'CREATE POLICY "%s_delete" ON public.%I FOR DELETE USING (public.is_org_admin(org_id))',
      t, t);
  END LOOP;
END $$;

-- Fix notifications RLS (was using get_my_org_ids() which can fail)
DROP POLICY IF EXISTS "notifications_select_own" ON public.notifications;
DROP POLICY IF EXISTS "notifications_update_own" ON public.notifications;
DROP POLICY IF EXISTS "notifications_select" ON public.notifications;
DROP POLICY IF EXISTS "notifications_insert" ON public.notifications;
DROP POLICY IF EXISTS "notifications_update" ON public.notifications;

CREATE POLICY "notifications_select" ON public.notifications
  FOR SELECT USING (
    public.is_super_admin()
    OR EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id = auth.uid() AND m.org_id = notifications.org_id)
  );
CREATE POLICY "notifications_insert" ON public.notifications
  FOR INSERT WITH CHECK (public.can_write_org_data(org_id));
CREATE POLICY "notifications_update" ON public.notifications
  FOR UPDATE USING (
    public.is_super_admin()
    OR EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id = auth.uid() AND m.org_id = notifications.org_id)
  );

-- Fix audit_logs RLS
DROP POLICY IF EXISTS "audit_logs_select_admin" ON public.audit_logs;
DROP POLICY IF EXISTS "audit_logs_select" ON public.audit_logs;
DROP POLICY IF EXISTS "audit_logs_insert" ON public.audit_logs;

CREATE POLICY "audit_logs_select" ON public.audit_logs
  FOR SELECT USING (
    public.is_super_admin()
    OR EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id = auth.uid() AND m.org_id = audit_logs.org_id)
  );
CREATE POLICY "audit_logs_insert" ON public.audit_logs
  FOR INSERT WITH CHECK (TRUE);  -- edge functions insert with service role, no restriction needed

-- ── 5. Indexes ────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_cam_calculations_property ON public.cam_calculations(property_id);
CREATE INDEX IF NOT EXISTS idx_cam_calculations_year     ON public.cam_calculations(fiscal_year);
CREATE INDEX IF NOT EXISTS idx_stakeholders_org          ON public.stakeholders(org_id);
CREATE INDEX IF NOT EXISTS idx_documents_property        ON public.documents(property_id);
CREATE INDEX IF NOT EXISTS idx_revenues_property_year    ON public.revenues(property_id, fiscal_year);
CREATE INDEX IF NOT EXISTS idx_actuals_property_year     ON public.actuals(property_id, fiscal_year);
CREATE INDEX IF NOT EXISTS idx_variances_property_year   ON public.variances(property_id, fiscal_year);
CREATE INDEX IF NOT EXISTS idx_reconciliations_property  ON public.reconciliations(property_id, fiscal_year);
CREATE INDEX IF NOT EXISTS idx_billings_org              ON public.billings(org_id);
CREATE INDEX IF NOT EXISTS idx_properties_structure      ON public.properties(org_id, structure_type);

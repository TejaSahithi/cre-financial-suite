-- Enterprise access control foundation.
--
-- Compatibility-first design:
-- - memberships remains the source of org membership and active/invited state.
-- - memberships.page_permissions and capabilities.signing_privileges remain
--   supported by the current UI.
-- - user_access remains the selected portfolio/property scope table.
-- - normalized member_* tables are added for future admin/reporting/audit use.

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS last_sign_in_at TIMESTAMPTZ;

ALTER TABLE public.memberships ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';
ALTER TABLE public.memberships ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE public.memberships ADD COLUMN IF NOT EXISTS custom_role TEXT;
ALTER TABLE public.memberships ADD COLUMN IF NOT EXISTS module_permissions JSONB DEFAULT '{}'::jsonb;
ALTER TABLE public.memberships ADD COLUMN IF NOT EXISTS page_permissions JSONB DEFAULT '{}'::jsonb;
ALTER TABLE public.memberships ADD COLUMN IF NOT EXISTS capabilities JSONB DEFAULT '{}'::jsonb;
ALTER TABLE public.memberships ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;
ALTER TABLE public.memberships ADD COLUMN IF NOT EXISTS deactivated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

UPDATE public.memberships
SET
  status = COALESCE(status, 'active'),
  module_permissions = COALESCE(module_permissions, '{}'::jsonb),
  page_permissions = COALESCE(page_permissions, '{}'::jsonb),
  capabilities = COALESCE(capabilities, '{}'::jsonb)
WHERE
  status IS NULL
  OR module_permissions IS NULL
  OR page_permissions IS NULL
  OR capabilities IS NULL;

CREATE INDEX IF NOT EXISTS idx_memberships_org_status ON public.memberships(org_id, status);
CREATE INDEX IF NOT EXISTS idx_memberships_capabilities_gin ON public.memberships USING gin(capabilities);
CREATE INDEX IF NOT EXISTS idx_memberships_page_permissions_gin ON public.memberships USING gin(page_permissions);

CREATE TABLE IF NOT EXISTS public.role_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
  role_key TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  default_page_permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
  default_capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, role_key)
);

CREATE TABLE IF NOT EXISTS public.member_page_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  membership_id UUID NOT NULL REFERENCES public.memberships(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  page_key TEXT NOT NULL,
  access_level TEXT NOT NULL DEFAULT 'none' CHECK (access_level IN ('none', 'read', 'write', 'approve', 'admin', 'full')),
  granted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (membership_id, page_key)
);

CREATE TABLE IF NOT EXISTS public.member_portfolio_access (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  membership_id UUID NOT NULL REFERENCES public.memberships(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  portfolio_id UUID NOT NULL REFERENCES public.portfolios(id) ON DELETE CASCADE,
  access_level TEXT NOT NULL DEFAULT 'read' CHECK (access_level IN ('read', 'write', 'approve', 'admin', 'full')),
  granted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (membership_id, portfolio_id)
);

CREATE TABLE IF NOT EXISTS public.member_property_access (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  membership_id UUID NOT NULL REFERENCES public.memberships(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  property_id UUID NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  access_level TEXT NOT NULL DEFAULT 'read' CHECK (access_level IN ('read', 'write', 'approve', 'admin', 'full')),
  granted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (membership_id, property_id)
);

CREATE TABLE IF NOT EXISTS public.member_signing_authority (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  membership_id UUID NOT NULL REFERENCES public.memberships(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  authority_key TEXT NOT NULL,
  authority_level INT NOT NULL DEFAULT 0 CHECK (authority_level BETWEEN 0 AND 4),
  granted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (membership_id, authority_key)
);

CREATE TABLE IF NOT EXISTS public.permission_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  target_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  membership_id UUID REFERENCES public.memberships(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  before_value JSONB,
  after_value JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.role_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_page_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_portfolio_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_property_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_signing_authority ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.permission_audit_events ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.is_active_org_member(check_org_id UUID)
RETURNS BOOLEAN AS $$
  SELECT public.is_super_admin()
    OR EXISTS (
      SELECT 1
      FROM public.memberships m
      WHERE m.user_id = auth.uid()
        AND m.org_id = check_org_id
        AND COALESCE(m.status, 'active') IN ('active', 'owner')
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.access_level_rank(level TEXT)
RETURNS INT AS $$
  SELECT CASE lower(COALESCE(level, 'none'))
    WHEN 'full' THEN 4
    WHEN 'admin' THEN 4
    WHEN 'approve' THEN 3
    WHEN 'write' THEN 2
    WHEN 'edit' THEN 2
    WHEN 'read' THEN 1
    WHEN 'read_only' THEN 1
    WHEN 'readonly' THEN 1
    ELSE 0
  END;
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.membership_page_access(check_org_id UUID, page_name TEXT)
RETURNS TEXT AS $$
  WITH active_membership AS (
    SELECT m.*
    FROM public.memberships m
    WHERE m.user_id = auth.uid()
      AND m.org_id = check_org_id
      AND COALESCE(m.status, 'active') IN ('active', 'owner')
    ORDER BY
      CASE m.role
        WHEN 'org_admin' THEN 0
        WHEN 'manager' THEN 1
        WHEN 'editor' THEN 2
        WHEN 'viewer' THEN 3
        ELSE 4
      END
    LIMIT 1
  ),
  normalized AS (
    SELECT
      m.role,
      COALESCE(m.page_permissions, '{}'::jsonb) AS page_permissions,
      COALESCE(m.capabilities, '{}'::jsonb) AS capabilities
    FROM active_membership m
  )
  SELECT CASE
    WHEN public.is_super_admin() THEN 'admin'
    WHEN EXISTS (SELECT 1 FROM normalized WHERE role = 'org_admin') THEN 'admin'
    WHEN EXISTS (
      SELECT 1 FROM normalized
      WHERE page_permissions ? page_name
    ) THEN (
      SELECT CASE
        WHEN lower(COALESCE(page_permissions->>page_name, 'none')) = 'full' THEN 'admin'
        ELSE lower(COALESCE(page_permissions->>page_name, 'none'))
      END
      FROM normalized
      LIMIT 1
    )
    WHEN EXISTS (SELECT 1 FROM normalized WHERE role IN ('manager', 'editor', 'finance', 'property_manager')) THEN 'write'
    WHEN EXISTS (SELECT 1 FROM normalized) THEN 'read'
    ELSE 'none'
  END;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.can_read_page(check_org_id UUID, page_name TEXT)
RETURNS BOOLEAN AS $$
  SELECT public.access_level_rank(public.membership_page_access(check_org_id, page_name)) >= 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.can_write_page(check_org_id UUID, page_name TEXT)
RETURNS BOOLEAN AS $$
  SELECT public.access_level_rank(public.membership_page_access(check_org_id, page_name)) >= 2;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.has_unrestricted_property_scope(check_org_id UUID)
RETURNS BOOLEAN AS $$
  SELECT public.is_super_admin()
    OR EXISTS (
      SELECT 1
      FROM public.memberships m
      WHERE m.user_id = auth.uid()
        AND m.org_id = check_org_id
        AND COALESCE(m.status, 'active') IN ('active', 'owner')
        AND (
          m.role = 'org_admin'
          OR COALESCE((m.capabilities->'scope_access'->>'all_portfolios')::boolean, false)
          OR COALESCE((m.capabilities->'scope_access'->>'all_properties')::boolean, false)
        )
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.can_access_portfolio(p_portfolio_id UUID)
RETURNS BOOLEAN AS $$
  SELECT public.is_super_admin()
    OR EXISTS (
      SELECT 1
      FROM public.portfolios pf
      WHERE pf.id = p_portfolio_id
        AND public.has_unrestricted_property_scope(pf.org_id)
    )
    OR EXISTS (
      SELECT 1
      FROM public.user_access ua
      WHERE ua.user_id = auth.uid()
        AND ua.scope = 'portfolio'
        AND ua.scope_id = p_portfolio_id
        AND ua.is_active = TRUE
        AND (ua.expires_at IS NULL OR ua.expires_at > now())
    )
    OR EXISTS (
      SELECT 1
      FROM public.properties pr
      JOIN public.user_access ua
        ON ua.scope = 'property'
       AND ua.scope_id = pr.id
       AND ua.user_id = auth.uid()
       AND ua.is_active = TRUE
       AND (ua.expires_at IS NULL OR ua.expires_at > now())
      WHERE pr.portfolio_id = p_portfolio_id
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.can_access_property(p_property_id UUID)
RETURNS BOOLEAN AS $$
  SELECT public.is_super_admin()
    OR EXISTS (
      SELECT 1
      FROM public.properties pr
      WHERE pr.id = p_property_id
        AND public.has_unrestricted_property_scope(pr.org_id)
    )
    OR EXISTS (
      SELECT 1
      FROM public.user_access ua
      WHERE ua.user_id = auth.uid()
        AND ua.scope = 'property'
        AND ua.scope_id = p_property_id
        AND ua.is_active = TRUE
        AND (ua.expires_at IS NULL OR ua.expires_at > now())
    )
    OR EXISTS (
      SELECT 1
      FROM public.properties pr
      JOIN public.user_access ua
        ON ua.scope = 'portfolio'
       AND ua.scope_id = pr.portfolio_id
       AND ua.user_id = auth.uid()
       AND ua.is_active = TRUE
       AND (ua.expires_at IS NULL OR ua.expires_at > now())
      WHERE pr.id = p_property_id
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.get_accessible_property_ids(p_org_id UUID)
RETURNS SETOF UUID AS $$
  SELECT pr.id
  FROM public.properties pr
  WHERE pr.org_id = p_org_id
    AND public.has_unrestricted_property_scope(p_org_id)
  UNION
  SELECT ua.scope_id
  FROM public.user_access ua
  WHERE ua.user_id = auth.uid()
    AND ua.org_id = p_org_id
    AND ua.scope = 'property'
    AND ua.is_active = TRUE
    AND (ua.expires_at IS NULL OR ua.expires_at > now())
  UNION
  SELECT pr.id
  FROM public.properties pr
  JOIN public.user_access ua ON ua.scope_id = pr.portfolio_id
  WHERE ua.user_id = auth.uid()
    AND ua.org_id = p_org_id
    AND ua.scope = 'portfolio'
    AND ua.is_active = TRUE
    AND (ua.expires_at IS NULL OR ua.expires_at > now());
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.can_write_org_data(check_org_id UUID)
RETURNS BOOLEAN AS $$
  SELECT public.is_super_admin()
    OR public.is_org_admin(check_org_id)
    OR EXISTS (
      SELECT 1
      FROM public.memberships m
      WHERE m.user_id = auth.uid()
        AND m.org_id = check_org_id
        AND COALESCE(m.status, 'active') IN ('active', 'owner')
        AND m.role IN ('manager', 'editor', 'finance', 'property_manager')
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

DROP POLICY IF EXISTS "role_definitions_select" ON public.role_definitions;
DROP POLICY IF EXISTS "role_definitions_write" ON public.role_definitions;
CREATE POLICY "role_definitions_select" ON public.role_definitions
  FOR SELECT USING (org_id IS NULL OR public.is_active_org_member(org_id));
CREATE POLICY "role_definitions_write" ON public.role_definitions
  FOR ALL USING (org_id IS NOT NULL AND (public.is_super_admin() OR public.is_org_admin(org_id)))
  WITH CHECK (org_id IS NOT NULL AND (public.is_super_admin() OR public.is_org_admin(org_id)));

DROP POLICY IF EXISTS "member_page_permissions_select" ON public.member_page_permissions;
DROP POLICY IF EXISTS "member_page_permissions_write" ON public.member_page_permissions;
CREATE POLICY "member_page_permissions_select" ON public.member_page_permissions
  FOR SELECT USING (user_id = auth.uid() OR public.is_super_admin() OR public.is_org_admin(org_id));
CREATE POLICY "member_page_permissions_write" ON public.member_page_permissions
  FOR ALL USING (public.is_super_admin() OR public.is_org_admin(org_id))
  WITH CHECK (public.is_super_admin() OR public.is_org_admin(org_id));

DROP POLICY IF EXISTS "member_portfolio_access_select" ON public.member_portfolio_access;
DROP POLICY IF EXISTS "member_portfolio_access_write" ON public.member_portfolio_access;
CREATE POLICY "member_portfolio_access_select" ON public.member_portfolio_access
  FOR SELECT USING (user_id = auth.uid() OR public.is_super_admin() OR public.is_org_admin(org_id));
CREATE POLICY "member_portfolio_access_write" ON public.member_portfolio_access
  FOR ALL USING (public.is_super_admin() OR public.is_org_admin(org_id))
  WITH CHECK (public.is_super_admin() OR public.is_org_admin(org_id));

DROP POLICY IF EXISTS "member_property_access_select" ON public.member_property_access;
DROP POLICY IF EXISTS "member_property_access_write" ON public.member_property_access;
CREATE POLICY "member_property_access_select" ON public.member_property_access
  FOR SELECT USING (user_id = auth.uid() OR public.is_super_admin() OR public.is_org_admin(org_id));
CREATE POLICY "member_property_access_write" ON public.member_property_access
  FOR ALL USING (public.is_super_admin() OR public.is_org_admin(org_id))
  WITH CHECK (public.is_super_admin() OR public.is_org_admin(org_id));

DROP POLICY IF EXISTS "member_signing_authority_select" ON public.member_signing_authority;
DROP POLICY IF EXISTS "member_signing_authority_write" ON public.member_signing_authority;
CREATE POLICY "member_signing_authority_select" ON public.member_signing_authority
  FOR SELECT USING (user_id = auth.uid() OR public.is_super_admin() OR public.is_org_admin(org_id));
CREATE POLICY "member_signing_authority_write" ON public.member_signing_authority
  FOR ALL USING (public.is_super_admin() OR public.is_org_admin(org_id))
  WITH CHECK (public.is_super_admin() OR public.is_org_admin(org_id));

DROP POLICY IF EXISTS "permission_audit_events_select" ON public.permission_audit_events;
DROP POLICY IF EXISTS "permission_audit_events_insert" ON public.permission_audit_events;
CREATE POLICY "permission_audit_events_select" ON public.permission_audit_events
  FOR SELECT USING (public.is_super_admin() OR public.is_org_admin(org_id));
CREATE POLICY "permission_audit_events_insert" ON public.permission_audit_events
  FOR INSERT WITH CHECK (public.is_super_admin() OR public.is_org_admin(org_id));

CREATE INDEX IF NOT EXISTS idx_member_page_permissions_user ON public.member_page_permissions(user_id, org_id);
CREATE INDEX IF NOT EXISTS idx_member_portfolio_access_user ON public.member_portfolio_access(user_id, org_id, is_active);
CREATE INDEX IF NOT EXISTS idx_member_property_access_user ON public.member_property_access(user_id, org_id, is_active);
CREATE INDEX IF NOT EXISTS idx_member_signing_authority_user ON public.member_signing_authority(user_id, org_id);
CREATE INDEX IF NOT EXISTS idx_permission_audit_events_org ON public.permission_audit_events(org_id, created_at DESC);

-- Scope-aware RLS for core CRE data. These policy names match the existing
-- app convention so this migration replaces older org-wide policies.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'portfolios','properties','buildings','units','tenants','leases',
    'expenses','budgets','vendors','invoices','revenues','actuals',
    'variances','documents','gl_accounts','cam_calculations'
  ]
  LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format('DROP POLICY IF EXISTS "%s_select" ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%s_insert" ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%s_update" ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%s_delete" ON public.%I', t, t);
  END LOOP;
END $$;

CREATE POLICY "portfolios_select" ON public.portfolios
  FOR SELECT USING (public.can_access_portfolio(id));
CREATE POLICY "portfolios_insert" ON public.portfolios
  FOR INSERT WITH CHECK (public.can_write_page(org_id, 'Portfolios'));
CREATE POLICY "portfolios_update" ON public.portfolios
  FOR UPDATE USING (public.can_write_page(org_id, 'Portfolios') AND public.can_access_portfolio(id))
  WITH CHECK (public.can_write_page(org_id, 'Portfolios'));
CREATE POLICY "portfolios_delete" ON public.portfolios
  FOR DELETE USING (public.is_org_admin(org_id));

CREATE POLICY "properties_select" ON public.properties
  FOR SELECT USING (public.can_access_property(id));
CREATE POLICY "properties_insert" ON public.properties
  FOR INSERT WITH CHECK (public.can_write_page(org_id, 'Properties') AND (portfolio_id IS NULL OR public.can_access_portfolio(portfolio_id)));
CREATE POLICY "properties_update" ON public.properties
  FOR UPDATE USING (public.can_write_page(org_id, 'Properties') AND public.can_access_property(id))
  WITH CHECK (public.can_write_page(org_id, 'Properties') AND (portfolio_id IS NULL OR public.can_access_portfolio(portfolio_id)));
CREATE POLICY "properties_delete" ON public.properties
  FOR DELETE USING (public.can_write_page(org_id, 'Properties') AND public.can_access_property(id));

CREATE POLICY "buildings_select" ON public.buildings
  FOR SELECT USING (public.can_access_property(property_id));
CREATE POLICY "buildings_insert" ON public.buildings
  FOR INSERT WITH CHECK (public.can_write_page(org_id, 'Buildings') AND public.can_access_property(property_id));
CREATE POLICY "buildings_update" ON public.buildings
  FOR UPDATE USING (public.can_write_page(org_id, 'Buildings') AND public.can_access_property(property_id))
  WITH CHECK (public.can_write_page(org_id, 'Buildings') AND public.can_access_property(property_id));
CREATE POLICY "buildings_delete" ON public.buildings
  FOR DELETE USING (public.can_write_page(org_id, 'Buildings') AND public.can_access_property(property_id));

CREATE POLICY "units_select" ON public.units
  FOR SELECT USING (public.can_access_property(property_id));
CREATE POLICY "units_insert" ON public.units
  FOR INSERT WITH CHECK (public.can_write_page(org_id, 'Units') AND public.can_access_property(property_id));
CREATE POLICY "units_update" ON public.units
  FOR UPDATE USING (public.can_write_page(org_id, 'Units') AND public.can_access_property(property_id))
  WITH CHECK (public.can_write_page(org_id, 'Units') AND public.can_access_property(property_id));
CREATE POLICY "units_delete" ON public.units
  FOR DELETE USING (public.can_write_page(org_id, 'Units') AND public.can_access_property(property_id));

CREATE POLICY "leases_select" ON public.leases
  FOR SELECT USING (property_id IS NULL OR public.can_access_property(property_id));
CREATE POLICY "leases_insert" ON public.leases
  FOR INSERT WITH CHECK (public.can_write_page(org_id, 'Leases') AND (property_id IS NULL OR public.can_access_property(property_id)));
CREATE POLICY "leases_update" ON public.leases
  FOR UPDATE USING (public.can_write_page(org_id, 'Leases') AND (property_id IS NULL OR public.can_access_property(property_id)))
  WITH CHECK (public.can_write_page(org_id, 'Leases') AND (property_id IS NULL OR public.can_access_property(property_id)));
CREATE POLICY "leases_delete" ON public.leases
  FOR DELETE USING (public.can_write_page(org_id, 'Leases') AND (property_id IS NULL OR public.can_access_property(property_id)));

CREATE POLICY "expenses_select" ON public.expenses
  FOR SELECT USING (property_id IS NULL OR public.can_access_property(property_id));
CREATE POLICY "expenses_insert" ON public.expenses
  FOR INSERT WITH CHECK (public.can_write_page(org_id, 'Expenses') AND (property_id IS NULL OR public.can_access_property(property_id)));
CREATE POLICY "expenses_update" ON public.expenses
  FOR UPDATE USING (public.can_write_page(org_id, 'Expenses') AND (property_id IS NULL OR public.can_access_property(property_id)))
  WITH CHECK (public.can_write_page(org_id, 'Expenses') AND (property_id IS NULL OR public.can_access_property(property_id)));
CREATE POLICY "expenses_delete" ON public.expenses
  FOR DELETE USING (public.can_write_page(org_id, 'Expenses') AND (property_id IS NULL OR public.can_access_property(property_id)));

CREATE POLICY "budgets_select" ON public.budgets
  FOR SELECT USING (property_id IS NULL OR public.can_access_property(property_id));
CREATE POLICY "budgets_insert" ON public.budgets
  FOR INSERT WITH CHECK (public.can_write_page(org_id, 'BudgetDashboard') AND (property_id IS NULL OR public.can_access_property(property_id)));
CREATE POLICY "budgets_update" ON public.budgets
  FOR UPDATE USING (public.can_write_page(org_id, 'BudgetDashboard') AND (property_id IS NULL OR public.can_access_property(property_id)))
  WITH CHECK (public.can_write_page(org_id, 'BudgetDashboard') AND (property_id IS NULL OR public.can_access_property(property_id)));
CREATE POLICY "budgets_delete" ON public.budgets
  FOR DELETE USING (public.can_write_page(org_id, 'BudgetDashboard') AND (property_id IS NULL OR public.can_access_property(property_id)));

-- Org-level tables still require page access plus active membership.
CREATE POLICY "tenants_select" ON public.tenants
  FOR SELECT USING (
    public.can_read_page(org_id, 'Tenants')
    AND (
      public.has_unrestricted_property_scope(org_id)
      OR EXISTS (
        SELECT 1
        FROM public.leases l
        WHERE l.org_id = tenants.org_id
          AND (
            l.tenant_id = tenants.id
            OR lower(COALESCE(l.tenant_name, '')) = lower(COALESCE(tenants.name, ''))
          )
          AND (l.property_id IS NULL OR public.can_access_property(l.property_id))
      )
    )
  );
CREATE POLICY "tenants_insert" ON public.tenants
  FOR INSERT WITH CHECK (public.can_write_page(org_id, 'Tenants'));
CREATE POLICY "tenants_update" ON public.tenants
  FOR UPDATE USING (public.can_write_page(org_id, 'Tenants')) WITH CHECK (public.can_write_page(org_id, 'Tenants'));
CREATE POLICY "tenants_delete" ON public.tenants
  FOR DELETE USING (public.can_write_page(org_id, 'Tenants'));

CREATE POLICY "vendors_select" ON public.vendors
  FOR SELECT USING (public.can_read_page(org_id, 'Vendors'));
CREATE POLICY "vendors_insert" ON public.vendors
  FOR INSERT WITH CHECK (public.can_write_page(org_id, 'Vendors'));
CREATE POLICY "vendors_update" ON public.vendors
  FOR UPDATE USING (public.can_write_page(org_id, 'Vendors')) WITH CHECK (public.can_write_page(org_id, 'Vendors'));
CREATE POLICY "vendors_delete" ON public.vendors
  FOR DELETE USING (public.can_write_page(org_id, 'Vendors'));

CREATE POLICY "invoices_select" ON public.invoices
  FOR SELECT USING (property_id IS NULL OR public.can_access_property(property_id));
CREATE POLICY "invoices_insert" ON public.invoices
  FOR INSERT WITH CHECK (public.can_write_page(org_id, 'Billing') AND (property_id IS NULL OR public.can_access_property(property_id)));
CREATE POLICY "invoices_update" ON public.invoices
  FOR UPDATE USING (public.can_write_page(org_id, 'Billing') AND (property_id IS NULL OR public.can_access_property(property_id)))
  WITH CHECK (public.can_write_page(org_id, 'Billing') AND (property_id IS NULL OR public.can_access_property(property_id)));
CREATE POLICY "invoices_delete" ON public.invoices
  FOR DELETE USING (public.can_write_page(org_id, 'Billing') AND (property_id IS NULL OR public.can_access_property(property_id)));

CREATE POLICY "revenues_select" ON public.revenues
  FOR SELECT USING (property_id IS NULL OR public.can_access_property(property_id));
CREATE POLICY "revenues_insert" ON public.revenues
  FOR INSERT WITH CHECK (public.can_write_page(org_id, 'Revenue') AND (property_id IS NULL OR public.can_access_property(property_id)));
CREATE POLICY "revenues_update" ON public.revenues
  FOR UPDATE USING (public.can_write_page(org_id, 'Revenue') AND (property_id IS NULL OR public.can_access_property(property_id)))
  WITH CHECK (public.can_write_page(org_id, 'Revenue') AND (property_id IS NULL OR public.can_access_property(property_id)));
CREATE POLICY "revenues_delete" ON public.revenues
  FOR DELETE USING (public.can_write_page(org_id, 'Revenue') AND (property_id IS NULL OR public.can_access_property(property_id)));

CREATE POLICY "actuals_select" ON public.actuals
  FOR SELECT USING (property_id IS NULL OR public.can_access_property(property_id));
CREATE POLICY "actuals_insert" ON public.actuals
  FOR INSERT WITH CHECK (public.can_write_page(org_id, 'ActualsVariance') AND (property_id IS NULL OR public.can_access_property(property_id)));
CREATE POLICY "actuals_update" ON public.actuals
  FOR UPDATE USING (public.can_write_page(org_id, 'ActualsVariance') AND (property_id IS NULL OR public.can_access_property(property_id)))
  WITH CHECK (public.can_write_page(org_id, 'ActualsVariance') AND (property_id IS NULL OR public.can_access_property(property_id)));
CREATE POLICY "actuals_delete" ON public.actuals
  FOR DELETE USING (public.can_write_page(org_id, 'ActualsVariance') AND (property_id IS NULL OR public.can_access_property(property_id)));

CREATE POLICY "variances_select" ON public.variances
  FOR SELECT USING (property_id IS NULL OR public.can_access_property(property_id));
CREATE POLICY "variances_insert" ON public.variances
  FOR INSERT WITH CHECK (public.can_write_page(org_id, 'ActualsVariance') AND (property_id IS NULL OR public.can_access_property(property_id)));
CREATE POLICY "variances_update" ON public.variances
  FOR UPDATE USING (public.can_write_page(org_id, 'ActualsVariance') AND (property_id IS NULL OR public.can_access_property(property_id)))
  WITH CHECK (public.can_write_page(org_id, 'ActualsVariance') AND (property_id IS NULL OR public.can_access_property(property_id)));
CREATE POLICY "variances_delete" ON public.variances
  FOR DELETE USING (public.can_write_page(org_id, 'ActualsVariance') AND (property_id IS NULL OR public.can_access_property(property_id)));

CREATE POLICY "documents_select" ON public.documents
  FOR SELECT USING (property_id IS NULL OR public.can_access_property(property_id));
CREATE POLICY "documents_insert" ON public.documents
  FOR INSERT WITH CHECK (public.can_write_page(org_id, 'Documents') AND (property_id IS NULL OR public.can_access_property(property_id)));
CREATE POLICY "documents_update" ON public.documents
  FOR UPDATE USING (public.can_write_page(org_id, 'Documents') AND (property_id IS NULL OR public.can_access_property(property_id)))
  WITH CHECK (public.can_write_page(org_id, 'Documents') AND (property_id IS NULL OR public.can_access_property(property_id)));
CREATE POLICY "documents_delete" ON public.documents
  FOR DELETE USING (public.can_write_page(org_id, 'Documents') AND (property_id IS NULL OR public.can_access_property(property_id)));

CREATE POLICY "gl_accounts_select" ON public.gl_accounts
  FOR SELECT USING (public.can_read_page(org_id, 'ChartOfAccounts'));
CREATE POLICY "gl_accounts_insert" ON public.gl_accounts
  FOR INSERT WITH CHECK (public.can_write_page(org_id, 'ChartOfAccounts'));
CREATE POLICY "gl_accounts_update" ON public.gl_accounts
  FOR UPDATE USING (public.can_write_page(org_id, 'ChartOfAccounts')) WITH CHECK (public.can_write_page(org_id, 'ChartOfAccounts'));
CREATE POLICY "gl_accounts_delete" ON public.gl_accounts
  FOR DELETE USING (public.can_write_page(org_id, 'ChartOfAccounts'));

CREATE POLICY "cam_calculations_select" ON public.cam_calculations
  FOR SELECT USING (property_id IS NULL OR public.can_access_property(property_id));
CREATE POLICY "cam_calculations_insert" ON public.cam_calculations
  FOR INSERT WITH CHECK (public.can_write_page(org_id, 'CAMCalculation') AND (property_id IS NULL OR public.can_access_property(property_id)));
CREATE POLICY "cam_calculations_update" ON public.cam_calculations
  FOR UPDATE USING (public.can_write_page(org_id, 'CAMCalculation') AND (property_id IS NULL OR public.can_access_property(property_id)))
  WITH CHECK (public.can_write_page(org_id, 'CAMCalculation') AND (property_id IS NULL OR public.can_access_property(property_id)));
CREATE POLICY "cam_calculations_delete" ON public.cam_calculations
  FOR DELETE USING (public.can_write_page(org_id, 'CAMCalculation') AND (property_id IS NULL OR public.can_access_property(property_id)));

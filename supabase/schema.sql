-- ============================================================
-- CRE Financial Suite — Supabase Schema
-- Profiles, Organizations, Memberships, Access Requests
-- + Row-Level Security (RLS) policies
-- ============================================================
--
-- IMPORTANT:
-- This file is the foundational auth + tenancy schema, not the complete
-- production contract. The app also depends on later additive migrations for
-- business tables, uploaded_files observability, pipeline_logs, scoped access,
-- and membership permission JSON.
--
-- Review these migrations before changing schema-dependent code:
--   - 20260322_add_core_tables.sql
--   - 202604010146112_pipeline_uploaded_files.sql
--   - 202604080146114_enterprise_schema.sql
--   - 20260422000200_enterprise_access_control.sql
--   - later uploaded_files review/scope migrations
--
-- Phase 1 note:
-- Do not treat schema.sql as the sole source of truth for uploaded_files,
-- pipeline_logs, audit visibility, or scoped-access behavior.

-- 1. PROFILES — user identity only (no role, no org_id)
CREATE TABLE IF NOT EXISTS public.profiles (
  id                  UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email               TEXT UNIQUE NOT NULL,
  full_name           TEXT,
  avatar_url          TEXT,
  onboarding_complete BOOLEAN DEFAULT FALSE,
  -- 'owner' = created the org (goes through full onboarding)
  -- 'invited' = added by admin (skips onboarding entirely)
  onboarding_type     TEXT DEFAULT 'owner',
  first_login         BOOLEAN DEFAULT TRUE,
  status              TEXT DEFAULT 'pending_approval',
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now()
);

-- For existing databases: add the columns if they don't exist
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS onboarding_type TEXT DEFAULT 'owner';
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS first_login BOOLEAN DEFAULT TRUE;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending_approval';


ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Users can read their own profile
CREATE POLICY "profiles_select_own" ON public.profiles
  FOR SELECT USING (auth.uid() = id);

-- Users can update their own profile
CREATE POLICY "profiles_update_own" ON public.profiles
  FOR UPDATE USING (auth.uid() = id);

-- Allow insert during signup (service role or trigger)
CREATE POLICY "profiles_insert_own" ON public.profiles
  FOR INSERT WITH CHECK (auth.uid() = id);

-- Super admins can read all profiles (checked via memberships)
CREATE POLICY "profiles_select_admin" ON public.profiles
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.user_id = auth.uid() AND m.role = 'super_admin'
    )
  );


-- 2. ORGANIZATIONS
CREATE TABLE IF NOT EXISTS public.organizations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  address         TEXT,
  phone           TEXT,
  timezone        TEXT DEFAULT 'America/New_York',
  currency        TEXT DEFAULT 'USD',
  primary_contact_email TEXT,
  plan            TEXT DEFAULT 'starter',       -- starter | professional | enterprise
  status          TEXT DEFAULT 'onboarding',    -- onboarding | under_review | active | suspended
  onboarding_step INT DEFAULT 1,
  enabled_modules TEXT[] DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;

-- Members of org can read their org
DROP POLICY IF EXISTS "orgs_select_members" ON public.organizations;
CREATE POLICY "orgs_select_members" ON public.organizations
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.org_id = organizations.id AND m.user_id = auth.uid()
    )
  );

-- Super admins can read all orgs
DROP POLICY IF EXISTS "orgs_select_admin" ON public.organizations;
CREATE POLICY "orgs_select_admin" ON public.organizations
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.user_id = auth.uid() AND m.role = 'super_admin'
    )
  );

-- Org admins can update their own org
DROP POLICY IF EXISTS "orgs_update_admin" ON public.organizations;
CREATE POLICY "orgs_update_admin" ON public.organizations
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.org_id = organizations.id AND m.user_id = auth.uid()
        AND m.role IN ('org_admin', 'super_admin')
    )
  );

-- Allow insert (for onboarding)
DROP POLICY IF EXISTS "orgs_insert" ON public.organizations;
CREATE POLICY "orgs_insert_authenticated" ON public.organizations
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);


-- ============================================================
-- HELPER FUNCTIONS (SECURITY DEFINER — bypass RLS for role checks only)
-- These return scalar values, not row data — no data leak risk.
-- ============================================================

-- Returns TRUE if the current auth user has role = 'super_admin'
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.memberships
    WHERE user_id = auth.uid() AND role = 'super_admin'
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Returns the set of org_ids the current auth user belongs to
CREATE OR REPLACE FUNCTION public.get_my_org_ids()
RETURNS SETOF UUID AS $$
  SELECT org_id FROM public.memberships
  WHERE user_id = auth.uid() AND org_id IS NOT NULL;
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Returns TRUE if the caller is org_admin (or super_admin) for a given org
CREATE OR REPLACE FUNCTION public.is_org_admin(check_org_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.memberships
    WHERE user_id = auth.uid()
      AND (role = 'super_admin' OR (role = 'org_admin' AND org_id = check_org_id))
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Returns TRUE if the caller can write to a given org's data
CREATE OR REPLACE FUNCTION public.can_write_org_data(check_org_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.memberships
    WHERE user_id = auth.uid()
      AND org_id = check_org_id
      AND role IN ('super_admin', 'org_admin', 'manager', 'editor')
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;


-- 3. MEMBERSHIPS — the ONLY place roles live
CREATE TABLE IF NOT EXISTS public.memberships (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  org_id              UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
  role                TEXT NOT NULL DEFAULT 'viewer',
  -- Roles: super_admin | org_admin | manager | editor | viewer
  assigned_portfolios TEXT[] DEFAULT '{}',
  assigned_owners     TEXT[] DEFAULT '{}',
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, org_id)
);

ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;

-- ── SELECT policies (no recursion) ──────────────────────────

-- 1. Users can always read their OWN membership rows
CREATE POLICY "memberships_select_own" ON public.memberships
  FOR SELECT USING (user_id = auth.uid());

-- 2. Users can read memberships of others in their same org(s)
CREATE POLICY "memberships_select_org" ON public.memberships
  FOR SELECT USING (org_id = ANY(SELECT public.get_my_org_ids()));

-- 3. Super admins can read ALL memberships
CREATE POLICY "memberships_select_admin" ON public.memberships
  FOR SELECT USING (public.is_super_admin());

-- ── INSERT policy ───────────────────────────────────────────
-- Org admins can add members to their own org; super admins to any org.
-- Also allow users to insert their own first membership (for onboarding org creation).
DROP POLICY IF EXISTS "memberships_insert" ON public.memberships;

CREATE POLICY "memberships_insert_secure" ON public.memberships
  FOR INSERT WITH CHECK (
    -- Case 1: Admin-initiated invite — org_admin or super_admin can assign any role
    public.is_org_admin(org_id)
    OR (
      -- Case 2: Self-registration during onboarding — user creates their OWN membership
      -- but ONLY with 'org_admin' role (the org creator role) and ONLY if they
      -- don't already have a membership in that org.
      user_id = auth.uid()
      AND role = 'org_admin'
      AND NOT EXISTS (
        SELECT 1 FROM public.memberships m
        WHERE m.user_id = auth.uid() AND m.org_id = memberships.org_id
      )
    )
  );

-- ── UPDATE policy ───────────────────────────────────────────
CREATE POLICY "memberships_update_admin" ON public.memberships
  FOR UPDATE USING (public.is_org_admin(org_id));

-- ── DELETE policy ───────────────────────────────────────────
CREATE POLICY "memberships_delete_admin" ON public.memberships
  FOR DELETE USING (public.is_org_admin(org_id));


-- 4. ACCESS REQUESTS — public insert, admin-only read
CREATE TABLE IF NOT EXISTS public.access_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name       TEXT NOT NULL,
  email           TEXT NOT NULL,
  company_name    TEXT NOT NULL,
  role            TEXT,
  property_count  TEXT,
  status          TEXT DEFAULT 'pending_approval',  -- pending_approval | approved | rejected
  approved_by     UUID REFERENCES public.profiles(id),
  requested_at    TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.access_requests ENABLE ROW LEVEL SECURITY;

-- Anyone can insert (public form)
CREATE POLICY "access_requests_insert_public" ON public.access_requests
  FOR INSERT WITH CHECK (true);

-- Only super admins can read
CREATE POLICY "access_requests_select_admin" ON public.access_requests
  FOR SELECT USING (public.is_super_admin());

-- Only super admins can update (approve/reject)
CREATE POLICY "access_requests_update_admin" ON public.access_requests
  FOR UPDATE USING (public.is_super_admin());


-- 5. INVITATIONS
CREATE TABLE IF NOT EXISTS public.invitations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT NOT NULL,
  org_id          UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL DEFAULT 'viewer',
  token           TEXT UNIQUE NOT NULL,
  status          TEXT DEFAULT 'pending_approval',  -- pending_approval | accepted | expired | revoked
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- Ensure a user can only have ONE pending invite per organization
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_pending_invite ON public.invitations(email, org_id) WHERE status = 'pending_approval';

ALTER TABLE public.invitations ENABLE ROW LEVEL SECURITY;

-- Org Admins can read their org's invitations
CREATE POLICY "invitations_select_org_admin" ON public.invitations
  FOR SELECT USING (public.is_org_admin(org_id));

-- Super Admins can read all invitations
CREATE POLICY "invitations_select_super_admin" ON public.invitations
  FOR SELECT USING (public.is_super_admin());

-- Org Admins can insert/update for their org
CREATE POLICY "invitations_insert_org_admin" ON public.invitations
  FOR INSERT WITH CHECK (public.is_org_admin(org_id));
  
CREATE POLICY "invitations_update_org_admin" ON public.invitations
  FOR UPDATE USING (public.is_org_admin(org_id));


-- ============================================================
-- TRIGGER: Auto-create profile on signup
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, onboarding_type, onboarding_complete, first_login, status)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
    COALESCE(NEW.raw_user_meta_data->>'onboarding_type', 'owner'),
    -- Invited users are already onboarded — they skip the flow
    CASE WHEN (NEW.raw_user_meta_data->>'onboarding_type') = 'invited' THEN TRUE ELSE FALSE END,
    TRUE,
    'approved'
  )
  ON CONFLICT (id) DO UPDATE
    SET
      full_name        = COALESCE(EXCLUDED.full_name, profiles.full_name),
      onboarding_type  = COALESCE(EXCLUDED.onboarding_type, profiles.onboarding_type),
      status           = 'approved',
      onboarding_complete = CASE
        WHEN EXCLUDED.onboarding_type = 'invited' THEN TRUE
        ELSE profiles.onboarding_complete
      END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_memberships_user_id ON public.memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_org_id ON public.memberships(org_id);
CREATE INDEX IF NOT EXISTS idx_memberships_role ON public.memberships(role);
CREATE INDEX IF NOT EXISTS idx_access_requests_status ON public.access_requests(status);

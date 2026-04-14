-- Migration: 20260321_create_organizations.sql
-- Description: Creates the baseline organizations, profiles, memberships, and access_requests tables,
-- plus foundational security functions used by RLS policies.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Organizations
CREATE TABLE IF NOT EXISTS public.organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  primary_contact_email TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Profiles (links auth.users to an application profile)
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT UNIQUE NOT NULL,
  full_name TEXT,
  role TEXT DEFAULT 'user',
  onboarding_type TEXT, -- Added to satisfy 20260410 dependency
  onboarding_complete BOOLEAN DEFAULT FALSE, -- Added to satisfy 20260410 dependency
  first_login BOOLEAN DEFAULT TRUE, -- Added to satisfy 20260410 dependency
  dashboard_viewed BOOLEAN DEFAULT FALSE, -- Added to satisfy 20260410 dependency
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 3. Memberships (many-to-many link between orgs and profiles)
CREATE TABLE IF NOT EXISTS public.memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  role TEXT DEFAULT 'member', -- owner, org_admin, member, super_admin
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, org_id)
);

-- Compatibility view for legacy/downstream migrations
CREATE OR REPLACE VIEW public.user_organizations AS
SELECT 
  id,
  user_id,
  org_id,
  role,
  created_at,
  updated_at
FROM public.memberships;

-- 4. INVITATIONS
CREATE TABLE IF NOT EXISTS public.invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT DEFAULT 'user',
  status TEXT DEFAULT 'pending',
  invited_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 6. USER ROLES (Legacy RBAC support)
CREATE TABLE IF NOT EXISTS public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, role)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_memberships_user ON public.memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_org ON public.memberships(org_id);
CREATE INDEX IF NOT EXISTS idx_invitations_email ON public.invitations(email);
CREATE INDEX IF NOT EXISTS idx_user_roles_user ON public.user_roles(user_id);

-- 5. Access Requests
CREATE TABLE IF NOT EXISTS public.access_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  full_name TEXT,
  company_name TEXT,
  phone TEXT,
  role TEXT,
  portfolios TEXT,
  properties_count TEXT,
  property_count TEXT,
  plan TEXT,
  billing_cycle TEXT,
  request_type TEXT DEFAULT 'access',
  status TEXT DEFAULT 'pending_approval',
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 5. Baseline Security Functions (Satisfies 20260322 dependencies)
-- Standardizing on SETOF UUID to be consistent with downstream migrations (20260404, etc.)
-- Policies in 20260322 will be refactored to use IN (SELECT ...) instead of ANY().

CREATE OR REPLACE FUNCTION public.get_my_org_ids()
RETURNS SETOF UUID AS $$
  SELECT org_id FROM public.memberships
  WHERE user_id = auth.uid() AND org_id IS NOT NULL;
$$ LANGUAGE sql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.can_write_org_data(check_org_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.memberships
    WHERE user_id = auth.uid()
      AND org_id = check_org_id
      AND role IN ('org_admin', 'manager', 'editor', 'super_admin')
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.is_org_admin(check_org_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.memberships
    WHERE user_id = auth.uid()
      AND (role = 'super_admin' OR (role = 'org_admin' AND org_id = check_org_id))
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.memberships
    WHERE user_id = auth.uid() AND role = 'super_admin'
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

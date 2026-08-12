-- Fix team-member invite persistence.
--
-- The previous memberships_role_check still allowed only legacy roles
-- (manager/editor/viewer/etc.), which rejected canonical CRE roles such as
-- portfolio_manager during team invites. Normalize existing legacy rows, then
-- replace the constraint with the canonical role set.

CREATE OR REPLACE FUNCTION public.cre_normalize_role(p_role text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE lower(COALESCE(p_role, ''))
    WHEN 'super_admin' THEN 'super_admin'
    WHEN 'owner' THEN 'org_owner'
    WHEN 'org_owner' THEN 'org_owner'
    WHEN 'admin' THEN 'org_admin'
    WHEN 'org_admin' THEN 'org_admin'
    WHEN 'manager' THEN 'property_manager'
    WHEN 'editor' THEN 'lease_admin'
    WHEN 'viewer' THEN 'auditor'
    WHEN 'read_only' THEN 'auditor'
    WHEN 'asset_manager' THEN 'portfolio_manager'
    WHEN 'portfolio_manager' THEN 'portfolio_manager'
    WHEN 'operations_director' THEN 'portfolio_manager'
    WHEN 'facility_manager' THEN 'property_manager'
    WHEN 'construction_manager' THEN 'property_manager'
    WHEN 'property_manager' THEN 'property_manager'
    WHEN 'lease_admin' THEN 'lease_admin'
    WHEN 'leasing_agent' THEN 'leasing_agent'
    WHEN 'leasing_director' THEN 'lease_admin'
    WHEN 'finance' THEN 'finance'
    WHEN 'cfo' THEN 'finance'
    WHEN 'controller' THEN 'finance'
    WHEN 'cfo_controller' THEN 'finance'
    WHEN 'financial_analyst' THEN 'finance'
    WHEN 'accounts_manager' THEN 'finance'
    WHEN 'property_owner' THEN 'property_owner'
    WHEN 'auditor' THEN 'auditor'
    WHEN 'compliance_officer' THEN 'auditor'
    WHEN 'internal_auditor' THEN 'auditor'
    WHEN 'tenant' THEN 'tenant'
    WHEN 'custom' THEN 'custom_role'
    WHEN 'custom_role' THEN 'custom_role'
    ELSE NULL
  END;
$$;

ALTER TABLE public.memberships
  DROP CONSTRAINT IF EXISTS memberships_role_check;

UPDATE public.memberships
SET role = COALESCE(public.cre_normalize_role(role), 'custom_role'),
    updated_at = now()
WHERE role IS DISTINCT FROM COALESCE(public.cre_normalize_role(role), 'custom_role');

ALTER TABLE public.memberships
  ADD CONSTRAINT memberships_role_check
  CHECK (role IN (
    'super_admin',
    'org_owner',
    'org_admin',
    'portfolio_manager',
    'property_manager',
    'lease_admin',
    'leasing_agent',
    'finance',
    'property_owner',
    'auditor',
    'tenant',
    'custom_role'
  ));

ALTER TABLE public.memberships
  DROP CONSTRAINT IF EXISTS memberships_role_check;

ALTER TABLE public.memberships
  ADD CONSTRAINT memberships_role_check
  CHECK (role IN (
    'super_admin',
    'org_admin',
    'manager',
    'editor',
    'viewer',
    'finance',
    'auditor'
  ));

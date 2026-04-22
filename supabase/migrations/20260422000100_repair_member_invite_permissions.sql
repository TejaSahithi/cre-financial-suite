-- Ensure invited-member metadata and page permissions can actually persist.
-- Some environments were missing these columns, causing invite-user to fall
-- back to a bare membership row with role only and no page access details.

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS last_sign_in_at TIMESTAMPTZ;

ALTER TABLE public.memberships ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';
ALTER TABLE public.memberships ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE public.memberships ADD COLUMN IF NOT EXISTS custom_role TEXT;
ALTER TABLE public.memberships ADD COLUMN IF NOT EXISTS module_permissions JSONB DEFAULT '{}'::jsonb;
ALTER TABLE public.memberships ADD COLUMN IF NOT EXISTS page_permissions JSONB DEFAULT '{}'::jsonb;
ALTER TABLE public.memberships ADD COLUMN IF NOT EXISTS capabilities JSONB DEFAULT '{}'::jsonb;

UPDATE public.memberships
SET
  page_permissions = COALESCE(page_permissions, '{}'::jsonb),
  module_permissions = COALESCE(module_permissions, '{}'::jsonb),
  capabilities = COALESCE(capabilities, '{}'::jsonb),
  status = COALESCE(status, 'active')
WHERE
  page_permissions IS NULL
  OR module_permissions IS NULL
  OR capabilities IS NULL
  OR status IS NULL;

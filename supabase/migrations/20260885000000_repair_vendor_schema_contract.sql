-- Repair the hosted vendors table to match the application Vendor payload contract.
-- Earlier migration used CREATE TABLE IF NOT EXISTS, so existing deployments kept
-- the old narrow vendors table and rejected company/payment_terms during create.

ALTER TABLE public.vendors
  ADD COLUMN IF NOT EXISTS company TEXT,
  ADD COLUMN IF NOT EXISTS contact_name TEXT,
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS phone TEXT,
  ADD COLUMN IF NOT EXISTS category TEXT,
  ADD COLUMN IF NOT EXISTS payment_terms TEXT DEFAULT 'net_30',
  ADD COLUMN IF NOT EXISTS tax_id TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS rating NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

UPDATE public.vendors
SET
  payment_terms = COALESCE(NULLIF(payment_terms, ''), 'net_30'),
  status = COALESCE(NULLIF(status, ''), 'active'),
  rating = COALESCE(rating, 0),
  created_at = COALESCE(created_at, now()),
  updated_at = COALESCE(updated_at, now());

ALTER TABLE public.vendors
  ALTER COLUMN payment_terms SET DEFAULT 'net_30',
  ALTER COLUMN status SET DEFAULT 'active',
  ALTER COLUMN rating SET DEFAULT 0,
  ALTER COLUMN created_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET DEFAULT now();

CREATE INDEX IF NOT EXISTS vendors_org_id_idx ON public.vendors(org_id);
CREATE INDEX IF NOT EXISTS vendors_org_name_idx ON public.vendors(org_id, name);

NOTIFY pgrst, 'reload schema';
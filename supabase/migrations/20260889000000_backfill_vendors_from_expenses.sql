-- Backfill Vendor Management from existing actual expenses.
--
-- Some invoice/manual expense rows carried only a text vendor/vendor_name with
-- no vendors row and no vendor_id. Vendor Management reads public.vendors, so
-- those extracted vendors were invisible even though Actual Expenses displayed
-- the vendor text. This migration is idempotent: it creates one vendor per
-- org/name when missing, then links matching expense rows back to vendors.id.

WITH expense_vendor_names AS (
  SELECT
    e.org_id,
    trim(COALESCE(NULLIF(e.vendor_name, ''), NULLIF(e.vendor, ''))) AS vendor_name
  FROM public.expenses e
  WHERE e.org_id IS NOT NULL
    AND trim(COALESCE(NULLIF(e.vendor_name, ''), NULLIF(e.vendor, ''))) <> ''
), distinct_expense_vendors AS (
  SELECT DISTINCT org_id, vendor_name
  FROM expense_vendor_names
)
INSERT INTO public.vendors (org_id, name, company, category, payment_terms, status)
SELECT
  ev.org_id,
  ev.vendor_name,
  ev.vendor_name,
  'other',
  'net_30',
  'active'
FROM distinct_expense_vendors ev
WHERE NOT EXISTS (
  SELECT 1
  FROM public.vendors v
  WHERE v.org_id = ev.org_id
    AND lower(trim(v.name)) = lower(trim(ev.vendor_name))
);

UPDATE public.expenses e
SET vendor_id = v.id,
    vendor_name = v.name,
    vendor = v.name,
    updated_at = now()
FROM public.vendors v
WHERE e.org_id = v.org_id
  AND e.vendor_id IS NULL
  AND trim(COALESCE(NULLIF(e.vendor_name, ''), NULLIF(e.vendor, ''))) <> ''
  AND lower(trim(COALESCE(NULLIF(e.vendor_name, ''), NULLIF(e.vendor, '')))) = lower(trim(v.name));

NOTIFY pgrst, 'reload schema';

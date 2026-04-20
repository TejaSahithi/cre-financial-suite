-- Additive support for detailed property imports from DOCX/PDF/image documents.
-- Existing UI/service code already supports the other enriched property columns.

ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS leased_sf NUMERIC DEFAULT 0;

ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS acquired_date DATE,
  ADD COLUMN IF NOT EXISTS parcel_tax_id TEXT,
  ADD COLUMN IF NOT EXISTS phone TEXT,
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS parking_spaces NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS amenities TEXT,
  ADD COLUMN IF NOT EXISTS insurance_policy TEXT;

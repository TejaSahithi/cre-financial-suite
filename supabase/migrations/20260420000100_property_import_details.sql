-- Additive support for detailed property imports from DOCX/PDF/image documents.
-- Existing UI/service code already supports the other enriched property columns.

ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS leased_sf NUMERIC DEFAULT 0;


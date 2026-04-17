-- Carry selected building/unit scope through the canonical upload pipeline.
-- This is additive and safe for existing uploaded files.

ALTER TABLE public.uploaded_files
  ADD COLUMN IF NOT EXISTS building_id UUID REFERENCES public.buildings(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS unit_id UUID REFERENCES public.units(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_uploaded_files_building_scope
  ON public.uploaded_files (org_id, building_id)
  WHERE building_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_uploaded_files_unit_scope
  ON public.uploaded_files (org_id, unit_id)
  WHERE unit_id IS NOT NULL;

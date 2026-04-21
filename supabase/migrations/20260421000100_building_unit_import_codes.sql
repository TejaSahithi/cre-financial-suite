-- Add business identifiers used by document/bulk imports to resolve hierarchy.
-- These are additive and safe for existing rows.

ALTER TABLE public.buildings
  ADD COLUMN IF NOT EXISTS building_id_code TEXT;

ALTER TABLE public.units
  ADD COLUMN IF NOT EXISTS unit_id_code TEXT,
  ADD COLUMN IF NOT EXISTS bedroom_bathroom TEXT;

CREATE INDEX IF NOT EXISTS idx_buildings_org_building_code
  ON public.buildings (org_id, building_id_code)
  WHERE building_id_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_units_org_unit_code
  ON public.units (org_id, unit_id_code)
  WHERE unit_id_code IS NOT NULL;

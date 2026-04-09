-- Fix unique constraints for CAM config tables and cam_calculations.
--
-- Problem:
--   property_config had UNIQUE(property_id) and lease_config had UNIQUE(lease_id),
--   but the application upserts with onConflict: "org_id,property_id" / "org_id,lease_id".
--   cam_calculations had no unique constraint but upserts on "org_id,property_id,fiscal_year".
--
-- Solution:
--   Replace single-column unique constraints with multi-column ones that include org_id.
--   Use NULLS NOT DISTINCT so that NULL values don't bypass the constraint.
-- Safe to run multiple times.

-- ── property_config ──────────────────────────────────────────────────────
-- Drop the old single-column unique constraint (may have been created inline or as named)
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.property_config'::regclass
      AND contype = 'u'
      AND array_length(conkey, 1) = 1
  ) THEN
    EXECUTE (
      SELECT 'ALTER TABLE public.property_config DROP CONSTRAINT ' || quote_ident(conname)
      FROM pg_constraint
      WHERE conrelid = 'public.property_config'::regclass
        AND contype = 'u'
        AND array_length(conkey, 1) = 1
      LIMIT 1
    );
  END IF;
END $$;

ALTER TABLE public.property_config
  ADD CONSTRAINT property_config_org_property_key
  UNIQUE NULLS NOT DISTINCT (org_id, property_id);

-- ── lease_config ─────────────────────────────────────────────────────────
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.lease_config'::regclass
      AND contype = 'u'
      AND array_length(conkey, 1) = 1
  ) THEN
    EXECUTE (
      SELECT 'ALTER TABLE public.lease_config DROP CONSTRAINT ' || quote_ident(conname)
      FROM pg_constraint
      WHERE conrelid = 'public.lease_config'::regclass
        AND contype = 'u'
        AND array_length(conkey, 1) = 1
      LIMIT 1
    );
  END IF;
END $$;

ALTER TABLE public.lease_config
  ADD CONSTRAINT lease_config_org_lease_key
  UNIQUE NULLS NOT DISTINCT (org_id, lease_id);

-- ── cam_calculations ─────────────────────────────────────────────────────
-- compute-cam upserts with onConflict: "org_id,property_id,fiscal_year"
-- Add the missing unique constraint.
ALTER TABLE public.cam_calculations
  ADD CONSTRAINT cam_calculations_org_property_year_key
  UNIQUE NULLS NOT DISTINCT (org_id, property_id, fiscal_year);

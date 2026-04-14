-- Fix CAM module: unique constraints + RLS policies for config tables.
-- Safe to run multiple times (idempotent).
--
-- Problems fixed:
--   1. property_config had UNIQUE(property_id) but code upserts on (org_id, property_id)
--   2. lease_config had UNIQUE(lease_id) but code upserts on (org_id, lease_id)
--   3. cam_calculations had no unique constraint but code upserts on (org_id, property_id, fiscal_year)
--   4. property_config and lease_config RLS policies lacked is_super_admin() bypass
--      (core tables got this in 20260408, but config tables were missed)

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 1: Fix unique constraints for ON CONFLICT support
-- ═══════════════════════════════════════════════════════════════════════════

-- ── property_config ──────────────────────────────────────────────────────
-- Drop old single-column unique constraint (created inline as UNIQUE(property_id))
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

-- Add multi-column unique constraint if it doesn't already exist
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.property_config'::regclass
      AND conname = 'property_config_org_property_key'
  ) THEN
    ALTER TABLE public.property_config
      ADD CONSTRAINT property_config_org_property_key
      UNIQUE NULLS NOT DISTINCT (org_id, property_id);
  END IF;
END $$;

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

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.lease_config'::regclass
      AND conname = 'lease_config_org_lease_key'
  ) THEN
    ALTER TABLE public.lease_config
      ADD CONSTRAINT lease_config_org_lease_key
      UNIQUE NULLS NOT DISTINCT (org_id, lease_id);
  END IF;
END $$;

-- ── cam_calculations ─────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.cam_calculations'::regclass
      AND conname = 'cam_calculations_org_property_year_key'
  ) THEN
    ALTER TABLE public.cam_calculations
      ADD CONSTRAINT cam_calculations_org_property_year_key
      UNIQUE NULLS NOT DISTINCT (org_id, property_id, fiscal_year);
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- PART 2: Fix RLS policies for property_config and lease_config
--
-- The core tables (properties, leases, expenses, etc.) got is_super_admin()
-- bypass in 20260408_apply_all_missing_v2.sql, but property_config and
-- lease_config still use the original policies from 20260402_config_tables.sql
-- which do NOT pass for super_admins without an explicit org membership.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── property_config RLS ──────────────────────────────────────────────────
DROP POLICY IF EXISTS "property_config_select" ON public.property_config;
DROP POLICY IF EXISTS "property_config_insert" ON public.property_config;
DROP POLICY IF EXISTS "property_config_update" ON public.property_config;
DROP POLICY IF EXISTS "property_config_delete" ON public.property_config;

CREATE POLICY "property_config_select" ON public.property_config
  FOR SELECT USING (
    public.is_super_admin()
    OR org_id = ANY(public.get_my_org_ids())
  );

CREATE POLICY "property_config_insert" ON public.property_config
  FOR INSERT WITH CHECK (
    public.is_super_admin()
    OR public.can_write_org_data(org_id)
  );

CREATE POLICY "property_config_update" ON public.property_config
  FOR UPDATE USING (
    public.is_super_admin()
    OR public.can_write_org_data(org_id)
  );

CREATE POLICY "property_config_delete" ON public.property_config
  FOR DELETE USING (
    public.is_super_admin()
    OR public.is_org_admin(org_id)
  );

-- ── lease_config RLS ─────────────────────────────────────────────────────
DROP POLICY IF EXISTS "lease_config_select" ON public.lease_config;
DROP POLICY IF EXISTS "lease_config_insert" ON public.lease_config;
DROP POLICY IF EXISTS "lease_config_update" ON public.lease_config;
DROP POLICY IF EXISTS "lease_config_delete" ON public.lease_config;

CREATE POLICY "lease_config_select" ON public.lease_config
  FOR SELECT USING (
    public.is_super_admin()
    OR org_id = ANY(public.get_my_org_ids())
  );

CREATE POLICY "lease_config_insert" ON public.lease_config
  FOR INSERT WITH CHECK (
    public.is_super_admin()
    OR public.can_write_org_data(org_id)
  );

CREATE POLICY "lease_config_update" ON public.lease_config
  FOR UPDATE USING (
    public.is_super_admin()
    OR public.can_write_org_data(org_id)
  );

CREATE POLICY "lease_config_delete" ON public.lease_config
  FOR DELETE USING (
    public.is_super_admin()
    OR public.is_org_admin(org_id)
  );

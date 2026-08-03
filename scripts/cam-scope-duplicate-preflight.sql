-- ============================================================
-- CAM scope migration — duplicate preflight report
--
-- Run this against staging/production BEFORE applying
-- 20260901000000_cam_scope_columns.sql, and inspect the output yourself.
-- This script is READ-ONLY (no ALTER/UPDATE/DELETE) — it only reports.
--
-- The migration itself also runs an equivalent check internally and will
-- abort (RAISE EXCEPTION) rather than apply its constraint change if it
-- finds anything here, but running this manually first gives you a
-- reviewable report before you commit to running the migration at all.
--
-- Expected result on any environment consistent with this repo's tracked
-- migration history: zero rows in both result sets below. See the
-- migration file's header comment for why that is expected (existing
-- UNIQUE(org_id, property_id, fiscal_year) + backfill always setting
-- scope_id = property_id makes a new duplicate mathematically impossible
-- for pre-existing rows). If either query returns rows, DO NOT apply the
-- migration — investigate first (see "Remote schema drift" precedent:
-- this project's linked Supabase instance has previously diverged from
-- what migration files alone imply).
-- ============================================================

-- ── 1. cam_calculations: duplicates under the NEW key this migration will
--       constrain (org_id, property_id, scope_level, scope_id, fiscal_year),
--       simulating the backfill (scope_level='property', scope_id=property_id
--       for every existing row) without writing anything.
-- ────────────────────────────────────────────────────────────────────────
SELECT
  org_id,
  property_id,
  'property'::text AS scope_level_after_backfill,
  property_id       AS scope_id_after_backfill,
  fiscal_year,
  COUNT(*)          AS row_count,
  array_agg(id ORDER BY created_at) AS row_ids
FROM public.cam_calculations
GROUP BY org_id, property_id, fiscal_year
HAVING COUNT(*) > 1;

-- ── 2. Sanity check: confirm the existing constraint this migration
--       depends on is actually present (if this returns zero rows, the
--       schema has already diverged from what this migration assumes —
--       stop and investigate rather than proceeding).
-- ────────────────────────────────────────────────────────────────────────
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.cam_calculations'::regclass
  AND conname = 'cam_calculations_org_property_year_key';

-- ── 3. Informational only: how many computation_snapshots rows exist per
--       property_id / engine_type / fiscal_year today. computation_snapshots
--       has no unique constraint (append-only history model — see migration
--       comment), so this is not a blocking check, just useful context for
--       how much data the backfill in step 2 of the migration will touch.
-- ────────────────────────────────────────────────────────────────────────
SELECT engine_type, COUNT(*) AS row_count,
       COUNT(*) FILTER (WHERE property_id IS NULL) AS org_level_rows_left_unscoped
FROM public.computation_snapshots
GROUP BY engine_type
ORDER BY engine_type;

-- ===========================================================================
-- CAM Legacy Repair (forward-only) — Part 2: drop the recreated
-- public.cam_profiles shell.
--
-- Root cause: migration 20269900000029_archive_legacy_cam_objects.sql
-- correctly renamed public.cam_profiles -> public.legacy_cam_profiles as
-- part of the deliberate CAM V2 archival. Migration
-- 20269900000034_repair_lease_workflow_abstraction_drift.sql, written to
-- repair unrelated schema drift on public.leases, re-ran an older
-- migration's CREATE TABLE IF NOT EXISTS public.cam_profiles verbatim
-- without accounting for the intentional rename five migrations earlier —
-- recreating an empty, orphaned public.cam_profiles table alongside the
-- real (also empty) public.legacy_cam_profiles archive. Both tables were
-- confirmed to have zero rows against the linked project before this
-- migration was written, so no data-copy step is required or performed
-- here.
--
-- This migration must only be applied after:
--   1. Every active application caller of public.cam_profiles has been cut
--      over to a CAM V2 canonical source or retired (see the accompanying
--      code changes in the same change set: approve-cam-profile,
--      save-cam-profile, ApprovalWorkflows.jsx, AdminControlSurfaces.jsx,
--      BudgetPreviewTabs.jsx, ChargeScheduleAndPreview.jsx,
--      approved-lease-expense-rules.ts).
--   2. A repo-wide dependency scan confirms zero remaining runtime
--      references to public.cam_profiles outside this migration file and
--      the archival migrations (28/29/34) themselves.
--
-- public.legacy_cam_profiles and public.legacy_cam_calculations are NOT
-- touched here -- they remain, read-only (INSERT/UPDATE/DELETE already
-- revoked by migration 29), as the retained archive for the observation
-- period.
-- ===========================================================================

DO $$
DECLARE
  v_row_count INT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'cam_profiles'
  ) THEN
    EXECUTE 'SELECT COUNT(*) FROM public.cam_profiles' INTO v_row_count;

    IF v_row_count > 0 THEN
      RAISE EXCEPTION 'Refusing to drop public.cam_profiles: table has % row(s). Investigate before dropping (expected 0, verified empty when this migration was authored).', v_row_count;
    END IF;

    DROP TABLE public.cam_profiles;
  END IF;
END $$;

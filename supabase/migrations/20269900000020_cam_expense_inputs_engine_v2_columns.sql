-- ===========================================================================
-- Enterprise CAM & Budget Implementation Blueprint v1.0 — Phase 3B-D bugfix,
-- found by the first real database -> engine -> ledger end-to-end test.
--
-- Phase 2 Correction 4 designed CamExpenseInputRow (the pure engine's
-- input contract) to read variability/controllability/service_period_start/
-- service_period_end directly off cam_expense_inputs — but no migration
-- ever actually added those columns to that (pre-existing, production)
-- table. The contract was correct in isolation (unit/golden tests all
-- construct these fields by hand) but was never wired against the real
-- table until build-cam-run-input-v2 tried to read it, which is exactly
-- the class of gap synthetic fixtures cannot catch and real-data
-- end-to-end tests exist to find.
--
-- No backfill of service_period_start/end: per this phase's own backfill
-- principle ("never invent missing historical dates or values"), existing
-- published inputs are left with NULL service periods. That is not a
-- silent gap — pools/pool-builder.ts::assembleSegmentAmounts already
-- treats a missing service period as a blocking
-- EXPENSE_SERVICE_PERIOD_MISSING exception, so an unset row surfaces as a
-- calculation-blocking exception the next time it's actually assigned to
-- a pool, not as a silently-wrong prorated amount.
-- ===========================================================================

ALTER TABLE public.cam_expense_inputs
  ADD COLUMN IF NOT EXISTS variability TEXT NOT NULL DEFAULT 'unknown'
    CHECK (variability IN ('fixed', 'variable', 'semi_variable', 'unknown')),
  ADD COLUMN IF NOT EXISTS controllability TEXT NOT NULL DEFAULT 'unknown'
    CHECK (controllability IN ('controllable', 'uncontrollable', 'unknown')),
  ADD COLUMN IF NOT EXISTS service_period_start DATE,
  ADD COLUMN IF NOT EXISTS service_period_end DATE,
  ADD CONSTRAINT cam_expense_inputs_service_period_order_check
    CHECK (service_period_start IS NULL OR service_period_end IS NULL OR service_period_end >= service_period_start);

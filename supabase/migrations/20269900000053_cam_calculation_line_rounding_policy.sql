-- ===========================================================================
-- CAM Enhancement and Budget Readiness Specification v2.0 — sections 21.18
-- and 22: a calculation line must disclose the rounding policy that actually
-- produced it, not merely the numbers.
--
-- cam_run_calculation_lines already carries unrounded_aggregate,
-- rounding_scope, rounded_amount and rounding_residual (migration
-- 20269900000024), and persist_cam_run_results already reads all four from the
-- engine payload. The one missing element is the POLICY in force.
--
-- This is denormalised onto each line by trigger rather than by widening
-- persist_cam_run_results, deliberately:
--   * that function is long and financially critical; re-emitting it wholesale
--     to add one column is a far larger blast radius than a focused trigger;
--   * the value is not a free parameter — it is exactly the parent run's
--     rounding policy, so deriving it from cam_runs cannot disagree with the
--     run, whereas a second copy passed through the payload could;
--   * it applies to lines written by any current or future writer.
--
-- The column is immutable in practice: it is only ever set on INSERT from the
-- parent run, and posted runs are already protected by
-- enforce_cam_run_immutability.
-- ===========================================================================

ALTER TABLE public.cam_run_calculation_lines
  ADD COLUMN IF NOT EXISTS rounding_policy JSONB;

COMMENT ON COLUMN public.cam_run_calculation_lines.rounding_policy IS
  'The rounding policy in force for the parent run, frozen onto the line at '
  'insert (specification 21.18/22). Includes internal_decimal_places, '
  'ledger_decimal_places, annual_rounding_scope, estimate_rounding_scope and '
  'residual_allocation. NULL only for lines written before this migration.';

CREATE OR REPLACE FUNCTION public.cam_calculation_line_set_rounding_policy()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_run public.cam_runs%ROWTYPE;
BEGIN
  IF NEW.rounding_policy IS NOT NULL THEN
    RETURN NEW; -- an explicitly supplied policy is never overwritten
  END IF;

  SELECT * INTO v_run FROM public.cam_runs WHERE id = NEW.cam_run_id;
  IF NOT FOUND THEN
    RETURN NEW; -- nothing to derive from; leave NULL rather than invent one
  END IF;

  NEW.rounding_policy := COALESCE(v_run.rounding_policy, '{}'::jsonb)
    -- annual_rounding_scope lives in its own column on cam_runs and is the
    -- authoritative boundary; make sure the frozen copy reflects it.
    || jsonb_build_object(
         'annual_rounding_scope',
         COALESCE(v_run.annual_rounding_scope,
                  v_run.rounding_policy ->> 'annual_rounding_scope',
                  'LEASE_POOL_PERIOD')
       );

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_cam_calculation_line_rounding_policy ON public.cam_run_calculation_lines;
CREATE TRIGGER trg_cam_calculation_line_rounding_policy
  BEFORE INSERT ON public.cam_run_calculation_lines
  FOR EACH ROW
  EXECUTE FUNCTION public.cam_calculation_line_set_rounding_policy();

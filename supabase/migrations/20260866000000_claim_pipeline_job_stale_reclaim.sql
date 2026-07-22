-- Lightweight, lazy stale-job reclaim for claim_pipeline_job
-- (20260824000200_pipeline_jobs_generation_rpcs.sql). Confirmed gap: if a
-- worker invocation crashes or is killed after claiming a job (status
-- flipped to 'running') but before reaching any terminal state, that job
-- stayed 'running' forever -- there is no heartbeat column, no pg_cron in
-- this stack, and no background reaper anywhere in the schema. This is
-- deliberately NOT a full heartbeat/dead-letter subsystem: no new column,
-- no background process. It widens the existing atomic claim predicate to
-- ALSO match a 'running' job whose updated_at is stale (nothing has touched
-- it in 10 minutes), so the very next claim attempt for that job
-- (whenever something next tries -- a retry, a new generation, a manual
-- re-extraction) can pick it back up instead of leaving it stuck forever.
-- Still gated by cancel_requested_at IS NULL and attempt < max_attempts,
-- exactly like the fresh-queued path.

CREATE OR REPLACE FUNCTION public.claim_pipeline_job(
  p_job_id UUID,
  p_worker_name TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_claimed public.pipeline_jobs%ROWTYPE;
BEGIN
  IF p_job_id IS NULL THEN
    RAISE EXCEPTION 'job_id is required';
  END IF;

  UPDATE public.pipeline_jobs
     SET status = 'running',
         started_at = COALESCE(started_at, now()),
         attempt = attempt + 1,
         worker_name = p_worker_name,
         updated_at = now()
   WHERE id = p_job_id
     AND cancel_requested_at IS NULL
     AND attempt < max_attempts
     AND (
       (status = 'queued' AND available_at <= now())
       OR (status = 'running' AND updated_at < now() - interval '10 minutes')
     )
  RETURNING * INTO v_claimed;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN to_jsonb(v_claimed);
END;
$$;

REVOKE ALL ON FUNCTION public.claim_pipeline_job(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_pipeline_job(UUID, TEXT) TO service_role;

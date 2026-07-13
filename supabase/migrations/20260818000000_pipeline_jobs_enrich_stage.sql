-- Adds the "enrich" pipeline_jobs stage: the evidence-attachment + clause-
-- records pass deferred out of normalize-pdf-output's main request so a
-- slow/expensive evidence resolution can never again crash a request that
-- already contains a durable, good minimal review payload (see P0.1 in the
-- "Fix Lease Review extraction readiness" plan).

ALTER TABLE public.pipeline_jobs
  DROP CONSTRAINT IF EXISTS pipeline_jobs_stage_check;

ALTER TABLE public.pipeline_jobs
  ADD CONSTRAINT pipeline_jobs_stage_check
    CHECK (stage IN ('parse', 'normalize', 'review_draft', 'rule_extraction', 'enrich'));

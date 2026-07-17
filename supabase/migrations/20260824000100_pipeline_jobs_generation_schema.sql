-- P0.1: generation-aware job identity for pipeline_jobs/uploaded_files.
-- Part of the Lease Review pipeline-honesty plan
-- (C:\Users\tejas\.claude\plans\think-as-senior-enterprise-elegant-harbor.md).
--
-- Why a generation concept is needed at all: a bare uniqueness constraint on
-- (uploaded_file_id, stage) cannot distinguish an initial extraction from an
-- explicit re-extraction, a new provider/contract version, or a superseding
-- run -- without it, deduping "one active job per stage" would itself become
-- a bug (it would block legitimate re-extraction). generation_id is that
-- missing identity; active_generation_id on uploaded_files is the file's
-- current-generation pointer, advanced only by the dedicated
-- start_lease_extraction_generation RPC added in the next migration.
--
-- This migration only adds the schema and backfills existing rows so the
-- column can become NOT NULL safely. The uniqueness indexes that actually
-- make generation_id protective, and the RPCs that populate/advance it going
-- forward, are added in the next migration (pipeline_jobs_generation_rpcs)
-- -- kept separate so schema/backfill and new-behavior are independently
-- reviewable, matching this repo's established migration-repair convention.
--
-- Depends on 20260824000000_pipeline_jobs_leases_remote_drift_reconciliation.sql
-- having already restored pipeline_jobs.worker_name/counts and both CHECK
-- constraints on the target project -- this migration assumes that shape.

ALTER TABLE public.pipeline_jobs
  ADD COLUMN IF NOT EXISTS generation_id UUID,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

ALTER TABLE public.uploaded_files
  ADD COLUMN IF NOT EXISTS active_generation_id UUID;

-- --- Backfill, in three passes -------------------------------------------
--
-- Pass 1: every row currently queued/running for a given uploaded_file_id
-- shares ONE fresh generation_id. These are the only rows for which correct
-- grouping actually matters operationally going forward (they are what the
-- next migration's uniqueness index protects, and what
-- evaluate_lease_extraction_readiness will read as "the active generation").
WITH active_generations AS (
  SELECT uploaded_file_id, gen_random_uuid() AS new_generation_id
  FROM public.pipeline_jobs
  WHERE status IN ('queued', 'running')
  GROUP BY uploaded_file_id
)
UPDATE public.pipeline_jobs pj
SET generation_id = ag.new_generation_id
FROM active_generations ag
WHERE pj.uploaded_file_id = ag.uploaded_file_id
  AND pj.status IN ('queued', 'running')
  AND pj.generation_id IS NULL;

-- Pass 2: every remaining (terminal: completed/failed/cancelled) row gets
-- its own distinguishable legacy generation_id, one per row. These jobs are
-- not subject to the next migration's uniqueness index (scoped to
-- status IN ('queued','running') only) and nothing downstream needs two
-- historical jobs to share a generation for correctness -- only the active
-- generation's grouping is operationally meaningful. Giving each terminal
-- job its own id is the safe, reversible choice: it avoids collapsing
-- unrelated historical runs into one implied generation while still
-- satisfying the NOT NULL constraint added below. This is a deliberate
-- simplification versus perfectly reconstructing which historical
-- normalize+enrich job pairs belonged to the same real-world run --
-- reconstructing that has no operational consequence for already-terminal
-- jobs and is not attempted here.
UPDATE public.pipeline_jobs
SET generation_id = gen_random_uuid()
WHERE generation_id IS NULL;

-- Pass 3: point uploaded_files.active_generation_id at the file's current
-- generation -- preferring an active (queued/running) job's generation when
-- one exists, otherwise falling back to the most recently created job's
-- (now legacy-assigned) generation, so every file with any pipeline_jobs
-- history ends up with a non-null "current generation" pointer. Files with
-- zero pipeline_jobs rows (e.g. non-lease uploads that never entered this
-- pipeline) are intentionally left with active_generation_id = NULL --
-- there is no generation to point at.
WITH file_generation AS (
  SELECT DISTINCT ON (uploaded_file_id)
    uploaded_file_id,
    generation_id
  FROM public.pipeline_jobs
  ORDER BY
    uploaded_file_id,
    (status IN ('queued', 'running')) DESC,  -- prefer an active job's generation
    created_at DESC
)
UPDATE public.uploaded_files uf
SET active_generation_id = fg.generation_id
FROM file_generation fg
WHERE fg.uploaded_file_id = uf.id
  AND uf.active_generation_id IS NULL;

-- --- Enforce non-null now that every row has a value ---------------------
-- This is what makes the next migration's partial unique index
-- (uploaded_file_id, job_type, stage, generation_id) WHERE status IN
-- ('queued','running') actually protective: SQL NULLs never compare equal
-- to each other, so a unique index over a nullable generation_id would NOT
-- reject two concurrent NULL-generation active jobs for the same file/stage.
ALTER TABLE public.pipeline_jobs
  ALTER COLUMN generation_id SET NOT NULL;

-- --- Widen the status enum to include the real 'superseded' terminal value
-- A job superseded by a newer explicit re-extraction generation must be
-- marked with its own true terminal status, not the previously-used
-- workaround of status='completed' + error_code='SUPERSEDED' (a completed
-- job must never carry an error code) or a forced status='cancelled' while
-- the prior worker invocation may still be executing (flipping a status
-- column does not stop an already-running Edge Function invocation).
ALTER TABLE public.pipeline_jobs
  DROP CONSTRAINT IF EXISTS pipeline_jobs_status_check;
ALTER TABLE public.pipeline_jobs
  ADD CONSTRAINT pipeline_jobs_status_check
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'superseded'))
    NOT VALID;

COMMENT ON COLUMN public.pipeline_jobs.generation_id IS
  'Identifies which extraction generation (initial ingest, or an explicit re-extraction/replay) this job belongs to. Only jobs sharing the active generation (uploaded_files.active_generation_id) are considered for readiness/finalization.';
COMMENT ON COLUMN public.pipeline_jobs.idempotency_key IS
  'Format: lease-extraction:<uploaded_file_id>:<generation_id>:<stage>:<contract_version>. Enforced unique per org by pipeline_jobs_idempotency_unique (added in the next migration).';
COMMENT ON COLUMN public.uploaded_files.active_generation_id IS
  'The file''s current extraction generation. Advanced only by start_lease_extraction_generation. Cleared readiness fields (review_ready_at/review_ready_generation_id) whenever this changes.';

-- P0.0/P0.1 prerequisite for the Lease Review pipeline-honesty plan
-- (C:\Users\tejas\.claude\plans\think-as-senior-enterprise-elegant-harbor.md).
--
-- A read-only audit (supabase db dump --linked vs local, 2026-07-17, see
-- docs/database/migration-repair.md's "2026-07-17" section for the full
-- writeup) found that the linked remote project's live public.pipeline_jobs
-- and public.leases do not match what their own migration history says was
-- applied, even though `supabase migration list --linked` shows every
-- relevant migration (20260610120000_pipeline_jobs.sql,
-- 20260605000000_add_source_file_id_to_leases.sql) as applied. Same
-- "ledger says applied, object doesn't exist" pattern already documented
-- multiple times in migration-repair.md, just newly confirmed for the two
-- tables this plan builds on.
--
-- This migration only reconciles pipeline_jobs/leases back to the shape
-- every other migration in this repo already assumes -- it adds no new
-- behavior. Generation-awareness (generation_id, idempotency_key,
-- active_generation_id, the 'superseded' status value) is a separate,
-- later migration (20260824000100) so this reconciliation step stays
-- narrowly scoped and independently reviewable, matching this repo's own
-- established migration-repair convention.
--
-- Every statement here is additive/idempotent (IF NOT EXISTS, NOT VALID)
-- so it is a safe no-op wherever the tracked shape is already present
-- (confirmed: local Docker Postgres, which has always had these columns/
-- constraints) and only has a real effect against the drifted remote copy.

-- --- pipeline_jobs: restore the two columns 20260610120000_pipeline_jobs.sql
-- --- always defined but that do not exist on the live remote table today.
ALTER TABLE public.pipeline_jobs
  ADD COLUMN IF NOT EXISTS worker_name TEXT NULL,
  ADD COLUMN IF NOT EXISTS counts JSONB NOT NULL DEFAULT '{}'::jsonb;

-- --- pipeline_jobs: restore the two CHECK constraints
-- --- 20260610120000_pipeline_jobs.sql always defined; remote has neither,
-- --- meaning status/job_type have had zero enforcement in production.
-- --- Added NOT VALID so this migration cannot fail/abort if any existing
-- --- remote row already violates one of these (unknown until this actually
-- --- runs against that project) -- the constraint still applies to every
-- --- new/updated row from the moment this lands. Validating existing rows
-- --- against it (ALTER TABLE ... VALIDATE CONSTRAINT ...) is a deliberate,
-- --- separate follow-up once any violations found by the pre-push dry run
-- --- have been reviewed, not attempted automatically here.
ALTER TABLE public.pipeline_jobs
  DROP CONSTRAINT IF EXISTS pipeline_jobs_job_type_check;
ALTER TABLE public.pipeline_jobs
  ADD CONSTRAINT pipeline_jobs_job_type_check
    CHECK (job_type = 'lease_extraction') NOT VALID;

ALTER TABLE public.pipeline_jobs
  DROP CONSTRAINT IF EXISTS pipeline_jobs_status_check;
ALTER TABLE public.pipeline_jobs
  ADD CONSTRAINT pipeline_jobs_status_check
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')) NOT VALID;

-- --- pipeline_jobs.uploaded_file_id / .stage: local's migrated schema has
-- --- both NOT NULL; remote has both nullable. Deliberately NOT tightened
-- --- here -- every current write path already supplies both, so this is
-- --- believed to be a no-op in practice, but confirming zero existing NULL
-- --- rows on the live table needs to happen at push time (as part of the
-- --- same dry-run review as the CHECK constraints above), not asserted by
-- --- this migration. Tightening to NOT NULL is deferred to a follow-up
-- --- migration once that's confirmed.

-- --- pipeline_jobs.output: remote has an extra jsonb column no migration in
-- --- this repo's history creates. Left alone -- not read or written by any
-- --- current code path (confirmed by search), and dropping a live column is
-- --- a separate, deliberate decision, not part of this reconciliation.

-- --- leases.source_file_id: 20260605000000_add_source_file_id_to_leases.sql
-- --- shows applied in `migration list --linked`, but the column does not
-- --- exist on the live remote table -- the exact "frontend expects a
-- --- column not deployed in DB" bug that migration's own header comment
-- --- describes, confirmed to still be live on this project. Re-running its
-- --- exact original (already idempotent) definition here, following this
-- --- doc's established "capture the drift with a fresh dated migration"
-- --- pattern (see docs/database/migration-repair.md's 2026-07-08 entries).
ALTER TABLE public.leases
  ADD COLUMN IF NOT EXISTS source_file_id UUID
    REFERENCES public.uploaded_files(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_leases_source_file_id
  ON public.leases (source_file_id)
  WHERE source_file_id IS NOT NULL;

COMMENT ON COLUMN public.leases.source_file_id IS
  'The uploaded_files row that produced this lease via document review.';

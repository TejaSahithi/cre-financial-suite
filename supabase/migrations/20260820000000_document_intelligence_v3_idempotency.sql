-- Enterprise Document Intelligence v3, Phase 2: idempotency support for the
-- opt-in normalize-pdf-output side-write.
--
-- document_intelligence_runs (20260819000000_document_intelligence_v3_scaffold.sql)
-- had no idempotency key. This adds one, plus a unique index so the side-write
-- can INSERT ... ON CONFLICT (org_id, idempotency_key) DO UPDATE, reusing the
-- same run_id on retry instead of creating a new run every time
-- normalize-pdf-output is retried for the same file. Additive only: nullable
-- column (existing/legacy rows, and any row written without a key, are left
-- alone -- Postgres unique constraints treat NULL as distinct from NULL, so
-- multiple NULL-keyed rows remain valid).

ALTER TABLE public.document_intelligence_runs
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_document_intelligence_runs_org_idempotency
  ON public.document_intelligence_runs (org_id, idempotency_key);

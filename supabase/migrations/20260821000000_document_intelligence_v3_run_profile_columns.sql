-- Enterprise Document Intelligence v3, Phase 3: durable profile columns on
-- document_intelligence_runs.
--
-- Phase 3's readiness evaluator needs to read a document's classified
-- profile from a durable v3 table (per Phase 3 Task A: "It should read:
-- document_intelligence_runs, document_claims, ..."). Phase 2's side-write
-- never persisted the profile vertex_fact_ledger already computes
-- (metadata.extractionDebug.vertex_fact_ledger.document_profile) anywhere
-- durable -- it only lived in the transient ui_review_payload JSONB. This
-- is a small, additive extension of the Phase 2 run row to close that gap,
-- not a new table and not a behavior change: these columns are nullable,
-- populated only inside the same already-flag-gated side-write path, and
-- nothing reads them until this phase's readiness evaluator.

ALTER TABLE public.document_intelligence_runs
  ADD COLUMN IF NOT EXISTS profile_key TEXT,
  ADD COLUMN IF NOT EXISTS profile_confidence NUMERIC,
  ADD COLUMN IF NOT EXISTS profile_status TEXT
    CHECK (profile_status IS NULL OR profile_status IN ('unclassified', 'auto_detected', 'manual_override')),
  ADD COLUMN IF NOT EXISTS profile_signals JSONB NOT NULL DEFAULT '[]'::jsonb;

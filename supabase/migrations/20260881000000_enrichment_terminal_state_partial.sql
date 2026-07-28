-- Reliability Phase R1: guarantee an enrichment terminal state.
-- Part of fix/enrichment-terminal-state-and-546.
--
-- Today every enrich-stage failure (including a DOWNSTREAM_FUNCTION_FAILED
-- / HTTP 546 resource-exhaustion crash that happens strictly *after*
-- normalize already completed and wrote the 88 core standard_fields) is
-- written as enrichment_status: "failed", indistinguishable from a genuine
-- total loss. This widens the CHECK constraint by exactly one value,
-- 'partial', for "core data is reviewable, advanced enrichment did not
-- complete" -- not the literal 3-value spec (partial/retryable_failure/
-- resource_exhausted), since the latter two describe *why* a partial (or
-- failed) outcome happened, not alternative outcomes themselves. That
-- finer classification lives in the new enrichment_error column instead,
-- shaped {code, message, classification, retryable, stage}, deliberately
-- unconstrained (same reasoning uploaded_files.ui_review_payload's own
-- free-form JSONB fields already use elsewhere in this table).
--
-- enrichment_error is also deliberately a real top-level column, not a
-- ui_review_payload sub-key: the new compare-and-set terminal-state
-- writer (persistEnrichmentTerminalState, _shared/extraction/
-- enrichment-terminal-state.ts) must be able to persist a terminal
-- outcome using only id/org_id/active_generation_id equality -- it must
-- never need to first read the current ui_review_payload JSONB blob just
-- to safely spread-merge into it, since that pre-read is exactly the
-- step that a stale/failed re-fetch might not survive (the DB-level
-- compare-and-set is meant to be the whole generation fence).

ALTER TABLE public.uploaded_files
  DROP CONSTRAINT IF EXISTS uploaded_files_enrichment_status_check;
ALTER TABLE public.uploaded_files
  ADD CONSTRAINT uploaded_files_enrichment_status_check
    CHECK (enrichment_status IS NULL OR enrichment_status IN ('pending', 'running', 'completed', 'partial', 'failed'));

ALTER TABLE public.uploaded_files
  ADD COLUMN IF NOT EXISTS enrichment_error JSONB NULL;

COMMENT ON COLUMN public.uploaded_files.enrichment_error IS
  'Structured detail for a non-"completed" terminal enrichment_status: {code, message, classification, retryable, stage}. classification is "resource_exhausted" | "transport_error" | "unknown". Written by persistEnrichmentTerminalState (_shared/extraction/enrichment-terminal-state.ts). Null when enrichment_status is "completed" with no warning.';

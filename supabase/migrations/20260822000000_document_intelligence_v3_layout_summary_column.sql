-- Enterprise Document Intelligence v3, Phase 5: durable layout-audit summary
-- column on document_intelligence_runs.
--
-- Phase 5's canonical layout adapter (canonical-layout.ts) computes a
-- lightweight audit summary (page/block/table/figure/signature counts,
-- page-marker status) from the already-persisted docling_raw. This column
-- gives the side-write a durable place to store that summary, distinct
-- from the existing version_metadata (provider/API version identity) and
-- coverage (claim/evidence counts) columns already on this table.
-- Additive only, nullable-by-default JSONB -- existing rows are unaffected,
-- and nothing reads this column until the side-write starts populating it
-- (still gated end-to-end by ENABLE_DOCUMENT_INTELLIGENCE_V3).

ALTER TABLE public.document_intelligence_runs
  ADD COLUMN IF NOT EXISTS layout_summary JSONB NOT NULL DEFAULT '{}'::jsonb;

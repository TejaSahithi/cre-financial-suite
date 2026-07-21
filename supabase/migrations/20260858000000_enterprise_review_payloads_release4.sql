-- Release 4: Canonical projections as authoritative review payload foundation.
-- Additive only: legacy uploaded_files.ui_review_payload remains unchanged.

ALTER TABLE public.document_canonical_field_projections
  ADD COLUMN IF NOT EXISTS projection_schema_version TEXT NOT NULL DEFAULT 'canonical-field-projection-v1',
  ADD COLUMN IF NOT EXISTS projection_algorithm_version TEXT NOT NULL DEFAULT 'projection-resolution-v1',
  ADD COLUMN IF NOT EXISTS generation_id UUID NULL,
  ADD COLUMN IF NOT EXISTS display_value TEXT NULL,
  ADD COLUMN IF NOT EXISTS evidence_ids UUID[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS selected_candidate_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS rejected_candidates JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS conflict JSONB NULL,
  ADD COLUMN IF NOT EXISTS derivation JSONB NULL;

CREATE TABLE IF NOT EXISTS public.document_enterprise_review_payloads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  uploaded_file_id UUID NOT NULL REFERENCES public.uploaded_files(id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES public.document_intelligence_runs(id) ON DELETE CASCADE,
  generation_id UUID NULL,
  schema_version TEXT NOT NULL,
  source_mode TEXT NOT NULL CHECK (source_mode IN ('legacy', 'canonical_hybrid', 'canonical_strict')),
  payload JSONB NOT NULL,
  payload_hash TEXT NOT NULL,
  coverage_summary JSONB NOT NULL,
  parity_summary JSONB NULL,
  is_current BOOLEAN NOT NULL DEFAULT true,
  supersedes_payload_id UUID NULL REFERENCES public.document_enterprise_review_payloads(id),
  superseded_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT document_enterprise_review_payloads_schema_check CHECK (schema_version = 'enterprise-review-payload-v1')
);

CREATE UNIQUE INDEX IF NOT EXISTS document_enterprise_review_payloads_one_current
  ON public.document_enterprise_review_payloads (org_id, uploaded_file_id, run_id, schema_version)
  WHERE is_current;

CREATE INDEX IF NOT EXISTS document_enterprise_review_payloads_org_file_run_idx
  ON public.document_enterprise_review_payloads (org_id, uploaded_file_id, run_id);

CREATE INDEX IF NOT EXISTS document_enterprise_review_payloads_file_generation_idx
  ON public.document_enterprise_review_payloads (uploaded_file_id, generation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS document_enterprise_review_payloads_hash_idx
  ON public.document_enterprise_review_payloads (payload_hash);

CREATE TABLE IF NOT EXISTS public.document_field_review_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  uploaded_file_id UUID NOT NULL REFERENCES public.uploaded_files(id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES public.document_intelligence_runs(id) ON DELETE CASCADE,
  generation_id UUID NULL,
  canonical_field_key TEXT NOT NULL,
  original_projection_id UUID NULL,
  original_value JSONB NULL,
  override_value JSONB NULL,
  action TEXT NOT NULL CHECK (action IN ('accepted', 'overridden', 'cleared', 'marked_not_applicable', 'needs_followup')),
  reason TEXT NULL,
  reviewer_id UUID NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS document_field_review_overrides_one_active
  ON public.document_field_review_overrides (org_id, uploaded_file_id, run_id, COALESCE(generation_id, '00000000-0000-0000-0000-000000000000'::uuid), canonical_field_key)
  WHERE is_active;

CREATE INDEX IF NOT EXISTS document_field_review_overrides_lookup_idx
  ON public.document_field_review_overrides (org_id, uploaded_file_id, run_id, canonical_field_key);

ALTER TABLE public.document_enterprise_review_payloads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_field_review_overrides ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'document_enterprise_review_payloads' AND policyname = 'document_enterprise_review_payloads_select'
  ) THEN
    CREATE POLICY document_enterprise_review_payloads_select ON public.document_enterprise_review_payloads
      FOR SELECT USING (org_id IN (SELECT public.get_my_org_ids()));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'document_field_review_overrides' AND policyname = 'document_field_review_overrides_select'
  ) THEN
    CREATE POLICY document_field_review_overrides_select ON public.document_field_review_overrides
      FOR SELECT USING (org_id IN (SELECT public.get_my_org_ids()));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'document_field_review_overrides' AND policyname = 'document_field_review_overrides_insert'
  ) THEN
    CREATE POLICY document_field_review_overrides_insert ON public.document_field_review_overrides
      FOR INSERT WITH CHECK (public.can_write_org_data(org_id));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'document_field_review_overrides' AND policyname = 'document_field_review_overrides_update'
  ) THEN
    CREATE POLICY document_field_review_overrides_update ON public.document_field_review_overrides
      FOR UPDATE USING (public.can_write_org_data(org_id));
  END IF;
END $$;
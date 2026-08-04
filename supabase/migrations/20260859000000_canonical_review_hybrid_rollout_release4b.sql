-- Release 4B: organization rollout, payload diagnostics, and generation-aware review safety.

ALTER TABLE public.document_intelligence_runs
  ADD COLUMN IF NOT EXISTS generation_id UUID NULL;

CREATE INDEX IF NOT EXISTS document_intelligence_runs_generation_idx
  ON public.document_intelligence_runs (org_id, uploaded_file_id, generation_id, created_at DESC);

ALTER TABLE public.document_enterprise_review_payloads
  ADD COLUMN IF NOT EXISTS rollout_mode TEXT NULL CHECK (rollout_mode IN ('legacy', 'shadow', 'canonical_hybrid', 'canonical_strict')),
  ADD COLUMN IF NOT EXISTS rollout_source TEXT NULL CHECK (rollout_source IN ('organization_config', 'environment', 'default')),
  ADD COLUMN IF NOT EXISTS fallback_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS material_mismatch_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS blocking_finding_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payload_build_duration_ms INTEGER NULL,
  ADD COLUMN IF NOT EXISTS registry_version TEXT NULL,
  ADD COLUMN IF NOT EXISTS projection_algorithm_version TEXT NULL,
  ADD COLUMN IF NOT EXISTS approval_readiness_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS integrity_violation_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS document_enterprise_review_payloads_rollout_idx
  ON public.document_enterprise_review_payloads (org_id, rollout_mode, created_at DESC);

CREATE TABLE IF NOT EXISTS public.canonical_review_rollout_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('legacy', 'shadow', 'canonical_hybrid', 'canonical_strict')),
  enabled BOOLEAN NOT NULL DEFAULT true,
  document_family TEXT NULL,
  reason TEXT NULL,
  updated_by UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS canonical_review_rollout_configs_org_family_unique
  ON public.canonical_review_rollout_configs (org_id, COALESCE(document_family, 'default'));

CREATE INDEX IF NOT EXISTS canonical_review_rollout_configs_org_idx
  ON public.canonical_review_rollout_configs (org_id, enabled, document_family);

ALTER TABLE public.canonical_review_rollout_configs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'canonical_review_rollout_configs' AND policyname = 'canonical_review_rollout_configs_select'
  ) THEN
    CREATE POLICY canonical_review_rollout_configs_select ON public.canonical_review_rollout_configs
      FOR SELECT USING (org_id IN (SELECT unnest(public.get_my_org_ids())));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'canonical_review_rollout_configs' AND policyname = 'canonical_review_rollout_configs_insert'
  ) THEN
    CREATE POLICY canonical_review_rollout_configs_insert ON public.canonical_review_rollout_configs
      FOR INSERT WITH CHECK (public.is_org_admin(org_id));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'canonical_review_rollout_configs' AND policyname = 'canonical_review_rollout_configs_update'
  ) THEN
    CREATE POLICY canonical_review_rollout_configs_update ON public.canonical_review_rollout_configs
      FOR UPDATE USING (public.is_org_admin(org_id));
  END IF;
END $$;

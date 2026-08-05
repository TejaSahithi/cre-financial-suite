
ALTER TABLE public.document_enterprise_review_payloads
  DROP CONSTRAINT IF EXISTS document_enterprise_review_payloads_schema_check;

ALTER TABLE public.document_enterprise_review_payloads
  ADD CONSTRAINT document_enterprise_review_payloads_schema_check
  CHECK (schema_version IN ('enterprise-review-payload-v1', 'enterprise-review-payload-v2'));-- Release 6: canonical document semantics, document families, amendment effects, and semantic review resolutions.

CREATE TABLE IF NOT EXISTS public.document_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  uploaded_file_id UUID NOT NULL REFERENCES public.uploaded_files(id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES public.document_intelligence_runs(id) ON DELETE CASCADE,
  generation_id TEXT NOT NULL,
  term_normalized TEXT NOT NULL,
  term_display TEXT NOT NULL,
  definition_text TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('document_global', 'article', 'section', 'exhibit', 'schedule', 'amendment_only', 'document_family')),
  scope_key TEXT NULL,
  source_block_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_page_numbers INT[] NOT NULL DEFAULT '{}',
  evidence_ids UUID[] NOT NULL DEFAULT '{}',
  definition_status TEXT NOT NULL CHECK (definition_status IN ('resolved', 'ambiguous', 'conflicting', 'unresolved', 'superseded')),
  confidence NUMERIC NULL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  schema_version TEXT NOT NULL,
  algorithm_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS document_definitions_generation_scope_unique
  ON public.document_definitions (organization_id, uploaded_file_id, run_id, generation_id, term_normalized, scope_type, COALESCE(scope_key, ''));

CREATE INDEX IF NOT EXISTS document_definitions_org_file_idx
  ON public.document_definitions (organization_id, uploaded_file_id, run_id, generation_id, term_normalized);

CREATE TABLE IF NOT EXISTS public.document_cross_references (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  uploaded_file_id UUID NOT NULL REFERENCES public.uploaded_files(id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES public.document_intelligence_runs(id) ON DELETE CASCADE,
  generation_id TEXT NOT NULL,
  source_block_id TEXT NOT NULL,
  source_text TEXT NOT NULL,
  reference_type TEXT NOT NULL CHECK (reference_type IN ('section', 'article', 'exhibit', 'schedule', 'defined_term', 'amendment', 'document', 'date_clause', 'rent_clause', 'option_clause', 'other')),
  target_label TEXT NOT NULL,
  target_document_id UUID NULL,
  target_block_id TEXT NULL,
  target_section_key TEXT NULL,
  target_definition_id UUID NULL,
  resolution_status TEXT NOT NULL CHECK (resolution_status IN ('resolved', 'ambiguous', 'unresolved', 'invalid_target', 'cross_document', 'superseded_target')),
  confidence NUMERIC NULL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  reason_codes TEXT[] NOT NULL DEFAULT '{}',
  schema_version TEXT NOT NULL,
  algorithm_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS document_cross_references_lookup_idx
  ON public.document_cross_references (organization_id, uploaded_file_id, run_id, generation_id, reference_type, resolution_status);

CREATE TABLE IF NOT EXISTS public.document_family_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  document_family_id UUID NOT NULL,
  uploaded_file_id UUID NOT NULL REFERENCES public.uploaded_files(id) ON DELETE CASCADE,
  document_role TEXT NOT NULL CHECK (document_role IN ('base_lease', 'amendment', 'addendum', 'commencement_certificate', 'estoppel', 'assignment', 'guaranty', 'exhibit', 'schedule', 'unknown')),
  effective_date DATE NULL,
  execution_date DATE NULL,
  sequence_number INT NULL,
  parent_uploaded_file_id UUID NULL REFERENCES public.uploaded_files(id) ON DELETE SET NULL,
  amends_uploaded_file_id UUID NULL REFERENCES public.uploaded_files(id) ON DELETE SET NULL,
  family_detection_source TEXT NOT NULL,
  confidence NUMERIC NULL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  reason_codes TEXT[] NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS document_family_members_active_file_unique
  ON public.document_family_members (organization_id, uploaded_file_id)
  WHERE is_active;

CREATE INDEX IF NOT EXISTS document_family_members_family_idx
  ON public.document_family_members (organization_id, document_family_id, sequence_number, effective_date, execution_date);

CREATE TABLE IF NOT EXISTS public.document_amendment_effects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  document_family_id UUID NOT NULL,
  source_uploaded_file_id UUID NOT NULL REFERENCES public.uploaded_files(id) ON DELETE CASCADE,
  source_run_id UUID NOT NULL REFERENCES public.document_intelligence_runs(id) ON DELETE CASCADE,
  source_generation_id TEXT NOT NULL,
  target_uploaded_file_id UUID NULL REFERENCES public.uploaded_files(id) ON DELETE SET NULL,
  target_canonical_field_key TEXT NULL,
  target_clause_key TEXT NULL,
  target_definition_term TEXT NULL,
  effect_type TEXT NOT NULL CHECK (effect_type IN ('replace', 'supplement', 'delete', 'waive', 'extend', 'shorten', 'clarify', 'rename', 'restate', 'override', 'no_change', 'unknown')),
  effective_date DATE NULL,
  previous_value JSONB NULL,
  replacement_value JSONB NULL,
  source_claim_ids UUID[] NOT NULL DEFAULT '{}',
  source_evidence_ids UUID[] NOT NULL DEFAULT '{}',
  resolution_status TEXT NOT NULL CHECK (resolution_status IN ('resolved', 'ambiguous', 'unresolved', 'conflicting', 'superseded', 'not_applicable')),
  confidence NUMERIC NULL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  reason_codes TEXT[] NOT NULL DEFAULT '{}',
  algorithm_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS document_amendment_effects_family_target_idx
  ON public.document_amendment_effects (organization_id, document_family_id, target_canonical_field_key, effective_date, created_at);

CREATE TABLE IF NOT EXISTS public.document_semantic_search_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  uploaded_file_id UUID NULL REFERENCES public.uploaded_files(id) ON DELETE CASCADE,
  document_family_id UUID NULL,
  run_id UUID NULL REFERENCES public.document_intelligence_runs(id) ON DELETE CASCADE,
  generation_id TEXT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('field', 'definition', 'section', 'finding', 'evidence', 'amendment_effect')),
  entity_key TEXT NOT NULL,
  label TEXT NOT NULL,
  searchable_text TEXT NOT NULL,
  field_key TEXT NULL,
  section_key TEXT NULL,
  page_number INT NULL,
  status TEXT NULL,
  source TEXT NULL,
  evidence_ids UUID[] NOT NULL DEFAULT '{}',
  reason_codes TEXT[] NOT NULL DEFAULT '{}',
  search_vector TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', coalesce(label, '') || ' ' || coalesce(searchable_text, ''))) STORED,
  schema_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS document_semantic_search_records_scope_idx
  ON public.document_semantic_search_records (organization_id, uploaded_file_id, document_family_id, entity_type, status);
CREATE INDEX IF NOT EXISTS document_semantic_search_records_vector_idx
  ON public.document_semantic_search_records USING GIN (search_vector);

CREATE TABLE IF NOT EXISTS public.document_semantic_review_resolutions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  uploaded_file_id UUID NULL REFERENCES public.uploaded_files(id) ON DELETE CASCADE,
  document_family_id UUID NULL,
  semantic_entity_type TEXT NOT NULL,
  semantic_entity_id UUID NULL,
  canonical_field_key TEXT NULL,
  action TEXT NOT NULL CHECK (action IN ('confirm_family_membership', 'reject_family_link', 'confirm_chronology', 'resolve_amendment_target', 'select_definition', 'mark_reference_unresolved', 'accept_effective_value', 'override_effective_value')),
  resolution_value JSONB NULL,
  reason TEXT NULL,
  reviewer_id UUID NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS document_semantic_review_resolutions_scope_idx
  ON public.document_semantic_review_resolutions (organization_id, uploaded_file_id, document_family_id, semantic_entity_type, canonical_field_key, is_active);

CREATE TABLE IF NOT EXISTS public.document_semantic_rollout_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  document_family TEXT NULL,
  enable_document_semantics_v6 BOOLEAN NOT NULL DEFAULT false,
  enable_definition_resolution_v6 BOOLEAN NOT NULL DEFAULT false,
  enable_cross_reference_resolution_v6 BOOLEAN NOT NULL DEFAULT false,
  enable_amendment_precedence_v6 BOOLEAN NOT NULL DEFAULT false,
  enable_semantic_field_search_v6 BOOLEAN NOT NULL DEFAULT false,
  enable_enterprise_review_payload_v2 BOOLEAN NOT NULL DEFAULT false,
  enable_semantic_approval_gating BOOLEAN NOT NULL DEFAULT false,
  reason TEXT NULL,
  updated_by UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS document_semantic_rollout_configs_org_family_unique
  ON public.document_semantic_rollout_configs (org_id, COALESCE(document_family, 'default'));

ALTER TABLE public.document_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_cross_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_family_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_amendment_effects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_semantic_search_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_semantic_review_resolutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_semantic_rollout_configs ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'document_definitions',
    'document_cross_references',
    'document_family_members',
    'document_amendment_effects',
    'document_semantic_search_records',
    'document_semantic_review_resolutions'
  ] LOOP
    EXECUTE format('CREATE POLICY %I_select ON public.%I FOR SELECT USING (organization_id IN (SELECT public.get_my_org_ids()))', table_name, table_name);
    EXECUTE format('CREATE POLICY %I_insert ON public.%I FOR INSERT WITH CHECK (organization_id IN (SELECT public.get_my_org_ids()))', table_name, table_name);
    EXECUTE format('CREATE POLICY %I_update ON public.%I FOR UPDATE USING (organization_id IN (SELECT public.get_my_org_ids()))', table_name, table_name);
  END LOOP;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'document_semantic_rollout_configs' AND policyname = 'document_semantic_rollout_configs_select') THEN
    CREATE POLICY document_semantic_rollout_configs_select ON public.document_semantic_rollout_configs
      FOR SELECT USING (org_id IN (SELECT public.get_my_org_ids()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'document_semantic_rollout_configs' AND policyname = 'document_semantic_rollout_configs_insert') THEN
    CREATE POLICY document_semantic_rollout_configs_insert ON public.document_semantic_rollout_configs
      FOR INSERT WITH CHECK (public.is_org_admin(org_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'document_semantic_rollout_configs' AND policyname = 'document_semantic_rollout_configs_update') THEN
    CREATE POLICY document_semantic_rollout_configs_update ON public.document_semantic_rollout_configs
      FOR UPDATE USING (public.is_org_admin(org_id));
  END IF;
END $$;
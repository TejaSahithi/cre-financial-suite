-- Enterprise Document Intelligence v3, Phase 11: diagnostic-only document
-- package graph and related-document link model.
--
-- Additive only. These tables do not replace uploaded_files,
-- ui_review_payload, normalized_output, leases, document_intelligence_runs,
-- or any approval/Lease Review business path. They are server-owned
-- diagnostics populated only by the opt-in v3 side-write and readable by org
-- members for admin/debug inspection. Authenticated users get SELECT only via
-- is_member_of_org(org_id); no broad INSERT/UPDATE/DELETE policies are
-- granted.

CREATE TABLE IF NOT EXISTS public.document_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  package_key TEXT NOT NULL,
  package_type TEXT NOT NULL DEFAULT 'lease_package',
  display_name TEXT,
  primary_uploaded_file_id UUID REFERENCES public.uploaded_files(id) ON DELETE SET NULL,
  primary_lease_id UUID REFERENCES public.leases(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, package_key)
);

CREATE INDEX IF NOT EXISTS idx_document_packages_primary_upload
  ON public.document_packages (org_id, primary_uploaded_file_id)
  WHERE primary_uploaded_file_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_document_packages_primary_lease
  ON public.document_packages (org_id, primary_lease_id)
  WHERE primary_lease_id IS NOT NULL;

ALTER TABLE public.document_packages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "document_packages_select" ON public.document_packages;
CREATE POLICY "document_packages_select" ON public.document_packages
  FOR SELECT USING (public.is_member_of_org(org_id));

DROP TRIGGER IF EXISTS set_document_packages_updated_at ON public.document_packages;
CREATE TRIGGER set_document_packages_updated_at
  BEFORE UPDATE ON public.document_packages
  FOR EACH ROW
  EXECUTE FUNCTION public.set_workflow_updated_at();

CREATE TABLE IF NOT EXISTS public.document_package_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  package_id UUID NOT NULL REFERENCES public.document_packages(id) ON DELETE CASCADE,
  uploaded_file_id UUID REFERENCES public.uploaded_files(id) ON DELETE SET NULL,
  lease_id UUID REFERENCES public.leases(id) ON DELETE SET NULL,
  document_intelligence_run_id UUID REFERENCES public.document_intelligence_runs(id) ON DELETE SET NULL,
  document_profile TEXT,
  document_type TEXT,
  content_hash TEXT,
  file_name TEXT,
  document_date DATE,
  effective_date DATE,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  confidence NUMERIC,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, package_id, document_intelligence_run_id)
);

CREATE INDEX IF NOT EXISTS idx_document_package_documents_package
  ON public.document_package_documents (org_id, package_id);
CREATE INDEX IF NOT EXISTS idx_document_package_documents_upload
  ON public.document_package_documents (org_id, uploaded_file_id)
  WHERE uploaded_file_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_document_package_documents_lease
  ON public.document_package_documents (org_id, lease_id)
  WHERE lease_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_document_package_documents_content_hash
  ON public.document_package_documents (org_id, content_hash)
  WHERE content_hash IS NOT NULL;

ALTER TABLE public.document_package_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "document_package_documents_select" ON public.document_package_documents;
CREATE POLICY "document_package_documents_select" ON public.document_package_documents
  FOR SELECT USING (public.is_member_of_org(org_id));

DROP TRIGGER IF EXISTS set_document_package_documents_updated_at ON public.document_package_documents;
CREATE TRIGGER set_document_package_documents_updated_at
  BEFORE UPDATE ON public.document_package_documents
  FOR EACH ROW
  EXECUTE FUNCTION public.set_workflow_updated_at();

CREATE TABLE IF NOT EXISTS public.document_related_document_requirements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  package_id UUID NOT NULL REFERENCES public.document_packages(id) ON DELETE CASCADE,
  source_document_id UUID NOT NULL REFERENCES public.document_package_documents(id) ON DELETE CASCADE,
  required_document_type TEXT NOT NULL,
  reason TEXT,
  required_for TEXT[] NOT NULL DEFAULT '{}',
  importance_level TEXT NOT NULL DEFAULT 'medium'
    CHECK (importance_level IN ('critical', 'high', 'medium', 'low', 'hidden_optional')),
  status TEXT NOT NULL DEFAULT 'missing'
    CHECK (status IN ('missing', 'candidate_found', 'linked', 'waived', 'not_applicable')),
  candidate_document_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence_claim_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, package_id, source_document_id, required_document_type, reason)
);

CREATE INDEX IF NOT EXISTS idx_document_related_document_requirements_package
  ON public.document_related_document_requirements (org_id, package_id);
CREATE INDEX IF NOT EXISTS idx_document_related_document_requirements_source
  ON public.document_related_document_requirements (org_id, source_document_id);
CREATE INDEX IF NOT EXISTS idx_document_related_document_requirements_status
  ON public.document_related_document_requirements (org_id, status);

ALTER TABLE public.document_related_document_requirements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "document_related_document_requirements_select" ON public.document_related_document_requirements;
CREATE POLICY "document_related_document_requirements_select" ON public.document_related_document_requirements
  FOR SELECT USING (public.is_member_of_org(org_id));

DROP TRIGGER IF EXISTS set_document_related_document_requirements_updated_at ON public.document_related_document_requirements;
CREATE TRIGGER set_document_related_document_requirements_updated_at
  BEFORE UPDATE ON public.document_related_document_requirements
  FOR EACH ROW
  EXECUTE FUNCTION public.set_workflow_updated_at();

CREATE TABLE IF NOT EXISTS public.document_relationships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  package_id UUID NOT NULL REFERENCES public.document_packages(id) ON DELETE CASCADE,
  source_document_id UUID NOT NULL REFERENCES public.document_package_documents(id) ON DELETE CASCADE,
  target_document_id UUID REFERENCES public.document_package_documents(id) ON DELETE SET NULL,
  target_document_requirement_id UUID REFERENCES public.document_related_document_requirements(id) ON DELETE SET NULL,
  relationship_type TEXT NOT NULL
    CHECK (relationship_type IN (
      'original_lease_for',
      'amends',
      'assigns',
      'assumes',
      'guarantees',
      'references',
      'duplicate_of',
      'supersedes_candidate'
    )),
  confidence NUMERIC NOT NULL DEFAULT 0,
  evidence_claim_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'inferred'
    CHECK (status IN ('inferred', 'confirmed', 'rejected', 'missing_target', 'needs_review')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'uq_document_relationships_diagnostic_key'
      AND conrelid = 'public.document_relationships'::regclass
  ) THEN
    ALTER TABLE public.document_relationships
      ADD CONSTRAINT uq_document_relationships_diagnostic_key
      UNIQUE NULLS NOT DISTINCT (
        org_id,
        package_id,
        source_document_id,
        relationship_type,
        target_document_id,
        target_document_requirement_id
      );
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_document_relationships_package
  ON public.document_relationships (org_id, package_id);
CREATE INDEX IF NOT EXISTS idx_document_relationships_source
  ON public.document_relationships (org_id, source_document_id);
CREATE INDEX IF NOT EXISTS idx_document_relationships_target
  ON public.document_relationships (org_id, target_document_id)
  WHERE target_document_id IS NOT NULL;

ALTER TABLE public.document_relationships ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "document_relationships_select" ON public.document_relationships;
CREATE POLICY "document_relationships_select" ON public.document_relationships
  FOR SELECT USING (public.is_member_of_org(org_id));

DROP TRIGGER IF EXISTS set_document_relationships_updated_at ON public.document_relationships;
CREATE TRIGGER set_document_relationships_updated_at
  BEFORE UPDATE ON public.document_relationships
  FOR EACH ROW
  EXECUTE FUNCTION public.set_workflow_updated_at();

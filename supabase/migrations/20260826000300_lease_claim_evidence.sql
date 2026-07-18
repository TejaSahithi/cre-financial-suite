-- P2.1 — lease_claim_evidence + lease_claim_evidence_links.
--
-- Evidence is deliberately separate from claim identity (round-2 correction
-- #4): one claim can have multiple supporting evidence spans without
-- becoming multiple claims, so this is a genuine many-to-many relationship
-- via the links table below, not a column on lease_claims.
--
-- location_precision is honest about what the real adapters capture today
-- (round-2 correction, "evidence precision must be honest"): the Azure
-- Document Intelligence adapter (_shared/extraction/azure-layout-adapter.ts)
-- only ever captures a page number and a text span into the full content
-- string -- no bounding-region/polygon data exists anywhere in the real
-- adapter despite Azure returning boundingRegions[].polygon in its raw
-- response. bounding_regions stays nullable and CHECK-gated to
-- location_precision='geometry', a level nothing produces yet -- carried
-- for future-proofing, not faked.

CREATE TABLE public.lease_claim_evidence (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  extraction_run_id UUID NOT NULL,
  uploaded_file_id  UUID NOT NULL,

  location_precision TEXT NOT NULL CHECK (location_precision IN ('page', 'page_and_span', 'geometry')),
  page_start INT,
  page_end   INT,
  span_start INT,
  span_end   INT,
  -- Reserved for a future adapter that actually captures Azure's
  -- boundingRegions[].polygon or Docling block/table geometry -- nullable
  -- and unpopulated today, never fabricated.
  bounding_regions JSONB,
  -- Docling block_index/table_index positions, when available -- bare array
  -- positions today, not yet stable IDs (see Docling's own types.ts).
  block_ids TEXT[],

  source_text      TEXT,
  source_text_hash TEXT,

  -- Which P1 artifact (raw provider response, parser output) this evidence
  -- span was read from, when traceable to one -- nullable, since not every
  -- evidence-producing path (e.g. a deterministic rule reading normalized
  -- text) has a single owning artifact.
  artifact_id UUID,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (id, org_id),
  -- Lets lease_claim_evidence_links FK against (evidence_id, extraction_run_id, org_id).
  UNIQUE (id, extraction_run_id, org_id),

  FOREIGN KEY (extraction_run_id, org_id) REFERENCES public.extraction_runs (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (uploaded_file_id, org_id) REFERENCES public.uploaded_files (id, org_id) ON DELETE RESTRICT,
  -- Same-run artifact linkage (round-2 correction #3's extraction_artifacts_claim_link_unique):
  -- an evidence row's artifact must belong to the SAME run as the evidence
  -- itself, not just the same org.
  -- Column-scoped SET NULL: a bare SET NULL would null extraction_run_id
  -- and org_id too (both NOT NULL) whenever a linked artifact is deleted.
  FOREIGN KEY (artifact_id, extraction_run_id, org_id)
    REFERENCES public.extraction_artifacts (id, run_id, org_id) ON DELETE SET NULL (artifact_id),

  -- Geometry-requires-bounding_regions.
  CHECK (location_precision <> 'geometry' OR bounding_regions IS NOT NULL),
  -- A page number is required at every precision level that isn't purely
  -- span-based (all three levels here start from "which page").
  CHECK (page_start IS NOT NULL),
  CHECK (page_end IS NULL OR page_end >= page_start),
  -- Span columns required once precision is at least page_and_span.
  CHECK (
    (location_precision = 'page' AND span_start IS NULL AND span_end IS NULL)
    OR (location_precision IN ('page_and_span', 'geometry') AND span_start IS NOT NULL AND span_end IS NOT NULL AND span_end >= span_start)
  ),

  CHECK (source_text IS NULL OR char_length(source_text) <= 20000),
  CHECK (page_start > 0),
  CHECK (octet_length(COALESCE(bounding_regions::text, '')) <= 20000)
);

CREATE INDEX idx_lease_claim_evidence_run ON public.lease_claim_evidence (org_id, extraction_run_id);
CREATE INDEX idx_lease_claim_evidence_file ON public.lease_claim_evidence (org_id, uploaded_file_id);

ALTER TABLE public.lease_claim_evidence ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_claim_evidence_org_select ON public.lease_claim_evidence
  FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_claim_evidence FROM authenticated, anon;

-- lease_claim_evidence rows are immutable, same rationale as lease_claims.
CREATE OR REPLACE FUNCTION public.enforce_lease_claim_evidence_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'lease_claim_evidence rows are immutable (evidence %)', OLD.id;
END;
$$;

CREATE TRIGGER trg_lease_claim_evidence_immutable
  BEFORE UPDATE ON public.lease_claim_evidence
  FOR EACH ROW EXECUTE FUNCTION public.enforce_lease_claim_evidence_immutable();

-- ---------------------------------------------------------------------------
-- lease_claim_evidence_links -- many-to-many between claims and evidence.
-- A single extraction_run_id column, cross-validated against BOTH the claim
-- and the evidence's own run via two composite FKs, structurally prevents a
-- claim from one run ever being linked to evidence from a different run
-- (round-2 correction #3 test: "claim/evidence cross-run link rejected").
-- ---------------------------------------------------------------------------
CREATE TABLE public.lease_claim_evidence_links (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  extraction_run_id UUID NOT NULL,
  claim_id          UUID NOT NULL,
  evidence_id       UUID NOT NULL,
  -- Documentation-only role of this specific evidence for this claim (e.g.
  -- 'primary', 'corroborating') -- not DB-enforced beyond being a short string.
  link_role TEXT NOT NULL DEFAULT 'primary',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (claim_id, evidence_id),

  FOREIGN KEY (claim_id, extraction_run_id, org_id)
    REFERENCES public.lease_claims (id, extraction_run_id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (evidence_id, extraction_run_id, org_id)
    REFERENCES public.lease_claim_evidence (id, extraction_run_id, org_id) ON DELETE CASCADE,

  CHECK (char_length(link_role) BETWEEN 1 AND 60)
);

CREATE INDEX idx_lease_claim_evidence_links_claim ON public.lease_claim_evidence_links (claim_id);
CREATE INDEX idx_lease_claim_evidence_links_evidence ON public.lease_claim_evidence_links (evidence_id);

ALTER TABLE public.lease_claim_evidence_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_claim_evidence_links_org_select ON public.lease_claim_evidence_links
  FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_claim_evidence_links FROM authenticated, anon;

CREATE OR REPLACE FUNCTION public.enforce_lease_claim_evidence_links_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'lease_claim_evidence_links rows are immutable (link %)', OLD.id;
END;
$$;

CREATE TRIGGER trg_lease_claim_evidence_links_immutable
  BEFORE UPDATE ON public.lease_claim_evidence_links
  FOR EACH ROW EXECUTE FUNCTION public.enforce_lease_claim_evidence_links_immutable();

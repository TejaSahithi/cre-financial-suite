-- P3.1 — lease_document_segments: one immutable logical document segment.
--
-- Segment identity exists from day one (locked decision #6): even today's
-- one-document-per-file reality gets exactly one full-file segment
-- (segment_index=0, page_start=1, page_end=<page count>). A combined
-- assignment/amendment file (P3.4+) will later produce multiple segments
-- for the same uploaded_file_id/generation_id.

CREATE TABLE public.lease_document_segments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  uploaded_file_id  UUID NOT NULL,
  extraction_run_id UUID NOT NULL,
  generation_id     UUID NOT NULL,

  segment_index      INT NOT NULL,
  page_start         INT NOT NULL,
  page_end           INT NOT NULL,
  segment_key        TEXT NOT NULL,
  content_fingerprint TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (org_id, uploaded_file_id, generation_id, segment_key),
  UNIQUE (id, org_id),
  -- 4-part: lets lease_document_profile_records FK against
  -- (segment_id, uploaded_file_id, generation_id, org_id) -- catches a
  -- profile record referencing a segment from a DIFFERENT (e.g. stale/
  -- superseded) generation of the same file, not just the same file/org.
  UNIQUE (id, uploaded_file_id, generation_id, org_id),

  FOREIGN KEY (uploaded_file_id, org_id) REFERENCES public.uploaded_files (id, org_id) ON DELETE RESTRICT,
  -- Same 4-part composite already proven in P2.1/P2.5 (extraction_runs_claim_link_unique):
  -- catches wrong-file/wrong-generation in one FK, not just same-org.
  FOREIGN KEY (extraction_run_id, uploaded_file_id, generation_id, org_id)
    REFERENCES public.extraction_runs (id, uploaded_file_id, generation_id, org_id) ON DELETE RESTRICT,

  CHECK (page_start >= 1),
  CHECK (page_end >= page_start),
  CHECK (segment_index >= 0),
  CHECK (char_length(segment_key) BETWEEN 1 AND 300),
  CHECK (content_fingerprint IS NULL OR char_length(content_fingerprint) <= 200)
);

CREATE INDEX idx_lease_document_segments_file ON public.lease_document_segments (org_id, uploaded_file_id);
CREATE INDEX idx_lease_document_segments_run ON public.lease_document_segments (org_id, extraction_run_id);

ALTER TABLE public.lease_document_segments ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_document_segments_org_select ON public.lease_document_segments
  FOR SELECT USING (public.is_member_of_org(org_id));
-- REVOKE ALL from the start (P3.1 applies the lesson from P2.1's original
-- round-1 mistake directly, rather than grant-then-revoke).
REVOKE ALL ON public.lease_document_segments FROM authenticated, anon;

-- Same-generation overlapping segments are rejected in P3.1 (the simplest
-- correct behavior per the locked decision) -- enforced by a trigger since
-- an exclusion constraint over an integer range isn't natively expressible
-- as a plain CHECK without the btree_gist extension, which this schema
-- doesn't otherwise need.
CREATE OR REPLACE FUNCTION public.enforce_lease_document_segment_no_overlap()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.lease_document_segments s
     WHERE s.org_id = NEW.org_id
       AND s.uploaded_file_id = NEW.uploaded_file_id
       AND s.generation_id = NEW.generation_id
       AND s.id <> NEW.id
       AND NEW.page_start <= s.page_end
       AND NEW.page_end >= s.page_start
  ) THEN
    RAISE EXCEPTION 'lease_document_segments: overlapping page range for uploaded_file_id % generation_id % (segment %-%)', NEW.uploaded_file_id, NEW.generation_id, NEW.page_start, NEW.page_end;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_enforce_lease_document_segment_no_overlap
  BEFORE INSERT ON public.lease_document_segments
  FOR EACH ROW EXECUTE FUNCTION public.enforce_lease_document_segment_no_overlap();

CREATE OR REPLACE FUNCTION public.enforce_lease_document_segments_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'lease_document_segments rows are immutable (segment %)', OLD.id;
END;
$$;

CREATE TRIGGER trg_lease_document_segments_immutable
  BEFORE UPDATE ON public.lease_document_segments
  FOR EACH ROW EXECUTE FUNCTION public.enforce_lease_document_segments_immutable();

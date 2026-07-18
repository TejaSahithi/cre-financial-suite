-- P1.1: extraction-run provenance schema. Part of the Lease Intelligence
-- Enterprise P1-P8 roadmap (C:\Users\tejas\.claude\plans\think-as-senior-enterprise-elegant-harbor.md).
--
-- Every parse, semantic extraction, and re-extraction becomes traceable to
-- an immutable extraction_runs row (1:1 with a P0 generation), broken into
-- per-stage extraction_stage_runs, with every outbound provider call
-- recorded in provider_invocations and bounded/offloaded raw payloads in
-- extraction_artifacts.
--
-- Deliberately a NEW table set, not an extension of document_intelligence_runs
-- (the document_intelligence_v3 scaffold): that table's own write path
-- (side-write.ts) is explicitly best-effort/diagnostic-only -- the opposite
-- reliability contract from "a failed run cannot be presented as completed."
-- It also predates P0 (no generation_id) and its coverage/readiness columns
-- are shaped for the P2-scope claims ledger. One new, additive migration
-- costs nothing against the existing (still flag-gated-off) v3 surface.
--
-- Everything here is gated off by default at the call site (P1.2's
-- ENABLE_EXTRACTION_PROVENANCE flag decides whether any row is ever
-- inserted) -- this migration only adds schema, it does not change any
-- existing behavior by itself.
--
-- Round-3 external review (2026-07-17) found the first draft still had bare
-- FOREIGN KEY (col) REFERENCES parent(id) links on several tenant-scoped
-- columns -- a service-role bug could link a child row to a parent in a
-- DIFFERENT org. uploaded_files/leases/pipeline_jobs don't yet have
-- UNIQUE(id, org_id) (confirmed via grep across all migrations), so it's
-- added here before any composite FK below can reference them.
ALTER TABLE public.uploaded_files ADD CONSTRAINT uploaded_files_id_org_unique UNIQUE (id, org_id);
ALTER TABLE public.leases         ADD CONSTRAINT leases_id_org_unique         UNIQUE (id, org_id);
ALTER TABLE public.pipeline_jobs  ADD CONSTRAINT pipeline_jobs_id_org_unique  UNIQUE (id, org_id);

-- ---------------------------------------------------------------------------
-- extraction_runs -- one row per generation
-- ---------------------------------------------------------------------------
CREATE TABLE public.extraction_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- ON DELETE RESTRICT, not CASCADE: deleting an upload must never silently
  -- erase the provenance ledger. A future retention/purge workflow removes
  -- both deliberately, with audit authorization -- not as a side effect of
  -- an ordinary uploaded_files delete.
  uploaded_file_id  UUID NOT NULL,
  lease_id          UUID,
  -- Same UUID as pipeline_jobs.generation_id / uploaded_files.active_generation_id
  -- (P0). Not itself an FK -- generation_id is not a primary key anywhere,
  -- it's a correlation id shared across pipeline_jobs rows.
  generation_id     UUID NOT NULL,
  run_type          TEXT NOT NULL CHECK (run_type IN ('initial_extraction', 're_extraction', 'admin_replay')),
  provider_pipeline TEXT NOT NULL DEFAULT 'unknown',
  contract_version  TEXT NOT NULL,
  -- 'superseded' is a real fourth terminal state, not a reuse of 'failed':
  -- a generation replaced by a newer one before finishing is a normal
  -- lifecycle event (the user/system started a new extraction), not a
  -- processing failure, and the two must stay distinguishable in the data.
  status            TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'superseded')),
  error_code        TEXT,
  error_message     TEXT, -- sanitized; never raw provider payloads or document text
  actor_user_id     UUID,
  actor_email       TEXT,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb, -- small bounded counters only, never raw payload
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, generation_id), -- DB-enforced: at most one run per generation
  UNIQUE (id, org_id),            -- enables composite tenant-scoped FKs from child tables
  FOREIGN KEY (uploaded_file_id, org_id) REFERENCES public.uploaded_files (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (lease_id, org_id) REFERENCES public.leases (id, org_id) ON DELETE SET NULL,
  CHECK (
    (status = 'running' AND completed_at IS NULL)
    OR (status IN ('completed', 'failed', 'superseded') AND completed_at IS NOT NULL)
  ),
  CHECK (status <> 'completed' OR (error_code IS NULL AND error_message IS NULL))
);

CREATE INDEX idx_extraction_runs_uploaded_file ON public.extraction_runs (org_id, uploaded_file_id, created_at DESC);
CREATE INDEX idx_extraction_runs_lease ON public.extraction_runs (org_id, lease_id) WHERE lease_id IS NOT NULL;

ALTER TABLE public.extraction_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "extraction_runs_select" ON public.extraction_runs
  FOR SELECT USING (public.is_member_of_org(org_id));

CREATE TRIGGER set_extraction_runs_updated_at
  BEFORE UPDATE ON public.extraction_runs
  FOR EACH ROW EXECUTE FUNCTION public.set_workflow_updated_at();

-- Field-level terminal-immutability guard (not a blanket "reject every
-- update once terminal" trigger -- that would block a legitimate one-time
-- lease_id linkage arriving after the run already finalized, since lease
-- creation can happen later, during human review/approval, P0.6-style).
--
-- Rule: once completed/failed, status/provider identity/timing/result
-- fields are frozen. lease_id may move exactly once, from NULL to a
-- non-null value -- and only to a lease that actually belongs to the same
-- org and the same source file (checked here, not just assumed elsewhere).
-- No other non-null field may ever be overwritten.
CREATE FUNCTION public.enforce_extraction_run_terminal_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_lease_belongs_to_org_and_file BOOLEAN;
BEGIN
  IF OLD.status IN ('completed', 'failed', 'superseded') THEN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'extraction_runs.status is terminal once completed/failed and cannot be changed (run %)', OLD.id;
    END IF;
    IF NEW.completed_at IS DISTINCT FROM OLD.completed_at
       OR NEW.run_type IS DISTINCT FROM OLD.run_type
       OR NEW.provider_pipeline IS DISTINCT FROM OLD.provider_pipeline
       OR NEW.contract_version IS DISTINCT FROM OLD.contract_version
       OR NEW.generation_id IS DISTINCT FROM OLD.generation_id
       OR NEW.uploaded_file_id IS DISTINCT FROM OLD.uploaded_file_id
       OR (OLD.error_code IS NOT NULL AND NEW.error_code IS DISTINCT FROM OLD.error_code)
       OR (OLD.error_message IS NOT NULL AND NEW.error_message IS DISTINCT FROM OLD.error_message)
    THEN
      RAISE EXCEPTION 'extraction_runs identity/timing/result fields are immutable once terminal (run %)', OLD.id;
    END IF;

    -- lease_id: allow exactly one NULL -> non-null transition, verified
    -- against the deterministic leases.source_file_id authority (P0.6).
    IF NEW.lease_id IS DISTINCT FROM OLD.lease_id THEN
      IF OLD.lease_id IS NOT NULL THEN
        RAISE EXCEPTION 'extraction_runs.lease_id may only be set once, not replaced (run %)', OLD.id;
      END IF;
      SELECT EXISTS (
        SELECT 1 FROM public.leases
         WHERE id = NEW.lease_id
           AND org_id = OLD.org_id
           AND source_file_id = OLD.uploaded_file_id
      ) INTO v_lease_belongs_to_org_and_file;
      IF NOT v_lease_belongs_to_org_and_file THEN
        RAISE EXCEPTION 'extraction_runs.lease_id must reference a lease in the same org with source_file_id = this run''s uploaded_file_id (run %)', OLD.id;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_enforce_extraction_run_terminal
  BEFORE UPDATE ON public.extraction_runs
  FOR EACH ROW EXECUTE FUNCTION public.enforce_extraction_run_terminal_guard();

-- ---------------------------------------------------------------------------
-- extraction_stage_runs -- one row per (run, stage, attempt)
-- ---------------------------------------------------------------------------
CREATE TABLE public.extraction_stage_runs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL,
  run_id           UUID NOT NULL,
  pipeline_job_id  UUID,
  -- Stage vocabulary matches the REAL pipeline_jobs.stage values already in
  -- production use (parse/normalize/enrich) -- semantic/LLM extraction work
  -- happens inside 'normalize' and is represented by provider_invocations
  -- rows underneath it, not a separate invented stage.
  stage            TEXT NOT NULL CHECK (stage IN ('parse', 'normalize', 'enrich')),
  attempt          INT NOT NULL DEFAULT 1,
  status           TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  provider         TEXT, -- e.g. 'docling','azure_document_intelligence','legacy_hybrid','vertex_fact_ledger'
  error_code       TEXT,
  error_message    TEXT,
  input_fingerprint TEXT, -- hash, mirrors compute_runs.input_fingerprint precedent -- never raw content
  output_summary   JSONB NOT NULL DEFAULT '{}'::jsonb, -- counts only (chars/fields/tables), not full payload
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, stage, attempt),
  UNIQUE (id, org_id),
  -- 3-part: lets children (provider_invocations, extraction_artifacts)
  -- reference "this stage run AND confirm it belongs to this run" in one
  -- FK. A 2-part (id, org_id) FK would let a same-org-but-wrong-run
  -- stage_run_id through -- e.g. an invocation claiming run_id=A while its
  -- stage_run_id actually belongs to run B in the same org.
  UNIQUE (id, run_id, org_id),
  -- Composite FK: a stage row can never reference a run belonging to a
  -- DIFFERENT organization, enforced at the data layer, independent of RLS.
  FOREIGN KEY (run_id, org_id) REFERENCES public.extraction_runs (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (pipeline_job_id, org_id) REFERENCES public.pipeline_jobs (id, org_id) ON DELETE SET NULL,
  CHECK (
    (status = 'running' AND finished_at IS NULL)
    OR (status IN ('completed', 'failed') AND finished_at IS NOT NULL)
  )
);

CREATE INDEX idx_extraction_stage_runs_run ON public.extraction_stage_runs (org_id, run_id, stage);

ALTER TABLE public.extraction_stage_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "extraction_stage_runs_select" ON public.extraction_stage_runs
  FOR SELECT USING (public.is_member_of_org(org_id));

CREATE TRIGGER set_extraction_stage_runs_updated_at
  BEFORE UPDATE ON public.extraction_stage_runs
  FOR EACH ROW EXECUTE FUNCTION public.set_workflow_updated_at();

-- Same terminal-immutability family, but simpler: no lease_id-style
-- exception is needed here (stage runs never carry a lease link).
CREATE FUNCTION public.enforce_extraction_stage_run_terminal_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.status IN ('completed', 'failed') THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.finished_at IS DISTINCT FROM OLD.finished_at
       OR NEW.stage IS DISTINCT FROM OLD.stage
       OR NEW.run_id IS DISTINCT FROM OLD.run_id
       OR (OLD.error_code IS NOT NULL AND NEW.error_code IS DISTINCT FROM OLD.error_code)
       OR (OLD.error_message IS NOT NULL AND NEW.error_message IS DISTINCT FROM OLD.error_message)
    THEN
      RAISE EXCEPTION 'extraction_stage_runs is terminal once completed/failed and cannot be changed (stage run %)', OLD.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_enforce_extraction_stage_run_terminal
  BEFORE UPDATE ON public.extraction_stage_runs
  FOR EACH ROW EXECUTE FUNCTION public.enforce_extraction_stage_run_terminal_guard();

-- ---------------------------------------------------------------------------
-- provider_invocations -- one row per outbound provider call.
-- Start-then-terminalize lifecycle (INSERT status='running' before the
-- call, UPDATE to completed/failed after) -- NOT insert-only, since the
-- whole point is recording that a call started even if the worker crashes
-- before its outcome is known.
-- ---------------------------------------------------------------------------
CREATE TABLE public.provider_invocations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL,
  run_id            UUID NOT NULL,
  stage_run_id      UUID NOT NULL,
  provider          TEXT NOT NULL CHECK (provider IN ('azure_document_intelligence', 'vertex_ai', 'gemini_api_key', 'docling')),
  operation         TEXT NOT NULL, -- e.g. 'layout_analysis','document_profile_classification','fact_extraction_chunk'
  model             TEXT,
  location          TEXT,
  chunk_index       INT,
  provider_attempt  INT NOT NULL DEFAULT 1,
  -- '<generation_id>:<stage>:<stage_attempt>:<provider>:<operation>:<chunk_index>:<provider_attempt>'
  -- distinguishes a pipeline-stage retry, a chunk identity, and a
  -- provider-level HTTP retry from each other -- a retried call gets a new
  -- provider_attempt (new key, new row), never overwrites/duplicates.
  invocation_key    TEXT NOT NULL,
  request_id        TEXT,
  request_fingerprint TEXT,
  http_status       INT,
  status            TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  success           BOOLEAN,
  -- Generic, cross-provider taxonomy -- NOT the Vertex-specific
  -- VertexFailureClassification enum promoted directly. P7 can evolve this
  -- without rewriting historical provider semantics.
  failure_classification TEXT CHECK (failure_classification IN (
    'authentication', 'authorization', 'quota', 'rate_limit', 'resource_exhausted', 'timeout',
    'transport', 'provider_client_error', 'provider_server_error', 'invalid_response',
    'schema_validation', 'cancelled', 'superseded', 'unknown'
  )),
  provider_error_code   TEXT, -- provider-specific detail kept separate from the generic classification
  provider_error_status TEXT,
  error_message     TEXT, -- sanitized, no secrets/document text
  input_tokens      INT,
  output_tokens     INT,
  latency_ms        INT,
  -- Split into request/response (round-3 fix): a single artifact_status
  -- column can't represent "the request payload stored fine but the
  -- response payload failed to persist" -- a real, distinguishable case.
  request_artifact_status  TEXT NOT NULL DEFAULT 'not_requested' CHECK (request_artifact_status  IN ('not_requested', 'pending', 'stored', 'unavailable', 'redacted')),
  response_artifact_status TEXT NOT NULL DEFAULT 'not_requested' CHECK (response_artifact_status IN ('not_requested', 'pending', 'stored', 'unavailable', 'redacted')),
  requested_at      TIMESTAMPTZ NOT NULL,
  completed_at      TIMESTAMPTZ,
  raw_request_artifact_id  UUID,
  raw_response_artifact_id UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, invocation_key),
  FOREIGN KEY (run_id, org_id) REFERENCES public.extraction_runs (id, org_id) ON DELETE CASCADE,
  -- 3-part: this invocation's stage_run_id must belong to THIS invocation's
  -- run_id, not just the same org -- a 2-part (stage_run_id, org_id) FK
  -- would let a same-org-but-wrong-run reference through.
  FOREIGN KEY (stage_run_id, run_id, org_id) REFERENCES public.extraction_stage_runs (id, run_id, org_id) ON DELETE CASCADE,
  CHECK (
    (status = 'running' AND completed_at IS NULL)
    OR (status IN ('completed', 'failed') AND completed_at IS NOT NULL)
  ),
  CHECK (completed_at IS NULL OR completed_at >= requested_at),
  CHECK (NOT (success = true AND status = 'failed')),
  CHECK (NOT (success = false AND status = 'completed')),
  CHECK (input_tokens IS NULL OR input_tokens >= 0),
  CHECK (output_tokens IS NULL OR output_tokens >= 0),
  CHECK (latency_ms IS NULL OR latency_ms >= 0)
);

CREATE INDEX idx_provider_invocations_stage_run ON public.provider_invocations (org_id, stage_run_id);
CREATE INDEX idx_provider_invocations_run ON public.provider_invocations (org_id, run_id);

ALTER TABLE public.provider_invocations ENABLE ROW LEVEL SECURITY;
-- This RLS policy exists for defense-in-depth (service_role/superuser
-- contexts bypass RLS anyway) but is NOT the actual read path for
-- authenticated org members -- authenticated has no SELECT grant on this
-- base table at all (see the REVOKE/safe-views block below); ordinary reads
-- go through provider_invocations_safe, which additionally omits
-- error_message/provider_error_status/request_fingerprint/invocation_key.
CREATE POLICY "provider_invocations_select" ON public.provider_invocations
  FOR SELECT USING (public.is_member_of_org(org_id));

-- Terminal guard: once completed/failed, nothing may change except moving
-- request_artifact_status/response_artifact_status and the
-- raw_request_artifact_id/raw_response_artifact_id pointers themselves
-- (artifact persistence can finish slightly after the invocation itself
-- terminalizes -- those columns are deliberately NOT in the DISTINCT FROM
-- checks below).
CREATE FUNCTION public.enforce_provider_invocation_terminal_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.status IN ('completed', 'failed') THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
       OR NEW.success IS DISTINCT FROM OLD.success
       OR NEW.input_tokens IS DISTINCT FROM OLD.input_tokens
       OR NEW.output_tokens IS DISTINCT FROM OLD.output_tokens
       OR NEW.latency_ms IS DISTINCT FROM OLD.latency_ms
       OR NEW.run_id IS DISTINCT FROM OLD.run_id
       OR NEW.stage_run_id IS DISTINCT FROM OLD.stage_run_id
    THEN
      RAISE EXCEPTION 'provider_invocations result/identity fields are immutable once terminal (invocation %)', OLD.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_enforce_provider_invocation_terminal
  BEFORE UPDATE ON public.provider_invocations
  FOR EACH ROW EXECUTE FUNCTION public.enforce_provider_invocation_terminal_guard();

-- ---------------------------------------------------------------------------
-- extraction_artifacts -- bounded inline or private-object-storage payloads,
-- with retention metadata since these may contain full lease text, names,
-- addresses, signatures, financial terms, or internal prompts.
-- ---------------------------------------------------------------------------
CREATE TABLE public.extraction_artifacts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL,
  run_id             UUID NOT NULL,
  stage_run_id       UUID,
  artifact_type      TEXT NOT NULL CHECK (artifact_type IN ('parser_raw_output', 'provider_raw_request', 'provider_raw_response', 'normalized_snapshot')),
  storage_mode       TEXT NOT NULL CHECK (storage_mode IN ('inline', 'storage_object')),
  inline_content     JSONB,
  storage_bucket     TEXT,
  storage_path       TEXT,
  content_type       TEXT NOT NULL DEFAULT 'application/json',
  byte_size          INT NOT NULL,
  truncated          BOOLEAN NOT NULL DEFAULT false, -- reserved for the rare case a payload exceeds even the storage_object hard ceiling; never used to silently drop retrievability under the normal <=200KB/">200KB" split
  sha256             TEXT,
  retention_class    TEXT NOT NULL DEFAULT 'debug_short_term' CHECK (retention_class IN ('debug_short_term', 'audit_standard', 'legal_hold')),
  expires_at         TIMESTAMPTZ, -- NULL for legal_hold
  contains_document_content BOOLEAN NOT NULL DEFAULT true,
  contains_personal_data    BOOLEAN NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (run_id, org_id) REFERENCES public.extraction_runs (id, org_id) ON DELETE CASCADE,
  -- 3-part, same reasoning as provider_invocations.stage_run_id: this
  -- artifact's stage_run_id must belong to the artifact's own run_id, not
  -- just the same org. Previously had no FK at all (round-3 fix).
  FOREIGN KEY (stage_run_id, run_id, org_id) REFERENCES public.extraction_stage_runs (id, run_id, org_id) ON DELETE SET NULL,
  CHECK (
    (storage_mode = 'inline' AND inline_content IS NOT NULL AND storage_path IS NULL)
    OR (storage_mode = 'storage_object' AND storage_path IS NOT NULL AND inline_content IS NULL)
  ),
  -- Hard backstop reusing the 2MB precedent from persist_lease_extraction_merge;
  -- the OPERATIVE limit deciding inline vs. storage_object is a much
  -- tighter app-level constant (MAX_ARTIFACT_INLINE_BYTES = 200_000, P1.4).
  CHECK (inline_content IS NULL OR octet_length(inline_content::text) <= 2000000)
);

CREATE INDEX idx_extraction_artifacts_run ON public.extraction_artifacts (org_id, run_id);

ALTER TABLE public.extraction_artifacts ENABLE ROW LEVEL SECURITY;
-- Deliberately NO blanket SELECT policy for org members -- raw provider
-- content is not broadly readable. The only read path is the audited
-- get_extraction_artifact_authorization() RPC below (+ the
-- get-extraction-artifact Edge Function, P1.5, for storage_object rows).

-- Now that extraction_artifacts exists, wire the FKs from provider_invocations
-- that were deferred during CREATE TABLE (artifact rows reference their run,
-- but the FK direction we actually want enforced is invocation -> artifact,
-- scoped to the same org). extraction_artifacts needs UNIQUE(id, org_id)
-- FIRST, before either composite FK below can reference it.
ALTER TABLE public.extraction_artifacts
  ADD CONSTRAINT extraction_artifacts_id_org_unique UNIQUE (id, org_id);
ALTER TABLE public.provider_invocations
  ADD CONSTRAINT provider_invocations_raw_request_artifact_fkey
    FOREIGN KEY (raw_request_artifact_id, org_id) REFERENCES public.extraction_artifacts (id, org_id) ON DELETE SET NULL;
ALTER TABLE public.provider_invocations
  ADD CONSTRAINT provider_invocations_raw_response_artifact_fkey
    FOREIGN KEY (raw_response_artifact_id, org_id) REFERENCES public.extraction_artifacts (id, org_id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- get_extraction_artifact_authorization -- the ONLY read path for raw
-- artifact content. Verifies org membership, verifies a privileged role
-- (not just "any member"), verifies the artifact belongs to that org, and
-- audits every access. No provider authorization headers/API keys/bearer
-- tokens/service-account material may ever be present in what this returns
-- -- that sanitization happens at write time (P1.4's transport wrappers),
-- not here.
--
-- Renamed from get_extraction_artifact (round-3 review): a plain SQL
-- function cannot itself mint a Supabase Storage signed URL (that requires
-- the Storage API's createSignedUrl, only reachable from the service-role
-- HTTP client). This RPC's job is authorization + audit + returning either
-- the inline content or the artifact's OWN storage_bucket/storage_path --
-- never a caller-supplied bucket/path. The new get-extraction-artifact Edge
-- Function (P1.5) calls this RPC, then mints the signed URL for
-- storage_object rows. The RPC body/logic below was already written this
-- way (it already returns bucket/path and comments that the Edge Function
-- signs it) -- only the name changes here, to match the two-boundary design.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_extraction_artifact_authorization(
  p_org_id UUID,
  p_artifact_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_artifact public.extraction_artifacts%ROWTYPE;
  v_actor_user_id UUID := auth.uid();
  v_actor_email TEXT;
  v_is_privileged BOOLEAN;
  v_response JSONB;
BEGIN
  IF p_org_id IS NULL OR p_artifact_id IS NULL THEN
    RAISE EXCEPTION 'org_id and artifact_id are required';
  END IF;

  -- Actor identity is derived ENTIRELY from the authenticated session
  -- (auth.uid()), never from a caller-supplied parameter -- otherwise an
  -- authenticated-but-unprivileged caller could pass someone else's user_id
  -- and have the privileged-role check evaluate that other user's role
  -- instead of their own. This applies to both the authorization decision
  -- and the audit record: what gets logged is who ACTUALLY called this,
  -- not what they claimed.
  IF v_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'No authenticated user session';
  END IF;

  IF NOT public.is_member_of_org(p_org_id) THEN
    RAISE EXCEPTION 'Not a member of this organization';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.memberships
     WHERE user_id = v_actor_user_id
       AND org_id = p_org_id
       AND role IN ('super_admin', 'org_admin', 'manager', 'auditor')
  ) INTO v_is_privileged;

  IF NOT v_is_privileged THEN
    RAISE EXCEPTION 'Retrieving raw extraction artifact content requires a privileged role (org_admin/manager/auditor/super_admin)';
  END IF;

  SELECT email INTO v_actor_email FROM auth.users WHERE id = v_actor_user_id;

  SELECT * INTO v_artifact
    FROM public.extraction_artifacts
   WHERE id = p_artifact_id AND org_id = p_org_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Artifact not found for this organization';
  END IF;

  IF v_artifact.storage_mode = 'inline' THEN
    v_response := jsonb_build_object(
      'artifact_id', v_artifact.id,
      'storage_mode', 'inline',
      'content_type', v_artifact.content_type,
      'byte_size', v_artifact.byte_size,
      'truncated', v_artifact.truncated,
      'content', v_artifact.inline_content
    );
  ELSE
    -- storage_object retrieval (signed URL) is generated by the calling
    -- Edge Function using supabaseAdmin.storage.from(bucket).createSignedUrl()
    -- with a short expiry -- this RPC returns the bucket/path/hash for the
    -- Edge Function to do that, rather than generating a URL from SQL.
    v_response := jsonb_build_object(
      'artifact_id', v_artifact.id,
      'storage_mode', 'storage_object',
      'storage_bucket', v_artifact.storage_bucket,
      'storage_path', v_artifact.storage_path,
      'content_type', v_artifact.content_type,
      'byte_size', v_artifact.byte_size,
      'sha256', v_artifact.sha256
    );
  END IF;

  -- Retrieval is always audited, never silent.
  INSERT INTO public.audit_logs (
    org_id, property_id, entity_type, entity_id, action,
    actor_user_id, actor_email, severity, source, before, after, metadata, "timestamp"
  )
  VALUES (
    p_org_id, NULL, 'ExtractionArtifact', p_artifact_id::TEXT, 'extraction_artifact_retrieved',
    v_actor_user_id, v_actor_email, 'info', 'edge_function',
    NULL, NULL,
    jsonb_build_object('storage_mode', v_artifact.storage_mode, 'artifact_type', v_artifact.artifact_type),
    v_now
  );

  RETURN v_response;
END;
$$;

-- Read RPC that performs its own membership + privileged-role check
-- internally (same shape as an RLS SELECT policy would) -- safe to grant to
-- authenticated directly, unlike the write RPCs below.
REVOKE ALL ON FUNCTION public.get_extraction_artifact_authorization(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_extraction_artifact_authorization(UUID, UUID) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Safe projection views (round-3 fix): RLS controls which ROWS a role can
-- see, not which COLUMNS within a granted table -- once `authenticated` has
-- SELECT on provider_invocations, every granted column is readable,
-- including error_message/provider_error_status/request_fingerprint, any of
-- which could echo provider or document content. The base tables below are
-- fully locked down for authenticated/anon (no SELECT grant at all, see
-- below); ordinary reads go through these views instead.
--
-- Deliberately NOT security_invoker = true. A security_invoker view checks
-- the UNDERLYING TABLE's privileges against the querying user -- meaning
-- authenticated would need direct SELECT on the base table for the view to
-- work at all, which defeats the entire point of hiding columns. Instead,
-- these are ordinary (owner-rights) views, and org-scoping is written
-- directly into each view's WHERE clause via is_member_of_org(org_id) --
-- a plain SQL predicate, not an RLS policy, so it is evaluated normally for
-- every invoking user regardless of the view owner's own RLS-bypass status.
-- This is the standard pattern for column-level security in Postgres: the
-- view owner's table privileges satisfy the permission CHECK, while the
-- explicit WHERE clause (calling auth.uid() indirectly via
-- is_member_of_org) still correctly scopes rows to the real caller.
-- ---------------------------------------------------------------------------
CREATE VIEW public.extraction_runs_safe AS
SELECT id, org_id, uploaded_file_id, lease_id, generation_id, run_type,
       provider_pipeline, contract_version, status, error_code,
       started_at, completed_at, created_at, updated_at
FROM public.extraction_runs
WHERE public.is_member_of_org(org_id);

CREATE VIEW public.extraction_stage_runs_safe AS
SELECT id, org_id, run_id, stage, attempt, status, provider, error_code,
       started_at, finished_at, created_at, updated_at
FROM public.extraction_stage_runs
WHERE public.is_member_of_org(org_id);

CREATE VIEW public.provider_invocations_safe AS
SELECT id, org_id, run_id, stage_run_id, provider, operation, model, location,
       chunk_index, provider_attempt, status, success, failure_classification,
       input_tokens, output_tokens, latency_ms, requested_at, completed_at,
       request_artifact_status, response_artifact_status, created_at
FROM public.provider_invocations
WHERE public.is_member_of_org(org_id);

-- All four provenance tables: writes are service-role-only (via the
-- SECURITY DEFINER recorder RPCs in later P1 migrations) -- no
-- INSERT/UPDATE/DELETE/SELECT grant to authenticated/anon on the base
-- tables at all. Ordinary reads go through the three _safe views above;
-- extraction_artifacts has NO view and NO grant of any kind for
-- authenticated -- get_extraction_artifact_authorization() (+ the
-- get-extraction-artifact Edge Function, P1.5) is the only read path.
REVOKE ALL ON public.extraction_runs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.extraction_stage_runs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.provider_invocations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.extraction_artifacts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.extraction_runs_safe TO authenticated;
GRANT SELECT ON public.extraction_stage_runs_safe TO authenticated;
GRANT SELECT ON public.provider_invocations_safe TO authenticated;
GRANT ALL ON public.extraction_runs, public.extraction_stage_runs, public.provider_invocations, public.extraction_artifacts TO service_role;

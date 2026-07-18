-- P2.3 — transactional claims persistence RPCs.
--
-- One additive schema change first: lease_claim_evidence needs a
-- deterministic dedup key so the batch RPC below can be genuinely
-- idempotent for evidence, not just for claims (which already dedup via
-- claim_key). Computed by the P2.4 adapter's evidence-key.ts
-- (file+run+page/span+source_text_hash+block/cell identity), passed in by
-- the caller -- the RPC never invents it.
ALTER TABLE public.lease_claim_evidence ADD COLUMN evidence_key TEXT;
UPDATE public.lease_claim_evidence SET evidence_key = id::text WHERE evidence_key IS NULL;
ALTER TABLE public.lease_claim_evidence ALTER COLUMN evidence_key SET NOT NULL;
ALTER TABLE public.lease_claim_evidence ADD CONSTRAINT lease_claim_evidence_evidence_key_check CHECK (char_length(evidence_key) BETWEEN 1 AND 600);
ALTER TABLE public.lease_claim_evidence ADD CONSTRAINT lease_claim_evidence_org_id_evidence_key_key UNIQUE (org_id, evidence_key);

-- ---------------------------------------------------------------------------
-- persist_lease_claim_ledger_batch -- the sole write path for claims,
-- evidence, and their links. service_role only (pipeline-internal, not
-- browser-facing) -- SECURITY DEFINER, fixed search_path, same template as
-- P1's six recorder RPCs.
--
-- p_claims / p_evidence / p_links are JSONB arrays. Each claim/evidence item
-- carries a caller-assigned "local_id" (unique within this one batch call)
-- so links can reference them before their real UUIDs exist -- resolved
-- internally via v_claim_id_map/v_evidence_id_map, never round-tripped
-- through the caller.
--
-- Idempotency: claims dedup via the existing UNIQUE(org_id, claim_key);
-- evidence dedups via the new UNIQUE(org_id, evidence_key) above; links
-- dedup via the existing UNIQUE(claim_id, evidence_id). Re-submitting an
-- identical batch produces zero new rows and succeeds.
--
-- Atomicity: this function runs inside the caller's transaction with no
-- internal exception handling -- any RAISE (a bad item, a stale generation,
-- a missing required-evidence link) aborts the WHOLE batch via ordinary
-- Postgres transaction semantics, undoing every insert already made this
-- call. "Reject partial batches" falls out of this for free; it is not
-- separately implemented.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.persist_lease_claim_ledger_batch(
  p_org_id UUID,
  p_uploaded_file_id UUID,
  p_lease_id UUID,
  p_extraction_run_id UUID,
  p_extraction_stage_run_id UUID,
  p_generation_id UUID,
  p_claims JSONB,
  p_evidence JSONB,
  p_links JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_active_generation_id UUID;
  v_claim JSONB;
  v_evidence_item JSONB;
  v_link JSONB;
  v_claim_id_map JSONB := '{}'::jsonb;
  v_evidence_id_map JSONB := '{}'::jsonb;
  v_claim_id UUID;
  v_evidence_id UUID;
  v_claims_inserted INT := 0;
  v_claims_already_existed INT := 0;
  v_evidence_inserted INT := 0;
  v_evidence_already_existed INT := 0;
  v_links_inserted INT := 0;
  v_missing_evidence_concept TEXT;
  v_file_found BOOLEAN;
BEGIN
  SELECT EXISTS (SELECT 1 FROM public.uploaded_files WHERE id = p_uploaded_file_id AND org_id = p_org_id) INTO v_file_found;
  IF NOT v_file_found THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'FILE_NOT_FOUND_IN_ORG');
  END IF;

  SELECT active_generation_id INTO v_active_generation_id
    FROM public.uploaded_files
   WHERE id = p_uploaded_file_id AND org_id = p_org_id;

  IF v_active_generation_id IS NULL OR v_active_generation_id IS DISTINCT FROM p_generation_id THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'STALE_GENERATION');
  END IF;

  -- Claims
  FOR v_claim IN SELECT * FROM jsonb_array_elements(COALESCE(p_claims, '[]'::jsonb))
  LOOP
    v_claim_id := NULL;

    INSERT INTO public.lease_claims (
      org_id, uploaded_file_id, lease_id, generation_id, extraction_run_id,
      extraction_stage_run_id, provider_invocation_id, producer_type,
      concept_key, registry_status, claims_registry_version,
      scope_key, instance_key, candidate_ordinal, assertion_status,
      normalized_value, raw_value_text, derivation, confidence,
      claim_key, supersedes_claim_id, metadata
    ) VALUES (
      p_org_id, p_uploaded_file_id, p_lease_id, p_generation_id, p_extraction_run_id,
      COALESCE(NULLIF(v_claim->>'extraction_stage_run_id', '')::uuid, p_extraction_stage_run_id),
      NULLIF(v_claim->>'provider_invocation_id', '')::uuid,
      v_claim->>'producer_type',
      v_claim->>'concept_key',
      v_claim->>'registry_status',
      v_claim->>'claims_registry_version',
      COALESCE(v_claim->>'scope_key', 'lease'),
      COALESCE(v_claim->>'instance_key', 'default'),
      COALESCE((v_claim->>'candidate_ordinal')::int, 0),
      v_claim->>'assertion_status',
      v_claim->>'normalized_value',
      v_claim->>'raw_value_text',
      COALESCE(v_claim->'derivation', '{}'::jsonb),
      NULLIF(v_claim->>'confidence', '')::numeric,
      v_claim->>'claim_key',
      NULLIF(v_claim->>'supersedes_claim_id', '')::uuid,
      COALESCE(v_claim->'metadata', '{}'::jsonb)
    )
    ON CONFLICT (org_id, claim_key) DO NOTHING
    RETURNING id INTO v_claim_id;

    IF v_claim_id IS NULL THEN
      SELECT id INTO v_claim_id FROM public.lease_claims
       WHERE org_id = p_org_id AND claim_key = v_claim->>'claim_key';
      v_claims_already_existed := v_claims_already_existed + 1;
    ELSE
      v_claims_inserted := v_claims_inserted + 1;
    END IF;

    v_claim_id_map := v_claim_id_map || jsonb_build_object(v_claim->>'local_id', v_claim_id::text);
  END LOOP;

  -- Evidence
  FOR v_evidence_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_evidence, '[]'::jsonb))
  LOOP
    v_evidence_id := NULL;

    INSERT INTO public.lease_claim_evidence (
      org_id, extraction_run_id, uploaded_file_id, evidence_key,
      location_precision, page_start, page_end, span_start, span_end,
      bounding_regions, block_ids, source_text, source_text_hash, artifact_id
    ) VALUES (
      p_org_id, p_extraction_run_id, p_uploaded_file_id, v_evidence_item->>'evidence_key',
      v_evidence_item->>'location_precision',
      NULLIF(v_evidence_item->>'page_start', '')::int,
      NULLIF(v_evidence_item->>'page_end', '')::int,
      NULLIF(v_evidence_item->>'span_start', '')::int,
      NULLIF(v_evidence_item->>'span_end', '')::int,
      v_evidence_item->'bounding_regions',
      CASE WHEN v_evidence_item ? 'block_ids' AND jsonb_typeof(v_evidence_item->'block_ids') = 'array'
           THEN ARRAY(SELECT jsonb_array_elements_text(v_evidence_item->'block_ids'))
           ELSE NULL END,
      v_evidence_item->>'source_text',
      v_evidence_item->>'source_text_hash',
      NULLIF(v_evidence_item->>'artifact_id', '')::uuid
    )
    ON CONFLICT (org_id, evidence_key) DO NOTHING
    RETURNING id INTO v_evidence_id;

    IF v_evidence_id IS NULL THEN
      SELECT id INTO v_evidence_id FROM public.lease_claim_evidence
       WHERE org_id = p_org_id AND evidence_key = v_evidence_item->>'evidence_key';
      v_evidence_already_existed := v_evidence_already_existed + 1;
    ELSE
      v_evidence_inserted := v_evidence_inserted + 1;
    END IF;

    v_evidence_id_map := v_evidence_id_map || jsonb_build_object(v_evidence_item->>'local_id', v_evidence_id::text);
  END LOOP;

  -- Links
  FOR v_link IN SELECT * FROM jsonb_array_elements(COALESCE(p_links, '[]'::jsonb))
  LOOP
    v_claim_id := NULLIF(v_claim_id_map->>(v_link->>'claim_local_id'), '')::uuid;
    v_evidence_id := NULLIF(v_evidence_id_map->>(v_link->>'evidence_local_id'), '')::uuid;

    IF v_claim_id IS NULL OR v_evidence_id IS NULL THEN
      RAISE EXCEPTION 'link references unknown claim_local_id % or evidence_local_id %', v_link->>'claim_local_id', v_link->>'evidence_local_id';
    END IF;

    INSERT INTO public.lease_claim_evidence_links (org_id, extraction_run_id, claim_id, evidence_id, link_role)
    VALUES (p_org_id, p_extraction_run_id, v_claim_id, v_evidence_id, COALESCE(v_link->>'link_role', 'primary'))
    ON CONFLICT (claim_id, evidence_id) DO NOTHING;

    v_links_inserted := v_links_inserted + 1;
  END LOOP;

  -- Required-evidence enforcement (fails the whole batch, per the atomicity
  -- note above): a value-bearing claim for a registry concept with
  -- evidence_required=true must have at least one linked evidence row,
  -- whether that link came from this batch or an earlier one.
  SELECT lc.concept_key INTO v_missing_evidence_concept
    FROM public.lease_claims lc
    JOIN public.lease_claim_concepts lcc
      ON lcc.concept_key = lc.concept_key AND lcc.registry_version = lc.claims_registry_version
   WHERE lc.id IN (SELECT (value::text)::uuid FROM jsonb_each_text(v_claim_id_map))
     AND lcc.evidence_required = true
     AND lc.assertion_status IN ('asserted', 'derived', 'calculated')
     AND NOT EXISTS (SELECT 1 FROM public.lease_claim_evidence_links l WHERE l.claim_id = lc.id)
   LIMIT 1;

  IF v_missing_evidence_concept IS NOT NULL THEN
    RAISE EXCEPTION 'claim for concept % requires evidence but has none linked -- batch rejected', v_missing_evidence_concept;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'claims_inserted', v_claims_inserted,
    'claims_already_existed', v_claims_already_existed,
    'evidence_inserted', v_evidence_inserted,
    'evidence_already_existed', v_evidence_already_existed,
    'links_inserted', v_links_inserted,
    'claim_id_map', v_claim_id_map,
    'evidence_id_map', v_evidence_id_map
  );
END;
$$;

REVOKE ALL ON FUNCTION public.persist_lease_claim_ledger_batch(UUID, UUID, UUID, UUID, UUID, UUID, JSONB, JSONB, JSONB) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.persist_lease_claim_ledger_batch(UUID, UUID, UUID, UUID, UUID, UUID, JSONB, JSONB, JSONB) TO service_role;

-- ---------------------------------------------------------------------------
-- create_reviewer_replacement_claim -- the ONLY way a reviewer-sourced
-- correction comes into existence. Always a NEW row (producer_type
-- ='reviewer', supersedes_claim_id set) -- the original claim is never
-- touched, enforced already by lease_claims' own immutability trigger and
-- the supersession-compatibility trigger (same concept/scope/instance).
-- Actor identity: auth.uid() only, never a caller-supplied id (same fix
-- already applied to get_extraction_artifact_authorization in P1.1).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_reviewer_replacement_claim(
  p_org_id UUID,
  p_source_claim_id UUID,
  p_assertion_status TEXT,
  p_normalized_value TEXT,
  p_raw_value_text TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor_user_id UUID := auth.uid();
  v_source RECORD;
  v_new_claim_id UUID;
  v_new_claim_key TEXT;
BEGIN
  IF v_actor_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'NOT_AUTHENTICATED');
  END IF;

  IF NOT public.is_member_of_org(p_org_id) THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'NOT_ORG_MEMBER');
  END IF;

  SELECT * INTO v_source FROM public.lease_claims WHERE id = p_source_claim_id AND org_id = p_org_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'SOURCE_CLAIM_NOT_FOUND');
  END IF;

  v_new_claim_key := v_source.claim_key || ':reviewer:' || gen_random_uuid()::text;

  INSERT INTO public.lease_claims (
    org_id, uploaded_file_id, lease_id, generation_id, extraction_run_id,
    extraction_stage_run_id, provider_invocation_id, producer_type,
    concept_key, registry_status, claims_registry_version,
    scope_key, instance_key, candidate_ordinal, assertion_status,
    normalized_value, raw_value_text, claim_key, supersedes_claim_id,
    metadata
  ) VALUES (
    v_source.org_id, v_source.uploaded_file_id, v_source.lease_id, v_source.generation_id, v_source.extraction_run_id,
    NULL, NULL, 'reviewer',
    v_source.concept_key, v_source.registry_status, v_source.claims_registry_version,
    v_source.scope_key, v_source.instance_key, v_source.candidate_ordinal, p_assertion_status,
    p_normalized_value, p_raw_value_text, v_new_claim_key, p_source_claim_id,
    jsonb_build_object('reviewer_user_id', v_actor_user_id::text)
  )
  RETURNING id INTO v_new_claim_id;

  RETURN jsonb_build_object('success', true, 'replacement_claim_id', v_new_claim_id);
END;
$$;

REVOKE ALL ON FUNCTION public.create_reviewer_replacement_claim(UUID, UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_reviewer_replacement_claim(UUID, UUID, TEXT, TEXT, TEXT) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- record_claim_review_decision -- append-only, actor derived server-side.
-- The decision-specific required-field CHECK constraint on
-- lease_claim_review_decisions is the actual validation authority; this RPC
-- just derives identity and inserts.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_claim_review_decision(
  p_org_id UUID,
  p_lease_id UUID,
  p_decision_type TEXT,
  p_claim_id UUID DEFAULT NULL,
  p_replacement_claim_id UUID DEFAULT NULL,
  p_conflict_group_id UUID DEFAULT NULL,
  p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor_user_id UUID := auth.uid();
  v_actor_email TEXT;
  v_decision_id UUID;
BEGIN
  IF v_actor_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'NOT_AUTHENTICATED');
  END IF;

  IF NOT public.is_member_of_org(p_org_id) THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'NOT_ORG_MEMBER');
  END IF;

  SELECT email INTO v_actor_email FROM auth.users WHERE id = v_actor_user_id;

  INSERT INTO public.lease_claim_review_decisions (
    org_id, lease_id, decision_type, claim_id, replacement_claim_id,
    conflict_group_id, reason, actor_user_id, actor_email
  ) VALUES (
    p_org_id, p_lease_id, p_decision_type, p_claim_id, p_replacement_claim_id,
    p_conflict_group_id, p_reason, v_actor_user_id, v_actor_email
  )
  RETURNING id INTO v_decision_id;

  RETURN jsonb_build_object('success', true, 'decision_id', v_decision_id);
END;
$$;

REVOKE ALL ON FUNCTION public.record_claim_review_decision(UUID, UUID, TEXT, UUID, UUID, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_claim_review_decision(UUID, UUID, TEXT, UUID, UUID, UUID, TEXT) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- resolve_claim_conflict -- transitions a conflict group to 'resolved' (via
-- the existing controlled state-machine trigger) and records the decision
-- in one call. p_replacement_claim_id must share the group's exact fact
-- slot (concept_key/scope_key/instance_key) -- validated here since the
-- conflict_groups table's own trigger only validates member rows, not the
-- resolution_claim_id column.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_claim_conflict(
  p_org_id UUID,
  p_conflict_group_id UUID,
  p_replacement_claim_id UUID,
  p_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor_user_id UUID := auth.uid();
  v_actor_email TEXT;
  v_group RECORD;
  v_claim RECORD;
  v_decision_id UUID;
BEGIN
  IF v_actor_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'NOT_AUTHENTICATED');
  END IF;

  IF NOT public.is_member_of_org(p_org_id) THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'NOT_ORG_MEMBER');
  END IF;

  SELECT * INTO v_group FROM public.lease_claim_conflict_groups WHERE id = p_conflict_group_id AND org_id = p_org_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'CONFLICT_GROUP_NOT_FOUND');
  END IF;

  IF v_group.status NOT IN ('open', 'reopened') THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'CONFLICT_GROUP_NOT_OPEN');
  END IF;

  SELECT * INTO v_claim FROM public.lease_claims WHERE id = p_replacement_claim_id AND org_id = p_org_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'REPLACEMENT_CLAIM_NOT_FOUND');
  END IF;

  IF v_claim.concept_key IS DISTINCT FROM v_group.concept_key
     OR v_claim.scope_key IS DISTINCT FROM v_group.scope_key
     OR v_claim.instance_key IS DISTINCT FROM v_group.instance_key THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'REPLACEMENT_CLAIM_WRONG_FACT_SLOT');
  END IF;

  UPDATE public.lease_claim_conflict_groups
     SET status = 'resolved', resolution_claim_id = p_replacement_claim_id, resolved_at = now()
   WHERE id = p_conflict_group_id;

  SELECT email INTO v_actor_email FROM auth.users WHERE id = v_actor_user_id;

  INSERT INTO public.lease_claim_review_decisions (
    org_id, lease_id, decision_type, conflict_group_id, replacement_claim_id,
    reason, actor_user_id, actor_email
  ) VALUES (
    p_org_id, v_group.lease_id, 'resolve_conflict', p_conflict_group_id, p_replacement_claim_id,
    p_reason, v_actor_user_id, v_actor_email
  )
  RETURNING id INTO v_decision_id;

  RETURN jsonb_build_object('success', true, 'decision_id', v_decision_id);
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_claim_conflict(UUID, UUID, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_claim_conflict(UUID, UUID, UUID, TEXT) TO authenticated, service_role;

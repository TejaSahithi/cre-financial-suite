-- P2.5 — conflict detection.
--
-- The Wave-1 spec defines conflict identity as
-- (concept_key, scope_key, instance_key, generation_id) -- P2.1's original
-- lease_claim_conflict_groups schema omitted generation_id (built before
-- this spec was handed down). Adding it now, additively: the table is
-- still empty in every environment this has been applied to (100%
-- local/pre-release, nothing pushed), so a direct NOT NULL column add is
-- safe with no backfill needed.
ALTER TABLE public.lease_claim_conflict_groups ADD COLUMN generation_id UUID NOT NULL;
CREATE INDEX idx_lease_claim_conflict_groups_generation ON public.lease_claim_conflict_groups (org_id, generation_id);

-- The fact-slot-match trigger (P2.1) must also confirm a member's claim
-- belongs to the SAME generation as the group, not just the same
-- concept/scope/instance/file -- otherwise a later generation's
-- conflict-detection run could attach its claims to an older generation's
-- still-open conflict group.
CREATE OR REPLACE FUNCTION public.enforce_lease_claim_conflict_member_fact_slot_match()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_group RECORD;
  v_claim RECORD;
BEGIN
  SELECT concept_key, scope_key, instance_key, uploaded_file_id, generation_id INTO v_group
    FROM public.lease_claim_conflict_groups WHERE id = NEW.conflict_group_id;
  SELECT concept_key, scope_key, instance_key, uploaded_file_id, generation_id INTO v_claim
    FROM public.lease_claims WHERE id = NEW.claim_id;

  IF v_group.concept_key IS DISTINCT FROM v_claim.concept_key
     OR v_group.scope_key IS DISTINCT FROM v_claim.scope_key
     OR v_group.instance_key IS DISTINCT FROM v_claim.instance_key
     OR v_group.uploaded_file_id IS DISTINCT FROM v_claim.uploaded_file_id
     OR v_group.generation_id IS DISTINCT FROM v_claim.generation_id THEN
    RAISE EXCEPTION 'claim % does not share conflict group %''s fact slot (concept_key/scope_key/instance_key/uploaded_file_id/generation_id)', NEW.claim_id, NEW.conflict_group_id;
  END IF;
  RETURN NEW;
END;
$$;

-- generation_id joins the frozen identity-column set in the group
-- transition trigger (P2.1), alongside the existing lease_id-nulling
-- exception from the P1/P2.1 deletion-behavior fix.
CREATE OR REPLACE FUNCTION public.enforce_lease_claim_conflict_group_transitions()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.lease_id IS NULL AND OLD.lease_id IS NOT NULL
     AND NEW.org_id IS NOT DISTINCT FROM OLD.org_id
     AND NEW.uploaded_file_id IS NOT DISTINCT FROM OLD.uploaded_file_id
     AND NEW.generation_id IS NOT DISTINCT FROM OLD.generation_id
     AND NEW.concept_key IS NOT DISTINCT FROM OLD.concept_key
     AND NEW.scope_key IS NOT DISTINCT FROM OLD.scope_key
     AND NEW.instance_key IS NOT DISTINCT FROM OLD.instance_key
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.resolution_claim_id IS NOT DISTINCT FROM OLD.resolution_claim_id
     AND NEW.resolved_at IS NOT DISTINCT FROM OLD.resolved_at
     AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
  THEN
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.lease_id IS DISTINCT FROM OLD.lease_id
     OR NEW.uploaded_file_id IS DISTINCT FROM OLD.uploaded_file_id
     OR NEW.generation_id IS DISTINCT FROM OLD.generation_id
     OR NEW.concept_key IS DISTINCT FROM OLD.concept_key
     OR NEW.scope_key IS DISTINCT FROM OLD.scope_key
     OR NEW.instance_key IS DISTINCT FROM OLD.instance_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'lease_claim_conflict_groups identity columns are immutable (group %)', OLD.id;
  END IF;

  IF NOT (
    (OLD.status = 'open' AND NEW.status = 'resolved')
    OR (OLD.status = 'resolved' AND NEW.status = 'reopened')
    OR (OLD.status = 'reopened' AND NEW.status = 'resolved')
  ) THEN
    RAISE EXCEPTION 'illegal conflict group status transition % -> % (group %)', OLD.status, NEW.status, OLD.id;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- detect_and_persist_claim_conflicts -- groups a generation's value-bearing
-- claims by fact slot and opens a conflict group for any slot with more
-- than one genuinely distinct value. Comparison here is a single
-- case/whitespace-insensitive string comparison (lower(btrim(...))) --
-- sufficient because claim-normalization.ts already canonicalizes money/
-- percentage/decimal/integer/date/boolean into one fixed string
-- representation at persistence time ("$6,004.00"/"6004"/"6004.00" all
-- normalize to "6004.00"), so this one SQL expression correctly handles
-- every value type without re-implementing per-type parsing in SQL
-- (claim-comparison.ts, the TS reference implementation, documents this
-- same reasoning).
--
-- Idempotent: re-running detection over the same claim set reuses any
-- already-open/reopened group for that exact fact slot (org+generation+
-- concept+scope+instance) rather than creating a duplicate, and re-adding
-- an already-linked claim is a safe no-op via
-- lease_claim_conflict_members' own UNIQUE(conflict_group_id, claim_id).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.detect_and_persist_claim_conflicts(
  p_org_id UUID,
  p_uploaded_file_id UUID,
  p_lease_id UUID,
  p_generation_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_group RECORD;
  v_group_id UUID;
  v_groups_created INT := 0;
  v_groups_already_open INT := 0;
  v_members_linked INT := 0;
BEGIN
  FOR v_group IN
    SELECT concept_key, scope_key, instance_key, array_agg(id) AS claim_ids
      FROM public.lease_claims
     WHERE org_id = p_org_id AND generation_id = p_generation_id
       AND assertion_status IN ('asserted', 'derived', 'calculated')
       AND normalized_value IS NOT NULL
     GROUP BY concept_key, scope_key, instance_key
    HAVING count(DISTINCT lower(btrim(normalized_value))) > 1
  LOOP
    SELECT id INTO v_group_id
      FROM public.lease_claim_conflict_groups
     WHERE org_id = p_org_id AND generation_id = p_generation_id
       AND concept_key = v_group.concept_key
       AND scope_key = v_group.scope_key
       AND instance_key = v_group.instance_key
       AND status IN ('open', 'reopened')
     LIMIT 1;

    IF v_group_id IS NULL THEN
      INSERT INTO public.lease_claim_conflict_groups (org_id, lease_id, uploaded_file_id, generation_id, concept_key, scope_key, instance_key)
      VALUES (p_org_id, p_lease_id, p_uploaded_file_id, p_generation_id, v_group.concept_key, v_group.scope_key, v_group.instance_key)
      RETURNING id INTO v_group_id;
      v_groups_created := v_groups_created + 1;
    ELSE
      v_groups_already_open := v_groups_already_open + 1;
    END IF;

    INSERT INTO public.lease_claim_conflict_members (org_id, conflict_group_id, claim_id)
    SELECT p_org_id, v_group_id, claim_id FROM unnest(v_group.claim_ids) AS claim_id
    ON CONFLICT (conflict_group_id, claim_id) DO NOTHING;
    GET DIAGNOSTICS v_members_linked = ROW_COUNT;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'groups_created', v_groups_created,
    'groups_already_open', v_groups_already_open
  );
END;
$$;

REVOKE ALL ON FUNCTION public.detect_and_persist_claim_conflicts(UUID, UUID, UUID, UUID) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.detect_and_persist_claim_conflicts(UUID, UUID, UUID, UUID) TO service_role;

-- lease_claim_conflict_groups_safe (P2.1) needs to include the new
-- generation_id column -- a legitimate structural column, not sensitive
-- content, and grants to authenticated remain deferred regardless.
-- CREATE OR REPLACE VIEW cannot insert a column into the middle of an
-- existing column list (only append at the end), so drop and recreate --
-- safe since nothing has been granted SELECT on this view yet.
DROP VIEW public.lease_claim_conflict_groups_safe;
CREATE VIEW public.lease_claim_conflict_groups_safe AS
SELECT
  id, org_id, lease_id, uploaded_file_id, generation_id,
  concept_key, scope_key, instance_key,
  status, resolution_claim_id, resolved_at, created_at, updated_at
FROM public.lease_claim_conflict_groups
WHERE public.is_member_of_org(org_id);

-- P2.1 — lease_claim_conflict_groups / lease_claim_conflict_members /
-- lease_claim_review_decisions.
--
-- An "ambiguous" fact (round-1 decision) is represented as multiple separate
-- 'asserted' lease_claims rows for the same concept/scope/instance, linked
-- into ONE open conflict group here -- never a bounded multi-value object on
-- a single claim. Members and claims are immutable; the GROUP itself is
-- mutable (status/resolution), but only through the controlled state
-- machine below, never an arbitrary UPDATE.

CREATE TABLE public.lease_claim_conflict_groups (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- Nullable + ON DELETE SET NULL, same provenance-survives-business-record-
  -- deletion rationale as lease_claims.lease_id.
  lease_id          UUID,
  uploaded_file_id  UUID NOT NULL,

  -- The fact slot this group represents disagreement about.
  concept_key  TEXT NOT NULL,
  scope_key    TEXT NOT NULL DEFAULT 'lease',
  instance_key TEXT NOT NULL DEFAULT 'default',

  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'reopened')),
  resolution_claim_id UUID,
  resolved_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (id, org_id),
  -- Column-scoped SET NULL on both: a bare SET NULL would null org_id too
  -- (NOT NULL) whenever a linked lease/claim is deleted.
  FOREIGN KEY (lease_id, org_id) REFERENCES public.leases (id, org_id) ON DELETE SET NULL (lease_id),
  FOREIGN KEY (uploaded_file_id, org_id) REFERENCES public.uploaded_files (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (resolution_claim_id, org_id) REFERENCES public.lease_claims (id, org_id) ON DELETE SET NULL (resolution_claim_id),

  CHECK (
    (status = 'open' AND resolution_claim_id IS NULL AND resolved_at IS NULL)
    OR (status = 'resolved' AND resolution_claim_id IS NOT NULL AND resolved_at IS NOT NULL)
    OR (status = 'reopened' AND resolution_claim_id IS NULL AND resolved_at IS NULL)
  ),
  CHECK (char_length(concept_key) BETWEEN 1 AND 200),
  CHECK (char_length(scope_key) BETWEEN 1 AND 200),
  CHECK (char_length(instance_key) BETWEEN 1 AND 200)
);

CREATE INDEX idx_lease_claim_conflict_groups_lease ON public.lease_claim_conflict_groups (org_id, lease_id) WHERE lease_id IS NOT NULL;
CREATE INDEX idx_lease_claim_conflict_groups_status ON public.lease_claim_conflict_groups (org_id, status);

ALTER TABLE public.lease_claim_conflict_groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_claim_conflict_groups_org_select ON public.lease_claim_conflict_groups
  FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_claim_conflict_groups FROM authenticated, anon;

-- Controlled state machine: identity columns are frozen forever; status may
-- only move open -> resolved, resolved -> reopened, or reopened -> resolved
-- (never resolved -> open, never a same-status no-op update, never skipping
-- straight to reopened from open). A future P2.x RPC is the intended
-- caller, but the invariant is enforced here regardless of caller.
CREATE OR REPLACE FUNCTION public.enforce_lease_claim_conflict_group_transitions()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Single narrow exception, same rationale as lease_claims: leases(id)
  -- ON DELETE SET NULL fires an UPDATE that nulls lease_id alone, and must
  -- be allowed through untouched -- otherwise deleting a lease with an open
  -- conflict group would fail outright, defeating round-2 correction #8.
  IF NEW.lease_id IS NULL AND OLD.lease_id IS NOT NULL
     AND NEW.org_id IS NOT DISTINCT FROM OLD.org_id
     AND NEW.uploaded_file_id IS NOT DISTINCT FROM OLD.uploaded_file_id
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

CREATE TRIGGER trg_enforce_lease_claim_conflict_group_transitions
  BEFORE UPDATE ON public.lease_claim_conflict_groups
  FOR EACH ROW EXECUTE FUNCTION public.enforce_lease_claim_conflict_group_transitions();

-- ---------------------------------------------------------------------------
-- lease_claim_conflict_members -- immutable once inserted. A member's claim
-- must share the group's exact fact slot (concept_key/scope_key/instance_key)
-- and tenant, enforced by a trigger since composite FKs alone can't compare
-- two different tables' non-key columns.
-- ---------------------------------------------------------------------------
CREATE TABLE public.lease_claim_conflict_members (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  conflict_group_id UUID NOT NULL,
  claim_id          UUID NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (conflict_group_id, claim_id),
  FOREIGN KEY (conflict_group_id, org_id) REFERENCES public.lease_claim_conflict_groups (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (claim_id, org_id) REFERENCES public.lease_claims (id, org_id) ON DELETE CASCADE
);

CREATE INDEX idx_lease_claim_conflict_members_group ON public.lease_claim_conflict_members (conflict_group_id);
CREATE INDEX idx_lease_claim_conflict_members_claim ON public.lease_claim_conflict_members (claim_id);

ALTER TABLE public.lease_claim_conflict_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_claim_conflict_members_org_select ON public.lease_claim_conflict_members
  FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_claim_conflict_members FROM authenticated, anon;

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
  SELECT concept_key, scope_key, instance_key, lease_id, uploaded_file_id INTO v_group
    FROM public.lease_claim_conflict_groups WHERE id = NEW.conflict_group_id;
  SELECT concept_key, scope_key, instance_key, lease_id, uploaded_file_id INTO v_claim
    FROM public.lease_claims WHERE id = NEW.claim_id;

  IF v_group.concept_key IS DISTINCT FROM v_claim.concept_key
     OR v_group.scope_key IS DISTINCT FROM v_claim.scope_key
     OR v_group.instance_key IS DISTINCT FROM v_claim.instance_key
     OR v_group.uploaded_file_id IS DISTINCT FROM v_claim.uploaded_file_id THEN
    RAISE EXCEPTION 'claim % does not share conflict group %''s fact slot (concept_key/scope_key/instance_key/uploaded_file_id)', NEW.claim_id, NEW.conflict_group_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_enforce_lease_claim_conflict_member_fact_slot_match
  BEFORE INSERT ON public.lease_claim_conflict_members
  FOR EACH ROW EXECUTE FUNCTION public.enforce_lease_claim_conflict_member_fact_slot_match();

CREATE OR REPLACE FUNCTION public.enforce_lease_claim_conflict_members_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'lease_claim_conflict_members rows are immutable (member %)', OLD.id;
END;
$$;

CREATE TRIGGER trg_lease_claim_conflict_members_immutable
  BEFORE UPDATE ON public.lease_claim_conflict_members
  FOR EACH ROW EXECUTE FUNCTION public.enforce_lease_claim_conflict_members_immutable();

-- ---------------------------------------------------------------------------
-- lease_claim_review_decisions -- append-only reviewer decision log.
-- Round-2 correction #7: decision/relationship combinations are enforced
-- structurally, per decision type, rather than an unconstrained set of
-- nullable FKs. Secure actor-identity derivation (auth.uid()-only, never a
-- caller-supplied actor id) is explicitly a P2.3 RPC acceptance item, not
-- claimed here -- this migration only makes the table append-only, revokes
-- direct authenticated writes, and enforces the structural CHECKs.
-- ---------------------------------------------------------------------------
CREATE TABLE public.lease_claim_review_decisions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lease_id      UUID,

  decision_type TEXT NOT NULL CHECK (decision_type IN (
    'accept', 'reject', 'edit',
    'mark_not_applicable', 'mark_not_present', 'mark_manual_required',
    'resolve_conflict', 'reopen'
  )),

  claim_id             UUID,
  replacement_claim_id UUID,
  conflict_group_id    UUID,
  reason               TEXT,

  actor_user_id UUID,
  actor_email   TEXT,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Column-scoped SET NULL: a bare SET NULL would null org_id too (NOT
  -- NULL) whenever a linked lease is deleted.
  FOREIGN KEY (lease_id, org_id) REFERENCES public.leases (id, org_id) ON DELETE SET NULL (lease_id),
  FOREIGN KEY (claim_id, org_id) REFERENCES public.lease_claims (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (replacement_claim_id, org_id) REFERENCES public.lease_claims (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (conflict_group_id, org_id) REFERENCES public.lease_claim_conflict_groups (id, org_id) ON DELETE RESTRICT,

  -- Decision-specific required-field combinations (round-2 correction #7).
  CHECK (
    (decision_type = 'accept' AND claim_id IS NOT NULL AND replacement_claim_id IS NULL AND conflict_group_id IS NULL)
    OR (decision_type = 'reject' AND claim_id IS NOT NULL AND reason IS NOT NULL AND replacement_claim_id IS NULL AND conflict_group_id IS NULL)
    OR (decision_type = 'edit' AND claim_id IS NOT NULL AND replacement_claim_id IS NOT NULL AND reason IS NOT NULL AND conflict_group_id IS NULL)
    OR (decision_type IN ('mark_not_applicable', 'mark_not_present', 'mark_manual_required') AND claim_id IS NOT NULL AND replacement_claim_id IS NOT NULL AND conflict_group_id IS NULL)
    OR (decision_type = 'resolve_conflict' AND conflict_group_id IS NOT NULL AND replacement_claim_id IS NOT NULL AND claim_id IS NULL)
    OR (decision_type = 'reopen' AND conflict_group_id IS NOT NULL AND reason IS NOT NULL AND claim_id IS NULL AND replacement_claim_id IS NULL)
  ),
  CHECK (reason IS NULL OR char_length(reason) <= 2000),
  CHECK (octet_length(metadata::text) <= 20000)
);

CREATE INDEX idx_lease_claim_review_decisions_lease ON public.lease_claim_review_decisions (org_id, lease_id) WHERE lease_id IS NOT NULL;
CREATE INDEX idx_lease_claim_review_decisions_claim ON public.lease_claim_review_decisions (claim_id) WHERE claim_id IS NOT NULL;
CREATE INDEX idx_lease_claim_review_decisions_conflict_group ON public.lease_claim_review_decisions (conflict_group_id) WHERE conflict_group_id IS NOT NULL;

ALTER TABLE public.lease_claim_review_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_claim_review_decisions_org_select ON public.lease_claim_review_decisions
  FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_claim_review_decisions FROM authenticated, anon;

CREATE OR REPLACE FUNCTION public.enforce_lease_claim_review_decisions_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Single narrow exception, same rationale as lease_claims: leases(id)
  -- ON DELETE SET NULL fires an UPDATE that nulls lease_id alone, and must
  -- be allowed through untouched -- otherwise deleting a lease with a
  -- recorded review decision would fail outright, defeating round-2
  -- correction #8.
  IF NEW.lease_id IS NULL AND OLD.lease_id IS NOT NULL
     AND NEW.org_id IS NOT DISTINCT FROM OLD.org_id
     AND NEW.decision_type IS NOT DISTINCT FROM OLD.decision_type
     AND NEW.claim_id IS NOT DISTINCT FROM OLD.claim_id
     AND NEW.replacement_claim_id IS NOT DISTINCT FROM OLD.replacement_claim_id
     AND NEW.conflict_group_id IS NOT DISTINCT FROM OLD.conflict_group_id
     AND NEW.reason IS NOT DISTINCT FROM OLD.reason
     AND NEW.actor_user_id IS NOT DISTINCT FROM OLD.actor_user_id
     AND NEW.actor_email IS NOT DISTINCT FROM OLD.actor_email
     AND NEW.metadata IS NOT DISTINCT FROM OLD.metadata
     AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'lease_claim_review_decisions rows are append-only and immutable (decision %)', OLD.id;
END;
$$;

CREATE TRIGGER trg_lease_claim_review_decisions_immutable
  BEFORE UPDATE ON public.lease_claim_review_decisions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_lease_claim_review_decisions_immutable();

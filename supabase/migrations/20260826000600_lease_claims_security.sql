-- P2.1 — security consolidation: safe projection views over the claims
-- ledger tables, created now for forward-compatibility but NOT yet granted
-- to `authenticated` (security-posture adjustment agreed for P2.1: there is
-- no frontend/API consumer of the ledger yet, so granting a new data
-- surface before there's an actual use case would be premature -- grants
-- land in P2.6 alongside the first real reader).
--
-- REVOKE ALL on every base table was already applied inline in each table's
-- own migration (20260826000200 through 20260826000500) -- this migration
-- only adds the views.
--
-- Ordinary (owner-rights) views with an explicit
-- `WHERE public.is_member_of_org(org_id)` predicate, NOT
-- `security_invoker = true` -- the same fix P1 already had to apply after
-- discovering security_invoker requires the base-table grant to exist for
-- the querying role in the first place, which would defeat the entire
-- point of revoking it.
--
-- Each view excludes columns that can carry raw extracted document text,
-- freeform debug detail, or actor PII not meant for an ordinary org member:
-- lease_claims excludes raw_value_text/derivation/metadata; lease_claim_evidence
-- excludes source_text/source_text_hash/span_start/span_end/bounding_regions/
-- block_ids entirely (this is exactly the raw evidence text/geometry the
-- honest location_precision design exists to describe, never to broadly
-- expose); lease_claim_review_decisions excludes actor_email/metadata.

CREATE VIEW public.lease_claims_safe AS
SELECT
  id, org_id, uploaded_file_id, lease_id, generation_id,
  extraction_run_id, extraction_stage_run_id, provider_invocation_id,
  producer_type, concept_key, registry_status, claims_registry_version,
  scope_key, instance_key, candidate_ordinal,
  assertion_status, normalized_value, confidence,
  claim_key, supersedes_claim_id, created_at
FROM public.lease_claims
WHERE public.is_member_of_org(org_id);

CREATE VIEW public.lease_claim_evidence_safe AS
SELECT
  id, org_id, extraction_run_id, uploaded_file_id,
  location_precision, page_start, page_end, artifact_id, created_at
FROM public.lease_claim_evidence
WHERE public.is_member_of_org(org_id);

CREATE VIEW public.lease_claim_conflict_groups_safe AS
SELECT
  id, org_id, lease_id, uploaded_file_id,
  concept_key, scope_key, instance_key,
  status, resolution_claim_id, resolved_at, created_at, updated_at
FROM public.lease_claim_conflict_groups
WHERE public.is_member_of_org(org_id);

CREATE VIEW public.lease_claim_review_decisions_safe AS
SELECT
  id, org_id, lease_id, decision_type,
  claim_id, replacement_claim_id, conflict_group_id, reason,
  actor_user_id, created_at
FROM public.lease_claim_review_decisions
WHERE public.is_member_of_org(org_id);

-- No GRANT SELECT ... TO authenticated on any of the four views above --
-- deferred to P2.6. Not granting anything to anon either. service_role
-- retains its platform-default access and continues to read base tables
-- directly where needed (e.g. a future audit/debug RPC).

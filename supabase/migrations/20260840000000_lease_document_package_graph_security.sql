-- P3.2 — security consolidation: safe projection views over the package
-- graph tables, created now for forward-compatibility but NOT yet granted to
-- `authenticated` -- same deferred posture as P2.1/P3.1. Base tables already
-- REVOKE ALL from authenticated/anon inline in their own migrations.
--
-- Ordinary (owner-rights) views with an explicit
-- `WHERE public.is_member_of_org(org_id)` predicate, NOT
-- `security_invoker = true` (same fix already applied in P2.1/P3.1).

CREATE VIEW public.lease_document_packages_safe AS
SELECT
  id, org_id, lease_id, package_key, package_status, primary_document_id,
  package_version, created_by_type, created_at, updated_at
FROM public.lease_document_packages
WHERE public.is_member_of_org(org_id);

CREATE VIEW public.lease_package_documents_safe AS
SELECT
  id, org_id, package_id, uploaded_file_id, extraction_run_id, generation_id,
  full_file_segment_id, canonical_profile_record_id, membership_role,
  membership_status, membership_source, confidence, added_at, updated_at
FROM public.lease_package_documents
WHERE public.is_member_of_org(org_id);

-- Excludes membership_key (internal idempotency identifier) and metadata.

CREATE VIEW public.lease_document_relationships_safe AS
SELECT
  id, org_id, package_id, source_package_document_id, target_package_document_id,
  source_segment_id, target_segment_id, relationship_type, relationship_status,
  effective_date, confidence, producer_type, producer_name, producer_version,
  validation_status, resolution_reason, created_at, updated_at
FROM public.lease_document_relationships
WHERE public.is_member_of_org(org_id);

-- Excludes relationship_key, evidence_claim_id, evidence_summary and internal
-- provenance identifiers (extraction_run_id/extraction_stage_run_id/
-- provider_invocation_id/generation_id) -- same conservative posture as
-- lease_claims_safe.

CREATE VIEW public.lease_related_document_requirements_safe AS
SELECT
  id, org_id, package_id, requesting_package_document_id, requirement_type,
  required_profile_key, referenced_document_date, requirement_status,
  reason_code, requirement_key, created_at, resolved_at,
  resolved_by_package_document_id
FROM public.lease_related_document_requirements
WHERE public.is_member_of_org(org_id);

-- Excludes referenced_party_names/referenced_identifier (may carry
-- document-adjacent party detail) and metadata/evidence_claim_id.

-- No GRANT SELECT ... TO authenticated on any view above -- deferred until a
-- real reader exists (P3.4+). Not granting anything to anon either.
-- service_role retains its platform-default access.

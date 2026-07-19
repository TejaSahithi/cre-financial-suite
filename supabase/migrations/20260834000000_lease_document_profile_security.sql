-- P3.1 — security consolidation: safe projection views over the document
-- profile/segment tables, created now for forward-compatibility but NOT
-- yet granted to `authenticated` -- same deferred posture as P2.1's
-- lease_claims_safe family (no real consumer/reader exists yet). Base
-- tables already REVOKE ALL from authenticated/anon inline in their own
-- migrations (applying the lesson from P2.1's original round-1 mistake
-- directly this time, rather than grant-then-revoke).
--
-- Ordinary (owner-rights) views with an explicit
-- `WHERE public.is_member_of_org(org_id)` predicate, NOT
-- `security_invoker = true` (the same fix P2.1 already had to apply after
-- discovering security_invoker requires the base-table grant to exist for
-- the querying role in the first place).

CREATE VIEW public.lease_document_segments_safe AS
SELECT
  id, org_id, uploaded_file_id, extraction_run_id, generation_id,
  segment_index, page_start, page_end, segment_key, created_at
FROM public.lease_document_segments
WHERE public.is_member_of_org(org_id);

CREATE VIEW public.lease_document_profile_records_safe AS
SELECT
  id, org_id, uploaded_file_id, segment_id, extraction_run_id,
  extraction_stage_run_id, provider_invocation_id, generation_id,
  profile_key, registry_version, classification_status, confidence,
  producer_type, producer_name, producer_version, created_at
FROM public.lease_document_profile_records
WHERE public.is_member_of_org(org_id);

-- Excludes classification_key (internal idempotency identifier) and
-- evidence_summary/metadata (bounded, but may carry document-adjacent
-- detail not meant for broad org-member reading without a real consumer
-- yet) from the safe view -- same conservative exclusion posture as
-- lease_claims_safe excluding raw_value_text/derivation/metadata.

-- No GRANT SELECT ... TO authenticated on either view above -- deferred
-- until a real reader exists (P3.4+). Not granting anything to anon
-- either. service_role retains its platform-default access.

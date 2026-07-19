-- P3.1 — generated, immutable DB snapshot of the TS document profile
-- registry (supabase/functions/_shared/extraction/document-package/profile-registry.ts).
--
-- Same authoring/generated-snapshot split as P2.1's lease_claim_concepts:
-- the TS file is the AUTHORING source, these two tables are a deterministic
-- generated ARTIFACT of it, never a second independently-maintained
-- registry. Produced by scripts/generate-document-profile-registry.ts.

CREATE TABLE public.lease_document_profile_registry_versions (
  registry_version TEXT PRIMARY KEY,
  registry_hash     TEXT NOT NULL,
  published_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (registry_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE public.lease_document_profiles (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  registry_version        TEXT NOT NULL REFERENCES public.lease_document_profile_registry_versions(registry_version) ON DELETE RESTRICT,
  profile_key             TEXT NOT NULL,
  display_name            TEXT NOT NULL,
  allowed_relationship_roles TEXT[] NOT NULL DEFAULT '{}',
  supports_segmentation   BOOLEAN NOT NULL DEFAULT false,
  expected_claim_signals  TEXT[] NOT NULL DEFAULT '{}',
  permitted_override_domains TEXT[] NOT NULL DEFAULT '{}',
  requires_base_document  BOOLEAN NOT NULL DEFAULT false,
  introduced_in           TEXT NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (registry_version, profile_key)
);

CREATE INDEX idx_lease_document_profiles_registry_version ON public.lease_document_profiles(registry_version);
CREATE INDEX idx_lease_document_profiles_profile_key ON public.lease_document_profiles(profile_key);

-- Read-only reference data, no tenant scope -- same posture as
-- lease_claim_concepts/lease_claim_registry_versions.
REVOKE ALL ON public.lease_document_profile_registry_versions FROM authenticated, anon;
REVOKE ALL ON public.lease_document_profiles FROM authenticated, anon;

INSERT INTO public.lease_document_profile_registry_versions (registry_version, registry_hash) VALUES
  ('lease-document-profiles-v1', '82d6bf7b41219cd281f96e9e18f3db544d848766afefdd5f5c8474a29cd20845');

INSERT INTO public.lease_document_profiles
  (registry_version, profile_key, display_name, allowed_relationship_roles, supports_segmentation, expected_claim_signals, permitted_override_domains, requires_base_document, introduced_in)
VALUES
  ('lease-document-profiles-v1', 'base_lease', 'Base Lease', '{"base_document"}', false, '{"tenant_name","landlord_name","commencement_date","monthly_rent"}', '{}', false, 'lease-document-profiles-v1'),
  ('lease-document-profiles-v1', 'lease_assignment', 'Lease Assignment', '{"assigns"}', true, '{"assignor_name","assignee_name","assignment_effective_date","assignment_consideration"}', '{"parties"}', true, 'lease-document-profiles-v1'),
  ('lease-document-profiles-v1', 'lease_amendment', 'Lease Amendment', '{"amends"}', true, '{"all_other_terms_remain_same"}', '{}', true, 'lease-document-profiles-v1'),
  ('lease-document-profiles-v1', 'assignment_and_amendment', 'Assignment and Amendment', '{"assigns","amends"}', true, '{"assignor_name","assignee_name","assignment_effective_date"}', '{"parties"}', true, 'lease-document-profiles-v1'),
  ('lease-document-profiles-v1', 'lease_extension', 'Lease Extension', '{"extends"}', true, '{"expiration_date","renewal_options"}', '{"term"}', true, 'lease-document-profiles-v1'),
  ('lease-document-profiles-v1', 'lease_renewal', 'Lease Renewal', '{"renews"}', true, '{"renewal_options","renewal_type"}', '{"term"}', true, 'lease-document-profiles-v1'),
  ('lease-document-profiles-v1', 'guaranty', 'Guaranty', '{"guarantees"}', true, '{}', '{}', true, 'lease-document-profiles-v1'),
  ('lease-document-profiles-v1', 'commencement_certificate', 'Commencement Certificate', '{"resolves_commencement"}', true, '{"commencement_date","expiration_date","rent_commencement_date"}', '{"term"}', true, 'lease-document-profiles-v1'),
  ('lease-document-profiles-v1', 'rent_addendum', 'Rent Addendum', '{"amends","incorporates"}', true, '{"monthly_rent","annual_rent","escalation_rate"}', '{"rent"}', true, 'lease-document-profiles-v1'),
  ('lease-document-profiles-v1', 'cam_addendum', 'CAM Addendum', '{"amends","incorporates"}', true, '{"cam_amount","cam_cap_type","cam_cap_pct"}', '{"cam"}', true, 'lease-document-profiles-v1'),
  ('lease-document-profiles-v1', 'work_letter', 'Work Letter', '{"incorporates","attachment_to"}', true, '{"ti_allowance"}', '{}', true, 'lease-document-profiles-v1'),
  ('lease-document-profiles-v1', 'exhibit', 'Exhibit', '{"attachment_to"}', true, '{}', '{}', true, 'lease-document-profiles-v1'),
  ('lease-document-profiles-v1', 'unknown_supported_document', 'Unknown (Supported)', '{"related_unknown"}', true, '{}', '{}', false, 'lease-document-profiles-v1');

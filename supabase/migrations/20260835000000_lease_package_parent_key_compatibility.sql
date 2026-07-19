-- P3.2 — one additive parent-key constraint needed before the package graph
-- can safely reference lease_document_profile_records with full generation
-- fencing, mirroring the exact fix P3.1 already applied to
-- lease_document_segments (UNIQUE(id, uploaded_file_id, generation_id, org_id)).
--
-- Without this, lease_package_documents.canonical_profile_record_id could
-- only be checked against (id, org_id) -- same org, but not necessarily the
-- same file/generation -- letting a package-document row silently reference
-- a profile classification from a stale/different generation of the file.
ALTER TABLE public.lease_document_profile_records
  ADD CONSTRAINT lease_document_profile_records_package_link_unique
  UNIQUE (id, uploaded_file_id, generation_id, org_id);

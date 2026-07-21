-- Release 3: durable, geometry-preserving canonical document layout.
--
-- This is additive and non-authoritative. Lease Review continues to read
-- ui_review_payload; legacy docling_raw / azure_raw_response fallbacks remain.

ALTER TABLE public.uploaded_files
  ADD COLUMN IF NOT EXISTS canonical_layout_v3 JSONB DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS canonical_layout_v3_hash TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS canonical_layout_v3_schema_version TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS canonical_layout_v3_adapter_version TEXT DEFAULT NULL;

COMMENT ON COLUMN public.uploaded_files.canonical_layout_v3 IS
  'Release 3 geometry-preserving canonical layout artifact, built once from Azure analyzeResult at parse time when ENABLE_DOCUMENT_INTELLIGENCE_V3=true. Distinct from lossy docling_raw and from the misleading azure_raw_response compatibility alias. Immutable for the document generation that produced it.';

COMMENT ON COLUMN public.uploaded_files.canonical_layout_v3_hash IS
  'Deterministic checksum of the normalized canonical layout representation, excluding timestamps and transient runtime metadata.';

COMMENT ON COLUMN public.uploaded_files.canonical_layout_v3_schema_version IS
  'Release 3 canonical artifact schema version, e.g. canonical-layout-v3.';

COMMENT ON COLUMN public.uploaded_files.canonical_layout_v3_adapter_version IS
  'Release 3 adapter version that produced canonical_layout_v3, e.g. azure-native-v1.';

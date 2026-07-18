-- P1.5: private Storage bucket for extraction_artifacts rows with
-- storage_mode='storage_object' (payloads >200KB -- the app-level
-- MAX_ARTIFACT_INLINE_BYTES threshold, see recorder.ts). Part of the Lease
-- Intelligence Enterprise P1-P8 roadmap
-- (C:\Users\tejas\.claude\plans\think-as-senior-enterprise-elegant-harbor.md).
--
-- Deliberately UNLIKE financial-uploads (which grants ordinary org members
-- direct RLS-based read/write via storage.objects policies): raw provider
-- request/response content can contain full lease text, names, addresses,
-- signatures, financial terms, and internal prompts. No RLS policy here
-- grants `authenticated` any access at all -- the only read path is the
-- get-extraction-artifact Edge Function, which uses the service-role
-- client (bypasses RLS by default) after get_extraction_artifact_authorization
-- has already verified org membership, a privileged role, and written an
-- audit_logs row. Writes happen only from the service-role transport
-- wrappers, same posture.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'extraction-artifacts',
  'extraction-artifacts',
  false, -- not public; no anonymous or direct-authenticated access of any kind
  52428800, -- 50MB hard ceiling, matching extraction_artifacts.truncated's documented rare-case ceiling
  ARRAY['application/json', 'text/plain']
)
ON CONFLICT (id) DO UPDATE SET
  allowed_mime_types = EXCLUDED.allowed_mime_types,
  file_size_limit = EXCLUDED.file_size_limit;

-- No storage.objects RLS policies for this bucket, intentionally. The
-- table already has ROW LEVEL SECURITY enabled globally (Supabase default);
-- since no policy exists for 'extraction-artifacts', the default-deny
-- posture blocks anon/authenticated entirely, and only the service-role
-- client (used exclusively by get-extraction-artifact and the transport
-- wrappers) can read/write, since service_role bypasses RLS.

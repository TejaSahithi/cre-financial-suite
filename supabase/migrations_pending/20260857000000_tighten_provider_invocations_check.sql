-- **DO NOT APPLY UNTIL VERIFIED** -- see supabase/migrations/README or the
-- migration cleanup report for details. This tightens provider_invocations
-- .provider to only the two live providers (azure_document_intelligence,
-- openai), removing 'vertex_ai', 'gemini_api_key', and 'docling' from the
-- allowed set.
--
-- PRECONDITION: no existing rows may use provider IN ('vertex_ai',
-- 'gemini_api_key', 'docling'). This has NOT been verified against the live
-- database from this environment (no live DB connection available). Before
-- running `supabase db push` with this migration included, run:
--
--   SELECT provider, count(*) FROM public.provider_invocations
--   WHERE provider NOT IN ('azure_document_intelligence', 'openai')
--   GROUP BY provider;
--
-- and confirm zero rows. If any rows use a deprecated provider value, this
-- ALTER TABLE will fail loudly at apply time (Postgres validates existing
-- rows against a replaced CHECK constraint) rather than silently corrupting
-- or hiding data -- that failure is the intended safety net, not a bug.
ALTER TABLE public.provider_invocations
  DROP CONSTRAINT IF EXISTS provider_invocations_provider_check;

ALTER TABLE public.provider_invocations
  ADD CONSTRAINT provider_invocations_provider_check
  CHECK (provider IN ('azure_document_intelligence', 'openai'));

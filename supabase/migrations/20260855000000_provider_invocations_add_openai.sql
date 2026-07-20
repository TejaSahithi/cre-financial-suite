-- Migration to allow 'openai' as a valid provider in provider_invocations constraint
ALTER TABLE public.provider_invocations
  DROP CONSTRAINT IF EXISTS provider_invocations_provider_check;

ALTER TABLE public.provider_invocations
  ADD CONSTRAINT provider_invocations_provider_check
  CHECK (provider IN ('azure_document_intelligence', 'vertex_ai', 'gemini_api_key', 'docling', 'openai'));

-- Fixes a permission regression on the Extraction Timeline tab
-- ("permission denied for table extraction_runs") caused by a migration
-- ordering conflict between two prior migrations:
--
--   20260825000000_extraction_runs_provenance.sql (real commit 2026-07-18)
--     creates extraction_runs_safe / extraction_stage_runs_safe /
--     provider_invocations_safe as deliberate OWNER-RIGHTS views (no
--     security_invoker) -- see that migration's own comment, ~line 560-572:
--     an invoker-rights view would require `authenticated` to hold direct
--     base-table SELECT, which defeats the entire point of these views
--     (hiding error_message/provider_error_status/request_fingerprint/etc).
--     It revokes all base-table SELECT from `authenticated` and grants
--     SELECT only on the three views.
--
--   20260723000002_fix_security_definer_views.sql (real commit 2026-07-23,
--     i.e. actually LATER than 20260825000000 despite its earlier-sorting
--     filename timestamp -- Supabase applies any not-yet-recorded migration
--     regardless of whether its timestamp trails the latest applied one)
--     rebuilt the same three views WITH `security_invoker = true` to silence
--     a Supabase linter "Security Definer View" advisory, without
--     re-granting base-table access. With security_invoker, Postgres checks
--     the CALLING role's own privileges against the base table --
--     `authenticated` has none (revoked above), so every query against
--     these views from a real user fails with exactly
--     "permission denied for table extraction_runs".
--
-- Fix: recreate the three views exactly as 20260825000000 originally
-- defined them (same columns, same org-scoping WHERE clause), WITHOUT
-- security_invoker, restoring the intentional owner-rights design. Base
-- table grants and the unrelated 4th view (latest_snapshots, whose base
-- table computation_snapshots was never revoked from authenticated) are
-- untouched.
--
-- Reverting will bring back the Supabase dashboard's "Security Definer
-- View" advisor warning on these 3 views -- that needs to be acknowledged/
-- muted in the dashboard (Database -> Advisors), referencing the
-- COMMENT ON VIEW text below as the recorded justification. This migration
-- cannot do that part from SQL.

DROP VIEW IF EXISTS public.extraction_runs_safe;
CREATE VIEW public.extraction_runs_safe AS
SELECT id, org_id, uploaded_file_id, lease_id, generation_id, run_type,
       provider_pipeline, contract_version, status, error_code,
       started_at, completed_at, created_at, updated_at
FROM public.extraction_runs
WHERE public.is_member_of_org(org_id);

DROP VIEW IF EXISTS public.extraction_stage_runs_safe;
CREATE VIEW public.extraction_stage_runs_safe AS
SELECT id, org_id, run_id, stage, attempt, status, provider, error_code,
       started_at, finished_at, created_at, updated_at
FROM public.extraction_stage_runs
WHERE public.is_member_of_org(org_id);

DROP VIEW IF EXISTS public.provider_invocations_safe;
CREATE VIEW public.provider_invocations_safe AS
SELECT id, org_id, run_id, stage_run_id, provider, operation, model, location,
       chunk_index, provider_attempt, status, success, failure_classification,
       input_tokens, output_tokens, latency_ms, requested_at, completed_at,
       request_artifact_status, response_artifact_status, created_at
FROM public.provider_invocations
WHERE public.is_member_of_org(org_id);

-- DROP VIEW clears previously-granted privileges -- re-grant.
GRANT SELECT ON public.extraction_runs_safe TO authenticated;
GRANT SELECT ON public.extraction_stage_runs_safe TO authenticated;
GRANT SELECT ON public.provider_invocations_safe TO authenticated;

-- Durable guardrail against a third recurrence: this survives independent
-- of migration history and is visible via \d+/information_schema, unlike a
-- comment in a migration file that a future change might not see.
COMMENT ON VIEW public.extraction_runs_safe IS
  'Intentionally an OWNER-RIGHTS view (no security_invoker), with its own org-scoping via is_member_of_org(org_id) in the WHERE clause. Do NOT add security_invoker = true -- it breaks authenticated access, because the base table extraction_runs has no direct grant for authenticated by design. See migrations 20260825000000 and 20260879000000.';
COMMENT ON VIEW public.extraction_stage_runs_safe IS
  'Intentionally an OWNER-RIGHTS view (no security_invoker), with its own org-scoping via is_member_of_org(org_id) in the WHERE clause. Do NOT add security_invoker = true -- it breaks authenticated access, because the base table extraction_stage_runs has no direct grant for authenticated by design. See migrations 20260825000000 and 20260879000000.';
COMMENT ON VIEW public.provider_invocations_safe IS
  'Intentionally an OWNER-RIGHTS view (no security_invoker), with its own org-scoping via is_member_of_org(org_id) in the WHERE clause. Do NOT add security_invoker = true -- it breaks authenticated access, because the base table provider_invocations has no direct grant for authenticated by design. See migrations 20260825000000 and 20260879000000.';

# Controlled Staging Acceptance

Date: 2026-07-17
Branch: feature/document-intelligence-v3
Status: BLOCKED BEFORE STAGING DEPLOYMENT

## Gate Results

- Phase 5F committed: yes. Commit `719c734` (`Close Phase 5F reviewer projection validation`) is present in branch history.
- Working tree clean: no.
- Blocking local changes: six deleted migration files are present in the working tree:
  - `supabase/migrations/20260819000000_document_intelligence_v3_scaffold.sql`
  - `supabase/migrations/20260820000000_document_intelligence_v3_idempotency.sql`
  - `supabase/migrations/20260820000001_phase5d_source_link_typed_source.sql`
  - `supabase/migrations/20260821000000_document_intelligence_v3_run_profile_columns.sql`
  - `supabase/migrations/20260822000000_document_intelligence_v3_layout_summary_column.sql`
  - `supabase/migrations/20260823000000_document_intelligence_v3_package_graph.sql`

## Backend Recovery

- Runtime: `denoland/deno:2.7.12` in Linux Docker.
- Command scope: the four deferred related backend modules only.
- Result: 25 passed, 0 failed.
- Deno reported duration: 348 ms.
- Temporary Docker env file: removed after the run.
- Provider posture: `BUSINESS_EXTRACTION_PROVIDER=legacy_hybrid`, `ENABLE_DOCUMENT_INTELLIGENCE_V3=false`, `DISABLE_EXTERNAL_PROVIDER_CALLS=true`, `ENABLE_LOCAL_PROVIDER_MOCKS=false`.

## Staging Workflows

Not run. Non-production staging deployment was intentionally not attempted because the working tree was not clean.

Required workflows still pending:

- base lease
- CAM-heavy lease
- amendment

Required validations still pending:

- upload
- parse
- normalize
- Lease Review
- evidence
- save/reload
- approval
- financial rules
- audit/version
- exact source linkage
- one-document Azure canary

## Screenshots

No staging screenshots were captured because no staging deployment or workflow execution occurred.

## Blockers

Controlled Staging Acceptance is blocked until the working tree is clean or the six deleted migration files are explicitly accepted as intentional and committed before deployment.

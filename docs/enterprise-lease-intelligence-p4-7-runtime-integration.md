# Enterprise Lease Intelligence Roadmap - P4.7 Runtime Integration

Date: 2026-07-20
Base commit: f8655f5
Branch: feature/lease-intelligence-enterprise-p1-p8
Scope: P4.7 only - server-owned financial schedule runtime integration behind default-off feature mode.

## Verdict

P4.7 complete and locally verified. Full integrated P4 closure remains pending P4.8.

## Runtime Boundary

P4.7 adds one server-owned financial runtime boundary at:

- `supabase/functions/_shared/extraction/lease-financial-schedule/runtime/financial-runtime-orchestrator.ts`

The boundary is wired in `normalize-pdf-output` after the existing P2 claims and P3 package orchestration and before the authoritative finalizer. It reuses completed current-generation P4.5 calculation runs and P4.6 projection runs, then applies mode-dependent write-back and critical-date projection. It does not call providers, parsers, field extractors, or frontend code.

Worker terminal enrichment finalization now passes the server-derived financial mode to the same finalizer. Browser-supplied mode values remain ignored.

## Feature Modes

Defaults remain closed:

- `LEASE_CLAIMS_LEDGER_MODE`: unset resolves to `off`
- `LEASE_DOCUMENT_PACKAGE_MODE`: unset resolves to `off`
- `LEASE_FINANCIAL_SCHEDULE_MODE`: unset resolves to `off`

Dependency matrix:

- Financial `off`: no runtime orchestration, no P4 runtime writes, no output change.
- Financial `shadow`: requires claims ledger `shadow` or `active`; records failures honestly; no compatibility write-back; no live critical-date mutation; readiness remains P0/P1/P2/P3-authoritative.
- Financial `active`: requires claims ledger `active`; package-aware input requires package mode `active`; requires completed current-generation P4.5 calculation and P4.6 projection; requires successful compatibility write-back; blocks readiness on stale/missing/failed/unresolved required financial state.

Explicit mode errors:

- `FINANCIAL_MODE_REQUIRES_CLAIMS_LEDGER`
- `FINANCIAL_ACTIVE_REQUIRES_CLAIMS_ACTIVE`
- `FINANCIAL_ACTIVE_REQUIRES_PACKAGE_ACTIVE`
- `FINANCIAL_MODE_CONFIGURATION_INVALID`

## SQL Additions

Migration: `supabase/migrations/20260854000000_lease_financial_runtime_p4_7.sql`

Adds immutable/server-owned result tables:

- `lease_financial_compatibility_writes`
- `lease_financial_critical_date_projections`

Adds narrow service-role RPCs:

- `persist_lease_financial_projection(...)`
- `project_lease_financial_critical_dates(...)`

Write-back RPC behavior:

- Validates service-role-only authority.
- Fences org, lease, uploaded file, extraction run, generation, package, calculation run, projection run.
- Rejects stale generation, approved leases, incomplete runs, validation blockers, oversized patches and idempotency conflicts.
- Accepts only `fields`, `field_evidence`, and `confidence_scores` for bounded P4-owned compatibility keys.
- Rejects arbitrary `workflow_output`, raw claims, formulas, relationship graphs, provider metadata, artifact paths, CAM, expenses, budgets, billing rows, schedules and raw calculation structures.
- Preserves non-P4 compatibility content and stores projection version/run/hash metadata under extraction debug metadata.

Critical-date projection behavior:

- Stores candidate projection records only.
- Uses resolved valid P4 date results.
- Does not write live `critical_dates` rows.
- Preserves the existing approval/materialization lifecycle as the authoritative critical-date path.

## Finalizer Integration

The P3.7 finalizer was renamed to a private helper:

- `finalize_lease_extraction_for_review_p3_7(...)`

The public authoritative finalizer is now the financial-aware signature:

- `finalize_lease_extraction_for_review(UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT)`

Catalog audit after full-repository DB replay:

- `finalize_lease_extraction_for_review(p_org_id uuid, p_uploaded_file_id uuid, p_generation_id uuid, p_lease_id uuid, p_actor_user_id uuid, p_actor_email text, p_ledger_mode text, p_package_mode text, p_financial_mode text)`
- `finalize_lease_extraction_for_review_p3_7(...)` remains as private helper.
- `persist_lease_financial_projection`: service_role execute grant true.
- `project_lease_financial_critical_dates`: service_role execute grant true.

Active-mode finalizer blockers include missing/failed/stale calculation, missing/failed/stale projection, missing compatibility write-back, unresolved required date/term/rent, stated/calculated mismatch, required related document and invalid critical-date projection.

## Reviewer and Save Authority

Mode off/shadow preserve existing behavior.

Mode active adds legacy bypass guards:

- `save-lease-review-draft`: rejected with `financial-active review draft saves must use P4 reviewer decision routes`.
- `update-lease-extraction-field`: rejects P4-owned `field_value` edits with `financial-active field edits must use P4 reviewer decision routes`.

No frontend redesign was made.

## Scope Guardrails

Confirmed:

- No new date/rent/charge calculation rules.
- No mutation of P2 claims, P3 package-effective claims, P4 source candidate tables, or completed P4.5 calculation results.
- No P5 CAM allocation, recoverability, expense rules, actual expenses, budgets or billing rows.
- No provider, prompt, parser or routing changes.
- No frontend Lease Review redesign.
- No production database push.
- No remote database write.
- No deployment.
- No live provider call.
- No live-document regression.

## Verification

Preflight baseline already recorded on base commit f8655f5:

- Remote-parity DB lane: PASS.
- Full-repository DB lane: PASS.
- P4.1-P4.6 focused Docker Deno suite: 120 passed, 0 failed.
- Adjacent P1/P2/P3/P3.8 Docker Deno suite: 237 passed, 0 failed.
- Frontend Vitest: 62 files / 685 tests passed.
- Lint: PASS.
- Typecheck: PASS.
- Build: PASS with existing Vite dynamic-import/chunk warnings.
- Historical all-files backend blocker: inherited type-check failure in `update-lease-extraction-field.property.test.ts` lines 43, 86, 101.

Post-change verification:

- `deno check --no-lock` on runtime, wiring files and new tests: PASS.
- Focused P4.7 Docker Deno tests: 17 passed, 0 failed.
- Remote-parity DB lane: PASS.
- Full-repository DB lane: PASS.
- P4.1-P4.7 focused Docker Deno suite: 131 passed, 0 failed.
- Adjacent provenance/claims/package regression: 192 passed, 0 failed.
- Adjacent lease-document P3 regression: 45 passed, 0 failed.
- Adjacent P1/P2/P3/P3.8 aggregate: 237 passed, 0 failed.
- Frontend Vitest: 62 files / 685 tests passed.
- `npm run lint`: PASS.
- `npm run typecheck`: PASS.
- `npm run build`: PASS with existing Vite dynamic-import/chunk warnings.
- `git diff --check`: PASS.

All-files backend command:

`docker run --rm -v "${PWD}:/work" -w /work denoland/deno:2.7.12 test --no-lock --allow-read --allow-write --allow-env --allow-net --allow-run --allow-import supabase/functions/_tests`

Result: still blocked before execution by inherited type-check failure in `supabase/functions/_tests/update-lease-extraction-field.property.test.ts`:

- line 43: `SERVICE_ROLE_KEY` is `string | undefined` where `string` is required.
- line 86: `ANON_KEY` is `string | undefined` where `string` is required.
- line 101: `ANON_KEY` is `string | undefined` in fetch headers.

Classification: inherited all-files backend blocker, unchanged from baseline; no P4.7 failure surfaced.

Windows Deno note:

- Windows Deno 2.7.12 still panicked during `deno test` pipe/channel handling before test results.
- Linux Docker Deno 2.7.12 was used for trustworthy backend test counts.

## Secret and Content Scan

Changed-file scan found no committed secrets, no Azure Document Intelligence keys, no Vertex service-account private keys, no OAuth access tokens, no production credential references and no real customer document content.

Matches for `service_role`, Azure, Vertex and provider names are existing code comments/config guards or service-role grant strings in the migration/tests, not secret values.

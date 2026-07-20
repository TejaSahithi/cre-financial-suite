# Enterprise Lease Intelligence Roadmap ? P4.6 Compatibility Projection

Date: 2026-07-19
Branch: feature/lease-intelligence-enterprise-p1-p8
Scope: P4.6 only ? deterministic compatibility projection and shadow-diff layer for completed P4.5 financial calculation results.

## Verdict

P4.6 complete and locally verified; deterministic P4 date, term, rent and financial results can be projected into compatibility candidates and compared against existing output, but runtime write-back, critical-date projection and finalizer integration have not started.

## Implementation Summary

- Added `lease-financial-schedule/projection` pure projection modules.
- Added deterministic projection input hashing and run identity generation.
- Added adapters for date, term, rent, charge and schedule results into existing Lease Review-compatible field candidates.
- Reused the existing P2 compatibility payload builder and field projection primitives; no second uncontrolled compatibility registry was introduced.
- Added deterministic fixed-field dedupe that collapses duplicate same-field/same-value projections while preserving true value conflicts for review.
- Added shadow diff classification for resolved dates, calculated additions, formula-unresolved rows, related-document requirements, annualized-vs-billed rent separation, free-rent effects, financial conflicts and ordering differences.
- Added immutable P4.6 projection result tables and service-role RPCs for isolated projection run persistence.

## Scope Guardrails Confirmed

- No mutation of P2 claims, P3 package-effective claims, P4.1 date expressions, P4.2 dependencies/term candidates, P4.3 base-rent candidates or P4.4 charge candidates.
- No writes to `extraction_data`, `workflow_output`, `critical_dates`, review readiness or the Lease Review finalizer.
- No parser, provider, prompt, routing, CAM computation, expense recoverability or frontend Lease Review changes.
- `LEASE_FINANCIAL_SCHEDULE_MODE=off` remains passive; P4.6 tests assert no runtime write-back surface.
- Annualized rent remains distinct from billed rent: `$6,004 x 12 = $72,048` annualized reference; months 1-2 free produce first-year billed base rent `$60,040` only as schedule/diff evidence, never as `annual_rent`.

## Schema Notes

Migration: `20260853000000_lease_financial_projection_results_p4_6.sql`

New immutable tables:
- `lease_financial_projection_runs`
- `lease_financial_field_projections`
- `lease_financial_schedule_projections`
- `lease_financial_projection_diffs`

RPCs are `SECURITY DEFINER SET search_path = public, pg_temp`, service-role-only, idempotent where applicable, and only accept completed or completed-with-warnings P4.5 calculation runs. Projection rows and terminal runs are immutable. Lease foreign keys use column-scoped `ON DELETE SET NULL (lease_id)`; package/calculation history uses `ON DELETE RESTRICT`.

## Verification Results

- Windows Deno 2.7.12 test runner: blocked by known pipe/channel panic after type-check; Linux Docker used for real execution.
- `deno check` focused P4.6 files: PASS.
- Focused P4.6 backend Docker suite: `16 passed | 0 failed`.
- P4.1-P4.6 backend Docker suite: `108 passed | 0 failed`.
- Adjacent P1/P2/P3 package/provenance Docker suite with `--allow-env`: `198 passed | 0 failed`.
- All-files backend Docker attempt: blocked during type-check by inherited repository-wide issue in `update-lease-extraction-field.property.test.ts` lines 43, 86 and 101 (`string | undefined` passed where `string` is required). This matches the P4.5 inherited blocker; no new P4.6 failure observed before that blocker.
- Migration replay: `bash scripts/db-reset-two-lanes.sh both` PASS for remote-parity and full-repository lanes after correcting the P4.6 diff uniqueness index.
- Frontend regression: `62 files / 685 tests passed`.
- Lint: PASS.
- Typecheck: PASS.
- Build: PASS.

## Secret and Runtime Contact Review

Changed-file scan found no Supabase service-role secret values, Azure Document Intelligence keys, Vertex private keys, OAuth tokens, production project references used as credentials, or real customer document content. `service_role` appears only as the intended SQL role/grant text. `raw_document_text` and `provider_payload` appear only in SQL/tests as explicit exclusion checks.

No live provider calls were run. Backend verification used local Docker Deno and local Supabase migration replay only. All provider/provenance tests were mocked/pure; all-files backend was attempted without `--allow-net`.

## Known Deferred Item

The repository-wide all-files backend command still stops at the inherited `update-lease-extraction-field.property.test.ts` type-check issue. P4.6 focused, adjacent, migration and frontend regressions are green.
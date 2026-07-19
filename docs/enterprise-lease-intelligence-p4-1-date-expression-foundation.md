# Enterprise Lease Intelligence P4.1 Date-Expression Foundation

Date: 2026-07-19
Branch: feature/lease-intelligence-enterprise-p1-p8
Base P4.0 commit: 04cae5d
P4.1 commit: this implementation commit; final handoff records the concrete SHA after commit creation.
Verdict: P4.1 complete and locally verified; P4.2 has not started.

## Scope

P4.1 implements only the canonical date-expression foundation described by P4.0. It adds a generated registry snapshot, immutable expression candidate storage, source-claim/package provenance links, reviewer decision append logs, and a default-off feature-mode module.

No provider, parser, model, prompt, routing, finalizer, Lease Review compatibility output, `extraction_data`, `workflow_output`, P2 source claim, P3 package-effective claim, production deployment, remote database write, live document regression, CAM/expense, rent schedule, critical-date generation, term graph, date resolution, or rent calculation was added.

## Files And Migrations

Implementation files:

- `supabase/functions/_shared/extraction/lease-financial-schedule/feature-mode.ts`
- `supabase/functions/_shared/extraction/lease-financial-schedule/date-expressions/date-expression-registry-version.ts`
- `supabase/functions/_shared/extraction/lease-financial-schedule/date-expressions/date-expression-types.ts`
- `supabase/functions/_shared/extraction/lease-financial-schedule/date-expressions/date-expression-registry.ts`
- `supabase/functions/_shared/extraction/lease-financial-schedule/date-expressions/date-expression-normalization.ts`
- `supabase/functions/_shared/extraction/lease-financial-schedule/date-expressions/date-expression-key.ts`
- `supabase/functions/_shared/extraction/lease-financial-schedule/date-expressions/date-expression-validation.ts`
- `scripts/generate-date-expression-registry.ts`
- `supabase/migrations/20260848000000_lease_date_expression_foundation_p4_1.sql`

Test files:

- `supabase/functions/_tests/lease-financial-schedule-feature-mode.test.ts`
- `supabase/functions/_tests/lease-date-expression-registry.test.ts`
- `supabase/functions/_tests/lease-date-expression-validation.test.ts`
- `supabase/functions/_tests/lease-date-expression-rpc-contract.test.ts`

Report:

- `docs/enterprise-lease-intelligence-p4-1-date-expression-foundation.md`

Migration count after P4.1: 210.

## Canonical Date-Expression Vocabulary

Registry version: `lease-date-expressions-v1`.
Registry hash: `4fb01e689af22475cd4df1207847c37589cbfa90e56b31fbe0d30668a4c501a8`.
Registry row count: 12.

Canonical expression types:

- `fixed_date`
- `event_date`
- `relative_to_date`
- `relative_to_event`
- `earlier_of`
- `later_of`
- `minimum_of`
- `maximum_of`
- `dependent_date`
- `recurring_deadline`
- `notice_window`
- `unresolved_expression`

Vocabulary reconciliation:

- Accepted aliases normalize into the canonical set only, for example `fixed`, `specific_date`, and `explicit_date` normalize to `fixed_date`; `event` normalizes to `event_date`; `relative_event` normalizes to `relative_to_event`; `sooner_of` normalizes to `earlier_of`.
- Aliases are not inserted as independent registry rows.
- Unknown concepts such as `commencement_date` are not silently coerced into a date-expression type.
- No second uncontrolled concept registry was introduced; P4.1 candidate rows reference `concept_key` and source P2/P3 claims.

## Candidate Model And Provenance

`lease_date_expressions` is an immutable candidate table keyed by `(org_id, expression_key)`. The deterministic key includes registry version, org, lease/package identity, uploaded file, generation, concept/scope/instance, expression type, source claim identity, and stable expression components. It intentionally excludes timestamps, row order, and provider response order.

The model separates lanes explicitly:

- Extracted candidates require source claim linkage and semantic extractor provider provenance when produced by a semantic provider.
- Reviewer-origin candidates cannot carry provider/stage provenance and must use reviewer producer metadata.
- Derived and calculated candidates require formula key and calculation version.
- Unresolved and related-document candidates remain distinct from calculated results.
- Ambiguous candidates cannot carry an authoritative fixed date.
- P4.1 rejects resolved `explicit_date` values for dependency-bearing types other than `fixed_date` and `event_date`.

Provenance fences preserve:

- `org_id`
- `uploaded_file_id`
- `extraction_run_id`
- `generation_id`
- `package_id`
- `source_package_document_id`
- `source_package_effective_claim_id`
- `source_claim_id`
- `extraction_stage_run_id`
- `provider_invocation_id`
- registry version/hash metadata

Package-context validation requires source claims to belong to the same confirmed package lane. Single-document validation requires source claim file/run/generation to match the candidate context.

## RPC, Security And Immutability

Added RPCs:

- `persist_lease_date_expression_candidates(UUID, UUID, UUID, UUID, UUID, UUID, JSONB)`
- `record_lease_date_expression_review_decision(UUID, UUID, TEXT, JSONB, TEXT, TEXT)`

Security and grants:

- Both RPCs are `SECURITY DEFINER` with `SET search_path = public, pg_temp`.
- Candidate persistence rejects user JWT contexts with `SERVICE_ROLE_ONLY` and grants execute only to `service_role`.
- Reviewer decisions require `auth.uid()` and `public.is_member_of_org(p_org_id)` and grant execute only to `authenticated, service_role`.
- P4.1 tables revoke table access from `authenticated` and `anon`; no direct table write grants were added.
- RLS is enabled on candidate, link, and reviewer-decision tables.

Immutability and deletion behavior:

- Candidate rows are immutable after insert.
- Claim links are immutable.
- Reviewer decisions are append-only.
- Lease deletion may null only `lease_id` through column-scoped `ON DELETE SET NULL (lease_id)` and the matching immutability trigger exception.
- Anchor-expression deletion may null only `anchor_expression_id`.

## Feature Mode

New flag: `LEASE_FINANCIAL_SCHEDULE_MODE`.
Allowed values: `off`, `shadow`, `active`.
Default behavior: unset, empty, invalid, and near-miss values resolve to `off`.
Runtime default: off.

Dependency gates:

- `shadow` requires the claims ledger at least shadow.
- `active` requires claims ledger active.
- `active` with package-aware input requires package mode at least shadow.
- Browser/request body values cannot activate the feature mode.

No runtime orchestration calls this feature mode in P4.1.

## Validation Results

Pre-P4.1 prerequisite:

- P4.0 committed before P4.1 work: `04cae5d`.
- Working tree was clean before P4.1 edits.

Schema replay:

- `bash scripts/db-reset-two-lanes.sh remote-parity`: PASS, exit code 0.
- `bash scripts/db-reset-two-lanes.sh full-repository`: PASS, exit code 0.

P4.1 focused backend:

- Command: `docker run --rm -v "${PWD}:/work" -w /work denoland/deno:2.7.12 test --no-lock --allow-read --allow-env supabase/functions/_tests/lease-financial-schedule-feature-mode.test.ts supabase/functions/_tests/lease-date-expression-registry.test.ts supabase/functions/_tests/lease-date-expression-validation.test.ts supabase/functions/_tests/lease-date-expression-rpc-contract.test.ts`
- Result: `26 passed | 0 failed`.

P4.1 Deno check:

- Command: `docker run --rm -v "${PWD}:/work" -w /work denoland/deno:2.7.12 deno check --no-lock supabase/functions/_shared/extraction/lease-financial-schedule/feature-mode.ts supabase/functions/_shared/extraction/lease-financial-schedule/date-expressions/date-expression-registry.ts supabase/functions/_shared/extraction/lease-financial-schedule/date-expressions/date-expression-normalization.ts supabase/functions/_shared/extraction/lease-financial-schedule/date-expressions/date-expression-key.ts supabase/functions/_shared/extraction/lease-financial-schedule/date-expressions/date-expression-validation.ts scripts/generate-date-expression-registry.ts`
- Result: PASS, exit code 0.

Inherited focused suites:

- P3.8 integrated closure: `4 passed | 0 failed`.
- P1 provenance tests: `38 passed | 0 failed`.
- P2 claims/projection tests: `78 passed | 0 failed`.
- Bounded P0-P4.1 backend regression: 35 files, `284 passed | 0 failed`.

All-files backend command:

- Command: `docker run --rm -v "${PWD}:/work" -w /work denoland/deno:2.7.12 test --no-lock --allow-read --allow-write --allow-env --allow-net --allow-run --allow-import supabase/functions/_tests`
- Result: exit code 1 before test execution.
- Historical blocker: unchanged inherited TypeScript pre-execution blocker in `supabase/functions/_tests/update-lease-extraction-field.property.test.ts` at lines 43, 86, and 101, where `SUPABASE_URL`, `SERVICE_ROLE_KEY`, and `ANON_KEY` are typed as `string | undefined` for APIs requiring `string`.
- New unexplained P4.1 backend failures: 0.

Frontend and build:

- `npm test`: 62 files / 685 tests PASS.
- `npm run lint`: PASS, exit code 0.
- `npm run typecheck`: PASS, exit code 0.
- `npm run build`: PASS, exit code 0; existing Vite dynamic-import and chunk-size warnings only.

Hygiene:

- `git diff --check`: PASS before staging.
- Changed-file secret/content scan: no credential material, cloud-provider key material, OAuth token material, production credential references, or real customer-document content found in the P4.1 implementation, tests, migration, generator, or report.

## Explicit Non-Starts

P4.1 did not resolve dependent dates, calculate commencement dates, calculate expiration dates, build a term graph, create rent schedules, calculate rent, create additional charges, generate critical dates, update Lease Review compatibility output, modify `extraction_data`, modify `workflow_output`, wire runtime extraction orchestration, modify finalizer/readiness logic, or change P2/P3 source claims.

P4.1 did not treat annualized rent as billed rent. P4.1 did not flatten event or relative expressions into fabricated fixed dates.

## Final Statement

P4.1 complete and locally verified; the canonical date-expression registry, immutable expression candidates, source-claim provenance and feature-mode foundation are implemented, but date dependency resolution, term calculations and financial schedules have not started.
# Enterprise Lease Intelligence P4.3 Base-Rent Schedule Candidates

Date: 2026-07-19
Branch: feature/lease-intelligence-enterprise-p1-p8
Base P4.2 commit: 6b6ec01a28799a06a7a1d660b5e54d52179059d0
P4.3 commit: this implementation commit; final handoff records the concrete SHA after commit creation.
Verdict: P4.3 complete and locally verified; P4.4 has not started.

## Scope

P4.3 implements only the immutable, versioned base-rent schedule candidate model that sits after P4.1 date-expression candidates and P4.2 term candidates and before future deterministic financial calculations.

Flow preserved:

- P2/P3 effective source claims
- P4.1 immutable date-expression candidates
- P4.2 immutable dependency graph and term candidates
- P4.3 immutable base-rent schedules, periods, amount representations, abatements, escalation instructions, conflicts, and reviewer decisions
- Future deterministic resolution/calculation

P4.3 does not resolve dates, convert monthly and annual rent, convert PSF rent from area, expand escalation instructions, prorate partial periods, calculate CPI increases, create additional rent/CAM/tax/insurance/utility/security-deposit/allowance/amortization schedules, generate critical dates, modify `extraction_data`, modify `workflow_output`, change Lease Review output, modify finalizer/readiness logic, add runtime pipeline wiring, or implement P4.4.

## Files And Migrations

Implementation files:

- `supabase/functions/_shared/extraction/lease-financial-schedule/base-rent/base-rent-types.ts`
- `supabase/functions/_shared/extraction/lease-financial-schedule/base-rent/base-rent-key.ts`
- `supabase/functions/_shared/extraction/lease-financial-schedule/base-rent/base-rent-validation.ts`
- `supabase/migrations/20260850000000_lease_base_rent_schedule_candidates_p4_3.sql`

Test files:

- `supabase/functions/_tests/lease-base-rent-schedule-candidates.test.ts`
- `supabase/functions/_tests/lease-base-rent-period-amounts.test.ts`
- `supabase/functions/_tests/lease-base-rent-escalation-conflicts.test.ts`
- `supabase/functions/_tests/lease-base-rent-rpc-contract.test.ts`
- `supabase/functions/_tests/lease-financial-schedule-p4-3-integrated-closure.test.ts`

Report:

- `docs/enterprise-lease-intelligence-p4-3-base-rent-schedule-candidates.md`

Migration count after P4.3: 212.

## Base-Rent Schedule Contract

Contract version: `lease-base-rent-schedules-v1`.

Supporting contract versions:

- `lease-base-rent-periods-v1`
- `lease-base-rent-amounts-v1`
- `lease-base-rent-escalations-v1`
- `lease-base-rent-conflicts-v1`

Canonical schedule types:

- `stated_period_schedule`
- `fixed_step_schedule`
- `fixed_increase_schedule`
- `percentage_increase_schedule`
- `cpi_linked_schedule`
- `formula_schedule`
- `mixed_schedule`
- `unresolved_schedule`

Schedule statuses:

- `extracted`
- `unresolved`
- `ambiguous`
- `needs_review`
- `manual_required`
- `requires_related_document`
- `not_present`
- `not_applicable`
- `unreadable`
- `extraction_failed`

Schedule bases:

- `explicit_periods`
- `term_month_range`
- `date_expression_range`
- `free_rent`
- `abatement`
- `escalation_instruction`
- `mixed`
- `unknown`

The deterministic schedule key includes contract version, org, lease/package identity, uploaded file, extraction run, generation, source package document/effective claim, term candidate, instance key, and sorted source claim ids. It excludes confidence, display text, timestamps, filenames, upload order, and provider response order.

## Period And Amount Contract

Period types:

- `standard_rent_period`
- `free_rent_period`
- `partial_period`
- `holdover_period`
- `unresolved_period`

Billing statuses:

- `billed`
- `fully_abated`
- `partially_abated`
- `not_yet_determined`
- `not_applicable`

Abatement types:

- `full`
- `partial`
- `delayed_commencement`
- `stated_credit`
- `unknown`

Amount roles:

- `billed_base_rent`
- `stated_monthly_rent`
- `stated_annual_rent`
- `annualized_reference`
- `stated_psf_rate`
- `abatement_amount`
- `partial_period_amount`
- `unresolved_amount`

Amount bases:

- `fixed_amount`
- `per_month`
- `per_year`
- `per_square_foot_per_year`
- `per_square_foot_per_month`
- `per_day`
- `percentage`
- `formula_based`
- `unknown`

Frequencies:

- `monthly`
- `annually`
- `quarterly`
- `weekly`
- `daily`
- `one_time`
- `irregular`
- `unknown`

The model keeps stated monthly rent, stated annual rent, annualized reference values, PSF rates, abatement values, and partial-period values as separate records. It does not infer monthly from annual, annual from monthly, PSF from rentable area, or partial-period proration. The focused fixture keeps `$6,004` monthly, `$72,048` annualized, and `24` PSF as distinct amount rows.

## Escalation, Conflict And Review Contract

Escalation types:

- `stated_next_amount`
- `fixed_amount_increase`
- `fixed_percentage_increase`
- `cpi_adjustment`
- `periodic_step`
- `custom_formula`
- `unresolved_escalation`

Escalation instructions are stored as extracted candidates only. P4.3 records explicit step, percentage, CPI-linked, and formula-style instructions without generating future period rows, CPI values, increased rent amounts, or expanded schedules.

Conflict types:

- `overlapping_periods`
- `conflicting_period_amounts`
- `conflicting_period_boundaries`
- `multiple_schedule_candidates`
- `amendment_sequence_ambiguous`
- `escalation_instruction_conflict`
- `frequency_basis_conflict`
- `annualized_vs_billed_role_conflict`
- `stale_generation_candidate`
- `missing_related_document`

Reviewer operations are append-only:

- `accept_schedule`
- `reject_schedule`
- `replace_schedule`
- `accept_period`
- `reject_period`
- `correct_period_boundaries`
- `classify_annualized_vs_billed`
- `select_conflicting_amount`
- `mark_schedule_incomplete`
- `mark_requires_related_document`
- `reopen`

## Provenance And Package Behavior

P4.3 preserves:

- `org_id`
- `lease_id`
- `package_id`
- `uploaded_file_id`
- `extraction_run_id`
- `generation_id`
- `source_package_document_id`
- `source_package_effective_claim_id`
- `term_candidate_id`
- P4.1 date-expression ids
- P4.2 term/dependency ids
- P2 source claim ids
- extraction stage/provider invocation ids when the origin is semantic extraction

Package-aware behavior remains source-preserving. A base lease may establish a base schedule. An assignment preserves inherited economics unless there is an explicit amendment relationship. An amendment may create replacement or bounded period candidates only. Rent addenda stay in the rent domain. Commencement certificates contribute date boundaries only unless they contain explicit rent claims. CAM estimates, security deposits, allowances, amortization schedules, taxes, insurance, and utilities remain outside P4.3.

## RPC, Security And Immutability

Tables added:

- `lease_base_rent_schedule_candidates`
- `lease_base_rent_period_candidates`
- `lease_base_rent_period_amounts`
- `lease_base_rent_escalation_candidates`
- `lease_base_rent_schedule_claim_links`
- `lease_base_rent_schedule_conflicts`
- `lease_base_rent_reviewer_decisions`

RPCs added:

- `persist_lease_base_rent_schedule_candidates(UUID, UUID, UUID, UUID, UUID, UUID, JSONB)`
- `persist_lease_base_rent_period_candidates(UUID, UUID, UUID, JSONB)`
- `persist_lease_base_rent_period_amounts(UUID, UUID, UUID, JSONB)`
- `persist_lease_base_rent_escalation_candidates(UUID, UUID, UUID, JSONB)`
- `record_lease_base_rent_review_decision(UUID, UUID, UUID, UUID, UUID, TEXT, JSONB, UUID, UUID, TEXT, TEXT)`

All RPCs are `SECURITY DEFINER` with `SET search_path = public, pg_temp`. System persistence is service-role-only, validates org/package/file/run/generation context, enforces active generation fencing, and is idempotent through deterministic keys. Reviewer decisions require `auth.uid()`, org membership, idempotency key, stale-generation rejection, and audit-log writes.

P4.3 tables revoke table access from `authenticated` and `anon`; no direct authenticated table writes were added. RLS is enabled. Candidate rows, links, conflicts, escalation rows, amount rows, and reviewer decisions are immutable after insert. Lease deletion may null only `lease_id` where needed; provenance, keys, generation identity, package identity, statuses, and metadata remain intact.

## Feature Mode

`LEASE_FINANCIAL_SCHEDULE_MODE` remains the only financial-schedule feature flag. Its default remains off. P4.3 adds no new feature mode and no runtime orchestration wiring.

## Validation Results

Preflight:

- Branch confirmed: `feature/lease-intelligence-enterprise-p1-p8`.
- Base HEAD before P4.3 edits: `6b6ec01a28799a06a7a1d660b5e54d52179059d0`.
- Working tree was clean before P4.3 edits.
- P4.1 contract present: `lease-date-expressions-v1`, registry hash `4fb01e689af22475cd4df1207847c37589cbfa90e56b31fbe0d30668a4c501a8`.
- P4.2 contracts present: `lease-date-dependencies-v1` and `lease-term-candidates-v1`.
- `LEASE_FINANCIAL_SCHEDULE_MODE` unset resolves to `off`.

Schema replay:

- `bash scripts/db-reset-two-lanes.sh remote-parity`: PASS, exit code 0.
- `bash scripts/db-reset-two-lanes.sh full-repository`: PASS, exit code 0.

Focused P4.3 backend:

- Command: `docker run --rm -v "${PWD}:/work" -w /work denoland/deno:2.7.12 test --no-lock --allow-read --allow-env supabase/functions/_tests/lease-base-rent-schedule-candidates.test.ts supabase/functions/_tests/lease-base-rent-period-amounts.test.ts supabase/functions/_tests/lease-base-rent-escalation-conflicts.test.ts supabase/functions/_tests/lease-base-rent-rpc-contract.test.ts supabase/functions/_tests/lease-financial-schedule-p4-3-integrated-closure.test.ts`
- Result: `26 passed | 0 failed`.

P4.3 Deno check:

- Command: `docker run --rm -v "${PWD}:/work" -w /work denoland/deno:2.7.12 deno check --no-lock supabase/functions/_shared/extraction/lease-financial-schedule/base-rent/base-rent-types.ts supabase/functions/_shared/extraction/lease-financial-schedule/base-rent/base-rent-key.ts supabase/functions/_shared/extraction/lease-financial-schedule/base-rent/base-rent-validation.ts`
- Result: PASS, exit code 0.

Combined P4.1/P4.2/P4.3 focused backend:

- Command: `docker run --rm -v "${PWD}:/work" -w /work denoland/deno:2.7.12 test --no-lock --allow-read --allow-env supabase/functions/_tests/lease-financial-schedule-feature-mode.test.ts supabase/functions/_tests/lease-date-expression-registry.test.ts supabase/functions/_tests/lease-date-expression-validation.test.ts supabase/functions/_tests/lease-date-expression-rpc-contract.test.ts supabase/functions/_tests/lease-date-dependency-graph.test.ts supabase/functions/_tests/lease-term-candidates.test.ts supabase/functions/_tests/lease-date-dependency-term-rpc-contract.test.ts supabase/functions/_tests/lease-financial-schedule-p4-2-integrated-closure.test.ts supabase/functions/_tests/lease-base-rent-schedule-candidates.test.ts supabase/functions/_tests/lease-base-rent-period-amounts.test.ts supabase/functions/_tests/lease-base-rent-escalation-conflicts.test.ts supabase/functions/_tests/lease-base-rent-rpc-contract.test.ts supabase/functions/_tests/lease-financial-schedule-p4-3-integrated-closure.test.ts`
- Result: `73 passed | 0 failed`.

Inherited focused suites:

- P3.8 integrated closure: `4 passed | 0 failed`.
- P1 provenance tests: `38 passed | 0 failed`.
- P2 claims/projection tests: `78 passed | 0 failed`.
- Bounded P0-P4.3 backend regression: 44 files, `331 passed | 0 failed`.

All-files backend command:

- Command: `docker run --rm -v "${PWD}:/work" -w /work denoland/deno:2.7.12 test --no-lock --allow-read --allow-write --allow-env --allow-net --allow-run --allow-import supabase/functions/_tests`
- Result: exit code 1 before test execution.
- Historical blocker: unchanged inherited TypeScript pre-execution blocker in `supabase/functions/_tests/update-lease-extraction-field.property.test.ts` at lines 43, 86, and 101, where `SUPABASE_URL`, `SERVICE_ROLE_KEY`, and `ANON_KEY` are typed as `string | undefined` for APIs requiring `string`.
- New unexplained P4.3 backend failures: 0.

Frontend and build:

- `npm test`: 62 files / 685 tests PASS.
- `npm run lint`: PASS, exit code 0.
- `npm run typecheck`: PASS, exit code 0.
- `npm run build`: PASS, exit code 0; existing Vite dynamic-import and chunk-size warnings only.

Hygiene:

- `git diff --check`: PASS; no whitespace errors, with normal CRLF working-copy warnings only.
- Changed-file secret/content scan: PASS; no Supabase service-role secrets, Azure Document Intelligence keys, Vertex service-account private keys, OAuth access tokens, production credential references, or real customer document content found. The only `service_role` hits are benign SQL role/grant references.

## Explicit Non-Starts

P4.3 did not calculate unresolved dates, monthly rent from annual rent, annual rent from monthly rent, PSF rent from area, escalation expansions, prorations, CPI increases, additional rent, CAM, tax, insurance, utility, security-deposit, allowance, or amortization schedules.

P4.3 did not generate critical dates, modify `extraction_data`, modify `workflow_output`, alter Lease Review output, change finalizer/readiness behavior, wire runtime extraction orchestration, change provider/model/prompt/parser/routing behavior, run a live provider call, run a live-document regression, deploy, write to a remote Supabase database, or push a production migration.

P4.3 did not mutate P2 source claims, P3 package-effective claims, P4.1 date-expression candidates, or P4.2 dependency/term candidates.

## Final Statement

P4.3 complete and locally verified; immutable base-rent schedules, periods, amount representations, abatements and escalation candidates are implemented, but additional financial charges, deterministic calculations and runtime integration have not started.
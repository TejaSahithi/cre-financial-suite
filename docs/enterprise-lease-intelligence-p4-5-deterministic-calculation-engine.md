# Enterprise Lease Intelligence P4.5 Deterministic Calculation Engine

Date: 2026-07-19
Branch: feature/lease-intelligence-enterprise-p1-p8
Base P4.4 commit: 97b6e24
P4.5 commit: this implementation commit; final handoff records the concrete SHA after commit creation.
Verdict: P4.5 complete and locally verified; compatibility projection and runtime/finalizer integration have not started.

## Scope

P4.5 implements a passive deterministic calculation layer over the immutable P4.1-P4.4 source candidates. It does not alter the current Lease Review output path, the package compatibility projection, parser routing, provider wrappers, CAM computation, expense recoverability, finalizer/readiness logic, `extraction_data`, `workflow_output`, or `critical_dates`.

Input flow preserved:

- P2 immutable claims and evidence
- P3 package-effective claim resolution
- P4.1 immutable date-expression candidates
- P4.2 immutable dependency graph and term candidates
- P4.3 immutable base-rent schedule candidates
- P4.4 immutable financial charge candidates
- P4.5 immutable calculation run/result tables only

Every calculated value produced by P4.5 is represented in a new immutable result table. P4.5 does not update `lease_date_expressions`, `lease_date_expression_dependencies`, `lease_term_candidates`, `lease_base_rent_*_candidates`, `lease_financial_charge_*_candidates`, P2 claim rows, or P3 package-effective claim rows.

## Files And Migration

Implementation files:

- `supabase/functions/_shared/extraction/lease-financial-schedule/calculation/calculation-version.ts`
- `supabase/functions/_shared/extraction/lease-financial-schedule/calculation/calculation-types.ts`
- `supabase/functions/_shared/extraction/lease-financial-schedule/calculation/decimal-math.ts`
- `supabase/functions/_shared/extraction/lease-financial-schedule/calculation/date-only-math.ts`
- `supabase/functions/_shared/extraction/lease-financial-schedule/calculation/date-expression-resolver.ts`
- `supabase/functions/_shared/extraction/lease-financial-schedule/calculation/term-resolver.ts`
- `supabase/functions/_shared/extraction/lease-financial-schedule/calculation/rent-calculator.ts`
- `supabase/functions/_shared/extraction/lease-financial-schedule/calculation/charge-formula-evaluator.ts`
- `supabase/functions/_shared/extraction/lease-financial-schedule/calculation/deposit-reconciler.ts`
- `supabase/functions/_shared/extraction/lease-financial-schedule/calculation/amortization-calculator.ts`
- `supabase/functions/_shared/extraction/lease-financial-schedule/calculation/financial-validator.ts`
- `supabase/functions/_shared/extraction/lease-financial-schedule/calculation/calculation-conflict-detector.ts`
- `supabase/functions/_shared/extraction/lease-financial-schedule/calculation/calculation-service.ts`

Test files:

- `supabase/functions/_tests/lease-financial-calculation-date-term.test.ts`
- `supabase/functions/_tests/lease-financial-calculation-rent-charge.test.ts`
- `supabase/functions/_tests/lease-financial-calculation-rpc-contract.test.ts`
- `supabase/functions/_tests/lease-financial-schedule-p4-5-integrated-closure.test.ts`

Migration:

- `supabase/migrations/20260852000000_lease_financial_calculation_results_p4_5.sql`

Report:

- `docs/enterprise-lease-intelligence-p4-5-deterministic-calculation-engine.md`

Migration count after P4.5: 214.

## Versioned Calculation Contract

Calculation version: `lease-financial-calculation-v1`.

Engine versions:

- Date resolution: `lease-date-resolution-engine-v1`
- Term resolution: `lease-term-resolution-engine-v1`
- Rent calculation: `lease-rent-calculation-engine-v1`
- Charge calculation: `lease-charge-calculation-engine-v1`
- Date arithmetic policy: `lease-date-arithmetic-v1`
- Rounding policy: `lease-financial-rounding-half-up-v1`

Registry/version provenance preserved in calculation runs:

- Claims registry: `lease-claims-v1`, hash `4dd86ea371a473e68bb0930b3716740fffdfd3bbcf4979ba2643d9f8e2480a9a`
- Date registry: `lease-date-expressions-v1`, hash `4fb01e689af22475cd4df1207847c37589cbfa90e56b31fbe0d30668a4c501a8`
- Charge registry: `lease-financial-charges-v1`, hash `9339d825b1656e60d311535e3a124218c961d5cb2af2509132f6d04c4550699c`

A calculation run preserves exact input IDs/counts, stable input hash, formula versions, engine versions, registry versions/hashes, rounding policy, assumptions, status, validation codes, and generation identity. Input hashing uses stable sorted serialization so equivalent inputs produce the same run identity regardless of database row order.

## Date-Only Arithmetic Policy

P4.5 uses date-only ISO strings and UTC-only ordinal conversion. It does not depend on JavaScript local timezone offsets.

Documented and tested behaviors:

- End-of-month month addition clamps to the target month end and preserves end-of-month intent.
- Leap-year day/month/year offsets are deterministic.
- Negative offsets are supported, including examples such as 180 days before expiration.
- Relative date outputs record exclusive/inclusive assumptions explicitly.
- Term duration boundaries are inclusive: a duration-derived end date is one day before the same calendar-day anniversary. Therefore, an 86-month initial term after commencement ends on the final day before the 86-month anniversary, not on the anniversary date itself.
- Ambiguous date paths, missing event operands, unresolved operands, dependency cycles, and holiday/business-day adjustments without explicit inputs remain unresolved or needs-review rather than fabricated.

## Decimal And Monetary Policy

P4.5 monetary math uses scaled `BigInt` decimals for calculation paths and does not convert calculated monetary values back through JavaScript `number`.

Explicit scale rules:

- Input decimal scale: 6.
- Intermediate precision scale: 6.
- Currency output scale: 2.
- Percentage-rate scale: 6.
- Rounding mode: half-up, including negative values.
- Overflow bounds are enforced before arithmetic output.
- Currency formatting emits fixed two-decimal strings.

Unresolved unless explicitly supplied:

- missing interest rate
- missing compounding frequency
- missing proration method
- missing CPI input
- missing sales input
- missing area basis
- ambiguous formula
- ambiguous date path

## Financial Separation Guarantees

Annualized reference values and billed values stay distinct.

Known example verified:

- `$6,004 x 12 = $72,048` is an annualized reference.
- With months 1-2 free, first-year billed base rent is `$6,004 x 10 = $60,040`.
- The engine never overwrites or relabels `$72,048` as billed first-year rent.

Other P4.5 calculations preserve stated-versus-calculated variance, leave missing formula inputs unresolved, preserve security-deposit stated totals versus summed components, and do not expand amortization schedules into broad payment histories.

## Schema And RPC Guardrails

New tables:

- `lease_financial_calculation_runs`
- `lease_date_resolution_results`
- `lease_term_resolution_results`
- `lease_base_rent_calculation_results`
- `lease_base_rent_calculated_periods`
- `lease_base_rent_calculated_amounts`
- `lease_financial_charge_calculation_results`
- `lease_financial_formula_evaluation_results`
- `lease_financial_amortization_results`
- `lease_financial_validation_issues`
- `lease_financial_calculation_review_decisions`

Schema guardrails:

- Organization, package, generation, source-candidate, and calculation-run foreign keys are composite/fenced where the source table supports it.
- Lease references use column-scoped `ON DELETE SET NULL (lease_id)` only.
- Financial history avoids broad cascading deletion; new organization references use `ON DELETE RESTRICT`.
- Candidate/source references use `ON DELETE RESTRICT`.
- Result rows and reviewer decisions are immutable after insert.
- Terminal calculation runs are immutable after settlement.
- Run identity is idempotent with a null-safe package expression index over org, package, generation, calculation version, and input hash.
- Arrays and JSON metadata have explicit bounds.
- Raw document text and provider payload metadata are explicitly blocked.
- Every `SECURITY DEFINER` function uses `SET search_path = public, pg_temp`.
- Direct authenticated writes to result tables are revoked. Service-role RPCs own calculation run/result persistence; authenticated reviewer RPCs can only append review decisions with `auth.uid()` identity and org membership checks.
- No overloaded P4.5 RPC signatures were added.

## Passive Feature Mode

`LEASE_FINANCIAL_SCHEDULE_MODE=off` remains passive:

- No calculation-run rows are created through normal runtime.
- No extra pipeline call is introduced.
- No current output changes.
- No readiness changes.

P4.5 tests use pure unit tests and direct isolated SQL/RPC contract assertions only. Runtime pipeline wiring and compatibility projection remain future work.

## Verification

- Deno check for P4.5 modules/tests:
  - Command: `deno check --no-lock supabase/functions/_shared/extraction/lease-financial-schedule/calculation/*.ts supabase/functions/_tests/lease-financial-calculation-date-term.test.ts supabase/functions/_tests/lease-financial-calculation-rent-charge.test.ts supabase/functions/_tests/lease-financial-calculation-rpc-contract.test.ts supabase/functions/_tests/lease-financial-schedule-p4-5-integrated-closure.test.ts`
  - Result: PASS
- Focused P4.5 Deno tests:
  - Command: `docker run --rm -v "${PWD}:/work" -w /work denoland/deno:2.7.12 test --no-lock --allow-read --allow-write --allow-env --allow-net --allow-run --allow-import supabase/functions/_tests/lease-financial-calculation-date-term.test.ts supabase/functions/_tests/lease-financial-calculation-rent-charge.test.ts supabase/functions/_tests/lease-financial-calculation-rpc-contract.test.ts supabase/functions/_tests/lease-financial-schedule-p4-5-integrated-closure.test.ts`
  - Result: `17 passed | 0 failed`
- Combined P4.1-P4.5 financial schedule suite:
  - Command: Linux Deno 2.7.12 over P4.1 date, P4.2 dependency/term, P4.3 base-rent, P4.4 financial-charge, and P4.5 calculation tests.
  - Result: `92 passed | 0 failed`
- P3.8 closure:
  - Command: `denoland/deno:2.7.12 test ... supabase/functions/_tests/lease-package-p3-8-integrated-closure.test.ts`
  - Result: `4 passed | 0 failed`
- P1 provenance:
  - Command: `denoland/deno:2.7.12 test ... supabase/functions/_tests/extraction-provenance-*.test.ts supabase/functions/_tests/extraction-provenance-recorder.test.ts`
  - Result: `38 passed | 0 failed`
- P2 claims/projection:
  - Command: `denoland/deno:2.7.12 test ... supabase/functions/_tests/lease-claims-*.test.ts`
  - Result: `78 passed | 0 failed`
- Bounded P0-P4.5 backend regression slice:
  - Discovery pattern: `extraction-provenance|lease-review-readiness|lease-claims|lease-document|lease-package|lease-date-expression|lease-date-dependency|lease-term|lease-financial-schedule|lease-base-rent|lease-financial-charge|lease-financial-calculation`
  - Result: `FILES=52`; `362 passed | 0 failed`
- Full all-files backend command:
  - Command: `docker run --rm -v "${PWD}:/work" -w /work denoland/deno:2.7.12 test --no-lock --allow-read --allow-write --allow-env --allow-net --allow-run --allow-import supabase/functions/_tests`
  - Result: blocked before test execution by pre-existing TypeScript errors in `supabase/functions/_tests/update-lease-extraction-field.property.test.ts` at lines 43, 86, and 101 where `SUPABASE_URL`, `SERVICE_ROLE_KEY`, and `ANON_KEY` are typed `string | undefined` for APIs requiring `string`.
  - Comparison: unchanged from the P4.4 baseline blocker; no new P4.5 all-files backend failure was observed before the typecheck stop.
- Windows Deno note:
  - Runtime: `deno 2.7.12 (stable, release, x86_64-pc-windows-msvc)`.
  - Direct Windows `deno test` hit the inherited Deno test-runner pipe/channel panic during check/startup before any test failures were reported. Linux Docker was used for trustworthy backend execution.
- Remote-parity DB reset lane:
  - Command: `bash scripts/db-reset-two-lanes.sh remote-parity`
  - Result: PASS
- Full-repository DB reset lane:
  - Command: `bash scripts/db-reset-two-lanes.sh full-repository`
  - Result: PASS
- Frontend regression:
  - `npm test -- --run`: `62 passed (62)` files; `685 passed (685)` tests. Initial sandbox run hit Vite/esbuild `spawn EPERM`; escalated rerun passed.
  - `npm run lint`: PASS
  - `npm run typecheck`: PASS
  - `npm run build`: PASS with existing Vite dynamic-import and chunk-size warnings.

## Guardrail Scan

Accidental runtime integration search:

- Command: `git grep -n "lease_financial_calculation_runs" -- supabase/functions src ':!supabase/functions/_tests/**' ':!supabase/functions/_shared/extraction/lease-financial-schedule/calculation/**'`
- Result: no matches.

Forbidden current-output write scan over changed files:

- Terms checked: `extraction_data|workflow_output|critical_dates|review_readiness|finalize_lease_extraction_for_review`.
- Matches are limited to report text, contract-test assertions, and `financial-validator.ts` rejecting runtime/current-output keys as invalid calculation inputs; no implementation write path was added.

Secret/content scan:

- Changed files and report contain no Supabase service-role secrets, Azure Document Intelligence keys, Vertex service-account private keys, OAuth access tokens, production project references used as credentials, or real customer document content.
- Literal `service_role` occurrences are SQL role checks/grants and static contract-test assertions only.

## Boundary For Next Phase

P4.6 can begin compatibility projection only after this commit. P4.5 does not start compatibility projection, runtime pipeline wiring, finalizer integration, Lease Review frontend work, CAM computation, expense recoverability, provider routing, parser routing, or normalization orchestration.

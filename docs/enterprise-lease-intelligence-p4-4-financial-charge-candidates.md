# Enterprise Lease Intelligence Roadmap - P4.4 Financial Charge Candidate Foundation

Date: 2026-07-19
Base commit: 80b706fc70091fdce5911948a50319d9350fb8b6
Branch: feature/lease-intelligence-enterprise-p1-p8

## Verdict

P4.4 complete and locally verified with the expected phase boundary: immutable additional-charge, deposit/prepaid, allowance/contribution/reimbursement, formula, percentage-rent, conflict, amortization-instruction, and reviewer-decision candidate surfaces now exist. Deterministic financial calculation, compatibility projection, and runtime integration have not started.

## Implemented

- Added canonical P4.4 financial charge registry: `lease-financial-charges-v1`.
- Registry hash: `9339d825b1656e60d311535e3a124218c961d5cb2af2509132f6d04c4550699c`.
- Added deterministic key builders for charge, period, amount, deposit component, amortization instruction, and formula candidates.
- Added normalization for known financial charge aliases; unknown types return `null` and do not default to additional rent.
- Added validation for explicit candidate evidence, provenance/context fences, registry/hash fences, estimate/final separation, base-rent conflation prevention, deposit component separation, formula instructions, and amortization instructions.
- Added migration `20260851000000_lease_financial_charge_candidates_p4_4.sql` with immutable candidate tables, registry snapshot tables, RLS, service-role persistence RPC boundaries, and authenticated reviewer-decision RPC boundary.
- Added deterministic registry SQL generator: `scripts/generate-financial-charge-registry.ts`.

## Out Of Scope Preserved

P4.4 does not calculate or project financial outputs. The new code and migration explicitly reject calculated/generated metadata including:

- amortization schedules or computed payments
- percentage rent outputs
- CAM computations or recoverability results
- allocations, gross-up, reconciliation, caps/floors/stops outputs
- generated/expanded periods
- due dates, resolved dates, date/rent schedules, and critical dates

The migration does not update `extraction_data`, `workflow_output`, finalizer/readiness functions, providers, parser code, runtime routing, P2/P3 immutable source rows, P4.1 date expressions, P4.2 dependency/term rows, or P4.3 base-rent rows.

## Verification

- Focused P4.4 Deno tests:
  - Command: `docker run --rm -v "${PWD}:/work" -w /work denoland/deno:2.7.12 test --no-lock --allow-read --allow-env supabase/functions/_tests/lease-financial-charge-registry.test.ts supabase/functions/_tests/lease-financial-charge-candidates.test.ts supabase/functions/_tests/lease-financial-charge-rpc-contract.test.ts supabase/functions/_tests/lease-financial-schedule-p4-4-integrated-closure.test.ts`
  - Result: `14 passed | 0 failed`
- Deno check for P4.4 modules and generator:
  - Command: `docker run --rm -v "${PWD}:/work" -w /work denoland/deno:2.7.12 deno check --no-lock supabase/functions/_shared/extraction/lease-financial-schedule/charges/financial-charge-registry-version.ts supabase/functions/_shared/extraction/lease-financial-schedule/charges/financial-charge-types.ts supabase/functions/_shared/extraction/lease-financial-schedule/charges/financial-charge-registry.ts supabase/functions/_shared/extraction/lease-financial-schedule/charges/financial-charge-normalization.ts supabase/functions/_shared/extraction/lease-financial-schedule/charges/financial-charge-key.ts supabase/functions/_shared/extraction/lease-financial-schedule/charges/financial-charge-validation.ts scripts/generate-financial-charge-registry.ts`
  - Result: PASS
- Combined P4.1-P4.4 financial schedule suite:
  - Result: `87 passed | 0 failed`
- Remote-parity DB reset lane:
  - Command: `bash scripts/db-reset-two-lanes.sh remote-parity`
  - Result: PASS
- Full-repository DB reset lane:
  - Command: `bash scripts/db-reset-two-lanes.sh full-repository`
  - Result: PASS
- Bounded P0-P4.4 backend regression slice:
  - Command: discovered 48 files matching `extraction-provenance|lease-review-readiness|lease-claims|lease-document|lease-package|lease-date-expression|lease-date-dependency|lease-term|lease-financial-schedule|lease-base-rent|lease-financial-charge`
  - Result: `FILES=48`; `345 passed | 0 failed`
- Full all-files backend command:
  - Command: `docker run --rm -v "${PWD}:/work" -w /work denoland/deno:2.7.12 test --no-lock --allow-read --allow-write --allow-env --allow-net --allow-run --allow-import supabase/functions/_tests`
  - Result: blocked before execution by pre-existing TypeScript errors in `supabase/functions/_tests/update-lease-extraction-field.property.test.ts` at lines 43, 86, and 101 where `SUPABASE_URL`, `SERVICE_ROLE_KEY`, and `ANON_KEY` are typed `string | undefined` for APIs requiring `string`.
  - Comparison: unchanged from the P4.3 baseline blocker; no new P4.4 all-files backend failure was observed before the typecheck stop.
- Frontend regression:
  - `npm test`: `62 passed (62)` files; `685 passed (685)` tests. Initial sandbox run hit Vite/esbuild `spawn EPERM`; rerun outside sandbox passed.
  - `npm run lint`: PASS
  - `npm run typecheck`: PASS
  - `npm run build`: PASS with existing Vite dynamic-import and chunk-size warnings.
- Secret scan:
  - Changed-file scan found no committed provider credentials, OAuth tokens, production credential references, or customer data.
  - Literal `service_role` occurrences are SQL role checks/grants and static contract-test assertions only.

## Boundary For Next Phase

P4.5 can build deterministic package precedence over these immutable candidates. It should not assume amortization, percentage rent, CAM, recoverability, allocation, or due-date calculations already exist.

# Enterprise Lease Intelligence P4.2 Date Dependency Graph And Term Candidates

Date: 2026-07-19
Branch: feature/lease-intelligence-enterprise-p1-p8
Base P4.1 commit: 048a3c2
P4.2 commit: this implementation commit; final handoff records the concrete SHA after commit creation.
Verdict: P4.2 complete and locally verified; P4.3 has not started.

## Scope

P4.2 implements only the immutable date dependency graph and immutable lease-term candidate model that sit after P4.1 date-expression candidates and before future deterministic date resolution.

Flow preserved:

- P2/P3 effective source claims
- P4.1 immutable date-expression candidates
- P4.2 expression dependency graph
- P4.2 lease-term candidates
- Future P4.5 deterministic resolution/calculation

P4.2 does not resolve dependent expressions into dates, calculate commencement or expiration, expand recurring occurrences, calculate option deadlines, build rent schedules, calculate rent, generate critical dates, modify `extraction_data`, modify `workflow_output`, change Lease Review output, modify finalizer/readiness logic, add runtime pipeline wiring, or implement P4.3.

## Files And Migrations

Implementation files:

- `supabase/functions/_shared/extraction/lease-financial-schedule/date-dependencies/date-dependency-types.ts`
- `supabase/functions/_shared/extraction/lease-financial-schedule/date-dependencies/date-dependency-key.ts`
- `supabase/functions/_shared/extraction/lease-financial-schedule/date-dependencies/date-dependency-validation.ts`
- `supabase/functions/_shared/extraction/lease-financial-schedule/terms/lease-term-types.ts`
- `supabase/functions/_shared/extraction/lease-financial-schedule/terms/lease-term-key.ts`
- `supabase/functions/_shared/extraction/lease-financial-schedule/terms/lease-term-validation.ts`
- `supabase/migrations/20260849000000_lease_date_dependency_and_term_candidates_p4_2.sql`

Test files:

- `supabase/functions/_tests/lease-date-dependency-graph.test.ts`
- `supabase/functions/_tests/lease-term-candidates.test.ts`
- `supabase/functions/_tests/lease-date-dependency-term-rpc-contract.test.ts`
- `supabase/functions/_tests/lease-financial-schedule-p4-2-integrated-closure.test.ts`

Report:

- `docs/enterprise-lease-intelligence-p4-2-date-dependency-term-candidates.md`

Migration count after P4.2: 211.

## Dependency Graph Contract

Contract version: `lease-date-dependencies-v1`.

Direction convention: `source_expression` depends on `target_expression`.

Canonical dependency types:

- `anchor`
- `offset_anchor`
- `event_anchor`
- `alternative`
- `condition`
- `minimum_operand`
- `maximum_operand`
- `earlier_of_operand`
- `later_of_operand`
- `recurrence_anchor`
- `notice_anchor`
- `term_start`
- `term_end`
- `resolves`
- `supersedes_expression`
- `contextual`

Dependency statuses:

- `proposed`
- `valid`
- `ambiguous`
- `needs_review`
- `requires_related_document`
- `invalid`
- `superseded`

The deterministic dependency key includes contract version, org, lease/package identity, uploaded file, extraction run, generation, source expression id, target expression id or related-document requirement, dependency type, operand role/order, condition key, and source claim identity. It excludes timestamps, row order, filenames, upload order, and confidence-only selection.

Validation requires same org, same lease/package/file/run/generation context, valid source expression, valid target expression when present, no self-reference, no active dependency target pointing at stale/inactive expression statuses, explicit operand order for legally meaningful operand types, valid related-document requirements for missing anchors, and rejection of graph cycles.

## Term Candidate Contract

Contract version: `lease-term-candidates-v1`.

Canonical term types:

- `initial_term`
- `extension_term`
- `renewal_term`
- `option_term`
- `holdover_term`
- `construction_period`
- `rent_free_period`
- `partial_term`
- `unknown_term`

Term statuses use the P4.2/P4.1-compatible status vocabulary:

- `proposed`
- `valid`
- `ambiguous`
- `needs_review`
- `requires_related_document`
- `invalid`
- `superseded`

Origin types reuse the P4.1 vocabulary:

- `extracted`
- `reviewer`
- `derived`
- `calculated`
- `legacy_adapter`
- `system_projection`

The deterministic term key includes contract version, org, lease/package identity, uploaded file, extraction run, generation, term type, instance key, start/end expression ids, duration value/unit/inclusive rule, sequence number, parent term candidate, source effective claim, stable source claim ids, and related-document requirement. It excludes insertion time, row order, filename, upload order, and confidence-only selection.

Term validation requires canonical type/status/origin, same org/package/file/run/generation for start/end expressions, active-generation context, valid duration pairings, positive sequence numbers, related-document requirements when status requires them, and no P4.2 metadata fields that imply resolved dates, calculated dates, rent schedules, or critical dates.

## Cycle Detection

Cycle detection follows the graph direction `source_expression` depends on `target_expression`. New edges are rejected when they would create a dependency loop through existing active edges. The focused regression covers a three-expression loop and verifies that non-cyclic DAG edges remain accepted.

## Package-Aware Date Effect Behavior

P4.2 preserves package-aware provenance from P3 and P4.1. Dependency and term rows validate org, package, uploaded file, extraction run, generation, source claim, and package-effective claim identity without mutating P2 source claims, P3 package-effective claims, or P4.1 expression candidates.

Package-related date effects remain modeled as immutable dependencies and term candidates. P4.2 does not choose fixed effective dates, flatten legal dependency expressions, or use upload order as precedence.

## Related-Document Handling

Missing anchors and incomplete terms can be represented with `requires_related_document` status and a stable related-document requirement id. This preserves the distinction between known-but-unavailable supporting documents and invalid extraction. P4.2 does not fabricate a target date or collapse the requirement into an extracted value.

## Reviewer Decision Contract

Reviewer operations are append-only.

Dependency reviewer operations:

- `accept`
- `reject`
- `replace`
- `select_ambiguous_anchor`
- `mark_requires_related_document`
- `reopen`

Term reviewer operations:

- `accept`
- `reject`
- `replace`
- `mark_requires_related_document`
- `reopen`

RPCs added:

- `persist_lease_date_expression_dependencies(UUID, UUID, UUID, UUID, UUID, UUID, JSONB)`
- `persist_lease_term_candidates(UUID, UUID, UUID, UUID, UUID, UUID, JSONB)`
- `record_lease_date_dependency_review_decision(UUID, UUID, TEXT, JSONB, UUID, UUID, TEXT, TEXT)`
- `record_lease_term_review_decision(UUID, UUID, TEXT, JSONB, UUID, TEXT, TEXT)`

All RPCs are `SECURITY DEFINER` with fixed `search_path = public, pg_temp`. System persistence is service-role-only, bounded to batches of 100, validates org/package/file/run/generation context, enforces active-generation fencing, and is idempotent through deterministic keys. Reviewer RPCs require `auth.uid()`, org membership, idempotency key, stale-generation rejection, and audit-log writes. Direct authenticated table writes are not granted.

## Immutability And Deletion

Dependency rows and term candidates are immutable after insert. Reviewer decision rows are append-only. Lease deletion may null only the `lease_id` column through column-scoped `ON DELETE SET NULL (lease_id)` behavior; historical provenance, expression links, generation identity, package identity, keys, statuses, and metadata remain intact.

## Feature Mode

`LEASE_FINANCIAL_SCHEDULE_MODE` remains the only financial-schedule feature flag. Its default remains off. P4.2 adds no new feature mode and no runtime orchestration wiring. Shadow/active behavior is represented only in isolated tests and static contracts.

## Validation Results

Preflight:

- Branch confirmed: `feature/lease-intelligence-enterprise-p1-p8`.
- Base HEAD before P4.2 edits: `048a3c2`.
- Working tree was clean before P4.2 edits.
- P4.1 contract present: `lease-date-expressions-v1`, registry hash `4fb01e689af22475cd4df1207847c37589cbfa90e56b31fbe0d30668a4c501a8`.

Schema replay:

- `bash scripts/db-reset-two-lanes.sh remote-parity`: PASS, exit code 0.
- `bash scripts/db-reset-two-lanes.sh full-repository`: PASS, exit code 0.

Focused P4.2 backend:

- Command: `docker run --rm -v "${PWD}:/work" -w /work denoland/deno:2.7.12 test --no-lock --allow-read --allow-env supabase/functions/_tests/lease-date-dependency-graph.test.ts supabase/functions/_tests/lease-term-candidates.test.ts supabase/functions/_tests/lease-date-dependency-term-rpc-contract.test.ts supabase/functions/_tests/lease-financial-schedule-p4-2-integrated-closure.test.ts`
- Result: `21 passed | 0 failed`.

P4.2 Deno check:

- Command: `docker run --rm -v "${PWD}:/work" -w /work denoland/deno:2.7.12 deno check --no-lock supabase/functions/_shared/extraction/lease-financial-schedule/date-dependencies/date-dependency-types.ts supabase/functions/_shared/extraction/lease-financial-schedule/date-dependencies/date-dependency-key.ts supabase/functions/_shared/extraction/lease-financial-schedule/date-dependencies/date-dependency-validation.ts supabase/functions/_shared/extraction/lease-financial-schedule/terms/lease-term-types.ts supabase/functions/_shared/extraction/lease-financial-schedule/terms/lease-term-key.ts supabase/functions/_shared/extraction/lease-financial-schedule/terms/lease-term-validation.ts`
- Result: PASS, exit code 0.

Combined P4.1/P4.2 focused backend:

- Command: `docker run --rm -v "${PWD}:/work" -w /work denoland/deno:2.7.12 test --no-lock --allow-read --allow-env supabase/functions/_tests/lease-financial-schedule-feature-mode.test.ts supabase/functions/_tests/lease-date-expression-registry.test.ts supabase/functions/_tests/lease-date-expression-validation.test.ts supabase/functions/_tests/lease-date-expression-rpc-contract.test.ts supabase/functions/_tests/lease-date-dependency-graph.test.ts supabase/functions/_tests/lease-term-candidates.test.ts supabase/functions/_tests/lease-date-dependency-term-rpc-contract.test.ts supabase/functions/_tests/lease-financial-schedule-p4-2-integrated-closure.test.ts`
- Result: `47 passed | 0 failed`.

Inherited focused suites:

- P3.8 integrated closure: `4 passed | 0 failed`.
- P1 provenance tests: `38 passed | 0 failed`.
- P2 claims/projection tests: `78 passed | 0 failed`.
- Bounded P0-P4.2 backend regression: 39 files, `305 passed | 0 failed`.

All-files backend command:

- Command: `docker run --rm -v "${PWD}:/work" -w /work denoland/deno:2.7.12 test --no-lock --allow-read --allow-write --allow-env --allow-net --allow-run --allow-import supabase/functions/_tests`
- Result: exit code 1 before test execution.
- Historical blocker: unchanged inherited TypeScript pre-execution blocker in `supabase/functions/_tests/update-lease-extraction-field.property.test.ts` at lines 43, 86, and 101, where `SUPABASE_URL`, `SERVICE_ROLE_KEY`, and `ANON_KEY` are typed as `string | undefined` for APIs requiring `string`.
- New unexplained P4.2 backend failures: 0.

Frontend and build:

- `npm test`: 62 files / 685 tests PASS.
- `npm run lint`: PASS, exit code 0.
- `npm run typecheck`: PASS, exit code 0.
- `npm run build`: PASS, exit code 0; existing Vite dynamic-import and chunk-size warnings only.

Hygiene:

- `git diff --check`: PASS before commit.
- Changed-file secret/content scan: no credential material, cloud-provider key material, OAuth token material, production credential references, or real customer-document content found in the P4.2 implementation, tests, migration, or report.

## Explicit Non-Starts

P4.2 did not resolve date expressions into concrete dates, calculate commencement or expiration, expand recurring deadlines, calculate option deadlines, build rent schedules, calculate rent, generate critical dates, change Lease Review output, modify `extraction_data`, modify `workflow_output`, wire runtime extraction orchestration, modify finalizer/readiness logic, change provider/model/prompt/parser/routing behavior, run a live provider call, run a live-document regression, deploy, write to a remote Supabase database, or push a production migration.

P4.2 did not mutate P2 source claims, P3 package-effective claims, or P4.1 date-expression candidates.

## Final Statement

P4.2 complete and locally verified; the date dependency graph and immutable lease-term candidate model are implemented, but deterministic date resolution, rent schedules and financial calculations have not started.

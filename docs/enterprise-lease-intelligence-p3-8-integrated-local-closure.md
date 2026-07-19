# Enterprise Lease Intelligence P3.8 Integrated Local Closure

Date: 2026-07-19
Branch: feature/lease-intelligence-enterprise-p1-p8
Base commits: P3.1 c5b33db; P3.2 411691f; P3.3 20411f4; P3.4 259ef70; P3.5 558c447; P3.6 6cf3605; P3.7 07bc65b
Verdict: P3 complete and locally verified. Real-document pre-shadow acceptance remains required before enabling LEASE_DOCUMENT_PACKAGE_MODE=shadow against real tenant traffic.

## Scope

P3.8 is the final integrated local verification and closure pass for Enterprise Lease Intelligence P3. It validates the P3.1-P3.7 package graph, relationship detection, package membership, package-effective claim resolution, compatibility projection, runtime mode gating, active write-back contract, finalizer/readiness boundary, reviewer routes, retry/idempotency behavior, schema security, and default-off feature modes as one local package workflow.

P3.8 does not start P4. It does not add P4 date/rent calculation, P5 CAM or expense generation, P6 frontend redesign, provider/model/prompt/routing/parser changes, deployment, production migration push, remote database write, or live Azure/Vertex/Gemini/Docling/provider calls.

## Implementation

Changed files:

- `supabase/functions/_shared/extraction/document-package/resolution/package-claim-resolver.ts`
- `supabase/functions/_tests/lease-package-p3-8-integrated-closure.test.ts`
- `docs/enterprise-lease-intelligence-p3-8-integrated-local-closure.md`

No migration was added.

P3.8 added a sanitized integrated closure suite covering:

- base-only packages;
- assignment-only missing-base requirements;
- base plus assignment;
- base plus amendment;
- base plus two distinct amendments;
- base plus two conflicting amendments;
- combined assignment/amendment independent split;
- extension, renewal, commencement certificate, addenda, work letter, and guaranty scoped behavior;
- unknown supported documents;
- two possible base documents;
- missing prior amendment requirements;
- ambiguous supersession;
- feature-mode dependency matrix;
- stale generation fencing;
- deterministic retry keys;
- reviewer conflict decisions;
- finalizer signature and package-active blockers;
- write-back allowlist/rejectlist;
- package graph/RPC security;
- cross-org projection rejection;
- no provider fetch, no P4/P5 runtime strings, and no package-active review-save bypass.

## Defect Found And Fixed

The integrated closure test exposed one real P3 defect in combined `assignment_and_amendment` documents. When the same source claim was reachable through both an `assigns` relationship and an `amends` relationship, the resolver deduplicated candidates by relationship id ordering. That could attribute a party-domain claim such as tenant/assignee change to amendment authority (`explicit_amendment_override`) instead of assignment authority (`assignment_party_change`).

The fix is narrow and generic:

- For non-combined document profiles, existing dedupe ordering is preserved.
- For `assignment_and_amendment` source documents, relationship preference now follows the existing concept-domain policy.
- Party, assignment, and notices domains prefer `assigns`.
- All other domains prefer `amends`.
- The rule is applied only inside same-source-claim candidate dedupe; it does not add new precedence domains, mutate source claims, or change persistence/approval behavior.

## Local Feature Modes

Default-off behavior remains intact:

- `LEASE_CLAIMS_LEDGER_MODE` unset resolves to off.
- `LEASE_DOCUMENT_PACKAGE_MODE` unset resolves to off.
- Package shadow requires claims shadow or active.
- Package active requires claims active.
- Invalid or browser-supplied package modes fail closed and cannot override server-owned env mode.

## Verification

Preflight:

- Branch confirmed: `feature/lease-intelligence-enterprise-p1-p8`.
- Base HEAD before P3.8 edits: `07bc65b`.
- Migration count before and after P3.8: 209.
- Registry and package versions present: `lease-claims-v1`, `lease-document-profiles-v1`, `lease-document-relationships-v1`, `lease-package-resolution-v1`, `lease-package-projection-v1`.
- No P4 implementation changes were present before P3.8.

Database replay:

- `bash scripts/db-reset-two-lanes.sh remote-parity`: PASS, exit code 0.
- `bash scripts/db-reset-two-lanes.sh full-repository`: PASS, exit code 0.

Focused P3.8 suite:

- Command: `docker run --rm -v "${PWD}:/work" -w /work denoland/deno:2.7.12 test --no-lock --allow-read --allow-env supabase/functions/_tests/lease-package-p3-8-integrated-closure.test.ts`
- Result: 4 passed | 0 failed.

Focused P3.5/P3.6/P3.7 regressions after the fix:

- P3.5 command: `docker run --rm -v "${PWD}:/work" -w /work denoland/deno:2.7.12 test --no-lock --allow-read --allow-env supabase/functions/_tests/lease-package-claim-resolution.test.ts supabase/functions/_tests/lease-package-resolution-service.test.ts supabase/functions/_tests/lease-package-resolution-rpc-contract.test.ts`
- P3.5 result: 14 passed | 0 failed.
- P3.6 command: `docker run --rm -v "${PWD}:/work" -w /work denoland/deno:2.7.12 test --no-lock --allow-read --allow-env supabase/functions/_tests/lease-package-projection.test.ts supabase/functions/_tests/lease-package-projection-service.test.ts supabase/functions/_tests/lease-package-projection-rpc-contract.test.ts`
- P3.6 result: 13 passed | 0 failed.
- P3.7 command: `docker run --rm -v "${PWD}:/work" -w /work denoland/deno:2.7.12 test --no-lock --allow-read --allow-env supabase/functions/_tests/lease-package-runtime-orchestrator.test.ts supabase/functions/_tests/lease-package-runtime-rpc-contract.test.ts`
- P3.7 result: 6 passed | 0 failed.

Bounded P0/P1/P2/P3.8 backend regression:

- Runtime: `denoland/deno:2.7.12`.
- Command: bounded claims/provenance/profile/package/relationship/resolution/projection/runtime/readiness Deno suite selected by `rg --files supabase/functions/_tests | Where-Object { $_ -match 'extraction-provenance|lease-review-readiness|lease-claims|lease-document|lease-package' }`.
- Files: 31.
- Result: 258 passed | 0 failed.

Full all-files backend command:

- Command: `docker run --rm -v "${PWD}:/work" -w /work denoland/deno:2.7.12 test --no-lock --allow-read --allow-write --allow-env --allow-net --allow-run --allow-import supabase/functions/_tests`
- Result: exit code 1 before test execution.
- Failure: TypeScript type-check failure remains in `supabase/functions/_tests/update-lease-extraction-field.property.test.ts` where `SUPABASE_URL`, `SERVICE_ROLE_KEY`, and `ANON_KEY` are typed as `string | undefined` at call sites requiring `string`.
- Classification: inherited all-files suite blocker, unchanged from prior P3 baselines; not a P3.8 resolver, package graph, runtime, finalizer, write-back, reviewer-boundary, or schema regression.

Local DB catalog checks:

- Finalizer signatures: exactly one, `finalize_lease_extraction_for_review(uuid,uuid,uuid,uuid,uuid,text,text,text)`.
- Package graph authenticated DML grants: 0.
- Package RPCs with bad fixed `search_path`: 0.
- Untargeted composite foreign keys with `ON DELETE SET NULL`: 0.

Frontend and build checks:

- `npm test`: PASS, 62 files / 685 tests.
- `npm run lint`: PASS.
- `npm run typecheck`: PASS.
- `npm run build`: PASS; existing Vite dynamic-import/chunk-size warnings only.

Diff hygiene and scans:

- `git diff --check`: PASS.
- Changed-file secret scan: PASS. Broad literal scan found only non-secret symbolic references (`SERVICE_ROLE_KEY`, SQL role `service_role`, and report wording about customer document content); value-oriented credential/content scan found no Supabase service-role secret values, Azure Document Intelligence keys, Vertex private keys, OAuth tokens, production credential references used as credentials, or real customer payloads.

## Real-Document Corpus

Local search did not find an approved real four-document corpus or grounded saved artifacts suitable for P3.8 pre-shadow acceptance. The available local files were scratch PDFs, sanitized test fixtures, docs, diagnostics, and browser/profile artifacts.

No raw document text or customer document content was used in this report.

Real-document pre-shadow acceptance remains required before enabling `LEASE_DOCUMENT_PACKAGE_MODE=shadow` against real tenant traffic.

## Provider And Deployment Safety

- No Azure call was made.
- No Vertex call was made.
- No Gemini call was made.
- No Docling/parser live-provider path was invoked.
- No provider, model, prompt, parser, or routing change was made.
- No deployment was performed.
- No remote Supabase access was performed.
- No production migration push was performed.
- No live document regression was run.
- Default feature modes remain off.

Docker Deno test runs downloaded public Deno/npm CDN dependencies as needed for local test execution. The P3.8 implementation itself adds no provider fetch path.

## Deferred Work

- Real four-document pre-shadow acceptance with base lease, assignment, amendment, and termination/commencement or similar representative package remains required.
- P4 date/rent calculation has not started.
- P5 CAM/expense generation has not started.
- P6 frontend package UX has not started.
- No production or tenant-traffic activation is approved by P3.8.

# Enterprise Lease Intelligence P3.7 Package Runtime Orchestration

Date: 2026-07-19
Branch: feature/lease-intelligence-enterprise-p1-p8
Base commits: P3.1 c5b33db; P3.2 411691f; P3.3 20411f4; P3.4 259ef70; P3.5 558c447; P3.6 6cf3605
Verdict: P3.7 complete and locally verified; package orchestration, shadow comparison, active-mode compatibility write-back and finalizer/readiness integration are implemented behind default-off feature modes. Full integrated P3 closure and real-document pre-shadow acceptance remain pending P3.8.

## Scope

P3.7 wires the already-built P3 document-package services into the server-owned extraction orchestration path behind `LEASE_DOCUMENT_PACKAGE_MODE=off|shadow|active`.

Default behavior remains off. P3.7 does not add provider routing, prompt changes, parser changes, P4 date/rent calculation, P5 CAM/expense generation, Lease Review UI redesign, deployment, production migration push, remote database write, live provider call, or live document regression.

## Implementation

Changed files and migration:

- `supabase/functions/_shared/extraction/document-package/runtime/package-runtime-errors.ts`
- `supabase/functions/_shared/extraction/document-package/runtime/package-runtime-orchestrator.ts`
- `supabase/functions/_shared/extraction/document-package/runtime/package-runtime-result.ts`
- `supabase/functions/_shared/extraction/document-package/runtime/package-runtime-types.ts`
- `supabase/functions/_tests/lease-package-runtime-orchestrator.test.ts`
- `supabase/functions/_tests/lease-package-runtime-rpc-contract.test.ts`
- `supabase/functions/lease-extraction-worker/index.ts`
- `supabase/functions/normalize-pdf-output/index.ts`
- `supabase/functions/save-lease-review-draft/index.ts`
- `supabase/migrations/20260847000000_lease_package_runtime_p3_7.sql`
- `docs/enterprise-lease-intelligence-p3-7-package-runtime-orchestration.md`

Runtime orchestration boundary:

- `normalize-pdf-output` resolves server-owned claims/package modes.
- P2 claims ledger and single-document projection run first.
- `maybeRunLeaseDocumentPackagePipeline(...)` runs after completed P2 projection and before `finalize_lease_extraction_for_review(...)`.
- The orchestrator revalidates org/file/lease/generation/run identity from the database.
- Package runtime output is bounded status metadata only; raw claims, raw evidence, raw provider payloads, and lease text are not returned.

Mode dependency matrix:

- Package off: claims mode may be off, shadow, or active; no package orchestration is invoked and current P2 behavior remains unchanged.
- Package shadow: claims mode must be shadow or active; completed P2 claim ledger and projection are required; package writes are isolated to package runtime/projection/diff records and do not change `leases.extraction_data`.
- Package active: claims mode must be active; package compatibility projection is authoritative; failed or missing package state blocks readiness; no silent fallback to P2 compatibility output.

Structured mode errors:

- `PACKAGE_MODE_REQUIRES_CLAIMS_LEDGER`
- `PACKAGE_ACTIVE_REQUIRES_CLAIMS_ACTIVE`
- `PACKAGE_MODE_CONFIGURATION_INVALID`

## Runtime Behavior

Off mode:

- Returns a disabled runtime result before package DB reads or writes.
- Creates zero P3 package runtime rows.
- Leaves existing finalizer behavior unchanged.

Shadow mode:

- Runs or reuses profile, membership, relationship, resolution, projection, and comparison state after P2 projection exists.
- Persists package run/projection/diff evidence.
- Keeps the single-document compatibility payload authoritative.
- Records package failure as failed package coverage without blocking legacy readiness.

Active mode:

- Runs the complete package pipeline.
- Persists the package-aware compatibility payload through `persist_lease_package_claim_projection`.
- Treats package identity, stale generation, failed projection, failed write-back, open required conflict, required related-document gap, and invalid effective claim as readiness blockers.
- Does not downgrade to single-document output when package runtime fails.

## Compatibility Write-Back

New server-owned RPC:

- `persist_lease_package_claim_projection(UUID, UUID, UUID, UUID, UUID, UUID, UUID, UUID, JSONB, TEXT)`

The RPC validates:

- service-role execution;
- organization/file/lease relationship;
- locked active generation;
- extraction run ownership;
- package, resolution, and projection run ownership/completion;
- same package/generation identity;
- no stale projection source generation;
- no open critical required package conflict;
- bounded compatibility payload keys and payload size;
- approved-lease write rejection;
- idempotency key/hash behavior.

Allowed compatibility keys are limited to current Lease Review-compatible output such as `fields`, `field_evidence`, `confidence_scores`, optional `custom_fields`, `discovered_fields`, `rejected_fields`, and bounded package projection debug metadata. The RPC rejects raw claims, raw relationship graphs, provider metadata, storage paths, workflow-output replacement, CAM/expense/budget structures, wrong package/run identities, stale generations, approved leases, and idempotency conflicts.

## Finalizer Integration

`finalize_lease_extraction_for_review` remains the only authority that can set `review_readiness='ready'`.

P3.7 replaces the previous seven-argument function with one authoritative eight-argument signature that receives the server-resolved package mode. The function derives active generation from the locked `uploaded_files` row and rejects stale caller-supplied generation state.

Package-active readiness blockers include:

- `PACKAGE_PROFILE_MISSING`
- `PACKAGE_PROFILE_AMBIGUOUS`
- `PACKAGE_MEMBERSHIP_MISSING`
- `PACKAGE_MEMBERSHIP_AMBIGUOUS`
- `PACKAGE_RELATIONSHIP_MISSING`
- `PACKAGE_RELATIONSHIP_AMBIGUOUS`
- `PACKAGE_RESOLUTION_MISSING`
- `PACKAGE_RESOLUTION_FAILED`
- `PACKAGE_PROJECTION_MISSING`
- `PACKAGE_PROJECTION_FAILED`
- `PACKAGE_PROJECTION_STALE_GENERATION`
- `PACKAGE_COMPATIBILITY_NOT_PERSISTED`
- `PACKAGE_REQUIRED_CONFLICT_OPEN`
- `PACKAGE_REQUIRED_RELATED_DOCUMENT_MISSING`
- `PACKAGE_EFFECTIVE_CLAIM_INVALID`
- `PACKAGE_MODE_CONFIGURATION_INVALID`

Finalizer signature verification:

- Command: `docker exec supabase_db_cre-financial-suite-main psql -U postgres -d postgres -tAc "select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname='finalize_lease_extraction_for_review';"`
- Result: exactly one signature, `finalize_lease_extraction_for_review(uuid,uuid,uuid,uuid,uuid,text,text,text)`.

## Generation, Retry, And Reviewer Boundaries

- Same active-generation retries reuse completed package records where available.
- Stale generations cannot settle package runtime or write current compatibility output.
- Compatibility write-back is idempotent by key/hash.
- Failed active package orchestration is fatal to readiness.
- Shadow package failure is visible but does not change runtime Lease Review output.
- `save-lease-review-draft` rejects package-active review saves that would bypass package reviewer decision routes.
- Off and shadow review-save behavior remains unchanged.
- P2 source claims remain immutable.

## Verification

Preflight:

- Branch confirmed: `feature/lease-intelligence-enterprise-p1-p8`.
- Base HEAD confirmed before edits: `6cf3605`.
- Migration count before P3.7: 208.
- Migration count after P3.7: 209.
- Claims registry version/hash: `lease-claims-v1` / `4dd86ea371a473e68bb0930b3716740fffdfd3bbcf4979ba2643d9f8e2480a9a`.
- Document profile registry version/hash: `lease-document-profiles-v1` / `82d6bf7b41219cd281f96e9e18f3db544d848766afefdd5f5c8474a29cd20845`.
- Package resolution version: `lease-package-resolution-v1`.
- Package projection version: `lease-package-projection-v1`.

Database replay:

- `bash scripts/db-reset-two-lanes.sh remote-parity`: PASS, exit code 0, P3.7 migration applied.
- `bash scripts/db-reset-two-lanes.sh full-repository`: PASS, exit code 0, P3.7 migration applied with the full local schema.

Focused P3.7 suite:

- Command: `docker run --rm -v "${PWD}:/work" -w /work denoland/deno:2.7.12 test --no-lock --allow-read --allow-env supabase/functions/_tests/lease-package-runtime-orchestrator.test.ts supabase/functions/_tests/lease-package-runtime-rpc-contract.test.ts`
- Result: 6 passed | 0 failed.

Bounded P1-P3.7 backend regression:

- Runtime: `denoland/deno:2.7.12`.
- Command: bounded claims/provenance/profile/package/relationship/resolution/projection/runtime Deno suite including the P3.7 tests.
- Result: 255 passed | 0 failed.

P3.6 focused regression after P3.7:

- Command: `docker run --rm -v "${PWD}:/work" -w /work denoland/deno:2.7.12 test --no-lock --allow-read --allow-env supabase/functions/_tests/lease-package-projection.test.ts supabase/functions/_tests/lease-package-projection-service.test.ts supabase/functions/_tests/lease-package-projection-rpc-contract.test.ts`
- Result: 13 passed | 0 failed.

Full all-files backend command:

- Command: `docker run --rm -v "${PWD}:/work" -w /work denoland/deno:2.7.12 test --no-lock --allow-read --allow-write --allow-env --allow-net --allow-run --allow-import supabase/functions/_tests`
- Result: exit code 1 before test execution.
- Failure: TypeScript type-check failure remains in `supabase/functions/_tests/update-lease-extraction-field.property.test.ts` where `SUPABASE_URL`, `SERVICE_ROLE_KEY`, and `ANON_KEY` are typed as `string | undefined` at call sites requiring `string`.
- Classification: inherited all-files suite blocker, unchanged from the P3.6 baseline; not a P3.7 orchestration, migration, finalizer, write-back, reviewer-boundary, or package-runtime regression.

Frontend and build checks:

- `npm test`: initial sandbox run hit Windows `spawn EPERM`; rerun outside sandbox passed, 62 files / 685 tests.
- `npm run lint`: PASS.
- `npm run typecheck`: PASS.
- `npm run build`: PASS; existing Vite dynamic-import/chunk-size warnings only.

## Provider And Deployment Safety

- No Azure call was made.
- No Vertex call was made.
- No Docling/parser live-provider path was invoked.
- No provider, model, prompt, or parser routing change was made.
- No frontend redesign was made.
- No P4 calculation was added.
- No P5 CAM/expense generation was added.
- No deployment was performed.
- No remote Supabase access was performed.
- No production migration push was performed.
- No live document regression was run.

Docker Deno test runs downloaded public Deno/npm CDN dependencies as needed for local test execution. The P3.7 implementation itself adds no provider fetch path.

## Deferred Work

- Full integrated P3 closure has not started.
- Real-document pre-shadow acceptance has not started.
- P3.8 has not started.

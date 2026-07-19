# Enterprise Lease Intelligence P3.6 Package Compatibility Projection

Date: 2026-07-19
Branch: feature/lease-intelligence-enterprise-p1-p8
Base commits: P3.1 c5b33db; P3.2 411691f; P3.3 20411f4; P3.4 259ef70; P3.5 558c447
Verdict: P3.6 complete and locally verified; package-effective claims can be projected into a compatibility-equivalent Lease Review candidate and compared against the single-document projection, but runtime write-back and finalizer integration have not started.

## Scope

P3.6 adds deterministic package-aware compatibility projection over completed P3.5 package-effective claims. It converts package-effective truth into the same Lease Review compatibility field contract used by the P2 single-document projector, and can compare that package projection to an existing single-document compatibility payload.

Runtime behavior remains default off. P3.6 adds no upload, parse, normalize, enrichment, approval, finalizer, Lease Review UI, `extraction_data`, or `workflow_output` write path.

## Implementation

- Added `PACKAGE_PROJECTION_VERSION = lease-package-projection-v1` and retained the P2 field projection version as compatibility metadata.
- Added package projection input validation for completed resolution runs, active confirmed package documents, source-claim org/package/generation membership, duplicate single-cardinality slots, conflict/status consistency, and related-document requirements.
- Added package-effective-claim adapter and package field projector that reuses P2 projection primitives for registered value-bearing claims and synthesizes bounded package rows for package conflicts and missing related documents.
- Preserved P2 compatibility shape: stable field keys, field ordering, `fields` / `field_evidence` duplication, source page/text metadata, confidence, and extraction status vocabulary.
- Added package-aware diff classification for inherited base facts, explicit amendment overrides, assignment party changes, extension/renewal changes, commencement certificate resolution, guaranty/addenda/work-letter additions, conflicts, missing related documents, and residual P2 representation/value/evidence/status/ordering differences.
- Added isolated package projection persistence tables and service-role RPC for optional shadow persistence of projection runs, field projection rows, and bounded diff summaries.
- Kept P2 source claims immutable and did not mutate P3.5 package-effective claim rows.

## Runtime Boundaries

- `LEASE_DOCUMENT_PACKAGE_MODE=off` computes only and persists nothing.
- Shadow mode can persist only the isolated package projection records.
- Active mode is recognized but does not persist without explicit local/test opt-in.
- No runtime pipeline file imports `projectPackageCompatibilityForResolution` or `persist_lease_package_projection`.
- No finalizer/readiness migration or function was changed.
- No `leases.extraction_data`, `leases.workflow_output`, or compatibility output row is written by P3.6.

## Verification

Database replay:

- `bash scripts/db-reset-two-lanes.sh remote-parity`: PASS, exit code 0, P3.6 migration applied.
- `bash scripts/db-reset-two-lanes.sh full-repository`: PASS, exit code 0, P3.6 migration applied with the full local schema including the v3 scaffold migrations.

Focused P3.6 suite:

- Command: `docker run --rm -v "${PWD}:/work" -w /work denoland/deno:2.7.12 test --no-lock --allow-read --allow-env supabase/functions/_tests/lease-package-projection.test.ts supabase/functions/_tests/lease-package-projection-service.test.ts supabase/functions/_tests/lease-package-projection-rpc-contract.test.ts`
- Result: 13 passed | 0 failed.

Bounded P1-P3.6 backend regression:

- Runtime: `denoland/deno:2.7.12`.
- Command: bounded claims/provenance/profile/package/relationship/resolution/projection Deno suite including the P3.6 tests.
- Result: 249 passed | 0 failed.

Full all-files backend command:

- Command: `docker run --rm -v "${PWD}:/work" -w /work denoland/deno:2.7.12 test --no-lock --allow-read --allow-write --allow-env --allow-net --allow-run --allow-import supabase/functions/_tests`
- Result: pre-execution type-check failure remains in `supabase/functions/_tests/update-lease-extraction-field.property.test.ts` because `SUPABASE_URL`, `SERVICE_ROLE_KEY`, and `ANON_KEY` are typed as `string | undefined` where the tested APIs require `string`.
- Classification: inherited all-files suite blocker, not a P3.6 projection, migration, or package-compatibility regression.

Frontend and build checks:

- `npm test`: initial sandbox run hit Windows `spawn EPERM`; rerun outside sandbox passed, 62 files / 685 tests.
- `npm run lint`: PASS.
- `npm run typecheck`: PASS.
- `npm run build`: PASS; existing Vite dynamic-import/chunk-size warnings only.

Diff hygiene and scans:

- `git diff --check`: PASS.
- Changed-file secret scan: PASS, no matches for Supabase service-role secrets, Azure Document Intelligence keys, Vertex service-account private keys, OAuth access tokens, production credential references used as credentials, or customer document payloads.

## Provider And Deployment Safety

- No Azure call was made.
- No Vertex call was made.
- No Docling/parser/worker provider path was invoked.
- No deployment was performed.
- No remote Supabase access was performed.
- No production migration push was performed.

Docker Deno test runs downloaded public Deno/npm CDN dependencies as needed for local test execution. The P3.6 implementation itself adds no provider `fetch` path and no runtime call site.

## Deferred Work

- Runtime pipeline wiring has not started.
- Finalizer/readiness integration has not started.
- Lease Review UI activation has not started.
- Live four-document regression has not started.
- P3.7 has not started.
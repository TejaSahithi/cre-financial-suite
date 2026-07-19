# Enterprise Lease Intelligence P3.4 - Document Relationship Detection

Date: 2026-07-19
Branch: feature/lease-intelligence-enterprise-p1-p8
Base commits: P3.1 c5b33db; P3.2 411691f; P3.3 20411f4
Verdict: P3.4 complete and locally verified; evidence-backed document relationship detection is implemented, but precedence resolution, package-effective claims and package-aware compatibility projection have not started.

## Scope

P3.4 adds deterministic, evidence-backed relationship candidate detection for lease document packages. It is intentionally bounded to pure detection, validation, deterministic keying, and gated persistence/reviewer RPC contracts.

Implemented relationship coverage:

- base document marker
- assignment to base document
- amendment to base document
- assignment-and-amendment independent edges
- prior-amendment requirement from explicit dynamic claims
- extension and renewal edges
- guaranty to base document
- commencement certificate to base document
- rent/CAM addenda and attachments
- explicit supersedes candidates
- ambiguous and missing-related-document states

Out of scope and not started:

- precedence resolution
- package-effective claims
- package-aware compatibility projection
- P2 claim mutation
- runtime pipeline activation
- live provider calls
- deployment

`LEASE_DOCUMENT_PACKAGE_MODE` remains default-off. No runtime pipeline call site invokes the P3.4 relationship service.

## Files

Added:

- `supabase/functions/_shared/extraction/document-package/relationships/relationship-types.ts`
- `supabase/functions/_shared/extraction/document-package/relationships/relationship-key.ts`
- `supabase/functions/_shared/extraction/document-package/relationships/relationship-detector.ts`
- `supabase/functions/_shared/extraction/document-package/relationships/relationship-validator.ts`
- `supabase/functions/_shared/extraction/document-package/relationships/relationship-service.ts`
- `supabase/functions/_shared/extraction/document-package/relationships/assignment-relationship-detector.ts`
- `supabase/functions/_shared/extraction/document-package/relationships/amendment-relationship-detector.ts`
- `supabase/functions/_shared/extraction/document-package/relationships/extension-renewal-detector.ts`
- `supabase/functions/_shared/extraction/document-package/relationships/guaranty-relationship-detector.ts`
- `supabase/functions/_shared/extraction/document-package/relationships/commencement-relationship-detector.ts`
- `supabase/functions/_shared/extraction/document-package/relationships/addendum-relationship-detector.ts`
- `supabase/functions/_shared/extraction/document-package/relationships/attachment-relationship-detector.ts`
- `supabase/functions/_tests/lease-document-relationship-detector.test.ts`
- `supabase/functions/_tests/lease-document-relationship-service.test.ts`
- `supabase/functions/_tests/lease-document-relationship-rpc-contract.test.ts`
- `supabase/migrations/20260844000000_lease_document_relationship_detection_p3_4.sql`

This report: `docs/enterprise-lease-intelligence-p3-4-document-relationship-detection.md`.

## Persistence And Review Contract

Migration `20260844000000_lease_document_relationship_detection_p3_4.sql` adds:

- service-role-only `persist_lease_document_relationship_candidates(...)`
- authenticated reviewer `resolve_lease_document_relationship_decision(...)`
- `lease_document_relationship_reviewer_decisions`

The batch persistence RPC validates package scope, source membership, target membership, active source/target generation, source stage-run provenance, evidence claim existence, evidence file/run/generation consistency, self-relationship rejection, and idempotent relationship key insertion.

The reviewer RPC supports confirm, reject, select target, mark requires related document, reopen, confirm supersedes, and waive related document requirement. It derives actor identity from `auth.uid()`, checks org membership, guards stale source generation against the uploaded file active generation, records idempotent decisions, and writes audit logs.

## Verification

Preflight state:

- `git status --short --branch --untracked-files=all`: clean branch at start, `feature/lease-intelligence-enterprise-p1-p8...origin/feature/lease-intelligence-enterprise-p1-p8 [ahead 9]`
- `HEAD`: `20411f4`
- P3.1 commit: `c5b33db`
- P3.2 commit: `411691f`
- P3.3 commit: `20411f4`
- migration count before P3.4: 205

Focused P3.4 suite:

- Command: `docker run --rm -v "${PWD}:/work" -w /work denoland/deno:2.7.12 test --no-lock --allow-read --allow-env supabase/functions/_tests/lease-document-relationship-detector.test.ts supabase/functions/_tests/lease-document-relationship-service.test.ts supabase/functions/_tests/lease-document-relationship-rpc-contract.test.ts`
- Result: 26 passed / 0 failed

Related Deno regression, Docker Linux `denoland/deno:2.7.12`:

- P3.1 package registry and feature mode: 19 passed / 0 failed
- P3.3 package membership and requirements: 39 passed / 0 failed
- P2 claims registry/adapters/conflicts/projection: 67 passed / 0 failed
- P1 provenance transports/recorder/feature flag: 38 passed / 0 failed
- Phase-bounded Deno total: 189 passed / 0 failed

Database replay:

- `bash scripts/db-reset-two-lanes.sh remote-parity`: exit code 0, P3.4 migration applied, six v3 scaffold migrations restored by trap
- `bash scripts/db-reset-two-lanes.sh full-repository`: exit code 0, P3.4 migration applied with the full local schema including v3 scaffold migrations

Full backend suite note:

- Exact Phase 4F-style command in Docker with local env file, without `--no-check`: failed before test execution on pre-existing compile-time env narrowing in `supabase/functions/_tests/update-lease-extraction-field.property.test.ts` (`string | undefined` passed to APIs expecting `string`).
- Executable all-files command with `--no-check`: 1025 passed / 413 failed. Failures are broad existing DB/function integration environment failures when the entire historical suite is run en masse, not P3.4 relationship regressions. This was not used as the P3.4 acceptance gate.

Frontend and build checks:

- `npx vitest run src`: initial sandbox run hit Windows `spawn EPERM`; rerun outside sandbox passed, 62 files / 685 tests
- `npm run lint`: passed
- `npm run typecheck`: passed
- `npm run build`: passed; existing Vite chunk/dynamic-import warnings only

Diff hygiene and scans:

- `git diff --check`: passed
- Changed-file secret scan: passed, no matches for Supabase service-role secrets, Azure Document Intelligence keys, Vertex private keys, OAuth tokens, production credential references, or real customer document content
- Temporary Docker local Supabase env/status files: removed after verification

## External Access

No Azure, Vertex, Docling, parser, worker, deployment, migration to remote, or remote Supabase workflow was run for P3.4.

Docker Deno test runs downloaded public Deno dependencies as needed. The implementation itself contains no provider `fetch` path and adds no runtime call site. A temporary Docker env file used local Supabase values only and set `DISABLE_EXTERNAL_PROVIDER_CALLS=true`; it was removed after verification.

## Residual Conditions

P3.4 deliberately stops before effective-package truth:

- no document precedence resolution
- no package-effective claim selection
- no compatibility projection changes
- no UI/package activation
- no live four-document regression

Those belong to later phases.

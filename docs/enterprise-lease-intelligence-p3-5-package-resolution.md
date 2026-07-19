# Enterprise Lease Intelligence P3.5 Package Resolution

Date: 2026-07-18

Verdict: P3.5 complete and locally verified; explicit package precedence and package-effective claim selection are implemented, but package-aware compatibility projection and runtime pipeline/finalizer integration have not started.

## Scope

P3.5 adds deterministic package-effective claim resolution over immutable P2 source claims and confirmed P3 package membership/relationship inputs.

Runtime behavior remains default off. No upload, normalize, enrich, review, finalizer, compatibility projection, `extraction_data`, or `workflow_output` path was wired in this phase.

## Implementation

- Added `PACKAGE_RESOLUTION_VERSION = lease-package-resolution-v1`.
- Added pure package claim resolver, domain precedence policy, conflict keying, loader mapping helper, and bounded service wrapper.
- Added package-resolution persistence tables and RPC contracts for completed resolution runs, effective claim rows, override provenance, conflicts, and reviewer decisions.
- Preserved org/file/run/generation provenance in resolver input, persisted resolution rows, and migration constraints.
- Kept historical P2 source claims immutable; P3.5 does not update or delete `lease_claims`.

## Precedence Rules

- Base lease source claims remain immutable and are effective when no later confirmed package context exists.
- Later package documents can override only through confirmed and valid relationships.
- Assignments affect party/assignment/notices concepts only; economic and premises claims remain inherited unless explicitly allowed by policy.
- Amendments override only explicitly addressed concepts.
- Extension, renewal, and commencement certificate relationships are independently scoped and do not calculate dates.
- Guaranty, CAM addendum, rent addendum, and work-letter claims are domain-limited.
- Supersession, competing assignments, competing amendments, ambiguous relationship paths, stale generations, and missing related documents remain review states.
- Dynamic claims remain lower authority unless explicitly permitted; P3.5 only permits the narrow guaranty-party dynamic namespace.

## Verification

- DB reset lane `remote-parity`: PASS.
- DB reset lane `full-repository`: PASS.
- P3.5 focused Deno tests:
  - Command: `docker run --rm -v "${PWD}:/work" -w /work denoland/deno:2.7.12 test --no-lock --allow-read --allow-env supabase/functions/_tests/lease-package-claim-resolution.test.ts supabase/functions/_tests/lease-package-resolution-service.test.ts supabase/functions/_tests/lease-package-resolution-rpc-contract.test.ts`
  - Result: 14 passed | 0 failed.
- Bounded P1-P3.5 backend regression:
  - Runtime: `denoland/deno:2.7.12`.
  - Result: 214 passed | 0 failed.
- Full all-files backend command:
  - Command: `docker run --rm -v "${PWD}:/work" -w /work denoland/deno:2.7.12 test --no-lock --allow-read --allow-write --allow-env --allow-net --allow-run --allow-import supabase/functions/_tests`
  - Result: pre-execution type-check failure remains in `supabase/functions/_tests/update-lease-extraction-field.property.test.ts` because `SUPABASE_URL`, `SERVICE_ROLE_KEY`, and `ANON_KEY` are typed as `string | undefined`.
  - Classification: inherited all-files suite blocker, not a P3.5 resolver, migration, or package-resolution regression.
- Frontend regression: 62 files passed | 685 tests passed.
- Lint: PASS.
- Typecheck: PASS.
- Production build: PASS.
- `git diff --check`: PASS.

## Provider And Runtime Safety

- No Azure call was made.
- No Vertex call was made.
- No Docling/parser/worker live-provider path was invoked.
- No deployment was performed.
- No remote Supabase access was performed.
- No migration was pushed to production.

## Deferred Work

- Package-aware compatibility JSON projection has not started.
- Runtime upload/normalize/enrich/review/finalizer integration has not started.
- Lease Review output wiring has not started.
- P3.6 has not started.

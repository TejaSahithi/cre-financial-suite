# Azure + Vertex Canonical Pipeline Migration Phase 4F - Local Live-Provider Validation

## 1. Executive Result

Phase 4F was resumed after the Azure endpoint/key correction and read-only Azure preflight confirmation.

Verdict: PHASE 4F LOCAL LIVE-PROVIDER VALIDATION BLOCKED — AZURE_ANALYZE_TRANSPORT.

The fresh local upload exercised the real localhost product Edge Function path through `upload-handler`, `confirm-upload`, worker queueing, and `pipeline-status`. The worker made one parse-stage attempt and failed with `PDF_PARSING_FAILED` before producing Azure text/layout output, canonical layout, Vertex extraction, normalized output, or Lease Review records.

No deployment occurred. No Supabase link was changed. No remote Supabase project was read from or written to. No database migration was created. Implementation code changed only in the local parser source-selection path and its focused tests.

## 2. Commit and Branch

- Branch: `feature/document-intelligence-v3`
- Starting committed baseline for this resumed attempt: `c535a33` - `docs: record blocked Phase 4F provider validation`
- Prior Phase 4E implementation commit: `95668ae` - `Complete Phase 4E local provider fallback`
- Working tree before the resumed run: only this Phase 4F report was already modified from the earlier local attempt

## 3. Azure Preflight Provided Before Resume

Read-only Azure preflight was reported as passed before this resumed run:

- Model-list request: `SUCCESS`
- `prebuilt-layout` available: `true`
- `prebuilt-layout` model-get: `SUCCESS`
- Endpoint and key came from the same Azure Document Intelligence resource

The preflight did not print Azure secrets, and this report does not include Azure key values or raw provider payloads.

## 4. Local Runtime

Local stack/runtime state before the fresh upload:

- Supabase local stack: running
- Edge Functions: serving at `http://127.0.0.1:54321/functions/v1/<function-name>`
- Test document existed at `C:\tmp\phase4f\test-lease.pdf`
- Test document size: `9,136,164` bytes
- Test document last write time: `2026-06-03 14:48:17`

Live-provider Edge flags confirmed from the running local container, values printed only for non-secret flags:

- `EXTRACTION_PROVIDER=azure_document_intelligence`
- `STORE_FULL_AZURE_RAW_RESPONSE=false`
- `ENABLE_LOCAL_PROVIDER_MOCKS=false`
- `DISABLE_EXTERNAL_PROVIDER_CALLS=false`
- `BUSINESS_EXTRACTION_PROVIDER=vertex_primary_legacy_fallback`
- `WORKER_INTERNAL_SECRET: PRESENT`
- `LOCAL_SUPABASE_RUNTIME=true`

## 5. Local User Setup

A local-only user/org was created by a temporary script under `C:\tmp`. The password stayed in memory and was not written to disk.

Provisioning result:

- User id: `952da8cf-11ac-4ea9-a76e-ce3bd4506c05`
- Org id: `6593d324-ec75-4873-ad93-3d559ed55b18`
- Role: `org_admin`
- Password written to disk: `false`

## 6. Product Upload Path

The run used the same localhost Edge Function path used by the product upload component:

1. `upload-handler` with authenticated local user JWT and multipart form data
2. `confirm-upload` primary proceed action
3. `confirm-upload` idempotency retry
4. `pipeline-status` polling
5. Persisted database inspection

The previously failed uploaded file ids were not reused:

- Not reused: `3d5a82a2-fbf0-4c19-9cfe-9aff315462c5`
- Not reused: `82ee9d89-c16d-4f53-89ec-8c3f101eae72`

## 7. Fresh Upload Attempt

Fresh upload literal result:

- `upload-handler`: HTTP 200
- Fresh uploaded file id: `2ddbb049-d2c4-40a4-bdb7-2358e18e5471`
- Detected type: `pdf`
- Storage path present: `true`

Primary confirmation:

- `confirm-upload`: HTTP 200
- `already_confirmed`: `false`
- `extraction_queued`: `true`
- Pipeline job id: `efb97a66-eee6-48d3-a05f-bfee226676ce`
- Returned status: `parsing`

Idempotency retry:

- `confirm-upload`: HTTP 200
- `already_confirmed`: `true`
- Returned same pipeline job id: `efb97a66-eee6-48d3-a05f-bfee226676ce`
- Retry returned job stage/status: `parse` / `queued`

No additional processing retry was run.

## 8. Polling and Job Result

Polling result:

- First poll: upload status `parsing`, display state `queued`, latest job `queued`, stage `parse`, attempt `0`
- Final poll: upload status `failed`, display state `failed`, latest job `failed`, stage `parse`, attempt `1`, error code `PDF_PARSING_FAILED`

Persisted job evidence:

- Jobs for the fresh file: `1`
- Job id: `efb97a66-eee6-48d3-a05f-bfee226676ce`
- Stage: `parse`
- Status: `failed`
- Attempt: `1`
- Max attempts: `3`
- Error code: `PDF_PARSING_FAILED`
- Error message present: `true`

The error message itself was not printed to avoid exposing raw provider payloads.

## 9. Azure Validation

Azure was the only provider path reached.

Sanitized persisted result:

- Raw upload status: `failed`
- Processing status: `parse_failed`
- Failed step: `parse`
- Review status: `blocked_pipeline_failure`
- Review required: `false`
- Extraction method: `none`
- Parser provider: `null`
- Parser method: `none`
- Full text chars: `0`
- Page count: `null`
- Provider log counts: Azure mentions `1`, Vertex mentions `0`, legacy mentions `0`

Interpretation: the corrected Azure endpoint/key passed read-only model preflight, but the live upload pipeline still failed at parse before it persisted provider text/layout output. No raw Azure response or document text is included in this report.

## 10. Canonical-Layout Validation

Not reached.

Persisted result:

- Canonical layout present: `false`
- Canonical schema version: `null`
- Source content hash prefix: `null`

## 11. Vertex Validation

Not reached.

Persisted result:

- Requested provider: `null`
- Effective provider: `null`
- Acceptance state: `null`
- Fallback reason present: `false`
- Vertex attempt count: `null`
- Provider mocked: `null`
- Vertex document profile: `null`
- Vertex document index source: `null`
- Vertex evidence anchor count: `null`

## 12. Normalized Output and Review Payload

Not produced.

Persisted result:

- `ui_review_payload.records`: `0`
- Standard fields count: `0`
- Workflow expense rules count: `null`
- `review_required`: `false`
- `review_status`: `blocked_pipeline_failure`

`review-approve` prepare was skipped because no UI review records existed.

## 13. Lease Review Draft

Not created.

Reason: the pipeline stopped before producing a meaningful `ui_review_payload`, so there was no extracted payload to prepare into a Lease Review draft.

## 14. Document Intelligence v3 Readiness

Readiness diagnostic result for uploaded file `2ddbb049-d2c4-40a4-bdb7-2358e18e5471`:

- Diagnostic only: `true`
- Verdict/status: `null`
- Run id present: `false`
- Lease id present: `false`
- Claim count: `0`
- Canonical field count: `0`

## 15. Idempotency Result

Passed for the confirmation lifecycle.

- Primary `confirm-upload`: `already_confirmed=false`, queued job `efb97a66-eee6-48d3-a05f-bfee226676ce`
- Idempotency retry `confirm-upload`: `already_confirmed=true`, returned the same job id
- No second pipeline job was observed for the fresh file

## 16. Provider Usage and Repetition Control

The run honored the requested attempt boundary:

- One fresh uploaded file id
- One primary processing attempt
- One `confirm-upload` idempotency retry
- No reuse of the two prior failed uploaded file ids
- No `force_reextract`
- No second parse/normalize/provider retry after failure

Vertex was not called because parsing failed before canonical layout and business extraction.

## 17. Localhost and External Contact Boundary

Application workflow calls made by the runner targeted localhost Supabase only:

- `http://127.0.0.1:54321/functions/v1/upload-handler`
- `http://127.0.0.1:54321/functions/v1/confirm-upload`
- `http://127.0.0.1:54321/functions/v1/pipeline-status`
- `http://127.0.0.1:54321/functions/v1/document-intelligence-v3-readiness`

The local Edge runtime intentionally used the live Azure provider path as required by Phase 4F. No packet capture was performed.

## 18. Source-Transport Diagnosis

Repository-first tracing confirmed the parse failure mechanism:

- Strict Azure mode is selected in `parse-pdf-docling` when the provider mode is `azure_document_intelligence`.
- The local runtime creates a Supabase Storage signed URL from inside the Docker network.
- In local Edge Functions, `SUPABASE_URL` resolves to `http://kong:8000`, so the signed URL host category is `kong`.
- Before the fix, strict Azure mode skipped byte download and passed the signed URL through `parseDocument(..., { fileUrl })`.
- `parseDocument` delegated to `analyzeWithAzureLayout`.
- `analyzeWithAzureLayout` prefers `urlSource` whenever `fileUrl` is present.
- Because `fileBytes` were null in strict Azure mode, the Azure urlSource failure could not fall back to `base64Source`.

Sanitized persisted evidence from failed upload `2ddbb049-d2c4-40a4-bdb7-2358e18e5471` matched this hypothesis:

- File URL category: `kong`
- File size: `9,136,164` bytes
- Stage/status: `parse` / `failed`
- Attempt/max attempts: `1` / `3`
- Error code: `PDF_PARSING_FAILED`
- Sanitized Azure submit status: `400`
- Sanitized Azure error code: `InvalidRequest`
- Azure mentions: `1`
- Vertex mentions: `0`
- Legacy mentions: `0`
- Full text chars: `0`
- UI review records: `0`

No raw provider payload, document text, public tunnel, remote Supabase access, or Vertex call was used for this diagnosis.

## 19. Local-Only Fix Implemented

Added `supabase/functions/parse-pdf-docling/source-strategy.ts` and wired it into `parse-pdf-docling/index.ts`.

The local byte-source path is permitted only when all of these are true:

- Strict Azure mode is active.
- `LOCAL_SUPABASE_RUNTIME=true`.
- The signed/stored source URL host is local-only: `localhost`, `127.0.0.1`, or `kong`.
- The file size is known, positive, and within the local Azure byte-source guard.

For that local-only case, `parse-pdf-docling` downloads bytes from local Supabase Storage and calls the canonical parser without a `fileUrl`, forcing Azure to receive `base64Source` instead of an unreachable local `urlSource`.

Behavior intentionally preserved:

- Non-local runtimes keep the strict Azure URL-first strategy.
- Public HTTPS URLs keep the strict Azure URL-first strategy.
- Legacy/shadow modes keep the existing byte-download path.
- No provider default changed.
- No Vertex routing, fallback, P0 reconciliation, schema, migration, or deployment code changed.
- Full raw Azure response storage remains disabled unless explicitly enabled by `STORE_FULL_AZURE_RAW_RESPONSE=true`.

## 20. Post-Fix Verification

Focused static checks and direct assertions from the source-transport fix remained valid:

- `deno check --no-lock supabase/functions/_tests/parse-pdf-docling-source-strategy.test.ts`: PASS
- `deno check --no-lock supabase/functions/_tests/lease-extraction-worker-reconciliation.test.ts`: PASS
- `deno check --no-lock supabase/functions/parse-pdf-docling/index.ts supabase/functions/parse-pdf-docling/source-strategy.ts supabase/functions/lease-extraction-worker/index.ts`: PASS
- `deno eval --no-lock ... source strategy assertions`: PASS, printed `parser source strategy eval assertions passed`
- `deno eval --no-lock ... raw response storage assertions`: PASS, printed `raw response storage eval assertions passed`

Windows Deno panic evidence preserved:

- Current Windows runtime before recovery: `deno 2.7.11 (stable, release, x86_64-pc-windows-msvc)`, V8 `14.7.173.7-rusty`, TypeScript `5.9.2`
- Operating system reported by .NET runtime: `Microsoft Windows NT 10.0.26200.0`, `Microsoft Windows 10.0.26200`, `X64`
- Exact full backend command: `deno test --no-lock --allow-read --allow-write --allow-env --allow-net --allow-run --allow-import supabase/functions/_tests`
- Exact focused command: `deno test --no-lock supabase/functions/_tests/parse-pdf-docling-source-strategy.test.ts`
- Panic classification: Deno test-runner IPC/output channel failure, not an application assertion failure.
- Sanitized panic signature: `Unexpected client pipe failure`, Windows pipe path redacted, OS error code `6`, message `The handle is invalid`, stack site `cli/tools/test/channel.rs:252:49`.
- Timing/classification: the panic occurred after module check/discovery output and before any focused test execution counts were emitted. For the full suite, files were checked through `vertex-fact-ledger.test.ts` before the runner panic; no Deno test failure had been reported before the panic.
- Process exit code captured for the focused Windows run: `1`.

Repository Deno pin inspection:

- `supabase/functions/deno.json` configures compiler options/imports but does not pin the Deno executable version.
- No committed `2.7.11`, `2.7.12`, `DENO_VERSION`, `setup-deno`, or `deno-version` pin requiring exactly Deno `2.7.11` was found.

Patch-runtime and Linux-container recovery:

- Windows Deno was upgraded outside the repo to `deno 2.7.12`; the focused Windows test still panicked with the same Deno test-runner pipe/handle signature before counts.
- Docker Linux runtime used for recovery: `denoland/deno:2.7.12`, `deno 2.7.12 (stable, release, x86_64-unknown-linux-gnu)`.
- Docker mounted the same working tree at `/work`.
- Local Supabase was reached from Docker through `host.docker.internal:54321`; only local development keys were passed through a temporary env file under `C:\tmp`, and that file was deleted after the run. Secret values were not printed.

Focused test through real Deno test runner:

- Command: `docker run --rm -v "${PWD}:/work" -w /work denoland/deno:2.7.12 test --no-lock --allow-read --allow-write --allow-env --allow-net --allow-run --allow-import supabase/functions/_tests/parse-pdf-docling-source-strategy.test.ts`
- Tests discovered: `8`
- Tests passed: `8`
- Tests failed: `0`
- Process exit code: `0`

Directly related parser / Azure / raw-response / worker / provider-boundary tests:

- Command targeted `16` related test modules: source strategy, `parse-pdf-docling`, internal auth, Azure canonical layout, resolver/document-index/side-write raw-response paths, worker reconciliation/auth, business extraction boundaries, Vertex structured errors, and Vertex fact ledger tests.
- Result: terminated normally, no Deno panic.
- Tests passed: `234`
- Tests failed: `15`
- Process exit code: `1`
- Failure classification: deterministic existing `parse-pdf-docling.test.ts` failure. `Multi-page Vision fallback refuses flat page-one evidence` produced an uncaught `AssertionError: Expected function to reject`; the remaining tests in that file were cancelled and counted as failed by Deno.

Full backend regression recovery:

- Windows Deno `2.7.11`: failed with Deno test-runner pipe panic before pass/fail counts.
- Windows Deno `2.7.12`: focused test still failed with the same Deno test-runner pipe/handle signature before counts.
- Docker Linux Deno `2.7.12`, no local Supabase env: terminated normally but was not acceptance-valid; result `822 passed | 408 failed`, process exit code `1`, dominated by DB/local-environment mismatch.
- Docker Linux Deno `2.7.12`, local Supabase via `host.docker.internal:54321`: terminated normally, no Deno panic.
- Full command: `docker run --rm --env-file C:\tmp\phase4f-docker-local-supabase.env -v "${PWD}:/work" -w /work denoland/deno:2.7.12 test --no-lock --allow-read --allow-write --allow-env --allow-net --allow-run --allow-import supabase/functions/_tests`
- Test files run: `157`
- Tests passed: `1095`
- Tests failed: `138`
- Process exit code: `1`
- Duration: `3m14s`
- Failed test-name count from failure summary, excluding the uncaught parser module error/cancellations: `123`
- Representative failure class: local database schema/test-fixture mismatch, e.g. `memberships_role_check` rejects the role inserted by legacy DB-backed test helpers.

Failure attribution baseline:

- Baseline worktree command: `git worktree add --detach C:\tmp\phase4f-baseline-c535a33-attr c535a3331208f018494062ba5d8c9b8337899f92`
- Baseline worktree state: clean detached `c535a3331208f018494062ba5d8c9b8337899f92`; it did not contain `supabase/functions/parse-pdf-docling/source-strategy.ts` or `supabase/functions/_tests/parse-pdf-docling-source-strategy.test.ts`.
- Baseline runtime/permissions: same Docker Linux Deno `2.7.12`, same corrected local Supabase Docker env file, same Deno permissions/config. The baseline container mounted the main worktree `node_modules` read-only only because the detached worktree did not have dependencies installed.
- Baseline full command: `docker run --rm --env-file C:\tmp\phase4f-docker-local-supabase.env -v "${PWD}:/work" -v "C:\Users\tejas\Downloads\cre-financial-suite-main (3)\cre-financial-suite-main\node_modules:/work/node_modules:ro" -w /work denoland/deno:2.7.12 test --no-lock --allow-read --allow-write --allow-env --allow-net --allow-run --allow-import supabase/functions/_tests`
- Baseline full result: `1086 passed | 139 failed`, process exit code `1`, duration `3m13s`.
- Current full result: `1095 passed | 138 failed`, process exit code `1`, duration `3m14s`.
- Current-only failure names: `0`.
- Baseline-only failure name: `Bug Condition - PDF processing through ingest-file -> parse-pdf-docling connection`.
- Count delta: current has `+9` passed and `-1` failed versus the clean baseline. Eight added passes are the new source-strategy tests; the remaining improvement is the baseline-only ingest-file to parse-pdf-docling connection failure no longer failing in the Phase 4F working tree.
- Related bundle baseline: `226 passed | 15 failed`, process exit code `1`.
- Related bundle current: `234 passed | 15 failed`, process exit code `1`.
- Related bundle delta: exactly `+8` passed from the new source-strategy test module; no new related failures.
- Root related failure: `parse-pdf-docling.test.ts`, `Multi-page Vision fallback refuses flat page-one evidence`, uncaught `(in promise) AssertionError: Expected function to reject`; the remaining parser-module failures are Deno cancellations after that uncaught async assertion.
- Root failure attribution: pre-existing at baseline `c535a33`; the exercised implementation is `supabase/functions/_shared/extraction/parser.ts`, which is not part of the Phase 4F source-transport diff.
- Known Phase 4E baseline comparison: this still does not meet the Phase 4E `182/183` acceptance-style baseline with only the known `pipeline-status-edge.test.ts` failure. However, the additional recovered backend failures are not attributable to the Phase 4F source-transport change.

Provider-call boundary during backend recovery:

- No live upload, Azure analysis, Vertex business extraction, deployment, migration, or remote Supabase access was intentionally run.
- The Linux full regression contacted local Supabase only through `host.docker.internal:54321` for DB-backed tests.
- Provider-looking Vertex URLs in the Deno logs used `test-project` and came from `vertex-ai-structured-errors.test.ts` / `vertex-fact-ledger.test.ts`, which replace `globalThis.fetch` with mocked handlers. No raw provider payload or document text was printed.
- This was log/source classification, not packet capture.

Backend failure attribution verdict: `PHASE 4F CHANGE CLEAN - PRE-EXISTING BACKEND BASELINE FAILURE`.

A later explicit Phase 4F resume proceeded with the single post-checkpoint local live-provider attempt documented below. The backend baseline caveat above remains recorded as evidence context, not as the final live-attempt state.

## 21. Post-Checkpoint Live Provider Attempt

Checkpoint commit before live run:

- Commit: `8987dcd` - `Complete Phase 4F local Azure source transport`
- Working tree before live run: clean
- Deployment: not performed
- Remote Supabase access: not performed
- Migration/db push/supabase link: not performed

Provider configuration preflight, values not printed:

- `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT`: present
- `AZURE_DOCUMENT_INTELLIGENCE_KEY`: present
- Azure model-list preflight: success
- `prebuilt-layout` available: true
- `prebuilt-layout` model-get: success
- Vertex service-account configuration: present
- `WORKER_INTERNAL_SECRET`: present
- `EXTRACTION_PROVIDER=azure_document_intelligence`
- `BUSINESS_EXTRACTION_PROVIDER=vertex_primary_legacy_fallback`
- `ENABLE_DOCUMENT_INTELLIGENCE_V3=true`
- `STORE_FULL_AZURE_RAW_RESPONSE=false`
- `ENABLE_LOCAL_PROVIDER_MOCKS=false`
- `DISABLE_EXTERNAL_PROVIDER_CALLS=false`
- `LOCAL_SUPABASE_RUNTIME=true`
- `NORMALIZE_INLINE_ENRICHMENT=true`

Approved local test input validation:

- File: `C:\tmp\phase4f\test-lease.pdf`
- File exists: true
- File size bytes: `9,136,164`
- Nonzero and inside local Azure byte-source guard: true
- Header begins with `%PDF`: true

Fresh local-only provisioning:

- Local user created: true
- Local org created: true
- Role: `org_admin`
- Password written to disk: false

Fresh upload and confirmation lifecycle:

- `upload-handler`: HTTP `200`
- Fresh uploaded file id: `d2ea02b2-42e4-4082-8385-3d72b4925454`
- Detected type: `pdf`
- Storage path present: true
- `confirm-upload` primary: HTTP `200`, `already_confirmed=false`
- Pipeline job id: `a2a66907-91f0-4d02-8195-14815387be64`
- Primary returned status: `parsing`
- `confirm-upload` idempotency retry: HTTP `200`, `already_confirmed=true`
- Retry returned the same pipeline job: true
- Pipeline job count for the file: `1`
- No second provider attempt was run.

Local source-transport validation:

- Strict Azure mode: true
- `LOCAL_SUPABASE_RUNTIME=true`: true
- Local Storage URL category: `kong`
- Local byte-source branch selected: true
- Sanitized Edge log evidence: `reason=local Azure byte source (kong)`, size `8.71 MB`
- Size guard passed: true
- Public URL-first behavior and non-local behavior remain covered by the checkpoint tests.

Azure live-provider result:

- Stage: `parse`
- Sanitized failure stage: `AZURE_ANALYZE_TRANSPORT`
- Pipeline status: `failed`
- Processing status: `parse_failed`
- Failed step: `parse`
- Pipeline job status: `failed`
- Pipeline job attempt: `1`
- Error code: `PDF_PARSING_FAILED`
- Sanitized error classification: Azure analyze request transport/TLS connection closed before a successful analyze response was received.
- Azure submit succeeded: false
- Azure polling reached succeeded: false
- Extraction method: `none`
- Parser provider: `null`
- Page count: `null`
- Meaningful extracted text exists: false
- Raw Azure response persisted: false
- Full raw Azure payload printed or stored in this report: false

Azure analyze transport attribution:

- Attribution scope: the already-failed local job `a2a66907-91f0-4d02-8195-14815387be64` for uploaded file `d2ea02b2-42e4-4082-8385-3d72b4925454`; no product upload retry was run.
- Exception class: `Error`
- Nested cause class: `SendRequest connection error / TLS unexpected EOF`
- Failure category: `TLS/certificate` (`peer closed connection` / missing TLS `close_notify` before a successful submit response)
- HTTP status received: false
- HTTP status: `null`
- Sanitized Azure error code: `null`
- Elapsed time before failure: `1,777 ms`
- Original PDF byte count: `9,136,164`
- Calculated base64 character count: `12,181,552`
- Request content type: `application/json`
- Request body mode: `base64Source`
- API version: `2024-11-30`
- Model: `prebuilt-layout`
- Output content format: `markdown`
- POST URL constructed successfully: true
- Operation-Location header received: false
- Azure submit succeeded: false
- Azure polling reached: false

Azure tier and limit check:

- Pricing tier: `unknown`
- Tier source: not discoverable from the local runtime after the prior stop; Azure CLI is not installed, the restarted Edge runtime does not contain the previous live-provider env, and no protected Azure env file was found in the repo or `C:\tmp` diagnostic files.
- Approved PDF size: `9,136,164 bytes`
- F0 limit comparison: exceeds the 4 MB free-tier limit.
- S0 limit comparison: within the 500 MB standard-tier limit.
- Within actual tier limit: `unknown`
- Size-limit blocker classification: not selected because the observed failure was not an Azure HTTP/document-size response; no HTTP status or Azure error code was received.

Direct analyze probes:

- Tiny synthetic analyze probe: not run.
- Approved lease direct analyze probe: not run.
- Reason probes were not run: the handoff permits direct probes only when the resource is S0 or otherwise confirmed to support the document size and when the same protected environment is available. That condition was not met after the prior local runtime stop.
- Vertex calls during attribution: none.
- Product upload/confirm/worker retry during attribution: none.

Attribution classification:

`AZURE_RUNTIME_TRANSPORT_FAILURE`

Recommendation for the single next action:

- Restore the same protected Azure local environment and determine the resource tier without printing identifiers. If the resource is S0 or otherwise confirmed to support `9,136,164` bytes, run the permitted tiny synthetic Deno `base64Source` probe first. Do not rerun the product upload until the direct probe gate is satisfied.

Canonical-layout validation:

- Canonical layout present: false
- Canonical schema version: `null`
- Canonical page count: `null`
- Source content hash/provenance present: false
- Canonical validation reached: false
- Hollow canonical layout accepted: false

Vertex validation:

- Vertex reached: false
- Requested provider: `null`
- Effective provider: `null`
- Provider mocked: `null`
- Vertex attempt count: `null`
- Fallback used: `null`
- Acceptance state: `null`
- Provider provenance present: false

Output and Lease Review validation:

- `normalized_output` present: true, but only as blocked/failure metadata; normalized field count: `0`
- `ui_review_payload.records`: `0`
- Standard-field count: `0`
- Lease Review preparation attempted: false
- Lease Review preparation reason: payload was not eligible because parse failed before review records existed.
- Lease draft count before prepare: `0`
- Lease draft count after prepare: `0`
- Duplicate lease/review draft created: false

Sanitized sample field classification:

- Landlord: not present
- Tenant: not present
- Premises: not present
- Commencement date: not present
- Expiration date or term: not present
- Base rent: not present
- CAM/expense rule: not present
- Renewal/option: not present

Idempotency validation:

- Retry returned `already_confirmed=true`: true
- Retry returned same pipeline job: true
- Retry created no second pipeline job: true
- Retry did not rerun Azure: true
- Retry created no duplicate lease: true
- Retry created no duplicate Lease Review draft: true
- Reviewer state overwrite risk: not reached because no review draft existed.

Final live-validation verdict: `PHASE 4F LOCAL LIVE-PROVIDER VALIDATION BLOCKED — AZURE_ANALYZE_TRANSPORT`.

## 22. Security and Secret Checks

Secret values were not printed in this report.

The following were intentionally not exposed:

- Supabase service-role secrets
- Azure Document Intelligence keys
- Vertex service-account private keys
- OAuth access tokens
- Worker internal secret value
- Real document text
- Raw provider payloads

`STORE_FULL_AZURE_RAW_RESPONSE=false` was confirmed earlier in the local Edge runtime and remains part of the intended local live-provider posture.

Final secret scan result from the prior Phase 4F source-transport update: PASS. Changed-file scan found no Supabase service-role secret values, Azure Document Intelligence key values, Vertex service-account private key values, OAuth token values, credential-bearing production project references, real customer document content, or raw provider payloads. False positives were limited to checklist labels in this report and pre-existing environment variable names in parser code.

Additional backend-recovery hygiene:

- Temporary Docker local Supabase env file: deleted.
- Secret values from that temporary env file are not included in this report.
- No Deno verification container remains running.

## 23. Runtime / Temporary Files

Temporary runner cleanup:

- `C:\tmp\phase4f-resume-live-run.mjs`: deleted before this diagnosis resumed
- `C:\tmp\phase4f-trace-local-source.mjs`: deleted after the source-transport trace
- `C:\tmp\phase4f-docker-local-supabase.env`: deleted after backend recovery
- Password file written: `false`

Local Supabase and Edge Functions were already running before the resumed attempt. They were not stopped by this report update.

## 24. Remaining Risks

- The local-only source-transport fix was live-rerun once after checkpoint commit `8987dcd`; the local byte-source branch selected bytes successfully, but Azure analyze transport failed before a successful provider response.
- Backend verification is no longer blocked only by Windows Deno pipe panics; Linux recovery produced a normal process exit and baseline attribution showed no current-only failures from Phase 4F.
- Canonical-layout generation from Azure output remains not validated because Azure analyze did not return a successful result.
- Vertex primary extraction remains not validated because the pipeline stopped at the Azure parse stage.
- Vertex fallback/acceptance provenance remains not validated because Vertex was not reached.
- Normalized field output and Lease Review draft persistence remain not validated because no review records were produced.

## 25. Next Decision

Remote activation remains blocked. The checkpointed source-transport fix is clean, but Phase 4F live validation is blocked at Azure analyze transport, now attributed as `AZURE_RUNTIME_TRANSPORT_FAILURE` from the single post-fix local job. Do not begin Phase 4G until a fresh local live-provider attempt reaches Azure success, canonical layout, Vertex, normalized output, and Lease Review preparation.

PHASE 4F LOCAL LIVE-PROVIDER VALIDATION BLOCKED — AZURE_ANALYZE_TRANSPORT

AZURE_RUNTIME_TRANSPORT_FAILURE

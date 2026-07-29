# Lease Extraction Architecture Audit - 2026-07-29

## Executive Summary

The current lease flow is:

`LeaseUpload -> FileUploader -> upload-handler -> confirm-upload -> ingest-file -> pipeline_jobs -> lease-extraction-worker -> normalize-pdf-output -> LeaseReview`

The product goal is not "100% guaranteed extraction" for every commercial lease. That is not realistic with arbitrary scans, amendments, exhibits, OCR noise, and conflicting clauses. The enterprise goal should be "100% evidence-governed reviewability": every value shown to a reviewer is either supported by a page/quote/source node/confidence/generation, explicitly marked as fallback, manually edited, or left blank for review.

## Current Primary Upload To Review Flow

1. `src/pages/LeaseUpload.jsx`
   - Renders the upload screen.
   - Polls `pipeline-status` after upload/confirm.
   - Opens Lease Review only after finding or preparing a lease draft.

2. `src/components/FileUploader.jsx`
   - Sends the file to `upload-handler`.
   - Does not start extraction by itself.
   - Waits for explicit user confirmation before calling `confirm-upload`.

3. `src/services/edgeFunctions.js`
   - Adds Supabase auth and acting-org headers to Edge Function calls.
   - Uses multipart fetch for file upload.

4. `supabase/functions/upload-handler/index.ts`
   - Stores the file in Supabase Storage.
   - Creates or updates `uploaded_files`.
   - Leaves extraction pending until the file is confirmed.

5. `supabase/functions/confirm-upload/index.ts`
   - Marks `confirmed_at`.
   - Calls `ingest-file`.
   - Is idempotent so repeat confirmation does not intentionally double-start extraction.

6. `supabase/functions/ingest-file/index.ts`
   - Queues a lease extraction generation through `pipeline_jobs`.
   - Dispatches `lease-extraction-worker` fire-and-forget.
   - May reuse durable parser output on force re-extract if existing parse output looks valid.

7. `supabase/functions/lease-extraction-worker/index.ts`
   - Runs staged work: parse, normalize, bounded enrich, or enrich.
   - The parse stage calls the shared Azure parser inline.
   - The normalize stage calls `normalize-pdf-output`.
   - Enrichment is deferred/bounded so review can become available before every expensive clause/evidence enhancement is done.

8. `supabase/functions/normalize-pdf-output/index.ts`
   - Chooses the business extraction provider.
   - For active lease whole-document mode, forces `openai_primary_legacy_fallback`: primary whole-document GPT, then explicit TypeScript legacy fallback only when eligible.
   - Builds `normalized_output` and `ui_review_payload`.
   - Persists extraction debug metadata and business extraction provenance.

9. `src/pages/LeaseReview.jsx`
   - Loads the lease row and the linked `uploaded_files` row.
   - Bridges canonical review payloads when available.
   - Renders extraction truth metadata, standard fields, dynamic findings, clauses, timeline, and debug views.

## Extraction Paths Found

After the 2026-07-29 cleanup, the live lease extraction provider strategy is two-path:

1. Primary provider: Azure Document Intelligence parse plus whole-document GPT strict-schema extraction.
2. Fallback provider: TypeScript `legacy_hybrid` deterministic/rule/table/LLM pipeline, only as a whole-result fallback after a fallback-eligible primary failure.

These supporting branches still exist, but they are not separate live provider strategies:

- Primary queued worker path: upload confirm to `ingest-file` to `lease-extraction-worker`.
- Parser wrapper path: `parse-document-azure`, which also calls shared Azure parser logic.
- Worker inline parser path: worker calls shared parser directly.
- Whole-document GPT path: strict schema extraction from compact Azure document.
- OpenAI fact-ledger path: chunked/adaptive facts, then TypeScript field mapping.
- Legacy hybrid path: deterministic rules, tables, and LLM fallback.
- Primary-with-legacy-fallback path: OpenAI once, then legacy once for fallback-eligible failures.
- Minimal review payload path: core fields are persisted before expensive enrichment.
- Enrich path: builds workflow/clause/evidence details after core extraction.
- Bounded enrich path: breaks enrichment into smaller stages.
- Manual review path: produces explicit review-required output when extraction cannot prove usable values.
- UI-side fallback path: older UI code could synthesize core values from parsed text without provider evidence. This is now default-off for core fields.

## Target Architecture

Primary:

- Azure Document Intelligence parses the lease.
- The system persists full durable parser artifacts where storage allows.
- The LLM receives a compact, semantically complete Azure-derived document, not duplicated raw JSON.
- GPT whole-document strict schema extraction writes directly to lease fields.
- Every extracted field must carry source node IDs, page/quote evidence, confidence, and extraction mode.
- Unsupported values are rejected or shown as needs review.

Fallback:

- Fallback is explicit, not blended.
- Legacy deterministic hybrid may run only after primary failure and only as a whole-provider fallback.
- If fallback cannot prove a field, the UI shows blank, not guessed.
- Manual review is a valid terminal state.

## Implementation Changes Made

- Lease whole-document routing now treats both `lease` and `leases` as lease modules.
- Whole-document authoritative checks now apply to both `lease` and `leases`.
- Active lease extraction still enters through the compatibility provider name `openai_primary_legacy_fallback`, but live lease behavior is whole-document LLM primary plus sectioned LLM continuation for oversize documents.
- The business extraction orchestrator now suppresses TypeScript legacy fallback by default for leases; `LEASE_ENABLE_TYPESCRIPT_LEGACY_FALLBACK=true` is the explicit rollback switch.
- `ingest-file` now always queues lease PDFs through `lease-extraction-worker`; old `run_synchronously=true` requests are ignored for leases.
- User-facing direct `parse-document-azure` calls are blocked for lease files to prevent half-parsed, non-generation-scoped states.
- Critical routing files now share `isLeaseModuleType()` so singular/plural lease checks do not drift.
- Lease Review now displays extraction truth: parser provider, extraction mode, effective provider, fallback state, generation, review readiness, and enrichment status.
- Lease Review no longer displays preliminary raw parsed values without review payload evidence.
- Normalize now stamps `generation_id` into persisted extraction metadata so payload provenance can be compared against the active generation.
- Field display provenance now reports payload generation match/mismatch when that metadata is present.
- Core no-provider UI fallbacks are default-off in `normalizeLeaseReviewData`.
- Diagnostic no-provider core fallbacks remain available only through the explicit `allowNoProviderCoreFallbacks` option.

## Wiring Verification - 2026-07-29

- Scanned literal frontend and function-to-function Edge Function calls: 102 concrete calls, 0 missing function directories.
- Scanned those same calls against `supabase/config.toml`: 0 called functions missing explicit config after this pass.
- Added explicit Supabase function config for app-called endpoints that previously relied on platform defaults.
- Fixed `src/pages/SuperAdmin.jsx` to invoke `approve-request`, matching `supabase/functions/approve-request` and `[functions.approve-request]`.
- Fixed the review schema boundary test import so it resolves to `scripts/check-review-schema-boundaries.mjs`.
- Scanned relative JS/TS imports in `src`, `supabase/functions`, and `scripts`: 0 unresolved relative imports.
- Checked raw `/functions/v1/...` fetches: live non-test dispatches are limited to shared invocation helpers and expected internal handoffs.
- Verified the canonical lease handoff remains `upload-handler -> confirm-upload -> ingest-file -> pipeline_jobs -> lease-extraction-worker -> normalize-pdf-output -> LeaseReview`.
- Large-document enrich compute fix: monolithic `enrich` is now guarded by document size and redirected to bounded per-stage enrichment. Existing old `enrich` jobs are superseded and re-enqueued as bounded stages instead of calling the known 546-prone downstream path.

## Hardcoded Limits And Risks

Upload/UI:

- File upload size is capped at 50 MB.
- Preview URLs expire after 15 minutes.
- Large preview threshold is 25 MB.
- Accepted MIME/extensions are hardcoded in the uploader.

Parser:

- Local Azure byte fallback defaults to 10 MB.
- Stored parser output is capped by text chars, blocks, tables, pages, fields, warnings, and page text chars.
- Full raw Azure response depends on `STORE_FULL_AZURE_RAW_RESPONSE`.
- Risk: if the compact whole-document artifact is not persisted before caps, GPT may not receive all relevant lease context.

LLM:

- OpenAI/Azure OpenAI request timeout is 60 seconds per call.
- Default max output tokens is 16,384 unless overridden.
- Whole-document input max defaults to 400,000 characters and fails rather than truncates when exceeded.
- Oversize whole-document leases now route to sectioned strict LLM continuation/reduce before any terminal failure.
- Sectioned LLM continuation defaults to at most 8 section calls, controlled by `LEASE_WHOLE_DOCUMENT_LLM_MAX_SECTION_CHUNKS`.
- Sectioned LLM continuation stops before the normalize deadline reserve, controlled by `LEASE_WHOLE_DOCUMENT_LLM_SECTION_DEADLINE_RESERVE_MS`, so the function returns an explicit partial/blocked state instead of platform timeout.
- Fact-ledger chunking has chunk count, chunk size, concurrency, and deadline-reserve limits.
- Risk: long leases need continuation/reduce behavior, not silent truncation.

Worker:

- Parse, normalize, chained normalize, enrich, bounded enrich, retry delay, and retry grace windows are bounded by env-controlled limits.
- Default max attempts is generally 3.
- Risk: Supabase Edge compute limits still exist. The cleanup prevents lease extraction from using the old synchronous path and keeps enrichment bounded by default; limits should be explicit failure/retry states, not silent UI data pollution.

Review UI:

- Evidence snippets are truncated for display.
- Dynamic findings and clause rows have hardcoded dedupe and category heuristics.
- Older no-provider core field fallbacks used hardcoded address/security-deposit regexes. Those are now disabled by default for core fields.

## Guidance For Better Accuracy

- Keep Azure Document Intelligence as the only parser of record.
- Configure Azure OpenAI with the exact deployment name through env vars; do not rely on default model names.
- Keep whole-document GPT strict schema active for leases.
- Preserve and inspect compact Azure documents for long leases.
- Use sectioned strict LLM continuation/reduce for leases that exceed whole-document prompt size.
- Keep `LEASE_ENABLE_TYPESCRIPT_LEGACY_FALLBACK` unset in production unless deliberately rolling back; otherwise legacy regex/table extraction can publish unrelated values.
- Evaluate extraction against a golden CRE lease corpus before trusting production quality.
- Optimize for evidence-backed correctness over field fill rate. A blank field with a clear review reason is better than an unrelated value in the UI.

## Cleanup Result

Deleted stale/confusing artifacts:

- Historical extraction architecture docs and phase reports that described old parser/provider paths.
- Root-level extraction reports that duplicated or contradicted this audit.
- Generated benchmark `reports/latest` artifacts; benchmark fixtures, schema, replay input, and baseline remain.
- Scratch OCR/extraction scripts and generated temporary audit/handoff files.
- Retired/deprecated Edge Functions: `phase52-openai-diagnostic`, `extract-document-fields`, and `ocr-document-extract`.

Intentionally retained:

- `ingest-file`, `lease-extraction-worker`, `parse-document-azure`, and `normalize-pdf-output`: live canonical lease path.
- `parse-file`: still used for CSV/Excel/tabular imports outside lease PDF extraction.
- `extract-with-custom-fields`: custom-field workflow, not the canonical lease upload path.
- `extract-lease-expense-rules`: post-review lease expense rule generation, not initial lease abstraction extraction.
- `document-intelligence-v3/v4/v6` diagnostic/readiness/search endpoints: superadmin/debug/review tooling, not alternate lease extraction routes.
- `openai-fact-ledger` shared modules: still imported by the business extraction orchestrator and canonical claim/readiness code. For leases, active routing forces whole-document LLM primary plus sectioned LLM continuation for oversize documents; TypeScript legacy fallback is disabled by default and requires `LEASE_ENABLE_TYPESCRIPT_LEGACY_FALLBACK=true`. Deleting or renaming this folder safely requires a separate refactor that moves shared types/mappers out from under the legacy folder name.

## Modularization Result

Completed in this cleanup pass:

- Source-snippet extraction moved into `_shared/extraction/source-snippets.ts`, removing duplicated sentence-boundary and abbreviation logic from `normalize-pdf-output` and `lease-workflow`.
- Edge runtime timeout/budget constants moved into `_shared/extraction/edge-runtime-budgets.ts`, so parse/normalize/enrich budgets are centrally named and bounded.
- Lease extraction provider strategy moved into `_shared/extraction/lease-extraction-strategy.ts`, so the two-path rule is no longer embedded inside the large normalize Edge Function.

Remaining large-function/file risks:

- `normalize-pdf-output/index.ts` is still too large. Next cut should move review-payload assembly, enrichment dispatch/finalization, and dry-run handling into separate modules.
- `lease-workflow.ts` is still too large. Next cut should move summary-table recovery, responsibility evidence validation, and financial/date derivation into domain modules.
- `lease-extraction-worker/index.ts` should become a thin state-machine runner that delegates parse, normalize, enrich, retry/reconciliation, and cancellation handling.
- `LeaseReview.jsx` should be split into data loading hooks, extraction status banner, field-review body, debug/admin panel wiring, and action handlers.

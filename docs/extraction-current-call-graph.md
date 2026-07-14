# Extraction Pipeline — Current Call Graph (Verified)

## Why this doc exists

`docs/pipeline-call-graph.md` already establishes the top-level truth that there is one pipeline with two entry points (`upload-handler` for generic bulk import, `ingest-file` for lease documents), and that `.kiro/specs/backend-driven-pipeline/`'s generic Upload → Parse → Validate → Store → Compute stages are internal building blocks `ingest-file`/`review-approve` call into, not a separate system. This doc does not repeat that — it extends it with the lease-specific detail below the `ingest-file` entry point: exactly how a lease PDF moves through parsing, the two-phase (fast/minimal + deferred/enrich) extraction split, and into Lease Review and approval. Verified by reading all files directly (three full research passes across ~40 files), not inferred.

## The graph

```
Upload + confirmation (unchanged from docs/pipeline-call-graph.md):
  LeaseUpload.jsx --> FileUploader.jsx --> upload-handler
        (stores file, creates uploaded_files row, status='uploaded', confirmed_at=NULL)
  User clicks Proceed --> confirm-upload
        (atomically sets confirmed_at, forwards to ingest-file with the user's own JWT)

Lease PDF routing (ingest-file):
  ingest-file detects format --> pdf/doc/docx/image/unknown routes to the async lease path:
        inserts pipeline_jobs row (job_type:"lease_extraction", stage:"parse", status:"queued")
        fire-and-forget dispatches lease-extraction-worker (service-role auth)
        returns { extraction_queued: true, job_id, status: "parsing" } to the browser immediately

lease-extraction-worker (single invocation, sequential stage fallthrough):
  stage "parse"
    --> parse-pdf-docling
          --> _shared/extraction/parser.ts: parseDocument()
                --> (EXTRACTION_PROVIDER-gated) Azure Document Intelligence
                      _shared/azure/document-intelligence.ts (analyzeWithAzureLayout)
                      --> _shared/extraction/azure-layout-adapter.ts (normalizeAzureLayoutToDoclingOutput)
                --> or legacy fallback chain: native PDF text / OpenXML / Docling HTTP / Gemini Vision
          persists uploaded_files.docling_raw, status: pdf_parsed
  stage "normalize" (same worker invocation, falls through immediately after parse succeeds)
    --> normalize-pdf-output (normal mode)
          --> runExtractionPipeline()  [_shared/extraction/pipeline.ts]
                Rule extractor -> Table extractor -> LLM extractor (missing fields only,
                _shared/extraction/llm-extractor.ts --> _shared/vertex-ai.ts) -> Merge -> Validate
                (_shared/extraction/validator.ts) -> Calculate derived fields
          --> buildMinimalReviewPayload()   [fast, persisted immediately]
                hydrates evidence from result.metadata.extractionDebug.merged_field_sources /
                .llm_returned_field_details (already computed inside runExtractionPipeline,
                pre-validation and raw-LLM-response snapshots) -- so the minimal payload already
                has real source_page/source_text/confidence where available, not evidence:null
                stamps core_ready (payload-guard.ts computeCoreReady) and
                metadata.extraction_contract_version directly
          --> setStatus(uploaded_files, "review_required" | "validated")
          --> (default; NORMALIZE_INLINE_ENRICHMENT unset) enqueueEnrichmentJob()
                [_shared/extraction/enrichment-dispatch.ts]
                inserts pipeline_jobs row (stage:"enrich", status:"queued")
                fire-and-forget dispatches lease-extraction-worker again
          <-- returns to the "normalize" stage's own worker invocation, which marks that
              pipeline_jobs row completed and returns to whatever dispatched it (async, no one
              is waiting on this response by this point)

lease-extraction-worker (second, later invocation, for the enrich job)
  stage "enrich"
    --> normalize-pdf-output (mode: "enrich")
          re-loads the already-persisted normalized_output as `result` -- does NOT call
          runExtractionPipeline() again (no re-parse, no re-LLM-call)
          --> buildReviewPayload()   [expensive, deferred]
                --> buildLeaseWorkflowAbstraction()  [_shared/extraction/lease-workflow.ts]
                      detectDocumentProfileSignals() -- regex-based lease/assignment/amendment
                        /assignment_amendment classification
                      buildClauseRecords() against 34 hardcoded CLAUSE_DEFINITIONS
                      buildLeaseFieldMap() -- per-field evidence resolution via
                        _shared/extraction/evidence-index.ts (resolveVerifiedSourcePage,
                        findPageForSnippet -- page-indexed, WeakMap-cached over docling_raw)
                      deriveExpenseRules(), deriveCamProfile(), deriveBudgetPreview()
          patches ONLY uploaded_files.ui_review_payload (never touches uploaded_files.status)
          sets ui_review_payload.enrichment_status: "completed"
          on any failure: patches only enrichment_status: "failed" + enrichment_error,
            core standard_fields values are left untouched (P0 guarantee)

Human review:
  LeaseReview.jsx
    loads leases row (leaseService.filter) + uploaded_files row (id, status, ui_review_payload,
      reviewed_output, normalized_output, parsed_data), merges client-side into leaseFull
    polls uploaded_files every 4s while ui_review_payload.enrichment_status is pending/running
      (non-blocking banner; fields already visible from the minimal payload stay visible)
    reads fields via src/lib/leaseFieldResolver.js's resolveLeaseField() -- a 23-source fallback
      chain (see extraction-current-data-contract.md for the exact order)
    reviewer actions (accept/edit/reject/N/A/manual-required/needs-legal) write to
      leases.extraction_data.field_reviews[key] (client-computed; see confirmed bugs below --
      several of these write paths are currently broken)
    "Prepare"/draft creation (separate from final approval):
      --> review-approve (action: "prepare" or "approve" for non-lease modules)
            ensureLeaseReviewDrafts() -- creates/updates a leases row (status: "draft") from
              the review payload; this is a DRAFT, not the final abstract approval
    "Approve Lease Abstract" (the actual final approval, separate function/RPC):
      --> approve-lease-workflow
            builds an abstract snapshot + critical-date rows, then
            --> approve_lease_workflow RPC (Postgres, SECURITY DEFINER)
                  validates only actor/org/signed_by/signed_at/idempotency_key --
                  does NOT validate field completeness, confidence, or clause presence
                  (that gating is 100% client-side in LeaseReview.jsx's bulkEvaluation/
                  approvalBlockers -- a confirmed architectural gap, not fixed by this doc)
                  writes leases.status='approved', lease_abstract_versions row,
                  lease_field_reviews rows
            --> synchronously calls compute-lease (service-role auth) so the approved rent
                  schedule exists before the approval response returns
```

## Two-tier status model (a common point of confusion, stated explicitly)

There are **two separate, deliberately-unlinked** notions of "where is this file in its lifecycle":

1. **`uploaded_files.status`** — the FSM owned by `supabase/functions/_shared/pipeline-status.ts` (`uploaded → parsing → pdf_parsed → validating → review_required → approved → storing → stored → computing → completed`, plus `failed`/`cancelled` reachable from anywhere). This FSM has **no knowledge of the `enrich` stage or `enrichment_status`** — a file reaches `review_required` as soon as the *minimal* payload persists, before the deferred enrich pass has necessarily run at all.
2. **`ui_review_payload.core_ready` / `.enrichment_status`** — JSONB-only fields inside the `ui_review_payload` column itself, computed and read entirely outside the FSM. `core_ready` (boolean, stamped once by `buildMinimalReviewPayload`) gates whether "Open Lease Review" is enabled on the frontend (`src/lib/extractionStatusLabels.js`'s `computeCanOpenReview`). `enrichment_status` (`pending|running|completed|failed`) tracks the deferred pass independently and is deliberately never written back onto `uploaded_files.status` (confirmed: `enqueueEnrichmentJob`'s own doc comment states it "deliberately does NOT touch uploaded_files.status").

`pipeline_jobs.stage` is a **third**, separate vocabulary (`parse | normalize | review_draft | rule_extraction | enrich`) — a job-queue concept, not a file-status concept. `enrich` was added to this enum by a recent migration (`20260818000000_pipeline_jobs_enrich_stage.sql`) alongside the async-enrich mechanism described above.

**Confirmed live gap**: `supabase/functions/pipeline-status/index.ts`'s `deriveDisplayState` (in `status-utils.ts`) has no case for `latestJob.stage === "enrich"` — it falls through to the generic `"extracting"` bucket. If `pipeline-status` (the polling endpoint, distinct from `LeaseUpload.jsx`'s own direct `uploaded_files` polling) is ever queried while an `enrich` job is running for a file already at `status: "review_required"` with `core_ready: true`, it can report "Lease extraction is running" / `next_action: "wait"` instead of `ready_for_review` — a real, currently-live inconsistency between this endpoint and the `core_ready` hardening's intent.

## Draft creation vs. final approval — two distinct gates, easy to conflate

- **`review-approve`** (`action: "prepare"` or `"approve"` for lease modules) is the **draft** creation/update step — it writes a `leases` row with `status: "draft"`, using `ensureLeaseReviewDrafts()`'s dedup lookup (existing `lease_review_ids` → `extraction_data->>source_file_id` match → org+tenant+dates match). It is **not** the final abstract approval, despite the edge function's `action` param being literally named `"approve"`.
- **`approve-lease-workflow` → `approve_lease_workflow` RPC** is the actual final "Approve Lease Abstract" action a human triggers from `LeaseReview.jsx`. This is the server-owned workflow described in `docs/server-owned-workflow-pattern.md`/`docs/lease-approval-server-workflow.md` and is unaffected by anything in this doc.

## Known risks and duplication (cross-cutting, found while mapping)

- **Three independent "is this source text generic/useless" implementations** exist: `_shared/extraction/pipeline.ts`'s `isGenericSourceText`, `normalize-pdf-output/index.ts`'s own same-named function, and equivalent logic inside `_shared/extraction/lease-workflow.ts` — each with slightly different regex sets. A future consolidation should pick one.
- **Two independent "core mapping failed" computations** exist (`lease-workflow.ts` ~line 4506-4540, and `normalize-pdf-output/index.ts` ~line 2540-2573) that can diverge — `lease-workflow.ts`'s is read back as the nominal source of truth (`wfSummary.mapping_failure_reason`), but the caller's own fallback computation can override it under a `partialDocumentTextDetected` condition computed independently.
- **`@ts-nocheck` is present on essentially every file in this pipeline** (parser, extraction core, worker, review UI utilities) — no compile-time type safety anywhere in a codebase with extremely deep optional-chaining and dynamic-key JSON access.
- **Confirmed broken-import bugs** (fixed separately from this doc, in the commit immediately following it — listed here for the historical record of what mapping found): `src/pages/LeaseReview.jsx`'s `handleFieldSave`, `FieldDetailDrawer.onSaveEdit`, `onSaveEvidence`, the evidence-backfill effect, `handleMarkAsFullLease`, `handleSendBack`, and the auto-link/manual-link handlers all reference functions or variables (`updateLeaseFieldAndColumns`, `updateLeaseExtractionField`, `backfillLeaseEvidence`, `updateLeaseMutation`, `nextExtraction`) that are either not imported or never declared, throwing `ReferenceError`s caught by generic try/catch blocks. `src/components/lease-review/ExtractionDebugPanel.jsx`'s `handleApplyLatestExtraction` (undefined `applyLatestPatch`) and `handleRelinkSource` (unimported `updateLeaseExtractionField`) have the same class of bug. The correct, server-owned replacement functions all already exist and are correctly implemented in `src/services/leaseService.js` — see `extraction-current-data-contract.md` for exact line numbers.
- **Approval gating is 100% client-side.** `approve_lease_workflow` performs no field-completeness, confidence, or clause-presence validation — a caller invoking the RPC or edge function directly (bypassing `LeaseReview.jsx`'s UI) could approve a lease with every field blank. Not fixed by this doc or by the `vertex_fact_ledger` work that follows it (that work adds `approval_blockers` to the payload as an advisory signal only, per the guardrails on that task).
- **`src/components/lease-review/RequiredReviewQueue.jsx` is dead code** — not imported/rendered anywhere; `LeaseReview.jsx` implements an equivalent "Required Fields" card inline instead.
- **Four independent field-resolution/snapshot-building implementations exist across the codebase**: `leaseFieldResolver.js`'s `resolveLeaseField()` (the live, canonical one), `_shared/lease-approval-workflow.ts`'s `buildAbstractSnapshot()` (used by `approve-lease-workflow`), `src/services/leaseAbstractService.js`'s own `buildAbstractSnapshot()` (dead code, only called from the also-dead `approveLeaseAbstract`), and `dynamicFields.js`'s `buildCanonicalLeaseReviewField()` (the one that actually determines a field's approval-blocking status). Each independently re-derives "what is this field's value and where did it come from."

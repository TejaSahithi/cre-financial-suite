# Extraction Pipeline — Current Data Contract (Verified)

Per-file breakdown of what each file in the upload → parse → normalize → review → approval chain does, its inputs/outputs, the DB fields/JSON paths it reads and writes, and risks found while reading. Verified by reading every file listed below in full (not grepped/summarized from memory) across three research passes. Companion to `docs/extraction-current-call-graph.md` (the flow diagram); this doc is the reference for exact shapes and field names.

---

## Part 1 — Upload / intake / worker

### `src/pages/LeaseUpload.jsx`
Top-level upload page: scoping (property/building/unit), polling, stuck-pipeline detection, handoff to Lease Review.
- **Input**: URL params `property`/`building`/`unit`; `FileUploader`'s `onUploadComplete(result)` → `{file_id, awaiting_confirmation?, processing_error?, processing_started?}`.
- **Output/calls**: `pipeline-status`, `ingest-file` (retry/force_reextract), `review-approve` (`prepare` then `approve` fallback). Falls back to a direct `uploaded_files` select (`MINIMAL_UPLOADED_FILE_SELECT`) if `pipeline-status` errors.
- **DB**: reads/writes `uploaded_files`; writes `leases.extraction_data.{source_file_id,source_file_name,document_subtype,source_file_linked_at}` via `updateLeaseExtractionField`; reads `leases.extraction_data->>source_file_id` (`findLeaseByFileId`).
- **JSON paths**: `ui_review_payload.{records[],core_ready,pipeline_method,extraction_method,metadata.{pipeline,manualReviewFallback,parse_failed,timeoutReviewPending},global_warnings,warnings}`; `pipeline-status` response fields (`status,processing_status,failed_step,error_message,review_required,review_status,...`).
- **Risks**: `ACTIVE_STATUSES`/`STATUS_VALUES` (client) is a hand-maintained parallel vocabulary to the backend FSM (`_shared/pipeline-status.ts`) — omits `approved`. `normalizePipelineStatusRecord` is heavily fallback-chained, making true field provenance hard to trace without reading the function. `ensureLeaseDraft`'s error-recovery path is invoked on *any* `review-approve` failure, not just unsupported-action cases.

### `src/components/FileUploader.jsx`
Generic upload widget: send to `upload-handler`, explicit Proceed/Cancel gate, live status row.
- **Input (props)**: `onUploadComplete, defaultFileType, allowedFileTypes, propertyId, buildingId, unitId, orgId, multiple, accept, onOpenReview`.
- **Output**: `uploadSingleFile` → `{...upload-handler response, processing_started:false, awaiting_confirmation}`; `handleProceed` → `confirm-upload {file_id}`; `handleCancelUpload` → `cancel-upload {file_id}`; `ExtractionStatusRow.handleRetry` → `ingest-file {file_id, force_reextract:true, module_type}`.
- **DB**: `uploaded_files` (`id,file_name,file_size,mime_type,module_type,created_at,org_id,confirmed_at,status,ui_review_payload`), `organizations`, storage bucket `financial-uploads`.
- **Documented invariant**: extraction never starts as a side effect of this component — confirmed by an explicit code comment stating no `parse-pdf-docling`/Azure/`normalize-pdf-output`/Vertex/`lease-extraction-worker` call happens here.
- **Risks**: the 24h-lookback "refresh recovery" query means a pending confirmation older than 24h silently disappears from the UI (the DB row/session still exists). `ExtractionStatusRow`'s `ui_review_payload` fetch is explicitly one-shot (never re-polled) — if the payload changes after `status` first hits `review_required` (which the enrich stage does by design), this summary card can go stale.

### `src/hooks/useFileStatus.js`
Polling hook wrapping `pipeline-status` with backoff.
- **Output**: `{status,progress,errors,validCount,errorCount,isLoading,pollError,processingStatus,failedStep,errorMessage,refetch}`.
- **Note**: does not pass `include_details:true`, so never receives `ui_review_payload`/`docling_raw`/`normalized_output` — only the basic/legacy status shape.
- **Constants**: `TERMINAL_STATUSES = {parsed, review_required, completed, failed, cancelled}`; `POLL_INTERVAL_MS=3000`, `MAX_POLL_INTERVAL_MS=30000`, `MAX_CONSECUTIVE_FAILURES=10`.
- **Risk**: `TERMINAL_STATUSES` omits `approved`; includes `parsed`, a status the lease path doesn't actually pass through (lease flow is `uploaded→parsing→pdf_parsed→validating→review_required`).

### `src/lib/extractionStatusLabels.js`
Dependency-free module: friendly status labels + `core_ready`-based readiness gate.
- `getFriendlyExtractionLabel(status)`, `payloadHasMeaningfulFields(uiReviewPayload)`, `computeCanOpenReview({hasValidReviewPayload, uiReviewPayload, status})`.
- **JSON paths**: `ui_review_payload.core_ready` (read directly — the frontend's one authoritative reader of this backend-stamped flag), `records[0].standard_fields[]/.custom_fields[]`.
- Fallback to `payloadHasMeaningfulFields` only when `core_ready === undefined` (legacy rows); an explicit `false` is respected, never overridden.

### `supabase/functions/upload-handler/index.ts`
First-stage intake: validate, store bytes, insert `uploaded_files` row, cheap preflight only.
- **Input**: multipart `file`, `file_type` (must be in `VALID_FILE_TYPES`), optional `property_id/building_id/unit_id`.
- **Output**: `{error:false, file_id, storage_path, file_name, file_size, mime_type, property_id, building_id, unit_id, processing_status:"uploaded", confirmation_required:true, detected_type, possible_duplicate, created_at}`.
- **DB writes**: `uploaded_files` insert (`status:"uploaded"`, `confirmed_at` left NULL) with schema-drift-tolerant retries (drops `building_id`/`unit_id`, then `property_id`, on column-missing errors).
- **DB reads**: duplicate-heuristic query (`org_id + file_name + file_size`, last 30 days).
- **Risk**: `MAX_FILE_SIZE=50MB` is duplicated independently in `FileUploader.jsx`. Duplicate-check query failure is swallowed (`possible_duplicate` silently defaults false).

### `supabase/functions/confirm-upload/index.ts`
The "Proceed" step: atomically flips `confirmed_at`, forwards to `ingest-file`.
- **Input**: `{file_id}`.
- **DB write**: `uploaded_files.confirmed_at = now()` (conditional: `.is("confirmed_at", null)` — idempotent).
- **Call graph**: forwards the caller's own JWT + `x-acting-org-id` to `ingest-file`, spreads `ingest-file`'s response directly into its own top level.
- **Risk**: response shape is 1:1 coupled to whatever `ingest-file` returns for a given routing path — no normalization layer.

### `supabase/functions/cancel-upload/index.ts`
The "Cancel" step: hard-delete pre-confirmation, soft-cancel (job flag) post-confirmation.
- **Input**: `{file_id}`.
- **DB writes**: pre-confirmation → RPC `delete_unconfirmed_upload(...)` (hard delete `uploaded_files` + storage object); post-confirmation → `pipeline_jobs.cancel_requested_at = now()` where `status IN ('queued','running')`.
- **Documented invariant**: soft-cancel never touches `uploaded_files`/`docling_raw`/`ui_review_payload` — only flags the job.

### `supabase/functions/ingest-file/index.ts`
Central routing/orchestration for all uploaded file types.
- **Input**: `{file_id, module_type?, document_subtype?, defer_store?, force_reextract?, run_synchronously?}`.
- **Output**: varies by branch — async lease path (default): `{error:false, file_id, extraction_queued:true, job_id, status:"parsing", processing_status:"lease_extraction_queued"}` (202). Blocked/CSV/terminal paths have their own shapes (see call-graph doc).
- **DB writes**: `uploaded_files` (`module_type, document_subtype, review_required, review_status`, plus everything via `setStatus`/`setFailed`); `pipeline_jobs` insert (`stage:"parse"` or `"normalize"` if `force_reextract` finds reusable `docling_raw`), superseding any prior queued/running job for the file first.
- **Call graph**: dispatches `parse-pdf-docling`, `normalize-pdf-output`, `validate-data`, `store-data` (synchronous paths) and fire-and-forget `lease-extraction-worker` (async lease path).
- **Guard usage (P0 hardening)**: `parkForBlockedPipeline` re-reads `ui_review_payload/parsed_data/normalized_output` and calls `payload-guard.ts`'s `uploadedFileRowHasMeaningfulValues()` before writing a blocked/fallback payload — aborts and logs `blocked_write_skipped` if real values already exist.
- **Risks**: dead unreachable `return` block at the end of the CSV/structured branch. `parkForManualReview` (distinct from `parkForBlockedPipeline`) does **not** call the payload-guard check — an asymmetry in guard coverage (lower risk since it's the non-lease-PDF path). Fire-and-forget worker-dispatch failures don't update `uploaded_files.status` — a file can be stuck at `parsing` indefinitely if the dispatch fails and `EdgeRuntime.waitUntil` isn't available.

### `supabase/functions/lease-extraction-worker/index.ts`
Async worker: `parse` → `normalize` → `enrich` stage dispatch (single invocation for parse+normalize; enrich is a genuinely separate async hop).
- **Input**: `{job_id, file_id?}`. **Auth**: `x-worker-secret` match or `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>`.
- **Output**: varies by stage/outcome — normalize success additionally, defensively re-checks and re-dispatches the enrich job if `enrichment_status` isn't `completed`/`running` (covers the case where `normalize-pdf-output`'s own enqueue call died before the worker observed the response).
- **DB writes**: `pipeline_jobs` (status/attempt/stage transitions), `uploaded_files` (via `setStatus`/`setFailed`, plus direct `ui_review_payload.enrichment_status`/`.enrichment_error` read-modify-write patches on enrich-failure paths).
- **Guarantee 7 (enrich failure never clobbers core data)**: max-attempts-exceeded and generic enrich failures both fail only the job row + patch `enrichment_status`, never call `setFailed`/`failJobAndUpload` on `uploaded_files`.
- **Guard usage**: `reconcileDurableNormalize()` uses `payload-guard.ts`'s `uploadedFileRowHasMeaningfulValues()` as `contentBasedDurable`, explicitly superseding a purely status-based check because retry machinery resets `status` to `parsing`/`pdf_parsed` before re-running normalize, which would make a status-only check wrongly report "not durable."
- **Risk**: `POST_PARSE_STATUSES`/`POST_NORMALIZE_STATUSES` locally duplicate FSM knowledge from `_shared/pipeline-status.ts` rather than importing it — a recurring pattern across this codebase.

### `supabase/functions/_shared/internal-auth.ts`
`isInternalCall(req, env)` — three accepted forms: `x-worker-secret` match, `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>`, or `x-internal-service-key` match. `extractInternalOrgIdFromHeader` reads `x-internal-org-id` only if internal + UUID-shaped.
- **Risk**: separately (re-)implemented from `lease-extraction-worker/auth.ts`'s `isAuthorizedWorkerCall` (which only checks two of the three forms) — an asymmetry between "who can call the worker" and "who the worker can identify itself as" to functions it calls.

### `supabase/functions/_shared/pipeline-status.ts`
Single source of truth for `uploaded_files.status` transitions. `PipelineStatus` enum: `uploaded|parsing|parsed|pdf_parsed|validating|validated|review_required|approved|storing|stored|computing|completed|failed|cancelled`. `setStatus()` (validated FSM transition), `setFailed()` (unconditional, bypasses FSM). Full `ALLOWED_TRANSITIONS` table reproduced in the call-graph doc's two-tier status section.
- **Confirmed**: `enrich`/`enrichment_status`/`core_ready` do **not** appear anywhere in this file — by design, they live entirely inside the `ui_review_payload` JSONB column, outside this FSM.
- **Risk**: `STATUS_PROGRESS` and `extractPipelineMetadata` are duplicated (with drift) in `pipeline-status/status-utils.ts`.

### `supabase/functions/pipeline-status/index.ts`
Read-only polling/detail endpoint. `include_details` gates whether `ui_review_payload`/`docling_raw`/`normalized_output`/latest job/recent logs are included (three progressively-smaller `uploaded_files` column sets tried on schema error: `FULL_FILE_SELECT`/`BASIC_FILE_SELECT`/`MINIMAL_FILE_SELECT`).
- **`deriveDisplayState` enum**: `queued|parsing|normalizing|creating_review|extracting|retry_pending|blocked|ready_for_review|failed|unknown`.
- **Confirmed live bug** (see call-graph doc): no case for `latestJob.stage === "enrich"` — falls through to generic `"extracting"`, can misreport a `core_ready` file as still-extracting while `enrich` runs.
- **Risk**: `extractPipelineMetadata` duplicated here vs. `_shared/extraction/pipeline-contract.ts` with **opposite fallback-priority order** between the two same-named functions.

---

## Part 2 — Parser + extraction core

### `supabase/functions/parse-pdf-docling/index.ts`
Thin HTTP wrapper (no parsing logic of its own) — downloads/signs the file, delegates to `parseDocument()`, caps output, persists `docling_raw`, flips status to `pdf_parsed`.
- **Output**: deliberately does **not** return the full `docling_raw` blob (avoids a second multi-MB serialization that previously caused OOM/546 errors) — returns a summary (`page_count, full_text_chars, table_count, field_count, ...`).
- **Caps applied**: `MAX_STORED_TEXT_CHARS=80_000`, `MAX_STORED_BLOCKS=1000`, `MAX_STORED_TABLES=500`, `MAX_STORED_PAGES=150`, `MAX_STORED_FIELDS=500`, `MAX_STORED_WARNINGS=50`, per-block/page text capped at `MAX_PAGE_TEXT_CHARS=3_000`.

### `supabase/functions/_shared/extraction/parser.ts`
Canonical `parseDocument()` entry point — strategy matrix (digital PDF → native/Docling; scanned → Vision first; DOCX/XLSX → local ZIP/XML; unknown → parallel race). Normalizes every backend into `DoclingOutput`.
- **Strategy selection**: `pickStrategy()` — `docling_only|vision_only|vision_first|parallel`, based on mime type + `looksLikeScannedPdf` heuristic (printable-ASCII ratio + image-marker regex vs. text-operator regex, first 256KB only) + size thresholds.
- **Risk**: hand-rolled PDF stream decompression (`FlateDecode`/`ASCII85Decode`/`ASCIIHexDecode`) is a correctness/maintenance risk; `DOCX_LEASE_FIELD_ALIASES` is a separate, lease-specific field-extraction path parallel to the schema-driven extractors used later.

### `supabase/functions/_shared/extraction/extraction-provider.ts`
`resolveExtractionProvider()` — modes `legacy|azure_document_intelligence|azure_with_legacy_fallback|shadow_compare`, controlled by `EXTRACTION_PROVIDER` env var. `shouldUseAzureLayout`, `shouldFallbackToLegacy`, `isAzureLayoutOutput`.
- **This is the parsing-provider flag** — orthogonal to the new `BUSINESS_EXTRACTION_PROVIDER` (mapping/reasoning provider) introduced by the `vertex_fact_ledger` work.

### `supabase/functions/_shared/azure/document-intelligence.ts`
Direct HTTP client for Azure Document Intelligence `prebuilt-layout` — submit + poll until `succeeded`/`failed`.
- **Risk**: `getEffectiveAzureOutputFormat()` ignores its configured param entirely, always returns `"markdown"` — the `AZURE_DOCUMENT_INTELLIGENCE_OUTPUT_FORMAT` env var has no actual effect. 2-minute hard timeout, no retry.

### `supabase/functions/_shared/extraction/azure-layout-adapter.ts`
Converts Azure's `analyzeResult` into canonical `DoclingOutput`, inserting `[[PAGE n]]` markers into full-text.
- **Page-marking priority**: `content_spans` → `paragraph_bounding_regions` → `page_lines` → `unmapped_content` (no markers, flagged via `_metadata.page_markers_present:false`).
- **`fields: []` is always empty for Azure layout output** — any code reading `doclingRaw.fields` gets nothing extra from Azure-parsed documents.

### `supabase/functions/normalize-pdf-output/index.ts` (2,787 lines)
Main orchestrator — the file this task's `vertex_fact_ledger` provider branches inside. Two request modes:
1. **Normal mode**: `pdf_parsed` → `runExtractionPipeline()` → `buildMinimalReviewPayload()` (fast, persisted first) → (default) `enqueueEnrichmentJob()` and return immediately.
2. **`mode: "enrich"`**: re-loads `normalized_output`, runs `buildReviewPayload()` → `buildLeaseWorkflowAbstraction()`, patches only `ui_review_payload`.

**`ui_review_payload` shape (`schema_version: 2`, the full current contract)**:
```
{ schema_version: 2, file_id, file_name, module_type, document_subtype, extraction_method,
  pipeline_method, avg_confidence, review_required, review_status: "pending",
  enrichment_status: "pending"|"running"|"completed"|"failed", core_ready: boolean,
  records: [{
    row_index, record_index, values,
    fields: { [field_key]: {value, confidence, source, evidence, status} },
    standard_fields: [{ id, field_key, label, value, original_value, field_type, description,
      required, is_standard, confidence, source,
      evidence: {source_text, source_page, source_quality} | null,
      editable, extraction_status, status, validation_errors: [],
      accepted: false, rejected: false, user_edit: null }],
    custom_fields: [],
    missing_required: [], rejected_fields: [], warnings: [], confidence, notes,
    workflow_output: null | { lease_fields, lease_clauses, extracted_document_items,
      expense_rules, cam_profile, budget_preview, document_profile, summary, ... }
      -- only populated after the enrich pass runs
  }],
  rows: [...], global_warnings: [], warnings: [], validation_errors: [],
  metadata: { ...extractionDebug, extraction_contract_version: "lease-review-evidence-v3" },
  built_at }
```
`standard_fields[].status` values observed: `"missing" | "auto_populated" | "needs_review" | "pending_enrichment"`.

**Evidence hydration path (P0 hardening)**: the minimal payload reads `result.metadata.extractionDebug.merged_field_sources[fieldKey]` and `.llm_returned_field_details[fieldKey]` — both populated inside `runExtractionPipeline()` itself (pre-validation and raw-LLM-response snapshots) — so real evidence is present even before the deferred enrich pass runs, when available.

**Consolidated `extractionDebug` object** (built during the enrich/full pass): `extraction_contract_version, extraction_build_version, extraction_run_id, pipeline_job_id, mapping_failure_reason, core_mapping_failed, document_profile, full_text_chars, source_backed_fields_count, field_trace[], missing_fields_count, missing_by_reason, top_20_missing_fields[]`.

- **Risks**: `@ts-nocheck` on 2,787 lines of deeply nested logic. Two independent "core mapping failed" computations (here and in `lease-workflow.ts`) can diverge. `NORMALIZE_INLINE_ENRICHMENT=true` restores old synchronous behavior — a fully-implemented, reachable-but-dead-in-production code path. `minimalPersistError` is logged as a warning but the function continues as if the fast-durable-payload guarantee held — a silent violation if the minimal write itself fails.

### `supabase/functions/_shared/extraction/pipeline.ts`
`runExtractionPipeline()` — the 6-step orchestrator (Normalize → Rule → Table → LLM(missing-only) → Merge → Validate → Calculate). Returns `ExtractionPipelineResult = {rows, method, warnings, validationErrors, metadata}` — **this is the exact contract the `vertex_fact_ledger` orchestrator must also satisfy**.
- **`metadata.extractionDebug`** is the primary diagnostic surface — includes `merged_field_sources` (pre-validation field→{value,source,confidence,source_text,source_page} snapshot) and `validated_field_values` (post-validation), both built via `snapshotFieldMap()`.
- **"Shallow lease text" heuristic**: if embedded text is 0–2500 chars and file bytes are available, forces the LLM step to request *all* extractable fields rather than just missing ones (compensates for a parser that likely only captured page 1).
- **Risk**: `chunksProcessed` in the returned metadata is always `0` (dead field). Third independent copy of `isGenericSourceText`.

### `supabase/functions/_shared/extraction/llm-extractor.ts`
LLM fallback extraction (fields rule/table missed only). Groups fields via `getFieldGroups(moduleType)` (`schemas.ts`), builds per-group prompts with a keyword-targeted text excerpt (`buildRelevantSnippet`, capped 24,000 chars) or full PDF bytes in file mode. Provider fallback chain: **Vertex AI → Gemini API key → Claude/Anthropic**.
- **Response contract**: LLM must return per-field `{value, source_text, source_page, confidence}`; **a field with a value but no `source_text` is silently dropped** (`if (!evidence.sourceText) continue;`).
- **This is exactly where `unmapped_llm_keys[]` and `llm_returned_field_details{}` are built** — later read by `normalize-pdf-output/index.ts` as `result.metadata.extractionDebug.unmapped_llm_keys`/`.llm_returned_field_details`.
- **Risk**: the huge lease-domain-specific `LLM_SYSTEM_PROMPT` (~150 lines) is sent for every module type, not just leases — a real inconsistency for property/expense/revenue extraction. Concurrency capped at `MAX_ALLOWED_CONCURRENCY=3`.

### `supabase/functions/_shared/vertex-ai.ts`
Low-level Vertex AI (service-account OAuth2) + Gemini Developer API HTTP client — **the shared client the `vertex_fact_ledger` provider reuses unmodified** via `callVertexAIJSON<T>`/`callVertexAIFileJSON<T>`.
- **Auth**: tries `GOOGLE_SERVICE_ACCOUNT_KEY` (multiple decodings), then `GOOGLE_CLIENT_EMAIL`+`GOOGLE_PRIVATE_KEY`. Access tokens cached in-module until 5 min before expiry. Never returns credential fields in its response type.
- **Model/region fallback**: up to 4 locations × 7 models = 28 combinations tried on repeated 404s, with a network-error circuit breaker after 2 consecutive connection failures.
- **JSON robustness**: control-char sanitization + truncation repair (`tryRepairJson`) for responses that hit `maxOutputTokens` mid-object.

### `supabase/functions/_shared/extraction/schemas.ts`
`LEASE_SCHEMA` (~60+ fields: type, required, enumValues, min/max, labels, patterns, description) and `LEASE_GROUPS` (9 LLM prompt groups: parties, assignment, dates, financial, terms, expense_recovery, cam_structure, insurance, legal_options). `getSchema(moduleType)` falls back silently to `PROPERTY_SCHEMA` for unrecognized module types.
- **This is the field taxonomy the `vertex_fact_ledger` provider's fact-to-field mapper reuses unmodified** (via each field's existing `labels[]`).
- **Risk**: field `description` strings double as literal LLM prompt text — schema changes directly change LLM behavior with no separation of concerns.

### `supabase/functions/_shared/extraction/validator.ts`
Post-merge validation: type/enum/range checks (never corrects, only rejects to `null`), plus lease-specific cross-field sanity (`applyLeaseCrossFieldSanity`: rent-swap detection, person-vs-entity signatory demotion) and contextual inference (`normalizeLeaseContextualFields`: assignment tenant substitution, end-date inference). `flattenRecords()` produces the underscore-prefixed keys (`_field_confidences`, `_field_sources`, `_field_evidence`) `normalize-pdf-output/index.ts` reads directly.
- **This is the exact function the `vertex_fact_ledger` provider's fact-field-mapper calls unmodified** (`validateRecords()`) to guarantee identical type/enum enforcement between both providers.
- **Confirmed §5 fixes this session**: `landlord_consent="required"` sanitizer bug and `lease_type` enum-alias bugs (`full_service`→wrong target, `triple net` substring-match collision) were found and fixed in the P0 pass — see prior session's work, not re-litigated here.
- **Risk**: invalid non-required field values are silently discarded with **no `ValidationError` pushed** — a meaningful silent-data-loss risk for the ~90% of fields that aren't `required: true`.

### `supabase/functions/_shared/extraction/lease-workflow.ts` (4,693 lines)
Builds the expensive per-field-evidence "workflow abstraction" — clause records, expense rules, CAM profile, budget preview, and (today) the only document-profile classifier (regex-based). Entry point `buildLeaseWorkflowAbstraction({row, doclingRaw, documentSubtype, unmappedLlmFields?})`.
- **`CLAUSE_DEFINITIONS`**: 34 predefined clause types (rent_escalation, security_deposit, operating_expense_recovery, cam_recoveries, taxes, use_clause, assignment_subletting, repairs_maintenance, alterations, insurance, hazardous_materials, default, remedies, surrender, holdover, renewal_option, notices, subordination_estoppel, governing_law, jury_waiver, successors_assigns, late_fees, indemnification, defaults_remedies, termination, estoppel, broker_commission, guaranty, signage, exclusive_use, casualty, condemnation, force_majeure, compliance_laws, quiet_enjoyment) — **the `vertex_fact_ledger` provider reuses this exact 34-category vocabulary** for its `Fact.category` field.
- **`detectDocumentProfileSignals()`/`detectDocumentProfile()`**: classifies `lease | assignment | amendment | assignment_amendment` via regex signal sets, run twice (before and after field extraction). **This is the fallback the new Vertex classifier degrades to on failure.**
- **`FIELD_SPECS`**: a second, independent ~350-line field-definition list (own aliases/patterns) parallel to `LEASE_SCHEMA`.
- **Output** includes `lease_fields, lease_clauses, extracted_document_items, expense_rules, cam_profile, budget_preview, budget_handoff_readiness, validations, summary`.
- **Risk**: `@ts-nocheck` on the largest, most complex file in the pipeline. Confidence defaults to a hardcoded `0.74` magic number in several places.

### `supabase/functions/_shared/extraction/evidence-index.ts`
Page-indexed, WeakMap-cached structure over `doclingRaw.pages`/`.text_blocks` — the fix for "not enough compute resources" failures on long documents. `buildEvidenceIndex(doclingRaw)`, `findPageForSnippet`, `resolveVerifiedSourcePage`, `normalizeForPageMatch`/`compactForPageMatch`.
- **This is what the `vertex_fact_ledger` provider's "canonical document index" stage reuses directly** — not a rewrite, a promotion of this existing structure to a first-class pipeline artifact.
- Works off `pages`/`text_blocks` directly — **not dependent on `[[PAGE n]]` text markers** (those are consumed only by the LLM prompt layer for page-anchoring hints).

### `supabase/functions/_shared/extraction/payload-guard.ts`
Single source of truth for "does this row have real, meaningful data" — `isMeaningfulFieldValue`, `uploadedFileRowHasMeaningfulValues`, `computeCoreReady` (requires `tenant_name` + ≥3 of 5 remaining core categories). Built this session as part of the P0 hardening pass; unchanged by this task.

### `supabase/functions/_shared/extraction/enrichment-dispatch.ts`
`enqueueEnrichmentJob()` (supersede-then-insert `pipeline_jobs` row, `stage:"enrich"`) + `dispatchEnrichmentWorker()` (fire-and-forget, `EdgeRuntime.waitUntil`-wrapped). Built this session; unchanged by this task.
- **Risk**: dispatch failures are logged, never surfaced/thrown — the `pipeline_jobs` row still exists for a later scan, but nothing currently scans for orphaned queued jobs.

### `docling_raw` — full confirmed shape (persisted by `parse-pdf-docling`, read by everything downstream)
```
{ extraction_method: "pdf_text"|"openxml"|"docling"|"gemini_vision"|"hybrid"|"azure_layout"|"none",
  full_text: string,                  // often "[[PAGE n]]\n..." marked for multi-page docs
  markdown: string | null,
  page_count: number | null,
  pages: [{ page, text, fields?, width?, height?, unit? }],
  text_blocks: [{ block_index, type, text, page?, span? }],
  tables: [{ table_index, headers[], rows[][], markdown? }],
  fields: [{ key, value, confidence?, page?, source_text? }],   // always [] for azure_layout
  warnings: string[],
  raw_response: object | null,        // only if STORE_FULL_AZURE_RAW_RESPONSE=true
  raw_response_summary: object | null,
  _metadata: {
    provider?, extraction_method, model_id?, api_version?, output_format?, content_format?,
    raw_response_stored?, layout_contract_version?, canonical_layout_present?,
    page_markers_present?, page_marker_strategy?, page_mapping_coverage?,
    file_format, page_count, table_count, field_count, text_block_count, has_content,
    extraction_timestamp, text_truncated, blocks_truncated,
    pipeline: { parser_status, normalize_status, ai_status, review_status, error_code,
      error_message, started_at, finished_at, total_duration_ms, attempt, full_text_chars,
      page_count, mapped_fields_count, dynamic_terms_count, source_backed_count,
      lease_clauses_count, expense_terms_count, cam_terms_count, provider_used,
      docling_raw_present, ocr_used, warnings, stage },
    persisted_at
  }
}
```
**This shape is not renamed or restructured by the `vertex_fact_ledger` work, per guardrail.**

---

## Part 3 — Lease Review UI + approval

### `src/pages/LeaseReview.jsx` (4,195 lines)
Main reviewer page. Loads `leases` + `uploaded_files` rows, merges client-side into `leaseFull`, renders 13 tabs, drives field actions and final approval.
- **Reads**: `uploadedFile.ui_review_payload.enrichment_status` (drives `isEnrichmentInFlight` + 4s polling), `.metadata.extractionDebug.extraction_contract_version` (via `isStaleExtractionPayload`), `.records[0].standard_fields[]/.custom_fields[]/.fields/.workflow_output.lease_fields`, `lease.extraction_data.extraction_debug.{core_mapping_failed,mapping_failure_reason}`. Fallback rendering from `normalized_output.rows[0]`/`parsed_data[0]` when `ui_review_payload` hasn't landed yet.
- **Writes**: `leases.extraction_data.{fields,field_evidence,confidence_scores,workflow_output,extraction_debug,field_reviews,source_file_id,document_type_override,send_back,abstract}`, typed `leases` columns via `resolveFieldColumns`, `audit_logs` per field action.
- **Approval blocker logic** (`bulkEvaluation`/`approvalBlockers`, ~lines 1275–1462): a single global `REQUIRED_FIELD_KEYS` applies regardless of document profile — **not profile-aware today**, confirming the gap the `vertex_fact_ledger` work's `approval_blockers` (backend-only, advisory) is scoped to eventually address, but does not fix in this pass (per guardrail, `LeaseReview.jsx` isn't wired to consume it yet).
- **Confirmed bugs (fixed in the commit immediately following the docs commit)**: `handleFieldSave` (:1698), `FieldDetailDrawer.onSaveEdit` (:3577), `onSaveEvidence` (:3659, also references undefined `prevEvidence`), the evidence-backfill effect (:762), `handleMarkAsFullLease` (:914), `handleSendBack` (:1970), and the auto-link/manual-link handlers (:342-522, :525) all reference unimported functions or undeclared variables. All the correct replacements already exist in `src/services/leaseService.js`.

### `src/lib/leaseFieldResolver.js` (859 lines)
The canonical field-value resolution engine — `resolveLeaseField(lease, fieldKey, {mode})`.

**Canonical-mode fallback order (exact, confirmed by reading the code — load-bearing, reproduce exactly)**:
1. `approved_lease_abstracts.snapshot_json`
2. `lease.abstract_snapshot`
3. `lease.extraction_data.abstract`
4. `lease.extraction_data.workflow_output.lease_fields`
5. `lease.extraction_data.workflow_output.expense_rules`
6. `lease.extraction_data.workflow_output.cam_rules`
7. `lease.extraction_data.workflow_output.lease_clauses`
8. `lease.extraction_data.fields`
9. `lease.extraction_data.lease_fields`
10. `lease.extraction_data.workflow_output.extracted_document_items`
11. `lease.extraction_data.extracted_document_items`
12. `lease.extracted_fields`
13. `uploaded_files.reviewed_output`
14. `uf.records[0].workflow_output.lease_fields`
15. `uf.records[0].fields`
16. `uf.records[0].standard_fields`
17. `uf.records[0].custom_fields`
18. `uf.records[0]`
19. `uploaded_files.ui_review_payload`
20. `uploaded_files.normalized_output.rows[0]`
21. `uploaded_files.parsed_data[0]`
22. `uploaded_files.ui_review_payload.metadata.extractionDebug` (flattened `merged_field_sources` + `llm_returned_field_details`)
23. `lease` (top-level raw columns)

If a source is rejected but came from an "authoritative" path (`workflow_output|uf.records[0]|extraction_data.(fields|lease_fields)|uploaded_files.reviewed_output|lease.extracted_fields`), the resolver stops trusting any lower-priority source unless one with real evidence is found first — otherwise it returns "not found" rather than silently falling through to a weaker guess.

**Note**: this file is not modified by the `vertex_fact_ledger` work (per guardrail) — the new provider's output is designed to be consumed by this existing chain unchanged (sources 16-19 in particular).

### `src/lib/leaseReviewSchema.js` (1,307 lines)
Static schema/config: `LEASE_REVIEW_TABS`, `LEASE_REVIEW_FIELDS` (~70 fields), `REQUIRED_FIELD_KEYS` (single global list — `tenant_name, landlord_name, premises_address, square_footage, premises_use, lease_date, lease_term, commencement_date, expiration_date, monthly_rent, security_deposit, lease_type`), `FIELD_COLUMN_ALIASES`, `REVIEW_STATUSES`, `isStaleExtractionPayload()`/`CURRENT_EXTRACTION_CONTRACT_VERSION = "lease-review-evidence-v3"` (equality check, not lexicographic — checks nested `extractionDebug` path before the top-level one).

### `src/components/lease-review/FieldReviewTable.jsx`
Renders the per-tab data grid. Confidence badge via `classifyConfidence` (high ≥90, medium ≥75, low <75). Purely presentational — no direct DB access.

### `src/components/lease-review/SpecializedTables.jsx`
`RentScheduleTable` (reads `rent_schedules`), `ExpenseRuleSubsetTable`/`CamRulesTable` (via `leaseExpenseRuleService`), `ClauseRecordsTable` (reads `lease_clauses` table + falls back to `workflow_output.lease_clauses` across several nesting paths, checked against 20 `STANDARD_CLAUSE_TYPES`), `CriticalDatesTable` (fixed checklist of 7 date fields, client-side sanity flags).

### `src/components/lease-review/ExtractionDebugPanel.jsx`
Superadmin-only diagnostics. Shows `docling_raw` page text, raw pipeline JSON, mapped fields, field-mapping trace, source-matching results. Confirms the backend **does** compute a document profile today (`workflowOutput.document_profile`/`.selected_document_profile`/`.assignment_signal_count`/`.amendment_signal_count`) — this panel only displays it, does not gate approval.
- **Confirmed bugs**: `handleApplyLatestExtraction` (undefined `applyLatestPatch`), `handleRelinkSource` (unimported `updateLeaseExtractionField`) — both fixed alongside the `LeaseReview.jsx` bugs above.

### `src/components/lease-review/RequiredReviewQueue.jsx`
**Dead code** — not imported/rendered anywhere in the codebase.

### `src/components/lease-review/utils/evidenceResolver.js`
Text-matching/evidence-synthesis library for the (currently broken, per above) evidence-backfill effect. `buildSearchBlocks`, `findEvidenceForValue`, `buildCalculatedSupportingEvidence` (arithmetic sibling-field consistency checks for monthly/annual rent and rent-per-sqft).

### `src/components/lease-review/utils/dynamicFields.js` (1,241 lines)
Largest/most complex UI utility — discovers dynamic (non-fixed-schema) items and normalizes every field into the canonical review-row shape.
- **`collectExtractedDocumentItems(lease)`**: merges items from `extraction_data.workflow_output.{lease_fields, lease_clauses, extracted_document_items, clause_records}` (or `uploaded_files.ui_review_payload.metadata.workflow_output`/`.records[0].workflow_output` as fallback).
- **The dynamic-row contract every producer must match**: items/rows carry `is_dynamic: true` / `dynamic_document_item: true`, `maps_to_existing_field: false`, `creates_dynamic_row: true` — **this is the exact shape the `vertex_fact_ledger` provider's dynamic-fact-surfacer reuses** so zero frontend changes are needed.
- **`buildCanonicalLeaseReviewField()`**: the function that ultimately determines a field's approval-blocking status.
- **Risk**: dozens of independent regex-based validation/recovery rules can each silently null out an extracted value with no single centralized "why was this dropped" log visible to a non-superadmin reviewer.

### `src/components/lease-review/utils/validation.js`
`detectDocumentMismatch` (stored vs. extracted sanity checks — sqft, address, tenant name, expiration date), `detectFieldConflicts` (arithmetic/date-sanity on typed `leases` columns).
- **Risk**: `detectDocumentMismatch` only reads the `.fields` object-map shape, not `.standard_fields` (array format) — a coverage gap versus most other resolvers in the codebase.

### `supabase/functions/review-approve/index.ts` (1,835 lines)
The generic-pipeline human-review gate; also the function that **creates the `leases` draft row** (`ensureLeaseReviewDrafts`). `action ∈ {save, approve, reject, prepare}`. Lease documents skip `validate-data`/`store-data` entirely (routed to Lease Review first). Writes ~70 typed `leases` columns via `buildLeaseReviewDraftPayload`, plus `extraction_data.{fields,field_evidence}` (both from the same `buildPerFieldEvidence()` call — byte-identical at creation time). Calls `syncLeaseWorkflowArtifacts` → `lease_clauses`, `cam_profiles`, `syncLeaseExpenseRules`.
- **Important distinction**: this "approve" action only creates a **draft** (`status: "draft"`) — it is not the final abstract approval (that's `approve-lease-workflow` below). Easy to conflate given the shared `action: "approve"` name.

### `supabase/functions/approve-lease-workflow/index.ts` + `_shared/lease-approval-workflow.ts`
The actual "Approve Lease Abstract" function. Builds an abstract snapshot + critical-date rows, calls the `approve_lease_workflow` RPC, then synchronously calls `compute-lease`.
- **`buildAbstractSnapshot`**'s field-resolution order (a **third**, independent implementation, distinct from `leaseFieldResolver.js` and from `dynamicFields.js`): `review.value` → `extraction_data.fields[key]` → `extraction_data.workflow_output.lease_fields[key]` → `lease.extracted_fields[key]` → `lease[key]`.
- **RPC `approve_lease_workflow`** validates only `org_id/lease_id/signed_by/signed_at/idempotency_key` — **no field-completeness, confidence, or clause validation**. Idempotent via `lease_approval_workflow_runs` (unique on `org_id, idempotency_key`, row-locked).
- **Not modified by this task, per guardrail.**

### `supabase/functions/save-lease-review-draft/index.ts` / `supabase/functions/update-lease-extraction-field/index.ts`
Thin, audited, action-whitelisted RPC-callers (`save_lease_review_draft`, `update_lease_extraction_field`). `update-lease-extraction-field`'s whitelist covers `field_evidence_edit`, `custom_field_added`, `source_file_*_linked`, `document_type_override_set` — this is specifically the function `LeaseReview.jsx`'s `onSaveEvidence` and `ExtractionDebugPanel.jsx`'s `handleRelinkSource` are meant to call, per the confirmed-bugs list above.

### `src/services/leaseApprovalWorkflowService.js`
Trivial pass-through: `createLeaseApprovalIdempotencyKey`, `approveLeaseWorkflow` → `approve-lease-workflow` edge function.

### `src/services/leaseAbstractService.js` (695 lines)
Live exports: `saveAbstractDraft`, `rejectLeaseAbstract`, `loadFieldReviewMap`. **Significant dead code**: `approveLeaseAbstract` (a full independent client-side approval path, unused — confirmed via grep, no importers), its own `buildAbstractSnapshot` (a **fourth** independent field-resolution implementation), `syncApprovedAbstractExpenseTermsToRules` (~300 lines, unused). `persistFieldReviews` is an unconditional no-op (`mirrorLeaseFieldReviewsFromBrowser = false` hardcoded) — the `lease_field_reviews` table is populated only by the server-side RPC, never from this client path.
- **Historical note**: a code comment in this file documents a *previously-shipped* instance of the exact same bug class currently open in `LeaseReview.jsx` (`extractionData` undefined in scope, silently breaking Confirm Approval) — this class of bug has recurred in this codebase before.

### `src/services/leaseService.js` (205 lines)
The central server-owned-write service module. All exports referenced by the confirmed-bugs list (`updateLeaseFieldAndColumns`, `updateLeaseExtractionField`, `backfillLeaseEvidence`) are correctly implemented and correctly call their respective edge functions — confirmed the bug is exclusively that several intended call sites never imported them (or, for `sendLeaseBackForReextraction`/`linkLeaseSpaceAssignment`, were never adopted at all — those call sites still do direct `supabase.from("leases").update(...)` writes, bypassing the audited replacement). `leaseService.delete()` has no client-side fallback by design (fails loudly rather than degrading).

---

## Known risks and duplication (summary — see `extraction-current-call-graph.md` for the full narrative)

1. Three independent "is this source text generic" implementations (`pipeline.ts`, `normalize-pdf-output/index.ts`, `lease-workflow.ts`).
2. Two independent "core mapping failed" computations that can diverge (`lease-workflow.ts`, `normalize-pdf-output/index.ts`).
3. Four independent field-resolution/snapshot-building implementations (`leaseFieldResolver.js`, `_shared/lease-approval-workflow.ts`, `leaseAbstractService.js` [dead], `dynamicFields.js`).
4. `@ts-nocheck` on essentially every file in this pipeline.
5. Approval gating is 100% client-side — the RPC performs no completeness/confidence/clause validation.
6. Confirmed broken-import bugs across `LeaseReview.jsx`/`ExtractionDebugPanel.jsx` (fixed in the commit immediately following this doc).
7. `RequiredReviewQueue.jsx` and most of `leaseAbstractService.js` are dead code still present and importable, risking future edits to code with no live effect.

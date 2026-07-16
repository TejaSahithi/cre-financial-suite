# Azure Staging P0 — Parser Resource Exhaustion and Durable-State Reconciliation

**Scope:** implementation patch, backend-only. **Deployed:** no. **Live provider calls made:** none. **Production files touched:** exactly one — `supabase/functions/lease-extraction-worker/index.ts`.

---

## 1. Executive result

The observed incident (`uploaded_files.id = 7ee50442-188e-4a8c-895c-6e0483372646`) — a genuinely successful Azure Document Intelligence parse (71,188 characters, `docling_raw.extraction_method = azure_layout`) silently overwritten by an empty `manual_review_fallback` after a "not having enough compute resources" error — was traced to a **narrower, more precise root cause than the task's own six hypotheses assumed**. Three parallel research passes found that most of the hypothesized causes (byte-download timing, oversized parser HTTP responses, Azure paragraph/line duplication) are **already fixed** in the current codebase, with a code comment in `parse-pdf-docling/index.ts` explicitly referencing this exact incident class. The real, confirmed gap lives entirely in `lease-extraction-worker/index.ts`'s durable-state reconciliation logic: its guard function checked the wrong signal for a parse-stage failure, and its boolean reconciliation result had no way to distinguish "confirmed absent" from "the read itself failed." Both are now fixed with a three-state (`durable` / `not_durable` / `unknown`) reconciliation model, an active repair-on-discovery behavior, and a resume-not-fail redesign of the manual-review guard — confined to the one file this incident actually implicates.

**Verdict: `READY WITH CONDITIONS`** (§25).

---

## 2. Repository baseline

- Branch: `feature/document-intelligence-v3`.
- Log at start of this task: `c17f7b2` (Phase 4D report) → `f456e90` → `f2043af` (Phase 4C) → `3c13c50` → `23ba755` → `cb77efb` → `479b121` → `991fed7` → `2c5c544` → `f6c9674`.
- `git status --short` at start: only the untracked Phase 4E design report (`docs/azure-vertex-migration-phase4e-normalize-contract-design.md`), produced and approved in the immediately preceding phase, not yet committed — tree otherwise clean.
- `docs/azure-vertex-migration-phase4e-normalize-contract-design.md` confirmed present (this P0 patch is the ordering precondition Phase 4E's own report named for real-document acceptance testing).
- Phase 4A (`document-index-v3.ts`) and Phase 4B (`side-write.ts`) canonical-layout resolver adoption confirmed still present.
- `EXTRACTION_PROVIDER` presence check in local `.env*` files: zero matches (consistent with Phase 4E's own finding that provider flags are not set in any local/tracked config — deployed values are out of scope to read).
- Baseline test execution, run before any code change: 158/158 across the existing worker-auth suite (10) + Phase 1–4D pure-function suites (115) + Vertex tests (13) + fact-mapper tests (20) — all passed, 0 failed, confirmed before touching any code.

---

## 3. Confirmed root cause

`parse-pdf-docling`'s success write (`index.ts:568-582`, unmodified by this patch) persists `docling_raw` and flips `uploaded_files.status` to `"pdf_parsed"` together, atomically, in a single `.update()` call — so if `docling_raw` shows real Azure content, `status` was `"pdf_parsed"` at the moment that write committed. The overwrite the incident shows therefore did not happen because the parser's own write was incomplete; it happened because a **later worker write failed to correctly detect this durable state**.

Two independent defects compounded:

1. **Wrong signal for the failing stage.** `parkLeaseForManualReview()`'s own internal guard (before this patch, `index.ts:190`) always checked `reconcileDurableNormalize()` — which inspects `ui_review_payload`/`normalized_output`/`parsed_data` — regardless of which stage had actually failed. For a **parse**-stage failure, normalize has not run yet, so this guard could never detect a durable parse success; it structurally could only protect normalize-stage data.
2. **No "inconclusive" state.** `reconcileDurableParse()`'s durability check was a plain boolean, collapsing "confirmed absent" and "the reconciliation read itself failed" into the same `false` value. If the reconciliation SELECT failed under the same resource pressure that caused the original compute-kill (a plausible, not certain, contributing factor — see the hedge below), that read failure would be silently treated as proof the durable data didn't exist.

**Precision hedge, stated deliberately rather than smoothed over:** the *mechanism* that allowed the overwrite (defect 1, and defect 2's boolean collapse) is certain, established directly from reading the code. The *exact reason* `reconcileDurableParse`'s own check returned a negative result on the specific attempt that produced this incident's observed row — a genuine race between the atomic parser write committing and the worker's reconciliation read running, versus the reconciliation read itself failing under shared resource pressure — is **not** fully certain from static code reading alone; no log or trace evidence from the actual incident was reviewed (out of scope: no remote reads). The fix (§11) is deliberately robust to either cause, not tuned to just one.

---

## 4. Hypothesis-by-hypothesis findings

| # | Hypothesis | Verdict | Evidence |
|---|---|---|---|
| 1 | Full file downloaded before provider-mode resolution | **Disproven** for `azure_document_intelligence` mode | `parse-pdf-docling/index.ts:306-307` resolves provider mode before any Storage access; `:351,372-397` skip `.download()`/`ArrayBuffer`/`Uint8Array`/base64 entirely when `strictAzureMode` is true, with an explicit code comment about avoiding wasted heap. `parseDocument()` (`_shared/extraction/parser.ts:86-91`) already accepts `fileBytes: Uint8Array | null`. Not applicable to `azure_with_legacy_fallback`/`shadow_compare` modes, which the task's own P0-A section explicitly permits to retain byte-download. |
| 2 | Multiple simultaneous large allocations | **Partially confirmed, out of this patch's scope** | In strict Azure mode, `analyzeResult` → `azureOutput` → `persistedLayout` are three transiently-live objects before capping applies — real, but already bounded at persistence time by existing caps, and not confirmed as this incident's actual trigger. Per the plan's explicit scope restriction, not touched here. |
| 3 | Parser HTTP response returns the full parsed document | **Disproven** | `parse-pdf-docling/index.ts:603-629` already returns a small summary object only (`ok, file_id, processing_status, extraction_method, page_count, full_text_chars, table_count, field_count, ...`), with a comment explicitly citing this exact incident class by name ("the final allocation that pushed large leases over the Edge Function memory limit (546)"). Consumer tracing found no caller reading a large field from the success body today. |
| 4 | Worker marks parse failed without reconciling durable output | **Confirmed, root cause narrowed** | See §3. `reconcileDurableParse()` exists and is correctly *triggered* for compute-kill errors (`isTransportShapedFailure()` matches via `status >= 500`, independent of its `error_code` allow-list) — the defect is in what happens after it's triggered, not whether it runs. |
| 5 | Worker can overwrite successful Azure state with fallback markers | **Confirmed** | `parkLeaseForManualReview`'s fallback write exactly matches the observed incident row shape. See §3 for the exact mechanism. |
| 6 | Azure adapter duplicates paragraphs + lines into `text_blocks` | **Disproven** | Both `_shared/extraction/azure-layout-adapter.ts:13-47` (legacy) and `_shared/extraction/azure/azure-to-canonical-layout.ts:241` (v3) already implement paragraphs-primary, lines-fallback-only, each with an explicit comment stating this is deliberate to avoid duplicating "nearly all of the document text." `pages[].text` is a legitimately separate, non-duplicating structure. |

No hypothesis that was disproven was implemented, per the task's own instruction.

---

## 5. Before/after memory object graph

**Not changed in this patch.** Investigated in full during research (Hypothesis 2, §4): in strict Azure mode, the object graph is `analyzeResult` (raw Azure JSON) → `azureOutput`/`doclingOutput` (adapter transform, same object) → `persistedLayout` (capped copy built via explicit field-by-field construction, not a spread). This is already the *current* graph — this patch introduced no new intermediate objects in the parser/adapter path because it did not touch that path. Confirmed unchanged: `parse-pdf-docling/index.ts`, `_shared/extraction/parser.ts`, `_shared/extraction/azure-layout-adapter.ts`.

---

## 6. Exact allocations removed

**None, by this patch.** The allocation-reduction work this section would normally describe (small HTTP response, capped persistence object) was found already implemented in a prior, undocumented change to `parse-pdf-docling/index.ts` — confirmed via the exact code comment quoted in §4, item 3. This patch adds no new allocations to the parser path (it doesn't touch it) and adds only small, fixed-size objects to the worker path (a handful of extra scalar fields in the existing lightweight JSON-path projection query, plus one small repair-patch object per reconciled file).

---

## 7. Persistence-object construction

**Not changed in this patch.** Confirmed already correct: `parse-pdf-docling/index.ts:507-538` builds `persistedLayout` explicitly, field by field (`extraction_method`, `full_text`, `markdown`, `page_count`, `pages`, `text_blocks`, `tables`, `fields`, `warnings`, `raw_response`, `raw_response_summary`, `_metadata`) — never via a broad object spread of `doclingOutput`, which the existing code's own comment states was deliberately avoided because it "silently carries unknown heavy arrays... into JSONB."

---

## 8. Persistence caps and truncation behavior

**Not changed in this patch.** Confirmed already present and unmodified: `MAX_STORED_TEXT_CHARS=80_000`, `MAX_STORED_BLOCKS=1000`, `MAX_STORED_TABLES=500`, `MAX_STORED_PAGES=150`, `MAX_STORED_FIELDS=500`, `MAX_STORED_WARNINGS=50`, `MAX_PAGE_TEXT_CHARS=3_000`. `raw_response` (the full Azure API response) is stored only when `STORE_FULL_AZURE_RAW_RESPONSE=true` is explicitly set — its semantics are explicitly untouched by this patch, per the plan's own scope restriction; this remains a residual, conditional risk (recorded in §23) but is not addressed here since it was not confirmed to be this incident's cause and modifying it was explicitly out of scope.

---

## 9. Parser HTTP response before/after

**No "before" exists to compare against within this patch's timeframe — no change was made.** The response shape investigated in §4 (item 3) already excludes full text/pages/tables/blocks/raw response on success. Response-consumer tracing during research confirmed `lease-extraction-worker` depends on `error_code`/`parser_status`/`processing_status`/`message` specifically from *error* responses (`parserFailureAlreadyPersisted()`) — this patch does not touch `parse-pdf-docling`'s response construction in either the success or error path, so this dependency remains intact by construction, not by new precaution.

---

## 10. Serialized size measurements

**Not applicable — no parser-side change was made in this patch to measure.** No fixture-based `JSON.stringify(...).length` measurement was performed, since fabricating one would only describe pre-existing, unmodified behavior rather than anything this patch changed. If a future phase revisits the parser/adapter files, this section should be filled with real, measured before/after numbers at that time — asserting numbers here now would not reflect anything this patch actually did.

---

## 11. Worker durable-state reconciliation

This is the actual subject of this patch, entirely within `supabase/functions/lease-extraction-worker/index.ts`.

**Three-state model.** `reconcileDurableParse()` and `reconcileDurableNormalize()` now return `{ state: "durable" | "not_durable" | "unknown", ... }` instead of a boolean `durable`. Every call site switches on `state` explicitly (three branches each; `@ts-nocheck` is set file-wide in this codebase, so this is a *runtime*, not compiler-enforced, exhaustiveness discipline — stated precisely rather than overclaimed).

- **`"durable"`**: durability positively confirmed from a successful read.
- **`"not_durable"`**: a successful read positively confirms absence, a fallback shape, or insufficient content.
- **`"unknown"`**: the reconciliation read(s) failed even after one bounded retry (`selectWithRetry()`, a new helper: run once, retry exactly once more on error, never more). `"unknown"` is never treated as proof of absence anywhere in this patch.

**Stronger, provider-scoped durability criteria for parse.** `reconcileDurableParse` now requires, together: a recognized parser method that is explicitly not `"manual_review_fallback"`; substantial text (`fullTextChars >= MIN_LEASE_TEXT_CHARS`, unchanged threshold); and — **only when `rawMethod === "azure_layout"`** — `page_count > 0` and `docling_raw._metadata.provider === "azure_document_intelligence"`. Other recognized methods (`docling`, `gemini_vision`, `pdf_text`, `openxml`, `hybrid`) are deliberately **not** held to the Azure-specific structural checks — research found no evidence they share Azure's corruption mode, and imposing Azure-only assumptions on them was explicitly rejected during plan review. The existing `status ∈ POST_PARSE_STATUSES` path remains available as an alternate route to `"durable"`, OR'd with the new content-based path (mirroring `reconcileDurableNormalize`'s pre-existing, already-proven `statusBasedDurable || contentBasedDurable` pattern) — so a `status` column that hasn't caught up yet doesn't produce a false `"not_durable"` when the content itself is fully valid.

**Content-shape validation for normalize, not just a method-string check.** `reconcileDurableNormalize` already composed `uploadedFileRowHasMeaningfulValues()` (`_shared/extraction/payload-guard.ts`), which was read in full during this patch's implementation and confirmed to check **structural shape directly** — a fallback-shaped `rows: [{}]` row has zero own keys, so `Object.values(row).some(isMeaningfulFieldValue)` is `false` regardless of what `extraction_method` says. The pre-existing `isFallback` (`extraction_method === "manual_review_fallback"`) string check is therefore correctly understood and documented in this patch as an **additional, non-load-bearing safety net**, not the sole mechanism — a test (`reconcileDurableNormalize: rejects a structurally-empty artifact as not_durable even when extraction_method is not literally manual_review_fallback`) proves this holds even for a hypothetical future fallback writer using a different method string.

**Active repair, not just non-overwrite.** New `repairStaleReconciledState(supabaseAdmin, fileId, orgId, targetStatus, targetProcessingStatus)`: reads the row's current `status`; if it differs from the target, calls the existing `setStatus()` (reusing its transition validation — `ALLOWED_TRANSITIONS.review_required` already legally permits `→ pdf_parsed`, and `ALLOWED_TRANSITIONS.failed` already legally permits `→ review_required`/`→ parsing`, confirmed by direct reading of `_shared/pipeline-status.ts`, so **no FSM bypass was needed** for the repair scenarios this incident and its variants produce); if the row's `status` already equals the target (a same-state "transition" `setStatus`'s FSM does not model as a transition at all), falls back to a direct, tenant-scoped update of only the sibling fields (`processing_status`, `failed_step: null`, `error_message: null`), never writing `status` outside `setStatus`'s own FSM. This repairs a row already left corrupted by an earlier failed attempt, not merely prevents a fresh one.

**`parkLeaseForManualReview` redesigned to resume, never to fail on durable discovery.** Previously, discovering durable data inside this guard called `failJob` and stopped (data was safe, but the job — and the user's ability to see a completed extraction without manual re-triggering — was abandoned). Now it returns one of four outcomes: `"resume_from_durable_parse"`, `"resume_from_durable_normalize"`, `"parked"`, `"reconciliation_unknown"`. On durable discovery it repairs state and signals resume; it **never** calls `failJob` in that case. Both call sites were restructured so a resume outcome does not return early — control falls through into the *same* continuation code the main reconciliation check already uses (parse: the existing `parseReconciledToNormalize` flag now also gets set from this path, falling through to the stage-claim/normalize-dispatch block; normalize: a new, parallel `normalizeReconciledToComplete` flag falls through to the existing "mark job completed" + enrich-dispatch block). This reuses existing continuation logic rather than duplicating it.

**`"unknown"` handling.** At both main call sites and inside the parking guard, `"unknown"` resets `pipeline_jobs.status` to `"queued"` (confirmed valid existing enum value, `CHECK (status IN ('queued','running','completed','failed','cancelled'))`, `20260610120000_pipeline_jobs.sql:13,32`) with error fields cleared, leaves `uploaded_files` completely untouched, and returns a `RECONCILIATION_INCONCLUSIVE` / `retryable: true` response. `attempt` is deliberately left as-is (already incremented once at claim time for the current invocation), so the existing `max_attempts` guard — checked at the very top of the next invocation, before any work happens — correctly and automatically bounds how many times this can recur, with no new retry infrastructure invented.

---

## 12. Status reconciliation

`uploaded_files.status`, `.processing_status`, `.failed_step`, and `.error_message` are independent columns with no cross-column DB constraint (Phase 4D's finding, unaffected by this patch). This patch's repair function (§11) writes `status` (via `setStatus`, when a real transition applies) and `processing_status`/`failed_step`/`error_message` (always) together in effect, closing the specific contradictory combination this incident produced (`status=review_required` + `failed_step=parse` + `processing_status=parse_failed_manual_review` alongside genuinely valid `docling_raw`). No new status enum value was introduced; no database migration was made or is required.

---

## 13. Idempotency behavior

A second invocation of the same job after a successful reconciliation does not re-invoke Azure or duplicate normalization: once reconciliation resolves to `"durable"` and the job's `pipeline_jobs.status` reaches `"completed"` (either directly, for a job whose durable state was already past normalize, or via the normal parse→normalize→complete flow the resume path falls through into), the next invocation hits the existing terminal-status short-circuit (`["completed","failed","cancelled"].includes(job.status)`) before any work runs. The existing stage-claim optimistic-concurrency update (`.eq("stage","parse")`) — unmodified by this patch — continues to prevent two concurrent invocations from both dispatching normalize. Reconciliation reads are scoped by both `id` and `org_id` everywhere (verified by a dedicated test, §16), matching the tenant-isolation pattern already established elsewhere in this file.

---

## 14. Azure adapter deduplication

**Not changed in this patch.** Confirmed already correct in both `_shared/extraction/azure-layout-adapter.ts` and `_shared/extraction/azure/azure-to-canonical-layout.ts` — see §4, item 6. No change was made because none was needed.

---

## 15. Files changed

| File | Changed? | Nature |
|---|---|---|
| `supabase/functions/lease-extraction-worker/index.ts` | **Yes** | The entire fix — tri-state reconciliation, repair, resume-based `parkLeaseForManualReview`, both call sites restructured. 409 insertions, 104 deletions. |
| `supabase/functions/_tests/lease-extraction-worker-reconciliation.test.ts` | **Yes (new, test-only)** | 19 new tests, see §16. |
| `supabase/functions/parse-pdf-docling/index.ts` | No | Confirmed uninvolved by research; not touched. |
| `supabase/functions/_shared/extraction/parser.ts` | No | Confirmed uninvolved by research; not touched. |
| `supabase/functions/_shared/extraction/azure-layout-adapter.ts` | No | Confirmed uninvolved by research; not touched. |
| `normalize-pdf-output` business logic | No | Out of scope; unaffected. |
| Lease Review (frontend) | No | Out of scope; unaffected. |
| Database migrations | No | None created or needed. |
| Provider flags (`BUSINESS_EXTRACTION_PROVIDER`, `EXTRACTION_PROVIDER`, `STORE_FULL_AZURE_RAW_RESPONSE`) | No | Semantics and values untouched. |

No production file beyond the one named above was modified. No case arose during execution where a change to an additional file was needed.

---

## 16. Tests and literal results

**New test file**: `supabase/functions/_tests/lease-extraction-worker-reconciliation.test.ts`, 19 tests, built around a minimal hand-rolled chainable Supabase-client mock (no reusable mock of this exact chain shape existed elsewhere in the repo). Because `lease-extraction-worker/index.ts` registers a top-level `Deno.serve(...)` (this repo has no separate library module for this logic — the patch was deliberately kept to this one file only, per explicit scope correction), importing it for its `__test__` hook requires `--allow-net` and `sanitizeResources:false, sanitizeOps:false` on each `Deno.test()` call; this is stated here plainly as a real, if minor, deviation from this repo's usual minimal-permission test convention (`--allow-env --allow-read` only, no other file needs `--allow-net`), not glossed over. Nothing in the tests makes an actual network call — the permission is consumed only by the harmless, never-connected-to local listener bind.

Two rounds of real test failures were found and fixed during development — worth recording honestly rather than only showing the final green run: an initial mock bug (`.update(patch).eq(...).select(...).maybeSingle()` was resetting internal mode back to "read," silently no-op'ing every write made through `setStatus()`) and two test-setup bugs (a finite mock error-queue that ran out before all of `reconcileDurableParse`'s internal fallback/retry queries had been exhausted; one assertion that incorrectly expected parse-stage repair to also clear the top-level `extraction_method` column, which is deliberately not its responsibility). All three were mock/test defects, not production-code defects — fixed in the test file only.

Final result for the new file: **19/19 passed**. Covering: retry-then-unknown (a table that fails *every* read, not just a fixed count, proving genuine exhaustion rather than a lucky queue length); retry-succeeds-on-second-attempt; Azure-specific structural rejection (substantial text but `page_count=0`); Azure-specific structural acceptance (valid method + text + page count + provider metadata); `manual_review_fallback` never reported durable; non-Azure methods (`docling`) correctly exempt from the Azure-only structural checks; stale-status repair (both `status` and `processing_status` corrected together, `failed_step` cleared); fallback-shape rejection by content regardless of the method string; the sequenced-repair scenario (stale fallback normalize artifacts present after a parse repair do not block real normalization from running); positive durable-normalize reuse case; stage-aware resume (never reaches the destructive write); durable discovery never calls `failJob`; `"unknown"` at the parking guard also aborts the fallback write and leaves `uploaded_files` untouched; the true `not_durable` path still parks correctly (regression-proofing the pre-existing behavior); tenant scoping (`id` + `org_id` on every read); `resetJobForRetryableReconciliation` leaves `uploaded_files` fully untouched and only requeues the job with `attempt` left as-is; `selectWithRetry`'s own exactly-once-retry behavior, both the failure and success paths.

**Regression suite, run together with the new file, literal counts:**

| Suite | Result |
|---|---|
| `lease-extraction-worker-auth.test.ts` (pre-existing, unmodified) | 10/10 passed |
| `lease-extraction-worker-reconciliation.test.ts` (new) | 19/19 passed |
| Phase 1–4D pure-function suites (8 files) | 115/115 passed |
| `vertex-fact-ledger.test.ts` | 13/13 passed |
| `document-intelligence-v3-fact-mapper.test.ts` | 20/20 passed |
| `pipeline-status-edge.test.ts` + `pipeline-status-transitions.test.ts` | 5/6 passed — the 1 failure is the exact pre-existing, previously-documented case (`"pipeline-status sanitizes job and log payloads"`, an `AssertionError` on `metadata_summary.source_text.type`), reproduced identically, not re-fixed |
| **Combined backend total** | **182/183 passed** |
| Frontend Vitest (`npm run test -- --run`) | 657/657 passed, 56 files (unaffected — this patch is backend-only) |
| `npm run lint` | pass, exit 0 |
| `npm run typecheck` | pass, exit 0 |
| `npm run build` | pass, exit 0 (9.96s; pre-existing chunk-size warning only, unrelated) |
| `git diff --check` | clean |
| Secret scan (worker file + new test file) | clean, no matches |

---

## 17. Confirmation of no Azure fallback to Docling/Vision

This patch does not modify provider selection, `parseDocument()`, or `analyzeWithAzureLayout()` in any way. `reconcileDurableParse`'s new Azure-specific structural checks only ever *read* `docling_raw` fields already persisted by the existing, unmodified parser — they never trigger a re-parse, a provider switch, or an invocation of Docling/Vision. No Azure or Vertex call was made during this task's execution (development was 100% mocked/fixture-based per the task's own constraints).

---

## 18. Separate pipeline-status diagnosis (not patched here)

Confirmed accurate against current code, matching Phase 4D's report exactly: `pipeline-status/index.ts` still wraps its entire handler in one generic `try/catch` that maps every thrown error — including `getUserOrgId()`'s multi-organization-without-header throw — to a generic HTTP 400 with no distinguishing error code. The three known frontend call sites (`useFileStatus.js`, `LeaseUpload.jsx`, `FileHistory.jsx`) still carry their acting-org-header mitigation. One residual, unmitigated edge case remains: a super-admin with no previously-stored acting org (fresh session, cleared storage) still resolves to no header and hits the unmitigated throw. No production reproduction of this 400 was found in this repo. **Smallest separate patch, not implemented here**: either (a) `pipeline-status/index.ts` alone — catch the specific "multiple organizations" message and return a distinguishable status/code (e.g. HTTP 409 or `{code:"ACTING_ORG_REQUIRED"}`), or (b) `src/lib/actingOrg.js`/the three hook call sites — extend the existing acting-org fallback to also resolve/default/prompt for super-admins on first load.

---

## 19. Separate `persistLeaseExtractionMerge` diagnosis (not patched here)

Confirmed: `src/services/leaseService.js:191` defines it as a hoisted, top-level named `export async function` — no TDZ hazard possible, no conditional/lazy initialization. Both call sites (`src/pages/LeaseReview.jsx`, `src/components/lease-review/ExtractionDebugPanel.jsx`) use standard static ES-module named imports. No circular import found one level in either direction. A passing test suite (`leaseServiceHard3b3aWorkflow.test.js`) already covers its shape and error propagation. **Classification: probable stale deployed bundle / not reproducible locally from source** — matching, not contradicting, the prior Phase 4C/4D conclusion. Not modified in this patch.

---

## 20. Security and tenant-scoping verification

Every reconciliation read this patch touches or adds is scoped by both `id` and `org_id` (verified directly in the new `reconcileDurableParse`/`reconcileDurableNormalize` code and by a dedicated test, §16). The repair write (`repairStaleReconciledState`) is likewise scoped by both `id` and `org_id`. No new cross-tenant read/write surface was introduced. No secret value was read, logged, or printed anywhere in this patch — the console log lines added (`resume_from_durable_${failedStage}`, `reconciliation_inconclusive`, etc.) log only file/job identifiers, status strings, and counts, matching the existing logging style in this file exactly.

---

## 21. Deployment order

Per Phase 4E's own deployment ordering (§23 of `docs/azure-vertex-migration-phase4e-normalize-contract-design.md`), this P0 patch is the second step, after Phase 4E's design (already complete) and before real-document Phase 4E acceptance testing:

1. Complete Phase 4E Design — done.
2. **Implement this Azure resource P0 patch — done, this document.**
3. Retest Azure parser durability (staging, real documents — not performed in this task; see §24).
4. Implement Phase 4E behind an explicit mode flag.
5. Run Vertex-primary/fallback staging tests.
6. Measure and consider production rollout.

Only `supabase/functions/lease-extraction-worker` needs redeployment for this patch — `parse-pdf-docling` and the Azure adapter modules are unmodified and do not need redeploying alongside it.

---

## 22. Staging redeploy commands (described, not executed)

```
supabase functions deploy lease-extraction-worker --project-ref <staging-project-ref>
```

No other function needs deployment for this patch specifically. After deploying, confirm the deployed function version via the Supabase dashboard or `supabase functions list` before retesting.

---

## 23. Rollback plan

Rollback is a single function redeploy of the previous `lease-extraction-worker` version — no schema change was made, so no data migration or reversal is needed. Because the repair logic only ever *clears* stale error fields and moves `status`/`processing_status` to values consistent with data that is already durably present, rolling back does not orphan or corrupt any row it touched; a rolled-back worker simply resumes its old (defective) behavior going forward, without needing to undo any prior repair write. The one residual, unaddressed risk carried forward from research (not this patch's cause, not fixed here): `STORE_FULL_AZURE_RAW_RESPONSE`, if ever set `true` in a deployed environment, still stores an uncapped raw Azure response — recommend confirming this flag is unset in staging/production before or during the next retest, independent of this patch.

---

## 24. Staging retest checklist

To be performed once this patch is deployed to staging (not performed in this task — no deploy occurred):

- Re-run (or use a fresh synthetic large lease) an Azure parse that previously triggered a compute-kill; confirm `docling_raw` persists with `extraction_method=azure_layout` and the worker does **not** overwrite it with `manual_review_fallback`.
- Confirm a row already left in the pre-patch incident's exact contradictory state (`status=review_required`, `failed_step=parse`, `processing_status=parse_failed_manual_review`, valid `docling_raw`) gets repaired to `pdf_parsed`/cleared fields on the next worker invocation for that job, and proceeds to normalize.
- Confirm normalize then produces a real, non-empty `ui_review_payload` (not the `[{}]` fallback shape) for that repaired file.
- Confirm `Open Lease Review` for that file shows real extracted fields, not the empty manual-entry template.
- Confirm approval behavior is unaffected (No Gate, unchanged).
- Confirm no duplicate Azure calls or duplicate normalize runs occurred across the retry.

---

## 25. Retest recommendation

# READY WITH CONDITIONS

Conditions:
1. Staging retest (§24) must be performed against a real Azure-parsed document before this is considered fully validated end-to-end — this task's own constraints (no live provider calls, no deploy) mean the fix has been proven correct against mocked reconciliation scenarios only, not yet against a live compute-kill.
2. Confirm `STORE_FULL_AZURE_RAW_RESPONSE` is not `true` in the target deployed environment (§8/§23) — an existing, unrelated residual risk, not newly introduced or fixed by this patch, but worth checking before or alongside this retest.
3. Phase 4E implementation should not begin against real Azure documents until the staging retest in §24 passes, per Phase 4E's own stated deployment ordering.

**Phase 4E implementation has not been started. No deploy occurred. No live Azure or Vertex call was made.**

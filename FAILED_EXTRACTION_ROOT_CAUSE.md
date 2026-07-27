# Failed Extraction Root Cause — Craven Wings, 2026-07-26

Investigation type: read-only root-cause analysis + narrow local code patch.
No remote deployment, no re-extraction, no mutation of any `uploaded_files` row was performed. All database access in this investigation was `SELECT`/`pg_get_functiondef`/`information_schema` reads.

## 1. Exact failed generation

| Field | Value |
|---|---|
| `uploaded_file_id` | `34b86335-e5af-40c6-adbe-a2b7d12924c8` |
| `file_name` | `Craven Wings Lease Executed 1.pdf` |
| `active_generation_id` | `1108a7ef-c266-4f6b-8916-e1a09e5d16eb` |
| `parse` job id | `aa955c49-c6ab-488e-8c40-012f5460c367` (also used for `normalize` — same pipeline job row carries both stages) |
| `enrich` job id | `79f67ab5-ad8b-4e69-afab-f02491361d65` |
| Upload confirmed | 2026-07-26 06:04:22 UTC |
| parse completed | 2026-07-26 06:04:34 UTC (26 pages, 7 tables, 447 text blocks, 98,439 chars) |
| normalize completed | 2026-07-26 06:04:44 UTC (`method: "llm_only"`, `deferred_enrichment: true`) |
| enrich started | 2026-07-26 06:04:44.621 UTC |
| enrich `completed_with_warnings` | 2026-07-26 06:04:47.946 UTC |
| `uploaded_files.updated_at` (last write) | 2026-07-26 06:05:10.581 UTC |

Current DB state for this row (as of investigation time, unmodified by this investigation):
`processing_status: review_required`, `enrichment_status: pending` (column-level; the JSONB `ui_review_payload.enrichment_status` is `completed_with_warnings` — these two are different, independently-written fields, see §8), `review_readiness: pending`, `review_readiness_reasons: []`.

## 2. Exact downstream function

- **Caller:** `supabase/functions/lease-extraction-worker/index.ts`, `callInternalFunction()` (originally ~line 484, unmoved by this patch).
- **Callee:** `normalize-pdf-output`, invoked as `POST {SUPABASE_URL}/functions/v1/normalize-pdf-output` with body `{ file_id, pipeline_job_id: job.id, worker_attempt: attempt, mode: "enrich" }`.
- **Auth:** service-role bearer token + `apikey` + `x-internal-org-id` + `x-internal-service-key` + `x-worker-secret`, built by `buildInternalFunctionHeaders()` (`lease-extraction-worker/auth.ts`). No secret values are reproduced here.
- **Response received:** HTTP status `546`, no parseable JSON body (platform-level kill responses do not carry the callee's own JSON error shape). `classifyDownstreamError(546)` (`auth.ts:62-63`, `status >= 500` branch) maps this to `error_code: "DOWNSTREAM_FUNCTION_FAILED", retryable: true`.
- **546 is a Supabase Edge Function platform response** — "the function was killed for exceeding its compute/memory allocation," not an application-level exception. This exact status/message pair (`"Function failed due to not having enough compute resources (please check logs)"`) recurs verbatim across multiple prior Craven Wings attempts in `pipeline_jobs` (2026-07-24 07:16, 06:11, 05:09; 2026-07-14) and is referenced defensively throughout the codebase (`ingest-file/index.ts`, `normalize-pdf-output/index.ts`, `parse-document-azure/index.ts` all have existing "546 OOM" hardening comments/handling) — this is a known, recurring failure mode for this specific document, not a one-off.
- **This generation's exact instance of the raw error text was not directly recoverable** — see §3/§4/§8: the code path that ran for this generation discarded it before persisting it anywhere. The text above is inferred from every other historically-identical `(error_code, status)` pair on this same document, not read directly from this generation's own stored data.

## 3. Complete failure chain

```
lease-extraction-worker (enrich stage, job 79f67ab5)
  -> POST normalize-pdf-output {mode:"enrich"}
     -> Supabase platform kills the invocation: HTTP 546
          "Function failed due to not having enough compute resources"
  <- classifyDownstreamError(546) -> error_code=DOWNSTREAM_FUNCTION_FAILED, retryable=true
  -> isReviewReadyEnrichmentTransportFailure("DOWNSTREAM_FUNCTION_FAILED", msg, 546)
       [BEFORE THIS FIX] -> true  (treated as a safe, non-blocking warning)
  -> completeEnrichmentWithWarning(...)
       - pipeline_jobs.status = "completed"      (NOT "failed")
       - pipeline_jobs.error_code = null          (real error discarded)
       - pipeline_jobs.error_message = null        (real error discarded)
       - ui_review_payload.enrichment_status = "completed_with_warnings"
       - ui_review_payload.enrichment_warning = FABRICATED text:
           "Optional enrichment warning: some source page references could
            not be linked, but all core lease terms were successfully
            extracted and are ready for review."
       - fires finalize_lease_extraction_for_review RPC
           -> RPC call includes p_package_mode/p_financial_mode, params that
              DO NOT EXIST on the currently-deployed Postgres function
              (confirmed via pg_get_functiondef against the live DB)
           -> supabase-js resolves this as {error}, does not throw
           -> {error} was never inspected/logged -> silently discarded
           -> review_readiness / review_readiness_reasons never updated
  -> pipeline_logs: "pipeline_stage:enrich:completed_with_warnings"
       (the fabricated message, not the real 546 error)
  -> uploaded_files.review_readiness stays at its unevaluated default
       ("pending", reasons=[]) indefinitely
  -> frontend's synthesized "review_handoff" timeline row reads
       uploadedFile.review_readiness directly -> shows "pending" forever
```

## 4. Original error

Direct textual capture of the 546 body for THIS generation was not possible — the code path that ran discarded it (see §8, "what was thrown away"). By exact match against every other historical occurrence of the same `(error_code="DOWNSTREAM_FUNCTION_FAILED", status=546)` pair on this same document (`pipeline_jobs` rows for generations `9bff95e7`, `fb1f538c`, `cededd7c`, `6e5bae1f`), the underlying platform message is:

> `Function failed due to not having enough compute resources (please check logs)`

This is Supabase's own compute/memory-limit kill message, not an application exception. "please check logs" refers to Supabase's platform-level function invocation logs, which are **not accessible from this environment** — the installed Supabase CLI (`supabase functions --help`) has no `logs` subcommand, and `supabase inspect` only offers `db`/`report`, not function-invocation logs. This is a documented limitation of this investigation (Part 3), not something resolved.

## 5. Exact responsible file/function/line

- `supabase/functions/lease-extraction-worker/index.ts`, `isReviewReadyEnrichmentTransportFailure()` (was lines 567-577) — classified `DOWNSTREAM_FUNCTION_FAILED` as a safe, review-ready transport hiccup. **This is the primary local defect** — it converts a genuine downstream crash into a fabricated success narrative.
- `supabase/functions/lease-extraction-worker/index.ts`, `completeEnrichmentWithWarning()` (was lines 579-639) — unconditionally replaced the real error text with a fixed, factually-incorrect friendly string, and set `pipeline_jobs.error_code`/`error_message` to `null`, permanently discarding the real diagnostic trail.
- `supabase/functions/lease-extraction-worker/index.ts`, all 3 call sites of the `finalize_lease_extraction_for_review` RPC (`completeEnrichmentWithWarning`, the max-attempts-exceeded terminal path, and the real-failure path) — called the RPC's return value without ever inspecting `{error}`, silently discarding an RPC-level failure caused by a parameter/schema mismatch (see §6).

## 6. Did the adaptive architecture actually run?

| Question | Answer | Evidence |
|---|---|---|
| Adaptive extractor began? | **Yes.** `result.method: "llm_only"` (a real value only the primary `openai_fact_ledger`/`business-extraction-orchestrator.ts` path produces) and `extractionDebug.merged_field_sources` is present with 13 real field keys. | `normalized_output` column, this generation |
| Deterministic extraction ran? | Inconclusive from stored data alone — `merged_field_sources` is small (13 keys) for a 26-page/7-table document, consistent with either a genuinely sparse deterministic pass or an LLM-only path; cannot be distinguished further without the (inaccessible) function logs. | — |
| Domains routed (Section-Aware Candidate Router)? | Not directly observable from persisted data; no per-domain instrumentation is persisted to `uploaded_files`/`pipeline_logs`. | — |
| Azure OpenAI request attempted? | **Yes**, implied by `method: "llm_only"` and non-empty `merged_field_sources` with real `source_text`/`source_page` values (e.g. tenant_name, landlord_name). | `normalized_output.metadata.extractionDebug.merged_field_sources` |
| **Did Lease Truth Assembly run?** | **No markers present anywhere** — `ui_review_payload::text ILIKE '%truth_assembly%'` is `false` across the full 254,902-byte payload, despite `merged_field_sources` (Truth Assembly's own required input) being present. | See §7 below — this is a genuine, only-partially-resolved anomaly. |
| Was the canonical payload persisted? | **No** — no `truth_assembly_field_id`/`truth_assembly_status`/`truth_assembly_version` key exists anywhere in the stored payload. |
| Failure occurred before or after each point? | Parse/normalize/adaptive-LLM-mapping: **before** the 546 crash (all completed and persisted). Lease Truth Assembly override / rich `buildReviewPayload`: **at or after** the crash — enrich (which builds the rich payload) never completed. |

### Deployed build vs. local commit (§4 requirement)

- `normalize-pdf-output` was last deployed **2026-07-26 05:31:51 UTC** (version 226) — 33 minutes before this incident (06:04 UTC) — and has not been redeployed since (re-checked live via `supabase functions list` at investigation time; version/timestamp unchanged).
- `lease-extraction-worker` was last deployed **2026-07-25 15:07:52 UTC** (version 81), also unchanged since.
- The local repository (git HEAD, unchanged across this whole window for these two files) contains `lease-truth-assembly.ts`'s unconditional `truth_assembly_field_id`/`status`/`validationResults`/`version` spread onto every `standard_fields` entry inside `buildMinimalReviewPayload()`.
- **A direct local reproduction was run**: this exact document's real, stored `rows`/`extractionDebug` (pulled from the `normalized_output` column) was fed into the current `assembleCanonicalFields()` in an isolated `deno run` — it did **not** throw, and correctly computed `canonicalActive=true, status="verified"` for `tenant_name`, `landlord_name`, and `responsibility_taxes` (the exact fields the live payload shows). If the currently-deployed code had genuinely executed, the live payload **should** show `truth_assembly_field_id` for these fields. It does not.
- **Conclusion: this is a confirmed, reproducible discrepancy between the code the control plane reports as deployed and the code that evidently executed for this specific invocation.** The most likely explanation is edge-function isolate/propagation staleness (a warm, pre-deploy isolate serving this specific request) — a Supabase platform-level behavior, not an application bug — but this cannot be conclusively confirmed without Supabase's own function-invocation logs (inaccessible from this environment; see §3). This is reported honestly as **unresolved**, not assumed away.

## 7. Origin of the partial UI payload

The persisted `ui_review_payload` for this generation is **exclusively the minimal payload** built by `buildMinimalReviewPayload()` during the **normalize** stage (fast, durable, pre-enrichment persist) — never overwritten by the rich `buildReviewPayload()` (workflow abstraction, clause records, evidence resolution), because the deferred **enrich** job that builds it crashed (546) before it could run.

Evidence: `record[0]` has exactly the minimal-payload key set (`notes, fields, values, warnings, row_index, confidence, record_index, custom_fields, rejected_fields, standard_fields, workflow_output, missing_required, validation_errors`) with **no `extractionDebug` key at all** — `extractionDebug` is only ever attached by the rich `buildReviewPayload()` path, which never ran.

**Why tenant/landlord/tax show while other fields are missing:** this is a property of what the underlying extraction (deterministic + LLM) actually resolved before the crash, not something the crash itself caused. `extractionDebug.merged_field_sources` (computed during normalize, before the enrich crash) contains only 13 field keys: `admin_fee_pct, assignment_effective_date, cam_amount, commencement_date, landlord_consent, landlord_name, monthly_rent, option_exercise_deadline, property_address, property_name, responsibility_taxes, start_date, tenant_name`. Of these:
- `tenant_name`, `landlord_name`, `responsibility_taxes`, `property_address`, `property_name`, `landlord_consent` resolved to real values with real evidence (e.g. `tenant_name`: *"TENANT: CRESS FAMILY RESTAURANTS, LLC"*, page 12).
- `monthly_rent` resolved to `null`/`status:"missing"` with `source_text: "Months\nBase Rent PSF\nBase Rent Per Month\nMonths -- 1-2"` — a table **header** row was matched, not an actual rent figure, a known, separately-tracked stepped-rent-schedule-table extraction gap (see the existing "Lease Extraction Pipeline — Tier 1 + Tier 2 Fixes" plan's §2.6 rent-schedule fix — **out of scope for this incident's narrow fix**, since it is a pre-existing extraction-completeness gap, not something the 546 crash caused).
- `commencement_date` is present as a key in `merged_field_sources` but resolved to no usable value in this run.
- Every other schema field (`security_deposit`, `lease_type`, `square_footage`, `escalation_rate`, etc.) has **no entry at all** in `merged_field_sources` — the underlying pipeline never found a candidate for them in this document, independent of the enrich crash.

The 546 crash means the *reconciliation and validation layer* (Lease Truth Assembly, duplicate-alias merging, workflow abstraction) never ran on top of this — it does not explain the *presence* of the 13 resolved fields (that's the underlying extraction's own, pre-crash result) or the *absence* of the other ~75 schema fields (a separate, pre-existing recall gap).

## 8. State-machine inconsistency

Two independent columns track "is this generation reviewable," and only one of them updates correctly here:

- `uploaded_files.ui_review_payload.enrichment_status` (JSONB, written by `completeEnrichmentWithWarning`) — **correctly** becomes `"completed_with_warnings"`.
- `uploaded_files.review_readiness` / `review_readiness_reasons` (top-level columns, meant to be refreshed by the `finalize_lease_extraction_for_review` RPC call fired at the end of `completeEnrichmentWithWarning`) — **never updates**, because that RPC call is broken:

The live, deployed `finalize_lease_extraction_for_review` Postgres function (confirmed via `pg_get_functiondef` against the linked project) has the signature:
```
(p_org_id uuid, p_uploaded_file_id uuid, p_generation_id uuid DEFAULT NULL, p_lease_id uuid DEFAULT NULL, p_actor_user_id uuid DEFAULT NULL, p_actor_email text DEFAULT NULL)
```
— **no `p_package_mode` or `p_financial_mode` parameters.** But every call site in the currently-deployed `lease-extraction-worker` passes exactly those two extra named parameters (added to the *code* by commit `07bc65b`, "P3.7: add package runtime orchestration", 2026-07-19 — a migration change that was never pushed to this project's remote database; confirmed via `supabase migration list --linked`, which shows `20260847000000_lease_package_runtime_p3_7.sql` and `20260854000000_lease_financial_runtime_p4_7.sql` with `remote: ""`, i.e. never applied, alongside 60 other unapplied migrations on this project). Calling a Postgres function with named parameters it doesn't have fails with a function-resolution error; `supabase-js` resolves this as `{error}` rather than throwing, and **the calling code never inspected `{error}`** — so the failure was completely silent, on every single enrichment completion (success, warning, or failure) for this entire project, not just this one incident.

The frontend's `ExtractionTimelinePanel.jsx` synthesizes a `review_handoff` row directly from `uploadedFile.review_readiness` (`status: uploadedFile.review_readiness || uploadedFile.review_status || uploadedFile.processing_status`) — since that column never advances past its initial `"pending"` value, this row shows `"pending"` indefinitely, regardless of what actually happened in the pipeline. This fully explains "review_handoff remains pending."

**Important, separately-verified finding: this does NOT create an approval-safety hole.** `review-approve/index.ts`'s actual gate calls a *different* RPC, `finalize_lease_review_approval`, which independently re-derives readiness fresh at approval time by calling `evaluate_lease_extraction_readiness()` itself (confirmed via its live `pg_get_functiondef`) — it does not trust the stale `review_readiness` column. `evaluate_lease_extraction_readiness()` reads the enrich job's `pipeline_jobs.status` directly; before this fix that status was incorrectly `"completed"` (masking the crash), so approval **could** have gone through incorrectly. After this fix, a `DOWNSTREAM_FUNCTION_FAILED` enrich crash correctly lands the job at `status: "failed"`, which `evaluate_lease_extraction_readiness()` turns into `ENRICHMENT_FAILED` → `readiness: "failed"`, which `finalize_lease_review_approval` correctly blocks on. **The fix in this patch is what makes that pre-existing, correctly-designed approval gate actually fire for this failure mode** — it was not previously unreachable for architectural reasons, only because the enrich job's terminal status was being fabricated as "completed."

The "enrich still shown as running" observation could not be reproduced from the stored `pipeline_jobs`/`pipeline_logs` data for this exact generation (the enrich job row is `status: "completed"`, not `"running"`, at rest). The most likely explanation is `ExtractionTimelinePanel.jsx`'s `refetchInterval` polling logic caching a snapshot taken during the ~3.3 second `queued → running → completed_with_warnings` window and not being manually refreshed afterward — a client-side staleness artifact, not a persisted backend inconsistency. Flagged as inconclusive, not asserted as fact.

## 9. Local fix

Applied in `supabase/functions/lease-extraction-worker/index.ts` (no deploy):

1. **`isReviewReadyEnrichmentTransportFailure()`**: removed `code === "DOWNSTREAM_FUNCTION_FAILED"` and `text.includes("not enough compute resources")` from the "safe to mask as a warning" classification. A downstream crash now correctly routes to the pre-existing real-failure path (`failJob`, `enrichment_status: "failed"`, minimal payload preserved, real error logged) instead of the misleading warning path. `STAGE_TIMEOUT`/504/"timed out" are unchanged — no incident evidence implicates them.
2. **`completeEnrichmentWithWarning()`**: now accepts and persists the real original downstream error (`pipeline_jobs.metadata.enrich_original_error`) distinctly from the friendlier reviewer-facing summary, instead of discarding it. The friendly summary is still shown to reviewers for the (now narrower) set of genuinely-optional transport hiccups; the real diagnostic text is never lost again.
3. **All 3 call sites of the `finalize_lease_extraction_for_review` RPC** now inspect the RPC's own `{error}` return value and `console.error` it loudly if present, instead of silently discarding it (the previous `catch` block could never fire for this failure mode, since supabase-js resolves an RPC error as a normal, non-throwing result).

**Not fixed by code, because it is not a code problem** — per this task's own instruction not to invent a code workaround for a not-deployed dependency: the `finalize_lease_extraction_for_review` parameter mismatch is a genuine schema/migration drift issue. The correct fix is pushing the two pending migrations (see §11), not stripping the new parameters from the calling code (which would silently regress the package/financial-mode functionality those migrations are for, once they do land).

## 10. Regression tests

Added/updated in `supabase/functions/_tests/lease-extraction-worker-reconciliation.test.ts` (28 tests total in this file, all passing):

- `isReviewReadyEnrichmentTransportFailure`: `DOWNSTREAM_FUNCTION_FAILED`/546 now asserted `false` (previously asserted `true` — this existing test's assumption was the one being corrected); `STAGE_TIMEOUT`/504 unchanged (`true`).
- `completeEnrichmentWithWarning`: asserts `pipeline_jobs.metadata.enrich_original_error` equals the real original message and is distinct from the friendly `enrich_warning_message` — proves original error preservation (requirement #3).
- New test reproducing the exact silent-RPC-failure mode found in production (mocked `rpcErrors.finalize_lease_extraction_for_review`), asserting the failure is now logged via `console.error` naming both the RPC and the real error text, instead of vanishing.

All 3 new/modified tests pass; the full file (28 tests) passes; the broader Lease Truth Assembly / Section-Aware Router / fact-ledger suite (98 tests across 7 files) passes unchanged.

Not separately tested here (would require a live Postgres instance, unavailable in this sandbox — Docker is not running): requirement #4 ("failed enrich jobs reach a terminal state") and #5 ("review_handoff cannot remain indefinitely pending") are satisfied *by construction* once `isReviewReadyEnrichmentTransportFailure` routes to the pre-existing `failJob()` call (which sets `pipeline_jobs.status = "failed"`, an existing, already-tested terminal write — see the pre-existing `parkLeaseForManualReview`/`failJob` tests in the same file) and once `evaluate_lease_extraction_readiness()` is freshly re-evaluated at approval time (verified by direct `pg_get_functiondef` inspection, not by a new Deno test, since that function requires live Postgres to execute). Requirement #6 ("partial extraction is not presented as a successfully completed abstraction") is satisfied via the same mechanism — `finalize_lease_review_approval` blocks on `ENRICHMENT_FAILED` once the enrich job's status is genuinely `"failed"`.

## 11. Exact remote action required

**Not performed in this session (explicitly out of scope).** To fully close the `review_readiness`/`review_handoff` staleness described in §8 (a display/observability issue, not an approval-safety issue — see §8), push the two pending migrations that add `p_package_mode`/`p_financial_mode` to `finalize_lease_extraction_for_review`:

```
supabase db push
```

(applies all pending local migrations against the linked project `cjwdwuqqdokblakheyjb`, including — but not limited to — `20260847000000_lease_package_runtime_p3_7.sql` and `20260854000000_lease_financial_runtime_p4_7.sql`, which are the two specifically responsible for this RPC's signature; running a full `db push` also applies 60 other currently-pending migrations, including the entire `document-intelligence-v3`/`v4`/`v6` schema investigated in a prior session — **that is a separate, much larger decision the user has previously deferred, and this report does not recommend running a full `db push` without that being separately, explicitly authorized.** A narrower, single-migration `supabase migration up --include-all=false` targeting only those two files, or a manually-reviewed subset push, would resolve this specific gap without also activating the unrelated v3/v4/v6 system.)

To investigate the unresolved deployed-vs-executed code discrepancy in §6, Supabase's dashboard function-invocation logs for `normalize-pdf-output` around 2026-07-26 06:04:44–06:04:48 UTC (not accessible via the CLI tooling available in this environment) would be needed.

## 12. Confirmation of no remote mutation or deployment

- No `supabase functions deploy` was run at any point in this investigation.
- No `supabase db push` / migration was applied.
- No `INSERT`/`UPDATE`/`DELETE` was issued against `cjwdwuqqdokblakheyjb` — every database query in this investigation was `SELECT`, `pg_get_functiondef`, or `information_schema`/`supabase migration list` (read-only).
- The `uploaded_files` row for `34b86335-e5af-40c6-adbe-a2b7d12924c8` was read multiple times and never written to.
- The document was not re-extracted; no new pipeline job or generation was created.
- A temporary, local-only diagnostic script (`supabase/functions/_diag_craven_repro.ts`) was created to reproduce `assembleCanonicalFields()` against this generation's already-stored data and was deleted before this report was written (confirmed via `git status`, which shows only the two intended code changes).
- Code changes are local, uncommitted-by-this-session, and undeployed: `supabase/functions/lease-extraction-worker/index.ts` and `supabase/functions/_tests/lease-extraction-worker-reconciliation.test.ts`.

---

ROOT CAUSE:
A Supabase platform resource-exhaustion kill (HTTP 546) of `normalize-pdf-output` running in `mode:"enrich"` was misclassified by `isReviewReadyEnrichmentTransportFailure()` as a safe, review-ready transport warning instead of a real failure, and the separate `finalize_lease_extraction_for_review` RPC call that should have refreshed review readiness afterward has been silently failing on every invocation project-wide because the deployed code passes `p_package_mode`/`p_financial_mode` parameters that don't exist in the currently-live (un-migrated) Postgres function.

FAILED AT:
`supabase/functions/lease-extraction-worker/index.ts`, `isReviewReadyEnrichmentTransportFailure()` and `completeEnrichmentWithWarning()` (enrich-stage handling, ~line 567 and ~line 594 before this patch); downstream 546 originated in `normalize-pdf-output` invoked with `mode:"enrich"`.

ADAPTIVE EXTRACTION STARTED:
yes

LEASE TRUTH ASSEMBLY RAN:
no (and this could not be fully explained — see §6; the deployed code, reproduced locally against this document's real data, should have run it and did not throw, yet no truth_assembly marker exists in the stored payload)

PARTIAL UI PAYLOAD CAME FROM:
normalize stage's minimal payload (`buildMinimalReviewPayload()` in `normalize-pdf-output/index.ts`), never overwritten by the rich `buildReviewPayload()` because the deferred enrich job crashed before building it

LOCAL FIX:
Stopped classifying DOWNSTREAM_FUNCTION_FAILED as a safe/optional enrich outcome (routes to the existing real-failure path instead); preserved the original downstream error text instead of discarding it; made the finalize_lease_extraction_for_review RPC's silent failure loudly visible instead of swallowed. All in `lease-extraction-worker/index.ts`, with regression tests added.

REMOTE ACTION REQUIRED:
Push the two pending migrations that add p_package_mode/p_financial_mode to finalize_lease_extraction_for_review (20260847000000_lease_package_runtime_p3_7.sql, 20260854000000_lease_financial_runtime_p4_7.sql) — not a full `supabase db push`, which would also activate the unrelated, separately-deferred document-intelligence-v3/v4/v6 schema.

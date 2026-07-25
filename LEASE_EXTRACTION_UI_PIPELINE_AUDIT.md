# Lease Extraction → UI Pipeline Audit

**Scope:** report-only. No code was modified, no migrations run, no deploys made. Findings are marked **CONFIRMED** (traced directly in code, by me or by a completed research pass), **PLAUSIBLE** (consistent with code but not provable without a runtime artifact), or **NEEDS RUNTIME DATA** (cannot be resolved from the repository alone — the exact artifact needed is named).

**Investigation method note:** this audit was produced by launching 7 parallel research passes covering the full pipeline. **6 of 7 failed on an API session-limit error before completing** (only the fact-mapping/validator pass finished). The remaining sections were completed via direct, targeted code reads afterward, prioritized toward the concrete Craven Wings failures. Coverage is therefore uneven by design: Sections 4–8 (field lifecycle, Craven Wings reconstruction, readiness race, mapping/validation) are deep and code-confirmed; Sections 9 and 11 (dynamic-row schema completeness, observability) are shallower and flagged accordingly. Section 13 lists what a follow-up pass should re-run.

---

## 1. Executive summary

**Architecture.** Two independent extraction pipelines exist. The **primary** pipeline is `openai_fact_ledger`: a whole-document, chunk-by-chunk LLM pass (`fact-ledger-extractor.ts`) that extracts every atomic fact it can find, followed by a deterministic mapper (`fact-field-mapper.ts`) that scores each fact against all 88 `LEASE_SCHEMA` fields and keeps the best-scoring match. The **fallback** pipeline (`legacy_hybrid`) is a combination of regex/label rule-extraction (`rule-extractor.ts`) plus a `LEASE_GROUPS`-gated targeted-LLM extractor (`llm-extractor.ts`), used only when the primary path fails acceptance criteria. For the Craven Wings document, diagnostics showed `openai_extraction_attempted: false` with `293` facts extracted and only `26` mapped — confirming the primary path ran and the fallback did not.

**Top root causes, ranked by how much wrong data they produced:**
1. **No field has a "does this evidence's TOPIC match the field's CONCEPT" check beyond keyword/label overlap and a coarse clause-category veto that only ~28% of fields even have configured.** This is the single root cause behind the broker_name, renewal_options, and tenant_signatory_name failures — text that merely *contains* a matching keyword can win a field it has no business winning, provided it clears a modest label-length score and isn't blocked by one of a small number of hand-written per-field guards.
2. **No validator anywhere checks that a derived value's input was itself trustworthy.** `annual_rent = monthly_rent × 12` runs unconditionally (`dynamicFields.js:530`) whenever `monthly_rent` has *a* value, correct or not — this is confirmed in code, not inferred.
3. **No validator exists for compound-arithmetic sentences** ("$X per SF × Y SF = $Z total") — confirmed absent from `fact-field-mapper.ts`, `candidate-decision.ts`, and `validator.ts` by direct search. `ti_allowance` has zero downstream protection regardless of which stage introduces the wrong number.
4. **The review UI becomes fully interactive (including "Approve") as soon as the `normalize` stage completes — `enrich` is dispatched as a fire-and-forget background job, not awaited.** This is confirmed directly in `lease-extraction-worker/index.ts`, not merely observed in a screenshot.
5. **Expense/CAM/Tax tabs are empty on first review by design, not by failure** — `extract-lease-expense-rules` is only invoked from the lease-**approval** action or an explicit "extract_draft" re-extraction trigger (`LeaseReview.jsx:1928-1936, 2510-2516`), never as part of the automatic upload→parse→normalize→enrich pipeline.

**Failure-type breakdown:** of the 11 Craven Wings symptoms (A–K), roughly 5 are **mapping errors** (right field, wrong evidence — broker_name, renewal_options, tenant_signatory_name, electric_responsibility's cited evidence), 2 are **validation gaps with a plausible-but-unconfirmed extraction mechanism** (monthly_rent, ti_allowance), 1 is a **derivation-without-verification bug** (annual_rent), 1 is a **schema-design gap** (responsibility_repairs cannot represent split responsibility), 1 is a **sequencing/workflow design** that reads as a bug to a reviewer (expense/CAM/tax), and 1 is an **orchestration/readiness design** (enrich race). None of the 11 are OCR-quality failures in the sense of garbled text — the underlying OCR text is clean in every case examined; every failure is downstream of correctly-read text.

**Highest-risk silent-data-loss path:** the mapping layer's per-field guard coverage (`looksLikeFieldCompatibleFact`) is a hand-maintained allowlist covering ~27 of 88 fields. Every field NOT on that list (confirmed: `ti_allowance`, `tenant_signatory_name`, most notice/date fields, most CAM-detail fields) has **zero** value-shape protection — acceptance depends solely on a keyword-length score clearing `MIN_LABEL_SCORE = 3`. This is a structural gap, not a per-field bug, and it will keep producing new failures on new documents until it's addressed systematically rather than field-by-field.

---

## 2. End-to-end sequence diagram

```
React upload (src/components/.../FileUploader or LeaseUpload page)
  │
  ▼
Storage upload (Supabase Storage) — file bytes land in a bucket
  │
  ▼
upload-handler / confirm-upload / ingest-file (edge functions)
  │  writes: uploaded_files row (status, module_type, storage path)
  │  writes: pipeline_jobs row (stage: "parse", status: "queued")
  ▼
lease-extraction-worker  — stage = "parse"  (index.ts ~line 155 onward)
  │  logger.event("parse","started") → pipeline_logs
  │  Azure Document Intelligence call → raw analyzeResult
  │  azure-layout-adapter.ts normalizes → DoclingOutput { text_blocks, tables, fields, full_text }
  │  logger.event("parse","completed") (line 333, line 1912)
  │  on success: currentStage = "normalize" (line 1921), same invocation continues
  ▼
lease-extraction-worker  — stage = "normalize"  (line 1924 onward)
  │  logger.event("normalize","running") (line 1963)
  │  runs openai_fact_ledger (primary) — fact-ledger-extractor.ts chunks the doc,
  │    one independent LLM call per chunk, then fact-field-mapper.ts maps facts → fields
  │  (fallback path — legacy_hybrid — only runs if primary fails acceptance:
  │    rule-extractor.ts + llm-extractor.ts's LEASE_GROUPS-gated calls)
  │  writes: uploaded_files.ui_review_payload, uploaded_files.extraction_data
  │  pipeline_jobs row for THIS job → status: "completed"  (line 2123-2135, CONFIRMED)
  │  logger.event("normalize","completed") (line 2137)
  │  ── enqueues a SEPARATE "enrich" job (enqueueEnrichmentJob, line 2152) and RETURNS ──
  │  return jsonResponse({ stage: "normalize", status: "completed" })  (line 2158)
  │
  │  <<< AT THIS POINT the file's overall status can already read "review_required" —
  │      the Lease Review UI can load and "Approve" can be enabled. Enrich has not
  │      started yet. See Section 6. >>>
  ▼
lease-extraction-worker  — stage = "enrich"  (line 2161 onward, separate invocation)
  │  logger.event("enrich","running") (line 2168)
  │  calls normalize-pdf-output in mode:"enrich" (evidence/page-link resolution only,
  │    per the friendly failure message at line 2185: "some source page references
  │    could not be linked, but all core lease terms were successfully extracted")
  │  on failure classified as transport-only → completeEnrichmentWithWarning(),
  │    job still "completed", uploaded_files.ui_review_payload.enrichment_status="failed"
  │    but core payload untouched (Guarantee 7, line 2204-2207)
  │  on success → pipeline_jobs "completed" (line 2254-2265)
  ▼
Lease Review UI (src/pages/LeaseReview.jsx)
  │  reads via src/lib/leaseFieldResolver.js's resolveLeaseField() fallback hierarchy
  │  normalizes via src/lib/leaseReviewFieldNormalizer.js's normalizeStandardFields()
  │  renders via src/components/lease-review/LeaseReviewTabTable.jsx
  ▼
review-approve edge function (on "Approve Lease Abstract" click)
  │  writes approved_lease_abstracts.snapshot_json
  │  triggers leaseRulePipelineService.generateLeaseExpenseRulesForLease()
  │    (source: "approve_abstract") — THIS is when extract-lease-expense-rules
  │    first runs for most documents (see Section 5-J)
```

**Retry/fallback behavior confirmed in code:** `reconcileDurableNormalize()` and equivalent parse-side reconciliation logic (lines 1618-1912) exist specifically to avoid re-running an already-durable stage after a worker restart/crash — the code has generation-ID fencing (`job.generation_id` checked against `uploaded_files.active_generation_id`, line 2219-2220) precisely so a stale/superseded worker invocation cannot overwrite a newer generation's state. This is mature, defensive orchestration code — the race condition in Section 6 is a **design choice** (enrich is out-of-band), not a bug in this fencing machinery.

---

## 3. Source-of-truth map

| Data type | Authoritative source | UI reads |
|---|---|---|
| Raw OCR text | `DoclingOutput.full_text` / `text_blocks` (from `azure-layout-adapter.ts`), not persisted as its own durable row per document in every path examined | Never directly — only through downstream extraction |
| Normalized document | `docling` object passed in-memory through the pipeline for a single job run | Never directly |
| Facts (fact-ledger) | Transient — produced by `fact-ledger-extractor.ts` per chunk, consumed immediately by `fact-field-mapper.ts` within the same function call. **No evidence found of a durable per-fact table** (e.g. no `extracted_facts` row per fact was located in the migrations searched) — facts appear to live only in the JSON response shape returned by the mapper, not as individually queryable rows. **NEEDS RUNTIME DATA to confirm**: check whether `openai_facts_extracted_count`/`293` facts are persisted anywhere queryable, or only counted and discarded except for the ~26 that mapped. |
| Candidates | Same as facts — transient, scored in `scoreFactAgainstField()`, not confirmed as a durable table. `rejectedCandidates`/`unmappedFacts` are returned in the mapper's result shape and apparently surfaced through `extractionDebug` diagnostics, not a queryable candidates table. |
| Selected/mapped fields | `uploaded_files.extraction_data` and `uploaded_files.ui_review_payload` (JSON columns) | **Yes** — this is what `leaseFieldResolver.js`'s fallback hierarchy reads first |
| Evidence (sourceText/page/confidence) | Embedded inline with each field inside `ui_review_payload`/`extraction_data`, not a separate evidence table in the paths examined | Yes, via the same payload |
| Expense rules | `lease_expense_rule_review_workflow` migration confirms a dedicated table/workflow exists (`20260602183000_lease_expense_rule_review_workflow.sql`) | Only after `generateLeaseExpenseRulesForLease` has run (post-approval or explicit draft trigger) |
| Rent schedules | `20260850000000_lease_base_rent_schedule_candidates_p4_3.sql` and `20260516153000_rent_schedule_authority_and_permission_fix.sql` confirm migrations exist. Per prior work this session, the associated `lease-financial-schedule/` module was found **dormant** (`LEASE_FINANCIAL_SCHEDULE_MODE` defaults to `"off"`, no production code path constructs its inputs). **NEEDS RUNTIME DATA**: confirm current `LEASE_FINANCIAL_SCHEDULE_MODE` value in the live environment and whether these migrations' tables have any real rows. |
| Review rows (per-field review state) | `field_reviews` (referenced as `lease?.extraction_data?.field_reviews` in `leaseReviewFieldNormalizer.js:498`) | Yes, merged into the resolved row's `review` state |
| Approved snapshot | `approved_lease_abstracts.snapshot_json`, written by `review-approve` | Read preferentially in "canonical" mode by `leaseFieldResolver.js` (its fallback hierarchy puts this FIRST for canonical/downstream consumers, LAST-preferred for the reviewer-facing "display" mode, which instead prioritizes the live workflow payload — confirmed at `leaseFieldResolver.js:787-840`, two distinct `fallbackHierarchy` orderings for `mode:"display"` vs `mode:"canonical"`) |

**Does the UI ever read stale cached state?** Confirmed risk exists structurally: `leaseFieldResolver.js`'s "display" mode fallback hierarchy has **17 distinct data sources** it tries in order, several explicitly labeled as "legacy fallback" (line 788-790: "Top-level columns remain only as a legacy fallback when no workflow payload exists"). If a newer generation's payload write is incomplete or delayed, the resolver can silently fall through to an older/legacy source without any generation-ID check at the resolver layer itself (generation fencing was only confirmed at the **backend write** layer, line 2219-2220 — not at the **frontend read** layer). **NEEDS RUNTIME DATA**: a side-by-side comparison of `uploaded_files.active_generation_id` against whatever generation the displayed field's evidence actually originated from, for a document with more than one extraction attempt.

---

## 4. Field lifecycle

### monthly_rent

| Stage | Input | Output | Code path | Confidence | Evidence | Possible failure | Confirmed? |
|---|---|---|---|---|---|---|---|
| Document | Rent Addendum table (Months/Base Rent PSF/Base Rent Per Month, 8 rows) AND Exhibit B grease-trap sentence (contains literal phrase "monthly rent" adjacent to an unrelated $174.55 surcharge) | — | PDF pages 14, 21 | — | — | Two candidate sources for the same field, one correct, one a false-positive keyword match | Document text confirmed by direct read |
| Fact extraction | Chunked document text | Fact(s) tagged rent-related | `fact-ledger-extractor.ts` (chunk-independent LLM calls) | 0.0-1.0 model-reported | chunk text | If Exhibit B and the Rent Addendum land in different chunks (likely, ~7 pages apart), the model extracting the Exhibit B chunk has no competing context and may tag $174.55 as rent-adjacent | PLAUSIBLE — not runtime-confirmed which chunk produced the winning fact |
| Rule fallback (if triggered) | Same text | Regex/label match | `rule-extractor.ts` `extractViaPatterns`/`extractViaLabels` against `monthly_rent`'s patterns (schemas.ts:480-487) | 0.88/0.92 hardcoded | matched substring | Traced directly: the 4 explicit regex patterns require strict label→number→suffix or number→suffix adjacency; the grease-trap sentence's literal wording ("...$174.55 and will be added to the monthly rent effective...") does NOT satisfy any pattern's adjacency requirement under direct regex trace | CONFIRMED the regex patterns don't match this exact sentence — rule-path is NOT the likely source |
| Mapping | Facts vs. `monthly_rent` field | Best-scoring fact selected | `fact-field-mapper.ts` `scoreFactAgainstField`/`looksLikeFieldCompatibleFact` (184-193 per completed audit pass) | integer keyword score | fact's sourceText | Confirmed by completed audit: `monthly_rent`'s shape guard excludes %/escalation/holdover language but has **no exclusion for a surcharge/amortization sentence that merely contains the phrase "monthly rent"** | **CONFIRMED gap in code** |
| Table extraction (if table detected) | Rent Addendum table | monthly_rent from "Base Rent Per Month" column | `rule-extractor.ts extractFromKeyValueTables`, or the session's newly-added `extractRentScheduleFromTables` (not yet deployed) | 0.82-0.90 | table row text | "Base Rent Per Month" IS a listed `tableHeader` alias for `monthly_rent` (schemas.ts:479) — if Azure detected this as a real table, a correct value was available. Diagnostic `azure_table_count: 1` for a 26-page, 4-table document is suspicious | **NEEDS RUNTIME DATA**: the actual `docling.tables` array for this document, to confirm whether the Rent Addendum was recognized as a table at all |
| Persisted | Selected field | `monthly_rent: 174.55` | `extraction_data`/`ui_review_payload` | as above | grease-trap sentence | — | Confirmed as the actual displayed value (screenshot) |
| Display | Resolver read | $174.55, "Auto-filled", 99% | `leaseFieldResolver.js` | passthrough | passthrough | No resolver-level cross-check exists comparing this value against the Rent Addendum's own table text even if both are present in the payload | CONFIRMED absent — no such cross-check found |

### annual_rent

| Stage | Input | Output | Code path | Confidence | Evidence | Failure |
|---|---|---|---|---|---|---|
| Derivation | `monthly_rent = 174.55` (whatever its value, right or wrong) | `annual_rent = 174.55 × 12 = 2094.60` | `src/components/lease-review/utils/dynamicFields.js:530`: `derivationTrace: annual_rent = monthly_rent (${monthlyRent}) x 12`, `extractionStatus: "calculated"` | none (derived) | none (derived) | **CONFIRMED in code**: this derivation runs whenever `annual_rent` is missing/absent and `monthly_rent` has *any* value — there is no check that the input was independently verified, no comparison against a separately-stated annual figure if one exists elsewhere in the document, no confidence penalty communicated beyond the generic "Calculated" extraction-mode label |
| Display | Derived value | "$2,094.60", "Needs Review", Extraction Mode "Calculated", confidence "-" | `resolveLeaseReviewExtractionMode()` (`leaseReviewFieldNormalizer.js:383`) | correctly shows no confidence number for a derived value | derivation trace string | The UI's "Needs Review" status is the only signal a reviewer gets that this number is downstream of another field — nothing flags that its parent (monthly_rent) is itself wrong |

### ti_allowance

| Stage | Input | Output | Code path | Confidence | Evidence | Failure |
|---|---|---|---|---|---|---|
| Document | "$24.00 per square foot... $24.00 x 2,848 buildable square feet = $68,352.00 Tenant Improvement Allowance." | — | Exhibit B, page 21 | — | — | Compound arithmetic sentence with 3 numbers (24, 2848, 68352); correct answer is the LAST (total) |
| Field definition | — | Description explicitly gives this near-verbatim worked example demanding the TOTAL | `schemas.ts:816-826` — `ti_allowance` has `labels`/`tableHeaders` but **no `patterns`** | — | — | Description-level guidance is LLM-prompt-only; it cannot be enforced by any regex, since there are no `patterns` for this field |
| Extraction | Same sentence | `2848` (the bare SF count, not rate, not total) | Either `extractViaLabels()` (rule path, capture-until-next-label logic) or fact-ledger LLM extraction | — | full or partial sentence | **NEEDS RUNTIME DATA** to pin the exact stage; both are structurally capable of grabbing the wrong number from a 3-number sentence |
| Mapping/validation | Fact/candidate with value=2848 | Accepted unconditionally | `fact-field-mapper.ts` | score ≥ `MIN_LABEL_SCORE` | — | **CONFIRMED (completed audit pass)**: `ti_allowance` is not among the ~27 fields with a shape guard in `looksLikeFieldCompatibleFact`; `candidate-decision.ts` and `validator.ts` were searched directly and contain **no code referencing `ti_allowance` at all** — zero downstream protection regardless of which stage produced the wrong number |

### expiration_date

| Stage | Input | Output | Code path | Confidence | Evidence | Failure |
|---|---|---|---|---|---|---|
| Document | Commencement date is FORMULAIC (no explicit calendar date anywhere: "one day after four months from the Effective Date... or... after receipt of the Tenant's Certificate of Occupancy"); term is 86 months from that undated commencement; the only bare "Date: 9/8/20" lines in the document are on the signature/guaranty block (pages 12-13, tenant and guarantor signature dates) | — | pages 1, 12, 13 | — | — | No genuine expiration_date exists anywhere in the document body — it can only be correctly computed once commencement_date is known, and commencement_date itself should be null per the field's own formulaic-date guard (schemas.ts `term_dates` group hint, confirmed present this session) |
| Extraction/mapping | A "Date: 9/8/20" line | `expiration_date = 2020-09-08` | Not fully traced this pass | Shown as "Explicit", 98% | "Date: 9/8/20" | **NEEDS RUNTIME DATA/further code read**: the exact fact/candidate record and its `sourcePath`, to determine which specific "Date:" occurrence among the ≥2 in the document (tenant signature, guarantor signature) got mapped to `expiration_date` specifically rather than `lease_date` or a signature-date field, and why a date-role check didn't intervene. Confirmed by the completed audit pass: **no date-role validator exists anywhere in `validator.ts`** (`validateDate()` only checks ISO shape and a 1900-2200 year window, `validator.ts:51-75`) — so nothing in the codebase would have stopped this regardless of the exact mechanism. |

### broker_name

| Stage | Input | Output | Code path | Confidence | Evidence | Failure |
|---|---|---|---|---|---|---|
| Document | Section 15(iii) reletting-damages clause: "...brokerage commissions, advertising costs, attorney's fees, and economic incentives..." | — | page 8 | — | — | A remedies/damages clause listing several cost categories, one of which is brokerage commissions |
| Mapping (fact-ledger→mapper path) | Fact with sourceText from this clause | Should be REJECTED | `looksLikeFieldCompatibleFact` — confirmed (completed audit) `broker_name` IS one of the ~27 guarded fields, and its guard "rejects reletting/damages/attorneys/repairs language" | — | full clause text contains all of "reletting", "damages", "attorney's fees" | If this path processed the fact, it **should have rejected it** per the confirmed guard description — meaning the value likely did NOT arrive via this path |
| Frontend display validation | value="advertising costs", sourceText=the clause | NOT rejected | `leaseFieldResolver.js`'s `isValidEntityField()` — **directly traced by me against this exact value/sourceText** | — | — | **CONFIRMED**: none of the function's blocklist regexes (stopword set, date/phone patterns, "assumes in full"/"prior written consent" phrase, leading-word check, the `may/shall/without/consent/transfer/assign/.../brokerage fees?` keyword list, sentence-punctuation check, or the `clausePattern` clause-language check) match "advertising costs" as a value OR this specific sentence's exact wording as sourceText ("brokerage commissions" ≠ the blocklisted "brokerage fees"; "costs of reletting" isn't a blocklisted phrase). The value slips through purely because this document's specific word choices don't happen to hit the hardcoded trigger words. |
| Conclusion | — | — | — | — | — | This is a **mapping bug** if it came via a path that bypasses `looksLikeFieldCompatibleFact` (e.g. `rule-extractor.ts`'s `extractViaLabels`, which does not consult that function at all — it's fact-field-mapper-specific), compounded by a **validation gap** at the frontend resolver layer regardless of origin. **NEEDS RUNTIME DATA**: the field's actual `sourcePath`/`sourceProvider` to confirm which pipeline produced it. |

### renewal_options

Same structural pattern as broker_name: `looksLikeFieldCompatibleFact` guards this field (236-240 per completed audit, "rejects bare percentage values... requires renew/option/extend language") — the Section 10 surrender clause ("all carpets to be cleaned") contains none of "renew"/"option"/"extend", so if this fact-ledger path processed it, it too should have been rejected. Its presence in the UI again points to either a non-mapper path, or the frontend resolver reading an unvalidated fallback source. **NEEDS RUNTIME DATA** to close the loop.

### tenant_signatory_name

| Stage | Input | Output | Code path | Confidence | Evidence | Failure |
|---|---|---|---|---|---|---|
| Document | Section 29: "This Lease may not be modified in any manner other than by agreement signed by all parties hereto or their successors in interest." (boilerplate amendment clause) vs. the actual signature block (pages 12-13: "By: [illegible] / Its: PRESIDENT") | — | pages 10, 12-13 | — | — | Real signatory name is only present as an illegible handwritten signature — there is no clean typed name anywhere for this field |
| Mapping | — | **No dedicated guard exists** | `looksLikeFieldCompatibleFact` — confirmed by completed audit: `tenant_signatory_name` is NOT among the ~27 guarded fields; "the name never appears in this function" | — | — | **CONFIRMED gap** |
| Frontend display validation | value="signed by all parties hereto or their successors in interest" | NOT rejected | `leaseFieldResolver.js`'s `isValidEntityField()` — **directly traced by me** | — | — | **CONFIRMED**: every blocklist check was tested against this exact phrase and none fire. The value doesn't start with a leading stopword ("signed" isn't in `{or,and,in,of,the,by}`), contains none of the `may/shall/without/consent/transfer/assign/warrants/represents` keywords, has no sentence-ending punctuation or digit pattern, and the `clausePattern` check (tested against both value and full sourceText) requires the exact phrase "successor by merger" — this document says "successors in interest," a different phrase that doesn't match. |
| Conclusion | — | — | — | — | — | Double gap: no backend shape guard for this field at all, and the frontend's blocklist-style validator has a specific hole for this exact boilerplate phrasing. This is the cleanest, most fully-confirmed finding in this audit — verified end-to-end without needing runtime data. |

### responsibility_repairs

Confirmed by completed audit: this field IS covered by a shared responsibility-block guard in `looksLikeFieldCompatibleFact` (274-278), requiring `valueLooksLikePartyResponsibility()`. The UI's flat "landlord" value is not primarily a mapping bug — it is a **schema-design gap**: the field is a single enum (`landlord`/`tenant`/`shared`/`landlord_with_cap`) with no way to represent the lease's actual structure (Section 9: tenant repairs most interior systems including a landlord-arranged-but-tenant-paid HVAC carve-out; Section 11: landlord repairs only foundation/roof/structure). Whichever single clause happened to win the field's one slot determined the entire displayed answer.

### insurance_responsibility / electric_responsibility

`electric_responsibility` has **no guard** in `looksLikeFieldCompatibleFact` (confirmed by completed audit — it is not part of the shared responsibility regex group, which covers only `responsibility_utilities`). A narrower check exists one layer down in `candidate-decision.ts`'s `semanticPolicyFindings` (lines 145-149 per completed audit, "rejects repair-only electrical wording lacking a utility-payment anchor"). Whether Section 9's repair-clause text ("Tenant shall keep and maintain in good order... heating and air conditioning equipment") actually trips that specific reject was **not independently re-verified against the exact clause text in this pass** — flagged as **NEEDS FOLLOW-UP CODE READ** (read `candidate-decision.ts:139-149` against this exact sentence).

### tax responsibility alias pair (`tax_responsibility` / `responsibility_taxes`)

Already fixed earlier this session: `leaseFieldResolver.js`'s `FIELD_ALIASES` previously cross-aliased `responsibility_taxes → tax_responsibility` but not the reverse, so the `tax_responsibility`-keyed UI row could never see data stored under `responsibility_taxes`. This was corrected in this session (both directions now alias each other). Confirmed via test run at the time: 104+118 relevant tests passing after the fix.

### expense/CAM rule rows

See Section 5-J — this is a workflow-sequencing finding, not a per-field mapping bug. Covered in depth there.

---

## 5. Craven Wings failure reconstruction

**A. $174.55 mapped to monthly_rent** — Stage: mapping (fact-field-mapper), compounded by a possible table-detection failure upstream. Responsible function: `scoreFactAgainstField`/`looksLikeFieldCompatibleFact` (monthly_rent's guard has no surcharge-exclusion). Why validators didn't stop it: no rule anywhere rejects a value whose sourceText frames the number as an *addition to* rent rather than the rent itself. Later overwritten or preserved: preserved — it is the final displayed value. Minimal evidence to confirm: the actual fact/candidate record's `sourceText` and `chunkIndex`, and the `docling.tables` array to check whether the Rent Addendum was ever detected as a table at all (`azure_table_count: 1` for this document is the single most suspicious diagnostic number in this whole audit).

**B. annual_rent calculated from $174.55** — Stage: downstream derivation, **fully confirmed in code** (`dynamicFields.js:530`). Responsible function: the `annual_rent` derivation branch. Why validators didn't stop it: the derivation has no precondition checking the input's trustworthiness — it is unconditional given "monthly_rent has some value." Not overwritten — this is a live, correct-per-its-own-logic recomputation of a wrong input. Minimal evidence needed: none — this is fully confirmed by static code alone.

**C. 2,848 mapped as TI allowance instead of $68,352** — Stage: extraction (rule-label capture or LLM fact extraction — undetermined which), **compounded by a fully-confirmed total absence of any downstream validator** for this field anywhere in the codebase. Responsible function: unclear which extractor produced the value; confirmed that neither `fact-field-mapper.ts`, `candidate-decision.ts`, nor `validator.ts` contain any code path that would have caught it regardless. Minimal evidence needed: the raw fact-ledger LLM response for the chunk containing Exhibit B (to see whether the model itself returned 2848, or whether a downstream numeric-parsing step selected the wrong captured group from a correct LLM response).

**D. Signature date mapped as expiration date** — Stage: not fully traced to a specific function this pass. Confirmed: no date-role validator exists anywhere (`validator.ts`'s `validateDate()` only checks format/year-range). Minimal evidence needed: the specific fact/candidate record and its category tag, to see whether a "Date:" occurrence near the signature block was tagged with a rent/lease-term category that then got mis-scored against `expiration_date`, or whether it arrived via a different path entirely.

**E. "advertising costs" mapped as broker name** — Stage: most likely NOT the fact-ledger→mapper path (that path's `broker_name` guard should have rejected this sourceText per its confirmed reletting/damages/attorneys exclusion list). Confirmed instead: the frontend's `isValidEntityField()` blocklist, directly traced against this exact value and sourceText, does not reject it either — a second, independent gap. Minimal evidence needed: the field's `sourcePath`/`sourceProvider` in the actual payload, to identify which of the two (or more) extraction paths actually produced this value.

**F. "all carpets to be cleaned" mapped as renewal option** — Same structural finding as E: `renewal_options`'s mapper-layer guard should have rejected surrender/holdover language per its confirmed requirement for renew/option/extend keywords. Minimal evidence needed: same as E.

**G. Sentence fragment mapped as tenant signatory** — **Fully confirmed, no runtime data needed.** No backend shape guard exists for this field at all, and the frontend's blocklist validator was directly traced and confirmed not to catch this exact boilerplate phrasing ("signed by all parties hereto or their successors in interest" doesn't trip any of its ~8 regex checks). This is the single most solidly-closed-loop finding in the audit.

**H. Repair responsibility reduced to landlord** — **Schema-design gap, not a mapping bug**, confirmed: `responsibility_repairs` is a single flat enum field with no way to represent per-component split responsibility. Whichever clause won the field's one slot (Section 11, landlord's narrow foundation/roof duty) determined the display, discarding Section 9's much larger tenant-repair scope.

**I. Electric responsibility uses repair evidence** — Partially confirmed: no shape guard exists for `electric_responsibility` in the mapper's main guard function; a narrower check exists in `candidate-decision.ts`'s semantic policies but whether it actually fires against this specific clause's exact wording was not independently re-verified this pass. **Needs follow-up code read** against the precise Section 9 sentence.

**J. Expense/CAM/tax tabs show no rows** — **Fully confirmed, no runtime data needed, and NOT a pipeline failure.** `extract-lease-expense-rules` is invoked only from `LeaseReview.jsx`'s approval-flow (`source: "approve_abstract"`, lines 1928-1936) or an explicit "extract_draft" re-extraction trigger (lines 2510-2516) — never automatically during upload→parse→normalize→enrich. A reviewer seeing empty tabs on first load is seeing the pipeline working exactly as designed, not a broken extraction. This reads as a bug to a reviewer but is a workflow-sequencing/UX-communication issue.

**K. UI becomes reviewable while enrich is still running** — **Fully confirmed, no runtime data needed.** `lease-extraction-worker/index.ts` lines 2123-2158: the `normalize` stage's own `pipeline_jobs` row is marked `status: "completed"` and the function returns success immediately after *enqueuing* (not awaiting) a separate `enrich` job. `POST_NORMALIZE_STATUSES` (line 1318) includes `"review_required"` as a status reachable at/after normalize — meaning the file-level status that unlocks the review UI is not gated on enrich's completion at all. This is confirmed by design intent, not just observation: enrich is explicitly scoped to evidence/page-link resolution (per its own friendly failure message), not core field value determination, so the design choice is architecturally defensible — but it does mean a reviewer can be looking at and approving a lease abstract while a background process is still potentially finishing evidence-linking work.

---

## 6. Pipeline readiness and race-condition audit

**When is `review_required` set?** At or immediately after `normalize` stage completion (confirmed: `POST_NORMALIZE_STATUSES` includes it; the `normalize` stage handler completes and returns without waiting on `enrich`).

**Is `review_handoff` marked complete before enrich?** By the evidence above, yes — enrich is dispatched asynchronously (`enqueueEnrichmentJob`, line 2152, plus a defensive re-check at 2146-2153) after normalize's own job row is already `"completed"`.

**Can enrich still be running while review is accessible?** **Yes, confirmed.** This is the direct, intended consequence of the async-dispatch design above, not merely a timing accident.

**Does the frontend poll incomplete data?** Not independently confirmed this pass whether `LeaseReview.jsx` gates the "Approve" button on anything beyond the file's overall status. **NEEDS FOLLOW-UP**: read `LeaseReview.jsx`'s readiness-check logic directly (the earlier agent pass that was assigned this failed before completing).

**Are stale/partial review payloads cached?** Structural risk confirmed at the resolver layer (Section 3) — 17-source fallback hierarchy with no generation check at the read layer, though generation fencing does exist at the write layer.

**Is approval enabled prematurely?** Not fully confirmed — `review-approve`'s own gating logic (does it require all `requiredForApproval` fields to be valid?) was not read this pass. **NEEDS FOLLOW-UP.**

**Are stage transitions atomic?** Confirmed: `pipeline_jobs` row updates use targeted `.update()` calls keyed on `job.id`, with generation-ID checks before overwriting `ui_review_payload` (line 2219-2220) — this part of the system is well-engineered.

**State-machine table (partial — confirmed transitions only):**

| State | Allowed next states | Required completed stages | UI behavior | Approval allowed? |
|---|---|---|---|---|
| `queued` (parse) | `parse running` → `pdf_parsed` / `parse_failed_manual_review` | none | Not reviewable | No |
| `pdf_parsed` / normalize queued | `normalize running` → `review_required` / `normalize_failed_manual_review` | parse | Not reviewable | No |
| `review_required` | stays `review_required` while enrich runs async; can move to `validated`/`approved` | **normalize only** — NOT enrich | **Fully reviewable, confirmed** | **Yes, confirmed** — not gated on enrich |
| enrich (background, parallel to the row above) | `completed` / `completed_with_warnings` / job-level `failed` (core payload untouched, Guarantee 7) | — | Timeline panel shows "running"/"failed"/"completed" independently of the file's own review-readiness | N/A — doesn't gate approval |
| `approved` | (expense-rule extraction triggers here) | review_required + explicit user approval action | Read-only / snapshot view | — |

---

## 7. Mapping audit

*(This section is the completed research pass's finding, reproduced faithfully — see that pass's full output for line-level detail; summarized here.)*

**Label scoring**: base score = the character length of the single longest matching label/alias substring (not a count, not summed) — `fact-field-mapper.ts:307-315`. Labels and `field-contract.ts` aliases are pooled into one undifferentiated array with no separate weighting.

**Category-verified bonus**: +10 only when the classified clause category matches an `allowedClauseCategories` entry (`:326`).

**Cross-domain penalty**: category present but not allowed/rejected → score halved via `Math.floor(score/2)`, not zeroed (`:327`) — explicitly a soft penalty, not a hard block.

**Field-specific exact-match bonuses**: +12 for `annual_rent`/`monthly_rent` when the value matches a dedicated `sourceAnnualRentAmount()`/`sourceMonthlyInstallmentAmount()` checker; +12 for `tenant_name`/`landlord_name` when an explicit "herein called Tenant/Landlord" role label is present (`:329-331`).

**Generic-label penalty**: does not exist as a scoring mechanism — the "administrative fee vs. late fee" mitigation mentioned in code comments is actually the *categorical hard-veto* (Section 8), not a scoring adjustment.

**Value-shape guards (`looksLikeFieldCompatibleFact`)**: cover ~27 of 88 fields (`broker_name`, `renewal_options`, `property_address`, `monthly_rent`, `annual_rent`, `tenant_name`/`landlord_name`, the shared responsibility-fields block, and others — see Section 4's per-field detail for exact coverage/gaps on the fields this audit examined). Every other field has zero shape screening.

**Tie-breaking**: `bestScore` comparison first, `fact.confidence` second (`:472-478`) — confirmed no other tie-break dimension exists.

**Cross-domain blocking**: only via the clause-category veto in `candidate-decision.ts`, and only for the ~28% of fields with `evidencePolicy` configured.

**Fields confirmed able to accept wrong-shape content:** any field not in the ~27-field guard list (confirmed directly for `ti_allowance` and `tenant_signatory_name`; strongly implied for most notice/date/CAM-detail fields by the same absence).

---

## 8. Validation audit

*(Completed research pass's gap table, reproduced faithfully.)*

| Category | Status | Location |
|---|---|---|
| Person-name validation | Partial | `validator.ts` `looksLikePersonNotEntity()` (396-408) + cross-field sanity (319-388) — only demotes `tenant_name`/`landlord_name`, only with explicit signature-line evidence |
| Organization-name validation | Partial | `validator.ts` `ENTITY_FIELDS` (188-193) + `sanitizeLeaseFieldValue()` (184-270) — entity-suffix only required in a narrow deposit-context branch |
| Currency-role (monthly/annual/one-time) | Partial | Only a monthly×11>annual heuristic swap (322-335); no other charge field covered |
| Date-role (commencement/expiration/signature) | **Not present** | `validateDate()` (51-75) — format/year-range only |
| Boolean operative-language | Partial | `validateBoolean()` keyword coercion (77-86); conditional/discretionary detection lives only in `candidate-decision.ts` (151-159), a different module |
| Renewal-grant language | **Not present** | Only guard is `fact-field-mapper.ts:236-240` |
| Responsibility actor/action/cost-bearer | **Not present** in `validator.ts` | Lives entirely in `fact-field-mapper.ts:120-133` and `candidate-decision.ts:139-149` |
| Base-rent vs. additional-charge/surcharge | **Minimal** | Same monthly/annual swap check only; nothing distinguishes base rent from a CAM/parking/admin surcharge phrased near "rent" — **this is the exact gap behind Craven Wings finding A** |

**Gap table (validators needed):**

| Validator needed | Fields affected | Current behavior | Risk | Recommended location |
|---|---|---|---|---|
| Surcharge-vs-base-rent discriminator | `monthly_rent`, `annual_rent` | No exclusion for "added to the rent" phrasing | A surcharge can win the base-rent field, corrupting rent roll/budget baselines | `looksLikeFieldCompatibleFact` (fact-field-mapper.ts) or a `rejectedEvidencePatterns` entry on `monthly_rent` |
| Compound-arithmetic total-selector | `ti_allowance` | No code references this field in any validator | Any of 3+ numbers in a formula sentence can win | New guard in `looksLikeFieldCompatibleFact`, or a cross-field check in `validator.ts` |
| Date-line-role discriminator | `start_date`/`end_date`/`commencement_date`/`expiration_date`/signature dates | Only `resolveLeaseTermDatePair()` disambiguates exactly 2 term-tagged dates; signature dates aren't covered | Signature-block dates can win a term-date field | `validator.ts`'s `normalizeLeaseContextualFields()` (410-451) or a new guard |
| Entity-name coverage for `tenant_signatory_name`/`landlord_signatory_name` at the mapper layer | These 2 fields | `ENTITY_FIELDS` covers them in `validator.ts` (188-193) but `looksLikeFieldCompatibleFact` doesn't guard them separately from generic scoring | Boilerplate clause fragments can win before entity validation even runs | Add to `looksLikeFieldCompatibleFact`'s guard list |

**Confirmed architectural note:** entity-name validation is duplicated (not display-only) between `validator.ts` (backend, runs at mapping time) and `leaseFieldResolver.js` (frontend, display time) — both use an identically-named `ENTITY_FIELDS` set. The true "display-time-only" gaps are narrower: `leaseFieldResolver.js`'s `invalidResolvedField()` has property_name/permitted_use/lease_term/cam_amount checks with no backend equivalent (478-524).

---

## 9. Dynamic-row and repeated-record audit

*(Shallow pass — the dedicated research agent for this section failed before completing; findings below are from migration-file names and general session knowledge only, not a full schema read.)*

| Concept | Current flat field | Dynamic-row support found | Information lost | Migration needed? |
|---|---|---|---|---|
| Full rent schedules | `monthly_rent`/`annual_rent` (scalars) | Migrations exist (`lease_base_rent_schedule_candidates_p4_3.sql`, `rent_schedule_authority_and_permission_fix.sql`) but the associated `lease-financial-schedule/` module was confirmed **dormant** earlier this session (`LEASE_FINANCIAL_SCHEDULE_MODE` defaults off, no production writer) | Every period/rate pair beyond the one winning scalar | Likely no NEW migration needed — the schema may already exist; the gap is a missing **production writer**, not a missing table. **NEEDS RUNTIME DATA**: current `LEASE_FINANCIAL_SCHEDULE_MODE` value |
| Option/renewal terms | `renewal_options` (string) | None found this pass | The Option Term Addendum's 3 terms × 5 years × 2 rate columns entirely collapse to one clause-fragment string | Likely yes, unless the rent-schedule tables above can be repurposed |
| Repair responsibility by component | `responsibility_repairs` (single enum) | None found | Component-level split (foundation/roof=landlord, interior/HVAC=tenant with a carve-out) is unrepresentable | Yes |
| Insurance by policy type | Separate scalar fields per policy attribute | None found | The 3 distinct required policies (CGL, All-Risk/Special-Form, Business Interruption) aren't a repeatable row type | Yes |
| Expense rules by category | dedicated `lease_expense_rule_review_workflow` + `publish_lease_expense_rule_to_cam_workflow` migrations exist | **Yes — this one has real dynamic-row support** | Likely adequate; not independently verified against Section 4/5's exact clause complexity this pass | Not confirmed necessary |
| Consent requirements by object | Likely flat boolean/string fields (`landlord_consent`, `landlord_consent_for_transfer`) | Not confirmed | Assignment consent, signage consent, alterations consent, roofing-contractor consent all have different standards, collapsed to ~2 fields | Likely yes |
| Notice requirements | `renewal_notice_months`/`termination_notice_months` (scalars) | Not confirmed | Multiple distinct notice regimes (renewal notice, default-cure notice by default type, delivery-method rules) collapse to 2 numbers | Likely yes |
| Guaranty clauses | Generic "Clause Records"/dynamic-findings catch-all | `normalizeDynamicFindings()`/`routeDynamicRowToTab()` exist (confirmed present, not re-verified this pass) | The Exhibit D guaranty's 20 numbered provisions (liability scope, joint-and-several terms, rolling renewal) reduce to a handful of generic "Guaranty" rows with no structure | Possibly — depends on whether the catch-all mechanism can be extended with a typed sub-schema instead of a full migration |

**NEEDS FOLLOW-UP:** a dedicated read of `dynamicFields.js`, `routeDynamicRowToTab()`, and the CAM/expense-rule schema itself is required to firm up this section — this pass relied on migration filenames and prior session memory rather than direct code inspection.

---

## 10. UI audit

- **Wrong high-confidence values displayed**: confirmed structurally — confidence numbers (0.88/0.92/0.98 rule-match, 0.0-1.0 LLM self-report, or a mapper keyword-score) all flow into the same displayed "Confidence: X%" number with no indication of *which kind* of confidence it is. A 98% "rule regex matched cleanly" number and a 98% "LLM felt sure" number look identical to a reviewer, but mean different things.
- **Empty tabs**: confirmed by design (Section 5-J) — not a UI bug, a sequencing gap in reviewer-facing communication (no "expense rules haven't been extracted yet, approve first or click X" messaging was found in the tab-empty state).
- **Duplicated OR-alternate rows**: confirmed and already partially fixed this session (`tax_responsibility`/`responsibility_taxes` alias gap).
- **Unrelated evidence displayed with a value**: confirmed root cause is the mapping/validation gaps in Sections 4/5/7/8, not the UI rendering layer itself — the UI faithfully displays whatever `sourceText`/`value` pair it's given.
- **Missing validation reason**: confirmed and fixed this session — `LeaseReviewTabTable.jsx` previously computed `row.validationMessage` but never rendered it; now surfaced as an amber note under the value.
- **Rows before enrichment completes**: confirmed by design (Section 6).
- **Dynamic facts in the wrong tab**: not independently re-verified this pass (the dedicated research agent for `routeDynamicRowToTab()` failed before completing) — flagged as **NEEDS FOLLOW-UP**.

---

## 11. Observability audit

*(Shallow pass — confirmed what's already known from this session's earlier work; a dedicated deeper pass failed before completing.)*

**Confirmed existing:** `pipeline_logs` writes via `_shared/logger.ts`'s `event()` helper (`pipeline_stage:{stage}:{status}` messages); `extractionDebug` diagnostics including `openai_facts_extracted_count`, `openai_facts_mapped_count`, `llm_returned_field_details`, `merged_field_sources`, `unmapped_llm_keys`; `rejected_candidates` (surfaced via `fact-field-mapper.ts`'s return shape and read by `ExtractionDebugPanel.jsx`, per the successful mapping audit).

**Confirmed missing / recommended additions:**
- A metric for how many fields specifically were blanked by `shouldBlankUnsupportedStandardValue`'s trust gate (distinct from "never had a value") — suggested event: `field_blanked_by_trust_gate` with payload `{field_key, original_value, reason}`.
- A metric distinguishing OCR-confidence / LLM-confidence / mapper-keyword-score numerically, so a dashboard could show "this 98% was a regex match" vs. "this 98% was the model's self-report."
- A count of dynamic rows hidden by the UI's default filters (`shouldShowRow()` in `LeaseReviewTabTable.jsx`) — reviewers may never know a row existed if it never became `defaultVisible` and had no value.
- Generation-mismatch detection at the **read** layer (confirmed only write-layer fencing exists today).
- A per-document flag for "expense-rule extraction has not yet run" so the empty-tabs UX (Section 5-J) reads as expected-state rather than apparent failure.
- Table-detection diagnostics: `azure_table_count` already exists but nothing flags it as anomalously low relative to document length/page count — suggested a heuristic warning when `table_count` is far below what a document's `[[PAGE n]]`-delimited paragraph count would statistically suggest.

---

## 12. Micro-step remediation plan

### Phase 0 — diagnostics only
- **Step 0.1**: Add a log event recording each field's winning fact's `chunkIndex`/`sourcePath` alongside its value, specifically for `monthly_rent`, `ti_allowance`, `expiration_date`, `tenant_signatory_name`, `broker_name`, `renewal_options`. Files: `fact-field-mapper.ts` (add to the return shape), `normalize-pdf-output` (persist it into `ui_review_payload`). No migration. Deployment risk: none (additive logging). Tests: none required, this is diagnostics-only. Rollback: trivial (remove the added field). Definition of done: re-running Craven Wings (or an equivalent fixture) surfaces which exact chunk/path produced each of the 6 fields above.
- **Step 0.2**: Retrieve and inspect the actual `docling.tables` array for the Craven Wings document (or a fixture built from its exact PDF) to settle whether the Rent Addendum table was ever detected. No code change — this is a runtime data pull (Section 13, item 1).

### Phase 1 — stop dangerous wrong autofills
- **Step 1.1**: Add a `rejectedEvidencePatterns` entry to `monthly_rent`/`annual_rent` in `schemas.ts` rejecting sentences containing "amortiz(e/ation)", "grease trap", "added to the [monthly] rent" (i.e., rent-ADDITION language, not rent-STATEMENT language). Files: `schemas.ts`. Tests: a fixture asserting the grease-trap sentence no longer scores against `monthly_rent`. Migration: no. Deployment risk: low. Rollback: revert the regex addition. Accuracy impact: directly fixes finding A (and B by extension, once A is null instead of wrong).
- **Step 1.2**: Add a `ti_allowance`-specific guard to `looksLikeFieldCompatibleFact` requiring the captured value to be the LARGEST number in a 3+-number sentence when the sentence contains both "×"/"x" and "=". Files: `fact-field-mapper.ts`. Tests: a fixture using the exact Exhibit B sentence, asserting `68352` wins over `2848`/`24`. Migration: no. Risk: low, narrowly scoped. Accuracy impact: fixes finding C.
- **Step 1.3**: Add `tenant_signatory_name`/`landlord_signatory_name` to `looksLikeFieldCompatibleFact`'s guard list, rejecting sentences containing "modified"/"amended"/"successors in interest"/"binding agreement" absent a "By:"/signature-block anchor. Files: `fact-field-mapper.ts`. Also extend `leaseFieldResolver.js`'s `isValidEntityField` clausePattern to include "successors in interest" and "binding agreement" as reject phrases (belt-and-suspenders, since this field has zero backend guard today). Tests: fixture using the exact Section 29 sentence. Migration: no. Risk: low. Accuracy impact: fixes finding G.
- **Step 1.4**: Extend `broker_name`'s existing guard (already rejects reletting/damages/attorneys) and `renewal_options`'s existing guard (already requires renew/option language) — confirm via a fixture test using the EXACT Craven Wings sentences that they are in fact rejected by the CURRENT code, and if not, tighten the regex. This step is "verify the existing guard actually works," since this audit could not fully confirm which path bypassed it. Migration: no. Risk: none (test-only unless a gap is found).

### Phase 2 — fix canonical mapping
- **Step 2.1**: Add a date-role validator distinguishing signature-block dates from term dates, in `validator.ts`'s `normalizeLeaseContextualFields()`. Requires the source clause/label context to be available at validation time (verify it is). Tests: fixture with 2+ "Date:" lines, asserting the signature-adjacent one never wins `expiration_date`/`commencement_date`. Migration: no. Risk: medium (touches shared validation logic — regression-test broadly). Dependency: Step 0.1's diagnostics to confirm the exact current mechanism first.
- **Step 2.2**: Add the surcharge-vs-base-rent semantic check as a proper `validator.ts` cross-field rule (not just a `rejectedEvidencePatterns` regex), so it also protects the rule-extraction and LLM-fallback paths, not just the fact-ledger→mapper path. Dependency: Step 1.1.

### Phase 3 — fix repeated/dynamic records
- **Step 3.1**: Confirm whether `lease-financial-schedule/`'s existing (dormant) schema can represent the Rent Addendum's period/rate rows without a new migration; if yes, write the missing production writer (feature-flagged, `LEASE_FINANCIAL_SCHEDULE_MODE` still off by default until validated). Migration: possibly no (reuse existing dormant tables). Risk: medium — this is genuinely new production code, not a small fix. Deployment: behind the existing feature flag.
- **Step 3.2**: Design (not yet build) a typed sub-schema for repair-responsibility-by-component and insurance-by-policy-type, given both are currently unrepresentable. This is a real schema-design project, not a micro-step — flag for a separate planning pass.

### Phase 4 — fix expense/CAM pipeline
- **Step 4.1**: Add UI messaging on the Expense/CAM/Tax tabs when `extract-lease-expense-rules` has never run for this lease ("Expense rules haven't been generated yet — approve the lease abstract or click 'Extract expense rules' to populate this tab"), rather than a bare empty-state. Files: `LeaseReview.jsx`, the relevant tab-empty component. No backend change. Migration: no. Risk: none. This directly resolves the reviewer-facing confusion in finding J without touching the (working-as-designed) trigger sequencing.
- **Step 4.2** (larger, separate phase): evaluate whether expense-rule extraction should ALSO run automatically post-normalize (in parallel with enrich) rather than only at approval time, given Section 4/5 of most leases contain immediately-extractable CAM content that reviewers currently can't see until after they've already approved the abstract.

### Phase 5 — improve orchestration/readiness
- **Step 5.1**: Add a lightweight "enrichment_status" indicator to the Lease Review page itself (not just the separate Extraction Timeline panel) so a reviewer approving a lease while enrich is still running sees an explicit "evidence page-links still being resolved" note. Files: `LeaseReview.jsx`. No backend change (the data already exists in `ui_review_payload.enrichment_status`). Migration: no. Risk: none.
- **Step 5.2**: Add generation-ID checking at the frontend resolver read layer (`leaseFieldResolver.js`), not just the backend write layer, so a stale fallback-hierarchy read can be detected and flagged rather than silently displayed. Risk: medium (touches the core resolver used everywhere) — needs broad regression testing.

### Phase 6 — build evaluation harness
- **Step 6.1**: Build a small fixture-document test suite (starting with Craven Wings' exact problematic sentences, extracted as isolated test cases) that runs the full rule-extractor → fact-ledger-mock → mapper → validator chain and asserts each of the 11 findings (A–K) either resolves correctly or is explicitly nulled (never wrong). This is the natural test bed for every Phase 1/2 fix above and should be built alongside them, not after.

---

## 13. Required runtime artifacts

| Artifact | Source | Query/filter | Question it answers | Sensitive? |
|---|---|---|---|---|
| `docling.tables` raw array for Craven Wings' parse | `uploaded_files.extraction_data` or a `parse` stage debug dump, if persisted | Look for `table_count`/`tables` keyed by this file's `id` | Was the Rent Addendum ever detected as a table? (Central to finding A) | Contains lease financial terms — treat as confidential |
| The winning fact/candidate record for `monthly_rent`, `ti_allowance`, `expiration_date`, `tenant_signatory_name`, `broker_name`, `renewal_options` | `ui_review_payload`/`extraction_data` JSON, or `extractionDebug.merged_field_sources`/`llm_returned_field_details` if present | Per-field `sourcePath`/`sourceProvider`/`chunkIndex` | Which stage/path actually produced each wrong value | Same as above |
| Raw fact-ledger LLM response for the chunk containing Exhibit B | Not confirmed persisted anywhere — **may require re-running extraction with logging added (Phase 0, Step 0.1) since no durable per-fact table was found** | — | Did the LLM itself return the wrong TI number, or did a downstream parser mis-select it from a correct response? | Contains lease text sent to a third-party LLM provider |
| Current `LEASE_FINANCIAL_SCHEDULE_MODE` env value in production | Supabase project env vars | — | Is the dormant rent-schedule module still off, confirming Section 9's finding? | Not sensitive |
| `LeaseReview.jsx`'s exact "Approve" button gating logic | Source file, direct read (not yet done this pass) | — | Is approval gated on anything beyond file-level status? | Not sensitive |
| `review-approve` function body | Source file, direct read (not yet done this pass) | — | Does approval verify `requiredForApproval` fields before allowing snapshot? | Not sensitive |
| `docling.tables`/`azure_table_count` for a sample of OTHER documents | Historical `extraction_data` across multiple uploads | — | Is the apparent table-detection weakness specific to this document or systemic? | Contains other tenants' lease data — high sensitivity, aggregate/anonymize before sharing |

---

## 14. Ranked issue list

| # | Issue | Severity | Likelihood (recurs on new docs) | Fields affected | Silent-data-loss risk | Legal/financial impact | Ease of fix |
|---|---|---|---|---|---|---|---|
| P0-1 | No shape guard + no surcharge check on `monthly_rent`/`annual_rent` for "addition to rent" phrasing | P0 | High — any lease with an amortized surcharge clause | monthly_rent, annual_rent, everything derived from them (budget, rent roll) | High | Direct financial modeling error | Low (Phase 1.1) |
| P0-2 | No validator anywhere for `ti_allowance` | P0 | High — any lease with a per-SF × SF = total formula | ti_allowance | High | Direct TI budget error | Low (Phase 1.2) |
| P0-3 | `tenant_signatory_name` has zero backend guard and a frontend blocklist gap for common boilerplate phrasing | P0 | High — "successors in interest"/similar boilerplate is extremely common lease language | tenant_signatory_name (and structurally, any entity field relying only on the blocklist approach) | Medium (cosmetic but undermines document trust) | Low direct financial impact, high credibility/trust impact | Low (Phase 1.3) |
| P1-1 | No date-role validator distinguishing signature dates from term dates | P1 | Medium-high | expiration_date, commencement_date, start/end_date | Medium | Wrong lease-term dates affect renewal/critical-date tracking | Medium (Phase 2.1) |
| P1-2 | `responsibility_repairs`/insurance-by-policy schema cannot represent split responsibility | P1 | High — most commercial leases split repair responsibility by component | responsibility_repairs, related fields | Medium (information loss, not wrong-value display) | Medium — affects CAM/repair-cost allocation decisions | High (schema/migration work, Phase 3.2) |
| P1-3 | Expense/CAM/Tax tabs empty on first review with no explanatory messaging | P1 | Always, for every new lease | All expense-rule/CAM fields | Low (data isn't lost, just not yet generated) | Low direct, but erodes reviewer confidence in the tool | Low (Phase 4.1 messaging fix) |
| P1-4 | Review UI/Approve unlocked before enrich completes | P1 | Always | Evidence page-links specifically; core field values apparently unaffected | Low-medium | Reviewer may approve before evidence linking finishes | Low (Phase 5.1 messaging) |
| P2-1 | Confidence numbers from 3+ different semantic sources displayed identically | P2 | Always | All fields | Low (doesn't cause wrong values, causes miscalibrated trust) | Low | Medium (needs a schema addition to tag confidence provenance) |
| P2-2 | No generation-ID check at the frontend resolver read layer | P2 | Low-medium (only matters on re-extraction/multiple generations) | Any field, on documents re-extracted more than once | Medium if it occurs | Could show stale data as current | Medium (Phase 5.2) |
| P3-1 | `looksLikeFieldCompatibleFact`'s ~27-field guard coverage is a hand-maintained allowlist | P3 (systemic, not a single bug) | Certain to keep recurring | Every currently-unguarded field | High cumulative, low per-instance | Varies | High (requires a systematic approach, e.g. Phase 6's eval harness plus prioritized guard additions) |

---

## 15. Final recommendation

**Fix first:** Phase 1 (Steps 1.1–1.3) — these are small, narrowly-scoped, testable fixes that directly address the three highest-severity, highest-likelihood-of-recurrence findings (monthly_rent surcharge contamination, TI allowance's total-validator absence, tenant_signatory_name's double gap). None require a migration. Pair them with Phase 6's fixture harness so each fix ships with a regression test built from the exact Craven Wings sentences.

**Do not change yet:** the schema-design gaps (Phase 3.2 — repair-by-component, insurance-by-policy-type) and the expense-rule auto-trigger timing question (Phase 4.2). Both require product decisions (does the business want expense rules generated automatically pre-approval, at real infrastructure cost, versus the current on-demand model?) that shouldn't be bundled into a bug-fix pass.

**Prompt/schema changes still needed:** yes, but narrowly — the `rejectedEvidencePatterns` additions in Phase 1 are schema-level (not prompt-level) changes, consistent with this session's earlier Tier 1/Tier 2 work. No wholesale prompt rewrite is indicated by this audit; the failures found are mapping/validation-layer, not prompt-quality, issues (the underlying OCR text was clean in every case examined).

**Architecture changes required:** one real one — Section 6's enrich/review-readiness race is an architectural choice, not a bug, and changing it (making the review UI wait for enrich) would be a genuine behavior change with latency tradeoffs, not a micro-step. Recommend Phase 5.1 (surface enrichment status in the main review UI) as the low-risk interim fix, and defer the "should approval wait for enrich" question to a product discussion.

**Smallest safe next implementation slice:** Phase 0 (Steps 0.1–0.2) — pure diagnostics, zero behavior change, and it directly resolves 3 of this audit's "NEEDS RUNTIME DATA" flags (which exact stage produced the wrong `monthly_rent`/`ti_allowance`/`expiration_date` values), turning several PLAUSIBLE findings above into CONFIRMED ones before any fix is written.

---

## Deliverable summary

1. **Report path:** `LEASE_EXTRACTION_UI_PIPELINE_AUDIT.md` (repo root)
2. **10-line executive summary:** see Section 1.
3. **Top 5 P0/P1 issues:** (1) monthly_rent/annual_rent surcharge contamination — no guard exists; (2) ti_allowance has zero downstream validation anywhere in the codebase; (3) tenant_signatory_name has no backend guard and a confirmed frontend blocklist gap for common boilerplate; (4) no date-role validator distinguishes signature dates from term dates; (5) responsibility fields (repairs, insurance) are schema-flat and cannot represent real split responsibility.
4. **First recommended micro-step:** Phase 0, Step 0.1 — add per-field `chunkIndex`/`sourcePath` logging for the 6 highest-value fields, zero behavior change, turns several unconfirmed findings into confirmed ones before any fix ships.
5. **Runtime artifacts still needed:** the `docling.tables` array for this document (table-detection confirmation), the winning fact/candidate records for the 6 flagged fields (source-path confirmation), the raw fact-ledger LLM response for the Exhibit B chunk (TI allowance mechanism), the current `LEASE_FINANCIAL_SCHEDULE_MODE` value, and direct reads of `LeaseReview.jsx`'s approval-gating logic and `review-approve`'s validation — all listed in full in Section 13.

**Investigation completeness caveat, repeated from the top:** 6 of 7 dedicated research passes for this audit hit a session limit before finishing (upload/orchestration detail beyond what I re-derived directly, expense/CAM schema completeness, DB migration field-level detail, dynamic-row audit depth, and UI/observability depth). The sections built from direct verification (4, 5, 6, 7, 8) are solid. Sections 9 and 11 are shallower than the other sections and should be re-run for full depth before this audit is treated as final.

---

## 16. Micro-step 0 diagnostic results

**This section is investigation and design proposal only. No pipeline, mapper, resolver, or test code has been modified. Nothing in Parts C–G below has been implemented — it is presented for approval per the requesting instructions, and Part F (runtime re-extraction) could not be executed at all — see the callout there.**

### 16.0 — Correction to a prior "confirmed" finding (read this first)

Direct inspection this pass found that **Section 5-K and Section 6's conclusion — "the review UI/Approve becomes available as soon as `normalize` completes, not gated on enrich" — is INCORRECT as stated**, and is retracted here rather than quietly edited. What was true and what was missed:

- **True (unchanged):** `normalize`'s own `pipeline_jobs` row reaches `status: "completed"` and returns before `enrich` is awaited (`lease-extraction-worker/index.ts:2123-2158`). The file's raw `status` column can say `"review_required"` at that point, and the Lease Review **page** does become viewable then.
- **Missed:** there is a second, separate, more authoritative column — `uploaded_files.review_readiness` (distinct from raw `status`) — that is the actual approval gate, and it is enforced in three independent, mutually-reinforcing places:
  1. **Frontend:** `LeaseReview.jsx:1417-1454` — `canApprove = approvalBlockers.length === 0`, and `approvalBlockers` pushes a `review_not_ready` blocker whenever `reviewReadiness !== "ready"` (line 1425, `isReviewReady = reviewReadiness === "ready"`, line 1002).
  2. **Server, at the approval endpoint:** `review-approve/index.ts:345-348` — a comment states plainly this "is what actually prevents approving a file whose review_readiness never reached 'ready'"; the finalizer RPC is called and a non-ready result produces error_code `NOT_READY` (lines 370-373).
  3. **Database, at the write layer:** `20260824000400_lease_extraction_finalizer.sql:12-31` — a `BEFORE UPDATE` trigger (`enforce_review_readiness_ready_guard`) raises an exception if anything other than `finalize_lease_extraction_for_review()` itself tries to set `review_readiness = 'ready'`. This is not a convention, it's DB-enforced.
  - The readiness computation itself — `evaluate_lease_extraction_readiness()` (`20260824000300_lease_review_readiness.sql:82-182`) — **explicitly checks the enrich job's own `pipeline_jobs` row status** and adds a blocking reason of `ENRICHMENT_IN_PROGRESS` whenever it is `'queued'` or `'running'` (lines 167-175), and `ENRICHMENT_FAILED` when it is `'failed'`. Readiness cannot be `'ready'` while either of those blocking reasons is present.

**Reconciling this with the still-true "Guarantee 7" finding:** the graceful-degradation path (`completeEnrichmentWithWarning`, transport-only failures) marks the enrich **job** itself `"completed"` (with the warning stored separately), not `"failed"` — so *that specific class* of enrichment hiccup does not trip `ENRICHMENT_FAILED` and can still reach `"ready"`. A genuine hard enrich failure (`failJob()`, non-transport) leaves the job `"failed"` and **does** block readiness via `ENRICHMENT_FAILED`. Both of these coexist correctly with the finding above; only the "in-flight enrich never blocks approval" claim was wrong.

**Net correction:** Section 5-K / P1-4 in the ranked issue list should be **downgraded**. The review *page* can be viewed while enrich runs (this part stands, and is intentional per the `review_readiness` column's own comment: *"partial: ... reviewer may inspect for troubleshooting, but this state must never be labeled 'Ready for Review' (review_accessible is a separate concept from review_readiness)"*) — but the **Approve action itself is robustly blocked**, independently, at the frontend, the edge function, and the database trigger layer, while enrich is genuinely in progress or has hard-failed. This is one of the best-engineered parts of the whole system, not a gap. Sections 5 and 6 and the ranked issue list (Section 14, P1-4) should be read with this correction in mind; the live document text above is left as originally written, with this section as the authoritative correction, per the instruction not to silently overwrite prior findings.

### 16.1 — Part A: completed audit reads

**1. `LeaseReview.jsx` approval/readiness logic — CONFIRMED, detailed above in 16.0.** Additional findings:
- **Polling behavior — CONFIRMED:** `refetchInterval` (lines 271-274) polls the `uploaded_files` row every 4000ms *specifically while* `isLeaseReviewEnrichmentInFlight(ui_review_payload.enrichment_status)` is true, and stops polling once it isn't. So yes — the frontend actively refreshes after enrich completes; a reviewer who has the page open while enrich finishes will see the readiness state update within ~4s without a manual reload. **NEEDS FOLLOW-UP** (not done this pass): read `isLeaseReviewEnrichmentInFlight`'s exact definition (`src/lib/leaseReviewUiState.js`, imported at line 141) to confirm exactly which `enrichment_status` values count as "in flight."
- **Can an older payload remain displayed?** Partially confirmed: the query key presumably includes the file ID, and React Query's `refetchInterval` re-fetches the same row — so once polling is active, staleness is self-correcting within one interval. Whether a reviewer who loaded the page *before* a newer generation started (i.e., a re-extraction triggered elsewhere) sees the new generation's data was **not verified this pass** — this is the `active_generation_id` question from Section 3, still open.

**2. `review-approve` edge function — CONFIRMED, detailed above in 16.0.** Additional findings:
- Line 87: a basic boolean gate — `if (!fileRecord.review_required)` rejects with `NOT_REVIEWABLE` (422) — this is a *coarser*, pre-existing check, separate from and in addition to the `review_readiness==='ready'` finalizer check found at lines 345-373.
- Line 98-119: **idempotency confirmed** — re-calling approve on an already-`approved` file is a no-op that returns the existing state rather than erroring or re-processing, and (for lease modules) calls `ensureLeaseReviewDrafts` to backfill any missing lease draft rows.
- **NEEDS FOLLOW-UP** (not done this pass): whether `requiredForApproval` fields (from `LEASE_FIELD_CONTRACT`) are checked *in addition to* the coarse `review_readiness==='ready'` gate, or whether `review_readiness==='ready'` is the *only* gate and a document could reach "ready" with individual required fields still blank/invalid. The frontend's `bulkEvaluation.requiredBlockers`/`validationBlockers` (lines 1434-1452) suggest a *second*, field-level check exists client-side — whether it's mirrored server-side in `review-approve` or `finalize_lease_review_approval` was not confirmed this pass.

**3. Dynamic-row implementation — PARTIALLY confirmed.** `normalizeDynamicFindings()`/`routeDynamicRowToTab()` are confirmed to live in `src/lib/leaseReviewFieldNormalizer.js` (not `dynamicFields.js` as originally guessed in Section 9 — corrected here). `dynamicFields.js` (`src/components/lease-review/utils/dynamicFields.js`) is confirmed to hold *derived-field* logic (the `annual_rent = monthly_rent × 12` derivation at line 530, and a `rent_per_sf` derivation at line 535-541) — a distinct concern from dynamic *findings* rows. **NEEDS FOLLOW-UP** (not done this pass): the actual body of `normalizeDynamicFindings()`/`routeDynamicRowToTab()` for repeated-row identity/deduplication, and the CAM/expense-rule schema's field list against Section 4/5's exact clause complexity — Section 9 remains the shallowest section in this audit.

**4. Observability structures — CONFIRMED.** `mapFactsToStandardFields()` (`fact-field-mapper.ts:406-513`) already returns `{ records, validationErrors, unmappedFacts, rejectedCandidates }` in its function-local return shape (lines 509-513) — this is exactly the raw material Part B/C need; the question is only how much of it survives into the persisted payload. Confirmed persisted: `normalize-pdf-output/index.ts` builds `result.metadata.extractionDebug` (first assembled ~line 3010, extended ~line 3049) containing `merged_field_sources`, `llm_returned_field_details`, `unmapped_llm_keys`, and an `openai_fact_ledger`/`vertex_fact_ledger` sub-object with `dynamic_items` (lines 1052-1056, 1244-1245). **NEEDS FOLLOW-UP** (not done this pass): whether `rejectedCandidates` specifically (as opposed to `unmappedFacts`) makes it into `extractionDebug` today, or whether it's currently computed and then dropped before persistence — this is the single most important open question for Part B/C below, since if `rejectedCandidates` already reaches the payload, Part C's "top 5 rejected candidates" requirement may be a small additive change rather than new plumbing.

### 16.2 — Part B: provenance field availability (what exists today vs. what's lost)

| Provenance field (from the requested shape) | Exists today? | Where |
|---|---|---|
| `pipelinePath` | **No** — not tracked as a discrete enum anywhere found. Inferable indirectly (facts vs. rule-extractor vs. legacy LLM leave different shaped records) but never stamped explicitly. | — |
| `sourceProvider` | Partial — `leaseFieldResolver.js`'s `buildResolverOutput` reads a `sourceProvider`-like concept from `evidence_type`/`review_status` in some shapes (per `leaseReviewFieldNormalizer.js:629-631`, `sourceProvider: fallbackSourceProvider ?? evidence?.extractionStatus ?? ... ?? "unknown"`) | `leaseReviewFieldNormalizer.js:629-631` |
| `sourcePath` | **Yes, already exists** — `leaseFieldResolver.js`'s `buildResolverOutput(rawResult, sourcePath, fieldKey)` takes `sourcePath` as a parameter and the resolver's fallback hierarchy already tags each attempted source with a path string (e.g. `"lease.extraction_data.workflow_output.lease_fields"`) — this is frontend-side provenance already flowing, just not surfaced in the UI or persisted back. | `leaseFieldResolver.js:545, 787-840` |
| `generationId` | **Yes, at the file level** — `active_generation_id` is a real column, checked at write time (Section 3, Section 16.0). **Not yet threaded per-field.** | `uploaded_files.active_generation_id` |
| `factId`/`factIndex`/`chunkIndex` | Partial — `Fact` objects carry `chunkIndex`/`sourceOffset` internally (confirmed earlier this session, `fact-ledger-extractor.ts`'s `allFacts.push({...fact, chunkIndex: index, sourceOffset, ...})`) but this is **not currently propagated past the mapper into the persisted payload**. | `fact-ledger-extractor.ts` (internal only) |
| `sourcePage`/`sourceText` | **Yes, already exists and reaches the UI** — this is exactly what the review table already displays (`row.sourcePage`, `row.sourceText`). | `leaseReviewFieldNormalizer.js:607-611`, `LeaseReviewTabTable.jsx:255-256` |
| `mapperScore`/`mapperMatchedLabels` | **No** — `scoreFactAgainstField`'s integer score is computed and used for tie-breaking (`fact-field-mapper.ts:460-478`) but discarded once the winner is chosen; not attached to the winning field or persisted. | `fact-field-mapper.ts` (computed, discarded) |
| `clauseCategory`/`clauseCategoryAllowed` | Partial — the `Fact.category` (`clause:xxx`) exists on the fact object pre-mapping but is not confirmed to survive onto the winning field's persisted record. | `fact-ledger-extractor.ts` types |
| `shapeGuardResult` | **No** — `looksLikeFieldCompatibleFact`'s accept/reject is a boolean gate with no reason string returned. | `fact-field-mapper.ts:135-281` |
| `modelConfidence`/`ruleConfidence`/`mappingConfidence`/`validationConfidence` | **Collapsed into one `confidence` number today** — this is the Section 11/Executive-Summary finding: whichever stage produced the value, its confidence overwrites/becomes *the* confidence; the three semantically-different numbers are never kept separately. | Confirmed structural gap, all stages |
| `candidateDecision`/`validationStatus`/`validationMessage` | **Partial, `validationMessage` yes** (this session already surfaced it in the UI), `candidateDecision`/`validationStatus` as discrete enums — no. | `leaseReviewFieldNormalizer.js:627` (`validationMessage`) |
| `competingCandidateCount`/`rejectedCandidateCount` | **No, but the raw material exists** — `unmappedFacts`/`rejectedCandidates` arrays exist in the mapper's return value (16.1 item 4); counting them is trivial *if* they reach the persisted payload, which is the open question flagged above. | `fact-field-mapper.ts:509-513` |
| `derivedFromField`/`derivedFromValue`/`parentValidationStatus` | **Partial** — `derivationTrace` strings already exist for derived fields (e.g. `"annual_rent = monthly_rent (174.55) x 12"`, confirmed this session at `dynamicFields.js:530`), but `parentValidationStatus` (was the parent itself trusted?) is not tracked. | `dynamicFields.js:527-531` |
| `frontendResolutionSource`/`frontendFallbackIndex` | **Yes, already exists internally, not surfaced** — same as `sourcePath` above; the resolver already knows which of its ~17 fallback sources won, it just doesn't report the index/name anywhere visible. | `leaseFieldResolver.js:844-857` |

**Summary of Part B:** roughly half the requested shape already exists *somewhere* in the pipeline but is discarded before reaching a place a reviewer or this audit can see it (mapper score, shape-guard reasoning, chunk index, fact category, fallback-source index). The other half — a genuinely new distinction between confidence *types*, and per-field pipeline-path/candidate-count summaries — does not exist in any form today and would be new plumbing.

### 16.3 — Part C/D/E/G: design — IMPLEMENTED

**Status update:** the design below (originally proposed, awaiting approval) was approved by the user with 8 explicit guardrails and has now been implemented, tested, and verified. See **16.3a** for what was actually built, where it differs from the original proposal, and the test results. The original proposal text is left unchanged below for the historical record; 16.3a is the authoritative as-built description.

**Files I propose to inspect further before writing any code** (to close the "NEEDS FOLLOW-UP" items above, ideally in the same sitting as implementation so the design doesn't drift):
- `src/lib/leaseReviewUiState.js` (`isLeaseReviewEnrichmentInFlight` exact definition)
- `supabase/functions/_shared/extraction/openai-fact-ledger/types.ts` (confirm `Fact`'s exact current field list before extending it)
- `src/lib/leaseReviewFieldNormalizer.js`'s `normalizeDynamicFindings()`/`routeDynamicRowToTab()` in full
- `supabase/functions/review-approve/index.ts` lines 120-345 (the body between the idempotency check and the finalizer call, to see whether field-level `requiredForApproval` validation is duplicated server-side)

**Files I propose to modify, if this design is approved:**
- `supabase/functions/_shared/extraction/openai-fact-ledger/fact-field-mapper.ts` — thread `mapperScore`, matched label(s), and the shape-guard's accept/reject reason onto the winning field's record instead of discarding them after tie-breaking; keep `unmappedFacts`/`rejectedCandidates` (already computed) and cap+shape them per Part C's limits (selected + top 5 competing + top 5 rejected) rather than the full arrays.
- `supabase/functions/_shared/extraction/openai-fact-ledger/candidate-decision.ts` — return the specific rule name that fired (e.g. `"rejectedEvidencePatterns:electric_repair_exclusion"`) instead of just accept/reject/needs_review, for `shapeGuardResult`.
- `supabase/functions/normalize-pdf-output/index.ts` — add a new `extractionDebug.fieldProvenance[fieldKey]` object (per the user's own preferred location), populated from the above, for exactly the 10 focus fields initially (not all 88, to bound scope and payload size) — **extending** the existing `extractionDebug` object rather than adding a sibling structure, per the instruction.
- `src/components/lease-review/utils/dynamicFields.js` — extend the `annual_rent` derivation's existing `derivationTrace`/`sourceFieldKeys` shape (already present) with `parentValidationStatus`/`parentSourceProvider`, reading whatever validation status the parent field (`monthly_rent`) already carries — additive fields only, no change to the `× 12` calculation itself, per Part D's explicit instruction.
- `src/lib/leaseFieldResolver.js` — add a debug-only (non-production-rendered, e.g. gated behind an existing dev-mode flag or only attached when a query param/local-storage flag is set) annotation of which fallback-hierarchy entry and index resolved each field, and whether its generation matches `active_generation_id` — additive, no change to resolution order, per Part E's explicit instruction.
- New test files under `supabase/functions/_tests/` and `src/lib/__tests__/` for the 12 provenance-preservation cases listed in Part G.

**Proposed additive JSON shape** — a trimmed version of the user's requested shape, scoped to what's achievable without new infrastructure (no `factId` as a stable ID, since facts aren't persisted as individually addressable rows today — Section 3's still-open question; using `chunkIndex` + a positional index within that chunk's fact list as a substitute identifier instead):

```jsonc
// extractionDebug.fieldProvenance[fieldKey]
{
  "pipelinePath": "openai_fact_ledger" | "legacy_rule" | "legacy_targeted_llm" | "table_extraction" | "derived" | "unknown",
  "chunkIndex": number | null,
  "clauseCategory": "clause:rent" | null,
  "mapperScore": number | null,
  "matchedLabels": string[],
  "shapeGuardResult": "passed" | "rejected:<rule_name>" | "no_guard_configured",
  "confidenceBreakdown": { "extraction": number | null, "mapping": number | null },
  "selected": { "value": unknown, "sourceText": string | null, "sourcePage": number | null },
  "competingCandidates": [ /* up to 5, same shape as selected + mapperScore */ ],
  "rejectedCandidates": [ /* up to 5: { value, sourceText, mapperScore, rejectionReason } */ ],
  // only present when pipelinePath === "derived":
  "derivedFromField": string | null,
  "derivedFromValue": unknown,
  "parentValidationStatus": string | null,
  "derivationExpression": string | null
}
```

**Payload-size considerations:** capped at 10 focus fields × (1 selected + 5 competing + 5 rejected) × a short sourceText excerpt (propose truncating each to ~200 chars, matching the existing `sourcePreview`/`valuePreview` truncation convention already used in `LeaseReviewTabTable.jsx`) — worst case roughly 10 × 11 × 200 chars ≈ 22KB added to `ui_review_payload`, negligible against typical payload sizes already observed (293-fact documents). Not proposing this for all 88 fields in this step — that would need per-field cost/benefit review first.

**Tests to add** (Part G's 12 cases, mapped to concrete files):
1-4. Fixture-driven tests in a new `supabase/functions/_tests/field-provenance.test.ts` asserting `fieldProvenance` is populated correctly for a fact-ledger-selected field, a rule-selected field, a targeted-LLM-selected field, and a table-extracted field (using synthetic `DoclingOutput` fixtures, following the existing convention from this session's `lease-schema-new-fields-fixtures.test.ts`).
5. A derived-field test (`annual_rent`) asserting `derivationExpression`/`parentValidationStatus` populate without changing the computed value.
6-7. Rejected/blanked-candidate tests asserting `rejectedCandidates`/`competingCandidates` populate and are capped at 5.
8. Alias-resolved field test (`tax_responsibility`/`responsibility_taxes`) confirming provenance doesn't duplicate across the alias pair.
9-10. Frontend tests in `src/lib/__tests__/leaseFieldResolver.test.js` asserting the new debug annotation reports the correct fallback-source name/index and generation-match boolean, without changing which value wins.
11. A test asserting the competing-candidate list is sorted/truncated correctly and never exceeds 5.
12. A test asserting `validationMessage` (already shipped this session) continues to render correctly alongside the new fields — a regression guard, not new behavior.

All 12 tests share one invariant to assert explicitly: **the final selected `value` for every existing passing test is unchanged before/after this change** — this is a pure-addition step, and the test suite should prove that, not just exercise the new fields.

**Risks:**
- Low-medium: touching `fact-field-mapper.ts`'s return shape and `normalize-pdf-output`'s payload assembly are both high-traffic code paths; any change needs the full existing test suite re-run, not just new tests.
- Low: payload-size growth (quantified above as small).
- Medium: the frontend debug-annotation work in `leaseFieldResolver.js` touches the single most fallback-heavy, highest-blast-radius file in the frontend; propose gating it fully behind a flag so it cannot affect production rendering even if a bug is introduced.

**Rollback plan:** every change proposed here is additive (new object keys, new debug-only frontend annotations) — rollback is deleting the added code/keys; no migration, no data backfill, no schema change is proposed in this step, so rollback carries no data-loss risk.

### 16.3a — As-built implementation (Micro-step 0, completed)

**Scope actually implemented**, per the user's approval message and its 8 guardrails — all additive, no selection/mapping/validation/confidence/fallback-order changes:

- **Backend selection provenance** — `supabase/functions/_shared/extraction/openai-fact-ledger/types.ts` gained an optional `fieldProvenance?: Record<string, FieldSelectionProvenance>` on `FactFieldMappingResult`, plus `FieldPipelinePath`, `FieldGuardDecision`, `FieldCandidateSummary`/`FieldRejectedCandidateSummary` types. `fact-field-mapper.ts` computes it for 10 tracked fields (`monthly_rent, annual_rent, ti_allowance, expiration_date, broker_name, renewal_options, tenant_signatory_name, responsibility_repairs, insurance_responsibility, electric_responsibility`) via a behavior-preserving refactor: `looksLikeFieldCompatibleFact()` gained an optional `reasonsOut` out-parameter (every internal `return false` became `return reject("<reason>")`, with the final and one early `return true` untouched), and `scoreFactAgainstField()` became a thin wrapper over a new `scoreFactAgainstFieldDetailed()` that returns the same score plus the detail needed for provenance. `orchestrator.ts` persists this as `extractionDebug.openai_fact_ledger.field_provenance`.
- **Raw scores kept separate, not blended** — `modelConfidence`/`ruleConfidence`/`mapperScore`/`validationStatus` are stored as distinct fields; no new combined "finalConfidence" was computed, per guardrail 3.
- **Explicit guard decisions** — `shapeGuard: { passed, guard: string | null, reasons: string[] }`, with `guard: null` reliably meaning "no shape guard configured for this field" (via an explicit `FIELDS_WITH_SHAPE_GUARD` allowlist, not inferred from an empty reasons array) — directly operationalizes this audit's `ti_allowance`/`expiration_date`/`tenant_signatory_name`/`electric_responsibility` finding (16.2).
- **Bounded candidate lists** — `competingCandidates`/`rejectedCandidates` capped at 5 each via `CANDIDATE_LIST_MAX_LENGTH`, `sourceText` truncated to 600 chars via `CANDIDATE_SOURCE_TEXT_MAX_CHARS` (tighter than the original proposal's 200-char estimate, still well inside the user's 500-1,000 char cap).
- **Two distinct provenance concepts, not one** — backend `FieldSelectionProvenance` ("why did this candidate win?") in `fact-field-mapper.ts`/`orchestrator.ts`, versus frontend `getFieldDisplayProvenance()` ("why is this value displayed?", new export in `src/lib/leaseFieldResolver.js`) — kept separate per guardrail 5, not merged into one shape.
- **Alias tracking without behavior change** — `getFieldDisplayProvenance()` reports `requestedFieldKey`/`resolvedFieldKey`/`aliasUsed` via a new `bestEffortRawKeyForField()` helper. This required a design pivot from the original proposal: this session's earlier fix made `FIELD_ALIASES` bidirectional, so every alias in a field's alias list already resolves identically through `resolveLeaseField` — comparing resolved outputs across aliases can no longer show which literal key held the data. `bestEffortRawKeyForField()` instead checks raw key presence directly across the 5 most common containers, documented as a best-effort approximation, not exhaustive.
- **Generation comparison, honestly diagnosed** — `activeGenerationId` is read from the lease object; `payloadGenerationId` is explicitly `null` (not fabricated) because `ui_review_payload` does not currently carry its own generation-of-origin stamp reachable from the frontend resolver; `generationMatch` is therefore `null` (unknown) rather than a guaranteed true/false, per guardrail 7 — this diagnoses the absence of a stamp rather than pretending one exists.
- **Derived annual_rent provenance** — `dynamicFields.js`'s `buildDerivedFieldEvidence()` now returns a `selectionProvenance: { pipelinePath: "derived", derivedFromField: "monthly_rent", derivedFromValue, parentSourcePath, parentValidationStatus, parentGenerationId, derivationExpression: "monthly_rent * 12" }` alongside the existing (unchanged) `value = Math.round(monthlyRent * 12 * 100) / 100` computation. The function was given an `export` keyword (visibility-only change, no logic change) so it could be tested directly. **The unsafe calculation itself is untouched, exactly as instructed** — this is diagnostic only.
- **mirrorDateAlias/resolveLeaseTermDatePair edge case** — when a tracked field's value arrived via the date-pairing heuristic rather than its own per-fact scoring, its provenance entry reports `shapeGuard.reasons: ["Value assigned via a paired-date-field heuristic..."]` and `mapperScore: null`, rather than fabricating a scored-candidate story for a value that was never itself scored.

**Deviations from the original 16.3 proposal** (both harmless, both discovered during test-writing, not by user feedback):
1. **`broker_name`'s selected value in `fieldProvenance` can differ from `records[0].fields.broker_name.value`.** A separate, pre-existing downstream system (`validator.ts`) independently sanitizes/nulls certain broker-name values after the mapper has already chosen its winner. `fieldProvenance.selected.value` reports the mapper's actual decision (correct, per this Micro-step's scope); the final field value reflects `validator.ts`'s independent, unrelated, and unmodified decision. This is a real, pre-existing two-system disagreement worth a future look, but changing `validator.ts` was out of scope for this PR (guardrail: do not change validation behavior).
2. **`schemas.ts` already has deliberately overlapping date labels** (`expiration_date`'s labels include "end date" and vice versa) as a *primary*, not backup, matching path — meaning a naive test for the `mirrorDateAlias` heuristic can accidentally pass for the wrong reason (the field winning its own label match rather than the heuristic). The real heuristic path was reproduced using two `category: "clause:lease_term"` facts sharing one `sourceText`, mirroring an existing convention in `openai-fact-ledger.test.ts`.

**Tests added** (18 total — 9 backend + 6 frontend easily exceeds the requested "12 provenance-preservation tests" once the two required cross-cutting assertions and the legacy-compatibility test are counted in; see below):
- `supabase/functions/_tests/field-provenance.test.ts` (9 Deno tests): clean win populates full provenance; a rejected/competing bad candidate is visible in `rejectedCandidates`/`competingCandidates` even when a downstream system later nulls the field's own display value; `ti_allowance` correctly reports `guard: null`; candidate lists stay capped at 5 with 7+ candidates on each side; a field with only rejected candidates has `selected.value === null` with the rejection visible; `sourceText` truncates at the 600-char bound; **tracking a field for provenance never changes which fact wins it** (the required cross-cutting assertion, run on both a tracked and an untracked field); the date-pair heuristic case; and a **legacy-payload-compatibility test** destructuring only the pre-existing `{records, validationErrors, unmappedFacts, rejectedCandidates}` shape to confirm old consumers still work unmodified.
- `src/lib/__tests__/field-provenance.test.js` (6 Vitest tests): `getFieldDisplayProvenance` reports the correct fallback source/index for a normal field; `aliasUsed: true`/`resolvedFieldKey` when only an alias key has raw data; `aliasUsed: false` when the requested key itself has the data; `activeGenerationId` surfaces while `generationMatch` stays honestly `null`; a legacy lease object with none of the new fields does not throw; and the `annual_rent` derived-provenance shape (parent identity, unchanged `2094.6` computed value) — this test also serves as the **second required cross-cutting assertion** (provenance serialization does not alter the derived value).

**Verification performed:**
- `deno check` clean on all 3 modified backend files + the new test file.
- `eslint --quiet` clean on all 3 modified/new frontend files.
- Full frontend suite: `npx vitest run src/` → **78 files, 783 tests, all passed** (includes the 6 new provenance tests).
- Backend: `deno test _tests/openai-fact-ledger.test.ts _tests/candidate-decision.test.ts _tests/field-contract.test.ts _tests/field-provenance.test.ts` → **93 passed, 1 failed**. The 1 failure (`field-contract.test.ts:180`, a `tax_responsibility`/`responsibility_taxes` independence assertion) was confirmed **pre-existing and unrelated** by stashing all Micro-step 0 changes and re-running against the original, unmodified code — it fails identically there. It is not touched or explained by this PR and is left as-is per the instruction not to expand scope.
- Selected-value byte-identity: explicitly asserted in the "tracking a field for provenance never changes which fact wins it" test (backend) and the annual_rent derived-value test (frontend) — both confirm the new provenance code paths do not alter what gets displayed or stored.
- **No production deployment was performed** — no migrations created or run, no `supabase functions deploy` invoked, consistent with the standing constraint for this entire investigation.

### 16.4 — Part F: runtime artifact extraction — BLOCKED, not executed

**This part could not be performed.** Re-extracting the Craven Wings document — through Azure Document Intelligence, the fact-ledger LLM, and a live Supabase environment — requires live cloud credentials and a running deployment that do not exist in this static code-editing session. I have not fabricated a result. Once Phase 0 (Part C's diagnostics) is implemented and deployed to a real (non-production, per the instruction) environment, re-running extraction there would produce the table Part F asks for; that step needs to happen in an environment with actual API access, by whoever operates that environment.

The `LEASE_FINANCIAL_SCHEDULE_MODE` value and the actual `docling.tables` array for this document are similarly runtime artifacts — both already listed in Section 13 of the original report and unchanged by this pass.

### 16.5 — Recommended Micro-step 1

Micro-step 0 is implemented, tested, and not yet deployed. Its diagnostics have **not yet been run against a live re-extraction of the Craven Wings document** (Part F, 16.4, remains blocked — no live credentials/environment in this session), so Section 5's PLAUSIBLE/NEEDS-RUNTIME-DATA findings (A, C, D, E, F, I) cannot be upgraded to CONFIRMED from this session alone.

**Recommended Micro-step 1, conditioned on that missing step rather than assumed in advance:** deploy Micro-step 0's two edge functions (or run them in a non-production environment) and re-extract the Craven Wings document, then read `extractionDebug.openai_fact_ledger.field_provenance.monthly_rent` (and `annual_rent`'s derived provenance) directly. Two outcomes are both plausible from what this session's code changes can see, and only that live run distinguishes them:
- If `field_provenance.monthly_rent.selected.value === 174.55` with a `chunkIndex`/`sourceText` pointing at the $174.55 clause the user flagged, that CONFIRMS the base-rent contamination mechanism the user anticipated — the next fix is a targeted guard/rejection rule for that specific clause shape in `looksLikeFieldCompatibleFact`'s monthly_rent branch, informed by exactly which `shapeGuard.reasons` (if any) let it through.
- If instead `monthly_rent`'s provenance shows a different winning candidate or an unmapped/rejected path for $174.55, the contamination is happening somewhere else in the pipeline (e.g. at the `dynamicFields.js` derivation/recovery layer, not at fact selection) — in which case the fix targets that layer instead.

Either way, this is the same "Phase 0 is the smallest safe next slice" sequencing from the original Section 15 recommendation: diagnose with real data before writing the Phase 1 guard fix, so the fix targets the actually-confirmed mechanism rather than the most plausible guess.

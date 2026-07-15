# Document Intelligence v3 — Phase 0 Baseline (Read-Only)

Baseline snapshot for the "Enterprise Document Intelligence v3" effort, taken on branch `feature/document-intelligence-v3` (cut from `feature/lease-review-ui-alignment`, which is a strict superset of `main` and `origin/enterprise-architecture-hardening` — verified via `git rev-list --left-right --count`, 0 commits behind either). Produced by reading the pipeline end-to-end (upload through approval, frontend and backend) plus this repo's existing `docs/extraction-current-call-graph.md`, `docs/extraction-current-data-contract.md`, and `docs/lease-standard-field-model.md`, which independently verified much of the same ground and are cited below rather than re-derived. No source file was modified to produce this document.

---

## 1. Current upload → parse → normalize → enrich → Lease Review data flow

```
LeaseUpload.jsx --> upload-handler
      (stores file bytes, inserts uploaded_files row, status="uploaded", confirmed_at=NULL;
       does not itself parse — confirmed by an explicit code comment)
  User clicks Proceed --> confirm-upload
      (atomically sets confirmed_at, forwards to ingest-file with the user's own JWT)

ingest-file (central router, by file format):
  pdf/doc/docx/image/unknown --> async lease path:
        inserts pipeline_jobs row (job_type="lease_extraction", stage="parse", status="queued")
        fire-and-forget dispatches lease-extraction-worker (service-role auth)
        returns {extraction_queued:true, job_id, status:"parsing"} immediately
  csv/xlsx/text --> parse-file (existing CSV/Excel path, converges with pdf path at validate-data/store-data)

lease-extraction-worker (single invocation, sequential stage fallthrough):
  stage "parse"
    --> parse-pdf-docling (thin wrapper, no parsing logic of its own)
          --> _shared/extraction/parser.ts :: parseDocument()
                --> EXTRACTION_PROVIDER-gated:
                      "azure_document_intelligence" / "azure_with_legacy_fallback" / "shadow_compare"
                        --> _shared/azure/document-intelligence.ts (Azure prebuilt-layout,
                            submit + poll, URL-first so file bytes never load into Edge Function memory)
                        --> _shared/extraction/azure-layout-adapter.ts
                            (normalizes analyzeResult --> canonical DoclingOutput, inserts [[PAGE n]] markers)
                      "legacy" (default) --> native PDF text / OpenXML / Docling HTTP / Gemini Vision fallback chain,
                        strategy chosen by parser.ts::pickStrategy() (mime type + scanned-document heuristic)
          persists uploaded_files.docling_raw (capped: 80k text chars, 1000 blocks, 500 tables,
              150 pages, 500 fields, 50 warnings — the parse-OOM fix), status --> "pdf_parsed"
          on hard failure: persistBlockedParse() still writes a structured, UI-renderable
              blocked_pipeline_failure state rather than a bare 500

  stage "normalize" (same worker invocation, falls through immediately after parse succeeds)
    --> normalize-pdf-output (normal mode)
          --> resolveBusinessExtractionProvider():
                default "legacy_hybrid" (_shared/extraction/pipeline.ts::runExtractionPipeline()) unless
                the BUSINESS_EXTRACTION_PROVIDER secret is explicitly set to "vertex_fact_ledger"
                (or an internal-call-only debug override requests it for one request)
              legacy_hybrid: Rule extractor -> Table extractor -> LLM (missing fields only,
                Vertex AI Gemini primary, Gemini-API-key then Claude/Anthropic fallback) -> Merge -> Validate -> Calculate
              vertex_fact_ledger (opt-in, see Section 5): must return the identical
                ExtractionPipelineResult shape as legacy_hybrid
          --> buildMinimalReviewPayload()  [fast path, persisted immediately]
                hydrates evidence from metadata already computed inside the pipeline call
                (merged_field_sources / llm_returned_field_details) — so real source_page/
                source_text/confidence are present even before the deferred enrich pass runs
          writes uploaded_files.normalized_output, .ui_review_payload (schema_version 2),
              .parsed_data; status --> "review_required" or "validated"
          --> (default; NORMALIZE_INLINE_ENRICHMENT unset) enqueueEnrichmentJob()
                inserts a second pipeline_jobs row (stage="enrich", status="queued"),
                superseding any already-queued enrich job for the same file first
                fire-and-forget re-dispatches lease-extraction-worker

lease-extraction-worker (second, later invocation, for the enrich job)
  stage "enrich"
    --> normalize-pdf-output (mode:"enrich")
          re-loads the already-persisted normalized_output — does NOT re-parse or re-call the LLM
          --> buildLeaseWorkflowAbstraction()  [_shared/extraction/lease-workflow.ts, 4,693 lines]
                detectDocumentProfileSignals() / detectDocumentProfile() — regex-based
                    lease | assignment | amendment | assignment_amendment classification
                buildClauseRecords() against 34 hardcoded CLAUSE_DEFINITIONS
                buildLeaseFieldMap() — per-field evidence resolution via evidence-index.ts
                    (page-indexed, WeakMap-cached — the fix for the O(fields x candidates)
                    brute-force scan that used to cause 546/OOM errors on long documents)
                deriveExpenseRules(), deriveCamProfile(), deriveBudgetPreview()
          patches ONLY uploaded_files.ui_review_payload (never touches uploaded_files.status)
          sets ui_review_payload.enrichment_status: "completed" (or "failed", core fields untouched)

Human review — LeaseReview.jsx:
  loads leases row + uploaded_files row, merges client-side into leaseFull
  polls uploaded_files every 4s while ui_review_payload.enrichment_status is pending/running
  resolves every displayed field via src/lib/leaseFieldResolver.js::resolveLeaseField()
      — a 23-source fallback chain (approved_lease_abstracts.snapshot_json down to raw
        uploaded_files.parsed_data[0]; see extraction-current-data-contract.md for the exact order)
  reviewer actions (Accept/Edit/Reject/N-A/Manual-required) write through
      save-lease-review-draft / update-lease-field-and-columns / update-lease-extraction-field
      (edge functions --> SECURITY DEFINER RPCs), never direct client table writes, on the
      hardened paths — a few lower-stakes paths (auto-link, manual-link, custom-field-add)
      still write directly, per the frontend agent's audit
  "Prepare" / draft creation (distinct from final approval):
      --> review-approve (action="prepare" or "approve" for non-lease modules)
            ensureLeaseReviewDrafts() creates/updates a leases row, status="draft"
            — despite the action literally being named "approve", this is NOT final approval
  "Approve Lease Abstract" (the actual final approval):
      --> approve-lease-workflow
            builds an abstract snapshot + critical-date rows
            --> approve_lease_workflow RPC (Postgres, SECURITY DEFINER)
                  validates only actor/org/signed_by/signed_at/idempotency_key —
                  performs NO field-completeness, confidence, or clause-presence validation
                  writes leases.status="approved", a lease_abstract_versions row,
                  lease_field_reviews rows
            --> synchronously calls compute-lease so the approved rent schedule exists
                  before the approval response returns
```

Source: independently verified by the backend-pipeline Explore pass and cross-checked against `docs/extraction-current-call-graph.md` / `docs/extraction-current-data-contract.md` (both already in-repo, produced by an earlier session, no material discrepancies found against current HEAD).

---

## 2. Current status models

Four separate, only-partially-linked vocabularies describe "where is this document right now":

### `uploaded_files.status` (the FSM)
Owned by `supabase/functions/_shared/pipeline-status.ts`. Enum: `uploaded -> parsing -> parsed -> pdf_parsed -> validating -> validated -> review_required -> approved -> storing -> stored -> computing -> completed`, plus `failed`/`cancelled` reachable from anywhere. `setStatus()` enforces a validated transition table; `setFailed()` bypasses it unconditionally. **This FSM has no knowledge of the `enrich` stage at all** — a file reaches `review_required` as soon as the *minimal* payload persists, before the deferred enrich pass has necessarily run.

### `uploaded_files.processing_status`
A separate, more granular text column (added `20260601221738_stripe_billing_stage_2.sql`, independent of the `status` FSM above). Read by the `pipeline-status` polling endpoint; treated as optional/best-effort — code logs a warning and continues if the column is absent on a given environment (per `docs/deploy/schema-sync-checklist.md`).

### `ui_review_payload.core_ready` / `.enrichment_status`
JSONB-only fields inside the `ui_review_payload` column itself, computed and read entirely outside the FSM.
- `core_ready` (boolean): stamped once by `buildMinimalReviewPayload()`, requires `tenant_name` plus ≥3 of 5 remaining core categories (`payload-guard.ts::computeCoreReady`). Gates whether "Open Lease Review" is enabled client-side (`extractionStatusLabels.js::computeCanOpenReview`).
- `enrichment_status` (`pending|running|completed|failed`): tracks the deferred enrich pass independently. `enqueueEnrichmentJob()`'s own code comment states it "deliberately does NOT touch uploaded_files.status."

### `pipeline_jobs.stage`
A third, job-queue-specific vocabulary: `parse | normalize | review_draft | rule_extraction | enrich` (`enrich` added by `20260818000000_pipeline_jobs_enrich_stage.sql`). Distinct `pipeline_jobs.status`: `queued | running | completed | failed | cancelled`.

**Confirmed live inconsistency across these four models**: `supabase/functions/pipeline-status/index.ts`'s `deriveDisplayState` has no branch for `latestJob.stage === "enrich"` — it falls through to the generic `"extracting"` bucket. A file that is already `core_ready: true` and `status: "review_required"`, but has an `enrich` job still running, can be reported by this endpoint as "Lease extraction is running" / `next_action: "wait"`, contradicting the `core_ready` flag's own intent. This is a real, currently-live gap between two of the four status models, not a hypothetical one.

Two `leases`-table status columns add a fifth and sixth vocabulary at the abstract level, also unreconciled with the four above: `leases.status` (free text, no CHECK constraint — `draft|active|approved|expired|...`, written by `review-approve` and `approve_lease_workflow`) and `leases.abstract_status` (free text — `draft|pending_review|approved|rejected|superseded`, the lease-abstract-specific lifecycle).

---

## 3. Current compatibility risks

- **Field vocabulary fragmentation, six deep.** Backend: `LEASE_SCHEMA` (82 fields, the canonical typed schema) vs. `lease-workflow.ts`'s independent `FIELD_SPECS` (a second ~350-line field list with its own aliases — reconciled via `field-contract.ts`'s alias bridge per `docs/lease-standard-field-model.md`, but only for the fields that bridge covers). Frontend: `leaseFieldContract.js`, `leaseReviewSchema.js`, and `leaseFieldResolver.js` **each maintain their own, independently hand-written alias table** — `leaseFieldContract.js`'s own header comment flags this as a known maintenance-drift risk. Any v3 canonical-field-mapper work must collapse these into one source, not add a seventh.
- **Two field-status vocabularies on the frontend alone**: the persisted `REVIEW_STATUSES` (`pending/accepted/edited/rejected/not_applicable/needs_legal_review/manual_required`, written to `leases.extraction_data.field_reviews`) vs. `leaseReviewFieldNormalizer.js`'s freshly-computed-every-render `status` (`manually_edited/rejected/missing/auto_populated/needs_review`). These describe overlapping but not identical concepts and can disagree for the same field.
- **`ui_review_payload` is still the frontend's actual source of truth**, contradicting the target architecture's "claims are the source of truth, canonical fields are projections" principle. `leaseFieldResolver.js`'s 23-source fallback chain reads `ui_review_payload` and five other JSONB locations directly; there is no single canonical-fields table the UI projects from.
- **The claims/evidence layer that already exists is not durable.** The `vertex_fact_ledger` provider's `Fact[]` ledger (source-grounded: category, value, sourceText, sourcePage, confidence — structurally close to the v3 doc's `claim` shape) lives only inside `ui_review_payload.metadata.extractionDebug.vertex_fact_ledger`, a transient JSONB blob overwritten on every re-extraction. It is not a queryable, versioned table.
- **No Document Package Graph or supersession model exists.** No `references|amends|supersedes|assigns|terminates` relationship tracking between documents anywhere in the schema. Every document is reviewed in isolation; an assignment document has no structural link to "the original lease it needs."
- **Approval gating is 100% client-side, and already internally inconsistent.** `approve_lease_workflow` (the RPC) validates only actor/org/signature fields — no field-completeness, confidence, or clause-presence check. The only gating that exists is in the browser (`LeaseReview.jsx`'s `bulkEvaluation`), and it does not even agree with the advisory panel sitting next to it (see Section 4, "assignment treated like full lease").
- **`@ts-nocheck` is present on essentially every file in the extraction pipeline** — parser, pipeline orchestrator, worker, lease-workflow, all review-UI utility libraries. Any new v3 module inherits zero compile-time safety unless deliberately typed from the start.
- **Migration/RLS discipline is mature and must be followed exactly, not reinvented.** This repo has hit and fixed real local-vs-remote schema drift multiple times, documented in detail in `docs/database/migration-repair.md`: unique 14-digit migration timestamp prefixes are mandatory; always `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, never rely on a bare `CREATE TABLE IF NOT EXISTS` to evolve an existing table; new RLS policies must use `is_member_of_org(org_id)` / `org_id IN (SELECT get_my_org_ids())`, never `org_id = ANY(get_my_org_ids())` (local Postgres rejects the latter; remote's `get_my_org_ids()` has a different, undocumented return type than local's); always dry-run (`supabase db push --linked --dry-run`) against the linked remote project before pushing for real. Any new v3 tables (a claim ledger, a package graph) must go through this exact discipline.
- **A server-owned-workflow template already exists and should be reused**, not redesigned: `docs/server-owned-workflow-pattern.md` specifies the idempotency-run-table shape, the `SECURITY DEFINER` RPC body order, and shared Postgres helpers (`begin_workflow_run`, `complete_workflow_run`, `fail_workflow_run`) plus an edge-function helper (`_shared/workflow-helper.ts`). Any new v3 workflow (claim-ledger writes, package-graph resolution, profile-aware approval) should be built on this template.
- **Three independent "is this source text generic/useless" implementations** exist across `pipeline.ts`, `normalize-pdf-output/index.ts`, and `lease-workflow.ts`, each with slightly different regex sets — a consolidation candidate before any new evidence-validation logic is layered on top.

---

## 4. Current known bug table

| Bug | Verified status against current HEAD |
|---|---|
| `documentProfile` null/unknown | **Confirmed live**, and it's not a single null case — profile is computed **four different, unreconciled ways**: backend regex (`lease-workflow.ts::detectDocumentProfileSignals`), backend Vertex classifier (`vertex-fact-ledger/profile-classifier.ts`, flagged off by default), a frontend heuristic (`src/lib/documentProfile.js`, which itself overrides the AI label when ≥2 "full lease" signals are present), and a raw `workflow_output.document_profile` signal read directly by `leaseReviewFieldNormalizer.js`. `ApprovalBlockersPanel.jsx` literally renders the fallback string `"profile unknown"` when none resolve. |
| Assignment treated like full lease | **Confirmed and root-caused.** A profile-aware required-field contract already exists (`leaseFieldContract.js`'s `requiredByDocumentProfile`, which correctly marks e.g. `assignor_name`/`assignee_name` as assignment-only) — but it only feeds the **advisory** `ApprovalBlockersPanel`, whose own docstring states it "does not block accept/reject or approval." The **real, hard-blocking** approval gate is `leaseReviewSchema.js`'s flat `REQUIRED_FIELD_KEYS` (11 fields — `tenant_name, landlord_name, premises_address, square_footage, premises_use, lease_date, lease_term, commencement_date, expiration_date, monthly_rent, security_deposit` — all `allowNA:false`, zero document-profile branching), consumed directly by `LeaseReview.jsx`'s `bulkEvaluation`/`canApprove`. An assignment document is held to full-lease requirements in the live approval flow today, directly contradicting the advisory panel's own copy next to it ("an assignment/amendment document is never held to full-lease requirements" — true only of the panel, not the gate). |
| `landlord_name = <figure>` | **Not reproducible in current code** — no literal `<figure>` string exists anywhere in `src/`. The closest live defense is `leaseFieldResolver.js`'s `FALLBACK_VALUE_SENTINELS` list, which nulls out a set of known UI-string leaks (e.g. `"lease review draft"`, `"upload lease"`, `"cre platform"`) — implying this class of bug occurred before and was patched at the resolver layer. Should be re-verified against a fresh extraction of the actual document that produced this symptom before assuming it's fully resolved; the fix is a value-level sentinel list, not a structural guarantee against novel leaked strings. |
| Assignor missing | **Confirmed and structural.** `assignor_name`/`assignee_name` exist only in `leaseFieldContract.js` (advisory-only consumer). They are **entirely absent** from `leaseReviewSchema.js`'s `LEASE_REVIEW_FIELDS` array — no dedicated review-table row, no Accept/Reject action, no `FIELD_COLUMN_ALIASES` entry to write a real `leases` column. They surface in the live UI only incidentally, if the extractor happens to tag them as a generic "dynamic finding" row. |
| Original lease date mapped as signature date | **Not found as a live, reproducible bug** in any of the code paths read (validator, evidence resolver, workflow abstraction). Flagged as unverified rather than fixed or broken — needs a fixture-document regression test (naturally a Phase 12 golden-fixture candidate) before either conclusion is safe to state. |
| Optional missing fields too noisy | **Partially mitigated, not structurally solved.** `LeaseReviewTabTable.jsx::shouldShowRow()` already hides empty, non-required rows by default (an "Advanced" toggle reveals them) — but the underlying extraction noise itself is patched in three separate, uncoordinated places: `FALLBACK_VALUE_SENTINELS` (resolver-level), `LeaseUpload.jsx`'s hardcoded noisy-custom-field-key regex list (upload-quality-heuristic level), and `ExtractionDebugPanel`'s "Field-Level Missing Trace" section (debug-only visibility). No single validation-drop pipeline with one list of reasons exists yet — this is exactly what the target architecture's `validation_drops[]` contract is meant to replace these three with. |
| Clause Records polluted | **A cleaner fix already exists in the tree and is simply not wired in.** The live Clause Records tab in `LeaseReview.jsx` renders `computeFallbackClauseRows()` — a 24-path union over multiple JSONB locations that can include non-clause field data alongside real clauses. A separate, DB-table-backed `ClauseRecordsTable` component exists in `SpecializedTables.jsx` (queries the real `lease_clauses` table, checked against a fixed 20-type checklist) but is **never imported by `LeaseReview.jsx`** — it sits as dead code next to the live, noisier fallback path. |
| Enrichment banner stale | The banner logic itself in `LeaseReview.jsx` (~lines 2909-2915) looks structurally correct at current HEAD: non-blocking, 4-second poll while `enrichment_status` is `pending`/`running`, hides once it leaves that state, fields underneath remain visible throughout. A **related but distinct** confirmed-live bug sits one layer over, in `pipeline-status/index.ts`'s `deriveDisplayState` (see Section 2) — it has no branch for the `enrich` job stage and can misreport a `core_ready` file as still extracting on the *Upload* page (not the Review page banner itself). |
| Accept action persistence | The current `handleAccept` -> `persistFieldAction` path (optimistic local update, server persistence via `save-lease-review-draft`, revert-to-prior-state on failure) reads as structurally sound at current HEAD. Prior-session documentation (`docs/extraction-current-call-graph.md`) records a batch of now-apparently-fixed `ReferenceError`-class bugs in adjacent handlers (`handleFieldSave`, `onSaveEdit`, `onSaveEvidence`, `handleMarkAsFullLease`, `handleSendBack` previously referenced unimported functions) that were reportedly fixed "in the commit immediately following" that doc. Worth one direct confirmation pass early in Phase 1 rather than trusting that note against the exact current HEAD sha without re-checking. |

---

## 5. Existing architecture pieces already present

This is the central finding of Phase 0: substantial pieces of the target v3 architecture are **already built**, under the name `vertex_fact_ledger`, on this same branch's ancestry — wired end-to-end but not the default, and not yet consulted by the parts of the UI that actually gate behavior.

- **`vertex_fact_ledger` extraction provider** (`supabase/functions/_shared/extraction/vertex-fact-ledger/`) — a complete, parallel business-extraction path, opt-in via the `BUSINESS_EXTRACTION_PROVIDER` secret (default remains `legacy_hybrid`):
  - `profile-classifier.ts::classifyDocumentProfile()` — one Vertex AI call classifying into `full_lease | assignment | amendment | assignment_amendment | abstract | addendum | exhibit`, with the existing regex classifier (`detectDocumentProfileSignals`) as an automatic fallback on any failure. Never throws.
  - `types.ts` — defines `Fact { category, value, sourceText, sourcePage, confidence }`, an atomic source-grounded claim close in shape to the v3 doc's `claim` object. Facts with no real `sourceText` are dropped before construction.
  - `fact-ledger-extractor.ts` — extracts the `Fact[]` ledger from document chunks.
  - `fact-field-mapper.ts` — maps facts onto `LEASE_SCHEMA` fields, field-contract-aware (checks `field-contract.ts` aliases, not just each field's own labels), returns `unmappedFacts` for anything that doesn't map — this is a working canonical-field-mapper, not a stub.
  - `dynamic-fact-surfacer.ts` — surfaces unmapped facts as dynamic review rows, matching the existing `is_dynamic`/`creates_dynamic_row` frontend contract exactly, so zero frontend changes were needed to consume it.
  - `approval-blockers.ts::computeProfileApprovalBlockers()` — profile-aware advisory blockers (`{fieldKey, label, reason: "missing"|"unverified"}`) — explicitly advisory only; not consulted by the real approval gate (this is precisely the gap behind the "assignment treated like full lease" bug above).
  - `orchestrator.ts::runVertexFactLedgerPipeline()` — satisfies the exact same `ExtractionPipelineResult` contract as `legacy_hybrid`'s `pipeline.ts`, so either provider is a drop-in swap from the caller's point of view.
  - `document-index.ts::buildCanonicalDocumentIndex()` — explicitly "a thin, read-only view" reusing the existing `evidence-index.ts`, not a rewrite.

- **Shared field contract** — `supabase/functions/_shared/extraction/field-contract.ts` (backend) makes `docs/lease-standard-field-model.md` machine-readable: `LEASE_FIELD_CONTRACT`, `resolveCanonicalKey()`, `getFieldContract()`, `getFieldsForGroup()`, including `requiredByDocumentProfile` per field. `src/lib/leaseFieldContract.js` is a hand-ported frontend mirror of the same concept (not imported/shared — a maintenance-sync risk noted in its own header comment), with ~90 entries carrying `requiredForApproval`, `requiredForCam`, `requiredForBudget`, `requiredByDocumentProfile`, `evidenceRequired`.

- **Profile classifier** — exists at both the regex level (`lease-workflow.ts`, run unconditionally today) and the LLM level (`vertex-fact-ledger/profile-classifier.ts`, opt-in), plus an independent frontend heuristic (`src/lib/documentProfile.js`) that can override either backend signal when ≥2 full-lease structural signals are present.

- **Advisory profile-aware blockers** — `ApprovalBlockersPanel.jsx` (frontend) + `normalizeApprovalBlockers()` (`leaseReviewFieldNormalizer.js`) + `computeProfileApprovalBlockers()` (backend, vertex_fact_ledger-only) form a working, profile-aware advisory pipeline end to end — it is simply not wired into the actual approval decision.

- **Lease Review normalizer/UI refactor** — `leaseReviewFieldNormalizer.js::normalizeLeaseReviewData()` already provides the single-union-source pattern the target architecture's "UI Projection Service" describes in spirit (one function producing `standardFields`, `dynamicFindings`, `clauseRecords`, `expenseRules`/`camRules`, `approvalBlockers`, `tabs`, `readinessSummary` from the raw payload), replacing several previously-divergent per-purpose computations. `LeaseReviewTabTable.jsx` is already a single generic table component serving every tab, rather than one component per document type — directly consistent with the v3 principle "do not create separate UI structures per document type."

---

## 6. Gaps before true v3

- **Durable claim/evidence ledger is missing.** The `Fact[]` ledger described in Section 5 is real but transient — it lives inside `ui_review_payload`'s JSONB and is overwritten on every re-extraction. There is no `claim_ledger` (or equivalent) table: no durable claim IDs, no claim versioning, no claim-level audit trail independent of the review payload's own lifecycle.
- **Document Package Graph is missing.** No relationship table or logic exists for `references | amends | assigns | supersedes | terminates | renews | guarantees | clarifies | exhibits_for | duplicate_of`. An assignment document today has no structural link to "the original lease it needs" — that dependency is invisible to the system, only inferable by a human reviewer.
- **Supersession model is missing.** No `effective_from` / `effective_to` / `supersedes_claim_id` / `superseded_by_claim_id` / `current_status` fields exist anywhere. Nothing in the system currently resolves "what is the current truth" across a lease plus its amendments.
- **Profile-aware approval gate is not enforced server-side.** `approve_lease_workflow` performs zero field-completeness/confidence/clause validation. Everything gating "can this be approved" is client-side, and (per Section 4) the client-side gate that actually runs is not even the profile-aware one that already exists.
- **Field vocabularies are fragmented** across (at least) six independent lists — see Section 3. A canonical, single-sourced field registry is a prerequisite for a trustworthy field mapper, not an optional cleanup.
- **`ui_review_payload` is still the frontend's source of UI truth**, not a projection from a canonical claims store. The 23-source fallback chain in `leaseFieldResolver.js` is the practical, load-bearing embodiment of "canonical fields are computed ad hoc from wherever they can be found," the inverse of the target "canonical fields are projections from claims" principle.
- **Coverage/importance/readiness metrics are ad hoc**, not the structured `{processing_status, pages_processed, expected_items_found/missing, source_backed_claims, missing_related_documents, overall_coverage}` object the v3 contract specifies. `core_ready` is a boolean threshold, not a coverage measurement.
- **No document-profile-driven extraction planner exists** — today, extraction modules are not selected/skipped per profile (`modules_to_run` / `modules_skipped` with reasons); the same extraction groups run regardless of document type, and profile only affects downstream advisory display.

---

## 7. Phase 1 recommendations

1. **Treat `vertex_fact_ledger` as the foundation to promote and harden, not a pattern to duplicate.** It already satisfies a meaningful slice of the v3 contract (claims with evidence, profile classification with fallback, a working canonical-field mapper, advisory profile-aware blockers) and is designed as a drop-in replacement for `legacy_hybrid` via an identical result contract. Building a parallel "v3 claims system" from scratch would duplicate work that already exists and works.
2. **Durability first.** Before any UI or gating change, give the `Fact[]` ledger a real table (claim IDs, versioning, org/tenant scoping, RLS) so it survives re-extraction and can be audited — this is the single largest structural gap between what exists today and "claims are the source of truth."
3. **Close the profile-aware-gate gap deliberately, as its own reviewable slice.** The fastest, lowest-risk win available is wiring the already-built `computeProfileApprovalBlockers()` / `ApprovalBlockersPanel` output into the real `bulkEvaluation`/`canApprove` gate in `LeaseReview.jsx`, replacing the flat `REQUIRED_FIELD_KEYS` list — this alone fixes the "assignment treated like full lease" bug using code that already exists, without touching extraction.
4. **Do not add a seventh field-alias table.** Any new mapping work should consume `field-contract.ts` (backend) and converge the frontend's three independent alias tables (`leaseFieldContract.js`, `leaseReviewSchema.js`, `leaseFieldResolver.js`) onto it rather than adding another parallel definition.
5. **Reuse the server-owned-workflow template** (`docs/server-owned-workflow-pattern.md`) for any new v3 workflow — claim-ledger writes, package-graph resolution, or a hardened `approve_lease_workflow` — rather than inventing a new RPC shape.
6. **Any new migration follows the discipline in `docs/database/migration-repair.md` exactly**: unique 14-digit prefixes, additive `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, `is_member_of_org()` for new RLS policies, dry-run against the linked remote before any push. No new table should be pushed to the linked remote project without that checklist.
7. **A Document Package Graph and supersession model are real, sequenced-later work**, not Phase 1 material — they depend on the durable claim ledger existing first (a claim needs a stable ID before it can be superseded by another claim).

---

*No source file was modified to produce this document. Compiled from three parallel Explore passes (frontend Lease Review UI, backend extraction pipeline, database schema/migrations) plus direct reads of this repo's `docs/extraction-current-call-graph.md`, `docs/extraction-current-data-contract.md`, `docs/lease-standard-field-model.md`, `docs/server-owned-workflow-pattern.md`, `docs/database/migration-repair.md`, `docs/deploy/schema-sync-checklist.md`, `docs/lease-approval-server-workflow.md`, `docs/rule-cam-hardening-plan.md`, and `docs/enterprise-repo-structure.md`.*

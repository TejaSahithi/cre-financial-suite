# Lease Extraction Hardening Audit

Date: 2026-07-24
Scope: repository-first implementation review for the lease upload, extraction, review, and approval path.

## Current Flow

```text
Browser upload / re-extraction
  -> Supabase intake functions (ingest-file, upload-handler, parse-file)
  -> lease-extraction-worker orchestration and pipeline_jobs status
  -> parse-pdf-docling / parser output
  -> normalize-pdf-output
       -> _shared/extraction/pipeline.ts
          -> rule-extractor.ts
          -> table extraction path
          -> llm-extractor.ts
          -> merger.ts
          -> validator.ts
          -> calculator / lease-workflow enrichment
       -> buildReviewPayload / buildMinimalReviewPayload
       -> uploaded_files.ui_review_payload + extraction_data compatibility payload
  -> frontend resolver and review UI
       -> leaseFieldResolver.js
       -> leaseReviewSchema.js
       -> leaseReviewFieldNormalizer.js
       -> LeaseReview / approval blockers
  -> approval functions persist reviewer-approved abstract and financial records
```

## Capability Matrix

| Capability | Repository component | Current status | Stage A action |
| --- | --- | --- | --- |
| Rule/table/LLM extraction | `_shared/extraction/pipeline.ts`, `rule-extractor.ts`, `llm-extractor.ts` | Implemented | Preserved. High-risk LLM candidates continue to run even when deterministic values exist. |
| Candidate merge | `_shared/extraction/merger.ts` | Implemented | Reused. Added first-candidate evaluation, conflict status normalization, candidate IDs, decision metadata, and review blocking signals. |
| Evidence validation | `_shared/extraction/candidate-decision.ts`, `schemas.ts` | Implemented but uneven by field | Added semantic field policies for the known Macon-style false positives: property name, suite/unit, insurance responsibility, electric responsibility, conditional assignment consent, and heading-only additional insureds. |
| Canonical review status | New `_shared/extraction/review-status.ts` | Missing as a shared contract | Added canonical status enum normalization, resolution-state mapping, and authoritative-value gating. |
| Metadata propagation | `validator.ts`, `pipeline.ts`, `normalize-pdf-output/index.ts`, `leaseFieldResolver.js` | Partially connected | Propagated canonical status, resolution state, review requirements, conflict candidate IDs, and candidate decision records into payload and UI resolver data. |
| Duplicate canonical fields | `normalize-pdf-output/index.ts` review payload builder | Missing | Added canonical field key/scope and row-level duplicate canonical validation errors. |
| Approval blocking | Backend payload + frontend schema | Partially connected | Conflict/manual/invalid/insufficient evidence statuses are now canonicalized and marked `requires_review`; authoritative values are withheld for unresolved fields. |
| CAM / expense recovery tab | `lease-workflow.ts`, `leaseReviewFieldNormalizer.js`, specialized panels | Implemented, but Macon gap remains unmeasured here | Not fully closed in Stage A. Needs corpus-backed Stage C tests for expense rules and CAM display projection. |
| Golden corpus scoring | Benchmarks/test fixtures | Not found as a complete adjudicated corpus in this pass | Cannot claim 95% F1 or 98% critical precision until Macon Crossing and other leases have adjudicated expected outputs and scoring harness results. |

## Already Implemented And Preserved

- Existing six-step extraction pipeline remains the source of truth; no duplicate pipeline was introduced.
- Existing candidate merge and evidence validation modules remain in use.
- LLM `source_text` preservation, boolean negation handling, alias synchronization, conflict candidate propagation, and high-risk competing extraction behavior were preserved.
- Frontend field resolution continues to read from the existing review payload and extraction-data compatibility structures.

## Disconnected Or Weak Areas Found

- Review status vocabulary had legacy variants (`conflict_detected`, `manual_required`, `calculated`) mixed with newer review semantics, making approval gating ambiguous.
- Initial LLM-only candidates could bypass the same candidate-decision checks used for competing rule/table candidates.
- Conflict evidence could reach the UI without a stable candidate ID list or explicit decision record.
- Canonical field uniqueness was not asserted at review payload assembly.
- Critical semantic mistakes were field-specific and required policy checks rather than only confidence thresholds.

## Bugs Addressed In Stage A

- Property names can no longer be accepted from timing fragments such as `one (1) day in each calendar year`.
- Suite/unit fields reject common word fragments such as `in`.
- Insurance responsibility cannot be derived from waiver, subrogation, indemnity, casualty-proceeds, or limitation-of-liability clauses.
- Electric responsibility rejects repair-only electrical wording unless utility payment, metering, or service-charge evidence exists.
- Conditional assignment consent is downgraded to manual review and is not treated as an unconditional mandatory consent obligation.
- Heading-only `Additional Insured` evidence is rejected without operative insurance language.
- Conflicting critical candidates use canonical `conflict` status, carry conflict candidate IDs, and withhold authoritative values until reviewer resolution.

## Files Modified In This Stage

- `supabase/functions/_shared/extraction/review-status.ts`
- `supabase/functions/_shared/extraction/types.ts`
- `supabase/functions/_shared/extraction/candidate-decision.ts`
- `supabase/functions/_shared/extraction/merger.ts`
- `supabase/functions/_shared/extraction/validator.ts`
- `supabase/functions/_shared/extraction/pipeline.ts`
- `supabase/functions/_shared/extraction/schemas.ts`
- `supabase/functions/normalize-pdf-output/index.ts`
- `supabase/functions/_tests/candidate-decision.test.ts`
- `src/lib/leaseReviewSchema.js`
- `src/lib/leaseFieldResolver.js`

## Files Intentionally Not Replaced

- No new extraction orchestrator was created.
- No new candidate registry was created.
- No new approval workflow was created.
- No new frontend review surface was created.
- Existing document-intelligence and package-projection modules were not refactored for this Stage A pass.

## Accuracy Baseline

Current repository tests can verify targeted defect classes and contract compatibility, but they are not a measured lease-extraction accuracy baseline. The requested targets, measured F1 >= 95%, critical-field precision >= 98%, and zero unsupported critical autofill, require an adjudicated golden corpus that includes Macon Crossing and comparable leases. That corpus was not found as a complete local scoring asset in this pass, so the implementation must treat these targets as rollout gates, not achieved metrics.

## Staged Implementation Plan

### Stage A - Safety And Review Blocking

Status: in progress, with targeted code and regression coverage added.

- Normalize canonical review statuses and keep legacy status fields only as compatibility output.
- Evaluate every candidate, including first LLM-only candidates, through the candidate-decision policy layer.
- Preserve candidate, conflict, and decision metadata through merge, validate, normalize, and frontend resolver paths.
- Block authoritative values for conflict, manual review, invalid, insufficient evidence, and not-stated critical fields.
- Add duplicate canonical-field validation at review payload assembly.

### Stage B - Evidence And Retrieval

Status: not yet implemented in this pass.

- Build or connect the adjudicated golden corpus, including Macon Crossing.
- Add page-span and quote validation tests for critical fields.
- Score per-field precision, recall, F1, unsupported-autofill count, and conflict-routing count.
- Expand retrieval so clause category, modality, and section anchors are first-class evidence attributes.

### Stage C - Structured Legal Domains

Status: planned.

- Promote lease legal domains to structured objects: premises, dates, rent, expense recovery/CAM, insurance, assignment/subletting, repairs, utilities, termination, options, defaults, and notices.
- Prevent clause records from populating canonical fields unless they pass a field-specific mapping policy.
- Add CAM and expense-rule projection tests so expense recovery appears in the correct UI tab.

### Stage D - Dynamic Tenant-Configured Fields

Status: planned.

- Keep dynamic fields outside canonical standard keys unless tenant configuration explicitly maps them.
- Require evidence-backed mapping, candidate decisions, and reviewer approval for tenant-configured critical fields.
- Store custom fields with stable scope keys to avoid collisions with canonical lease fields.

### Stage E - Migration And Rollout

Status: planned.

- Add database migrations only after the canonical status and decision metadata contract is finalized.
- Backfill legacy review payloads with compatible status normalization where practical.
- Gate rollout on golden-corpus metrics and approval-blocking behavior, not only unit tests.

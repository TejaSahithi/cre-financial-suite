# Document Intelligence v3 Batch Advisory Audit QA

Generated: 2026-07-15
Phase: 47
Status: Phase 47 third-document uploaded-file-only QA completed - No Gate

## 1. Executive Summary

Phase 29 created a local-only, no-LLM, no-Azure diagnostic reconstruction pass that converts approved source-backed legacy projections into conservative v3 claims and evidence rows.

Approved IDs:

- org_id: `1307dd95-e7c5-4e08-833e-749444e8f4c8`
- uploaded_file_id: `fc8181e6-766d-49c7-b81b-b5d961160207`
- lease_id: `7b21f353-579d-48e8-b3dd-8e8c49743fe2`
- local run_id: `6d175b40-8f60-429f-8a29-a047e2a2e333`

Result: **13 diagnostic legacy-derived claims and 13 evidence rows created locally**.

Recommendation remains: **No Gate**.

## 2. Local-Only Target Proof

Local target checked before write:

- Supabase REST/API endpoint: `http://127.0.0.1:54321`
- Local database port: `127.0.0.1:54322`
- Docker local stack confirmed:
  - `supabase_kong_cre-financial-suite-main` maps `54321->8000`
  - `supabase_db_cre-financial-suite-main` maps `54322->5432`
- The target is loopback/local-only.
- No hosted Supabase endpoint was used.
- No remote read or remote write endpoint was used.
- No service key, secret file, or `SUPABASE_ACCESS_TOKEN` was used.

## 3. Scope Controls

Honored constraints:

- No deployment.
- No remote reads.
- No production writes.
- No service key or secret inspection.
- No `SUPABASE_ACCESS_TOKEN` use.
- No Azure call.
- No Vertex/Gemini call.
- No parse rerun.
- No extraction rerun.
- No approval behavior change.
- No Lease Review business-row change.
- No global `vertex_fact_ledger` enablement.
- No `BUSINESS_EXTRACTION_PROVIDER` change.
- No v3 advisory hard gate.

## 4. Source Evidence Inspection

Approved local rows inspected only:

- `uploaded_files.id = fc8181e6-766d-49c7-b81b-b5d961160207`
- `leases.id = 7b21f353-579d-48e8-b3dd-8e8c49743fe2`
- `document_intelligence_runs.id = 6d175b40-8f60-429f-8a29-a047e2a2e333`
- `document_canonical_field_projections` for the approved run
- `document_validation_drops` for the approved run

Before reconstruction:

| Metric | Count |
| --- | ---: |
| projections | 82 |
| source-backed projection candidates | 17 |
| claims | 0 |
| evidence rows | 0 |
| validation drops | 4 |

The stored `docling_raw` payload is present and has page/markdown markers. Reconstruction used only projection values that already had usable `source_text`.

## 5. Diagnostic Claim Shape

Every reconstructed claim uses a conservative generic shape:

| Attribute | Value |
| --- | --- |
| claim_type | `legacy_field_projection` |
| subject | `{ type: "document", role: "unknown" }` |
| predicate | `has_field_value` |
| object | `{ field_key, value, normalized_value }` |
| extraction_mode | existing projection mode, otherwise `normalized` |
| evidence_sufficiency | `partial` |
| evidence support_type | `direct_quote` |

No legal obligations, rights, restrictions, CAM/expense rules, or clause claims were inferred from bare fields.

## 6. Rows Written Locally

Local tables written for the approved run only:

| Table | Rows / update |
| --- | ---: |
| `document_claims` | 13 inserted |
| `document_claim_evidence` | 13 inserted |
| `document_validation_drops` | 4 inserted |
| `document_intelligence_runs` | diagnostic counts updated |

After reconstruction:

| Metric | Count |
| --- | ---: |
| projections | 82 |
| claims | 13 |
| evidence rows | 13 |
| validation drops | 8 |

## 7. Fields Reconstructed

Claims/evidence were reconstructed for:

- `all_other_terms_remain_same`
- `amended_base_rent_for_additional_year`
- `assignee_name`
- `assignee_notice_address`
- `assignment_consideration`
- `assignment_effective_date`
- `assignment_provisions`
- `assumption_scope`
- `landlord_consent`
- `property_address`
- `security_deposit`
- `square_footage`
- `tenant_signatory_name`

## 8. Fields Skipped Or Dropped

| Field | Reason |
| --- | --- |
| `landlord_signature_date` | `signature_date_sourced_from_original_lease_date` |
| `lease_term_months` | `source_text_does_not_support_numeric_term_months` |
| `status` | `source_text_does_not_support_status_value` |
| `tenant_signature_date` | `signature_date_sourced_from_original_lease_date` |

Populated fields still source-less:

- `tenant_name`

## 9. Updated Advisory Audit Result

| Metric | Value |
| --- | --- |
| documents audited | 1 |
| documents skipped | 0 |
| agreement level | partial_agreement_with_v3_more_profile_aware_and_evidence_mismatch_reduced |
| discrepancy count | 4 |
| recommendation | No Gate |

Evidence mismatch:

| State | Projections | Claims | Evidence |
| --- | ---: | ---: | ---: |
| before Phase 29 | 82 | 0 | 0 |
| after Phase 29 | 82 | 13 | 13 |

The evidence mismatch is reduced but not resolved. Most projections still do not have durable reconstructed claims/evidence, and `tenant_name` remains a populated source-less field.

## 10. Assignment, Profile, Related Document Checks

Assignment false full-lease blocker:

- current path still has false full-lease blockers: yes
- v3 still avoids hard full-lease gate: yes
- blocker fields: `annual_rent`, `base_year`, `cam_amount`, `expense_stop`, `lease_type`, `monthly_rent`, `rent_per_sf`

Profile:

- current profile_key: `assignment`
- assignment/assumption/amendment signal present: yes
- profile changed: no
- reason: Phase 29 reconstructs evidence only and does not change profile classification.

Related document:

- original lease requirement status: `missing`
- advisory/current-truth gap: yes
- hard gate applied: no

Temporal/supersession:

- temporal status: `blocked_missing_related_document`
- timeline available: no
- blocked by missing original lease: yes
- diagnostic only: yes

## 11. Validation Drops

Before Phase 29: 4 drops.

After Phase 29: 8 drops.

Reasons after reconstruction:

| Reason | Count |
| --- | ---: |
| Required field `end_date` is missing | 2 |
| Required field `start_date` is missing | 2 |
| `signature_date_sourced_from_original_lease_date` | 2 |
| `source_text_does_not_support_numeric_term_months` | 1 |
| `source_text_does_not_support_status_value` | 1 |

## 12. Risks And Remaining Blockers

- Evidence improved from 0 to 13 rows, but the run still does not have full durable fact-ledger coverage.
- `tenant_name` is populated but source-less and should not be converted into a claim without usable evidence.
- Original lease remains missing, so related-document/current-truth diagnostics remain advisory and incomplete.
- Current review still has assignment false full-lease blockers.
- The reconstructed claims are diagnostic legacy projections, not authoritative legal clause claims.

## 13. Verification

Because Phase 29 changed only local DB diagnostic rows and the QA report files, full app lint/typecheck/build/test was not required for source safety. No source/helper/edge code changed.

Required report verification:

- QA JSON parse check: passed

## 14. Recommendation: Gate / No Gate

**Recommendation: No Gate.**

Phase 29 reduced the evidence mismatch but did not resolve durable claim/evidence coverage or related-document/current-truth gaps. v3 should remain advisory-only.

## Phase 30 Business Review Report

Phase 30 produced a business-review report for the reconstructed diagnostic claims/evidence and validation drops.

Report created:

- `docs/document-intelligence-v3-phase30-business-review.md`

Reviewed counts:

| Item | Count |
| --- | ---: |
| reconstructed claims reviewed | 13 |
| evidence rows reviewed | 13 |
| validation/source-less issues reviewed | 5 |

Key business findings:

- Current review path still applies false full-lease blockers to an assignment document.
- v3 profile-aware path avoids a hard full-lease gate.
- Original lease is missing and should remain an advisory/current-truth related-document gap.
- Reconstructed legacy evidence is useful but incomplete and not sufficient for approval gating.
- `tenant_name` remains source-less and should not be promoted to a claim without usable evidence.

Recommendation remains: **No Gate**.

## Phase 31A Vertex Fact Ledger Preflight

Phase 31A prepared a controlled one-document `vertex_fact_ledger` extraction test plan for the approved assignment document. No provider call, extraction rerun, deploy, remote read, production write, approval change, or Lease Review business-row change occurred.

Approved IDs:

- org_id: `1307dd95-e7c5-4e08-833e-749444e8f4c8`
- uploaded_file_id: `fc8181e6-766d-49c7-b81b-b5d961160207`
- lease_id: `7b21f353-579d-48e8-b3dd-8e8c49743fe2`
- current local diagnostic run_id: `6d175b40-8f60-429f-8a29-a047e2a2e333`

### Source Data Availability

| Check | Result |
| --- | --- |
| uploaded file exists locally | yes |
| lease exists locally | yes |
| diagnostic run exists locally | yes |
| `docling_raw` present | yes |
| page-marked text present | yes |
| canonical layout buildable | yes |
| `normalized_output` present | yes |
| `ui_review_payload` present | yes |
| lease linkage present | yes |
| projections / drops / reconstructed claims / evidence present | yes |
| package graph related-document requirement present | yes |

Source data is sufficient for a one-document `vertex_fact_ledger` test, provided the future phase has explicit approval and valid scoped provider configuration.

### Execution Path

The future run would enter through `supabase/functions/normalize-pdf-output/index.ts`. Provider selection happens in `resolveBusinessExtractionProvider(...)`; the future execution must scope `BUSINESS_EXTRACTION_PROVIDER=vertex_fact_ledger` to this one run only.

The selected function would be `runVertexFactLedgerPipeline(input, options)` from `supabase/functions/_shared/extraction/vertex-fact-ledger/orchestrator.ts`.

Expected input includes:

- `docling`: approved `uploaded_files.docling_raw`
- `moduleType`: lease/leases
- `documentSubtype`: assignment
- `fileName`: approved uploaded file name
- optional file mode fields only if explicitly enabled; default is text mode

Expected output is the existing `ExtractionPipelineResult` shape: `{ rows, method, warnings, validationErrors, metadata }`, including `metadata.extractionDebug.vertex_fact_ledger`.

Model calls in the future run:

- `profile-classifier.ts` calls Vertex JSON once over head/tail text, with regex fallback.
- `fact-ledger-extractor.ts` calls Vertex JSON over up to 4 chunks by default.
- File mode is disabled by default and only reachable with `VERTEX_FACT_LEDGER_FILE_MODE=true` plus file payload.

Raw full model output is not currently persisted as a raw response. Parsed facts/debug metadata are persisted through `normalized_output.metadata.extractionDebug.vertex_fact_ledger` and mapped by `document-intelligence-v3/fact-mapper.ts` into v3 tables during side-write.

### Provider Config Preflight

No secret values were printed or inspected. Current process environment presence only:

| Variable | Present |
| --- | --- |
| `ENABLE_DOCUMENT_INTELLIGENCE_V3` | no |
| `BUSINESS_EXTRACTION_PROVIDER` | no |
| `VERTEX_PROJECT_ID` or `GOOGLE_PROJECT_ID` | no |
| `VERTEX_LOCATION` or `GOOGLE_LOCATION` | no |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | no |
| `GOOGLE_CLIENT_EMAIL` + `GOOGLE_PRIVATE_KEY` | no |
| `GEMINI_API_KEY` or `GOOGLE_API_KEY` | no |

Staging provider config was not checked because Phase 31A forbids remote reads and secret inspection.

### Phase 31B Guardrails

A future approved execution must use:

- exactly one approved `uploaded_file_id`
- exactly one approved `lease_id`
- local/staging only
- `ENABLE_DOCUMENT_INTELLIGENCE_V3=true` scoped to the execution only
- `BUSINESS_EXTRACTION_PROVIDER=vertex_fact_ledger` scoped to the execution only
- no global env/default change
- no deploy
- no production writes
- no approval behavior change
- no Lease Review business-row change
- no v3 hard gate

### Cost And Safety Boundary

- Maximum one document.
- Maximum one extraction attempt.
- No batch.
- No retry unless explicitly approved after a failure report.
- Log provider/model used.
- Log prompt bundle/pipeline version if available.
- Log token/cost metadata if available.
- Stop on provider auth/config failure.
- Stop on malformed output without repeated calls.

### Expected Phase 31B Local Writes

A future approved run would write or replace only rows tied to the new Phase 31B run/idempotency key:

- `document_intelligence_runs`
- `document_claims`
- `document_claim_evidence`
- `document_canonical_field_projections`
- `document_validation_drops`
- package graph rows if produced
- advisory/QA report files

It must not mutate approval state, review status, hosted data, Lease Review business rows, or the existing Phase 26/29 diagnostic run unless explicitly approved.

### Rollback Plan

Identify the future run by its Phase 31B idempotency key and run id. Delete only rows tied to that run:

1. Delete `document_claim_evidence` for claims on the Phase 31B run.
2. Delete `document_validation_drops` for the Phase 31B run.
3. Delete `document_canonical_field_projections` for the Phase 31B run.
4. Delete package graph relationship/requirement/document/package rows tied to the Phase 31B run/package.
5. Delete `document_claims` for the Phase 31B run.
6. Delete the `document_intelligence_runs` row matching the Phase 31B run/idempotency key.

Do not delete current local diagnostic run `6d175b40-8f60-429f-8a29-a047e2a2e333`, source fixture rows, or Phase 26/29 diagnostic rows unless explicitly approved.

### Decision

Phase 31B is **not safe to run yet** in this environment because provider credentials and scoped execution flags are not present in current process env, and staging config was intentionally not checked.

Phase 31B can proceed only after explicit user approval for one provider call and confirmation that scoped local/staging provider configuration is available.

Recommendation remains: **No Gate**.

## Phase 31B Controlled Provider Attempt

Phase 31B reached the execution gate but stopped before any provider call. No Vertex/Gemini call was made, no extraction was rerun, no production data was written, no approval behavior changed, and no Lease Review business rows changed.

Approved IDs:

- org_id: `1307dd95-e7c5-4e08-833e-749444e8f4c8`
- uploaded_file_id: `fc8181e6-766d-49c7-b81b-b5d961160207`
- lease_id: `7b21f353-579d-48e8-b3dd-8e8c49743fe2`
- prior local diagnostic run_id: `6d175b40-8f60-429f-8a29-a047e2a2e333`

### Safe Target Proof

| Check | Result |
| --- | --- |
| REST/API target | local `127.0.0.1:54321` |
| DB target | local `127.0.0.1:54322` |
| Docker DB container | `supabase_db_cre-financial-suite-main` |
| target type | local |
| production target | no |
| production write endpoint used | no |
| service key used | no |
| `SUPABASE_ACCESS_TOKEN` used | no |
| scoped upload/lease only | yes |

### Scoped Provider Config Gate

Provider call made: **no**.

Reason: required scoped provider flags and Vertex/Gemini credentials were missing in the current process environment.

Missing required config:

- `ENABLE_DOCUMENT_INTELLIGENCE_V3=true`
- `BUSINESS_EXTRACTION_PROVIDER=vertex_fact_ledger`
- `VERTEX_PROJECT_ID` or `GOOGLE_PROJECT_ID`
- `GOOGLE_SERVICE_ACCOUNT_KEY`, or `GOOGLE_CLIENT_EMAIL` plus `GOOGLE_PRIVATE_KEY`
- optional fallback `GEMINI_API_KEY` or `GOOGLE_API_KEY` was also absent

No secret values were printed or inspected.

### Source Data Confirmation

Approved source data is still sufficient for a future one-document run:

| Check | Result |
| --- | --- |
| uploaded file exists | yes |
| lease exists | yes |
| prior diagnostic run exists | yes |
| `docling_raw` present | yes |
| page markers / pages present | yes |
| markdown present | yes |
| document text available | yes |
| canonical layout buildable | yes |
| `normalized_output` present | yes |
| `ui_review_payload` present | yes |
| lease linkage present | yes |
| Azure needed | no |
| parse rerun needed | no |

Current local diagnostic counts remain:

| Row set | Count |
| --- | ---: |
| projections | 82 |
| validation drops | 8 |
| claims | 13 |
| evidence | 13 |
| package documents | 1 |
| related document requirements | 1 |

### Execution Result

| Item | Result |
| --- | --- |
| provider attempts | 0 |
| retry occurred | no |
| new run_id | none |
| provider/model used | none |
| token/cost metadata | none |
| malformed output | no; no provider output was produced |

No provider-backed v3 diagnostic run was created.

### Comparison To Prior Run

Prior run remains `6d175b40-8f60-429f-8a29-a047e2a2e333`.

| Finding | Status |
| --- | --- |
| tenant_name evidence | unchanged; source-less from Phase 30 |
| invalid signature dates | unchanged; dropped from Phase 29 |
| original lease | missing |
| related-document gap | advisory |
| current review false full-lease blockers | remain |

No advisory audit was rerun against a new run because no new run exists.

### Rollback

Rollback is not needed because Phase 31B created no provider-backed v3 rows.

If a future provider-backed run is created, identify it by its new `run_id` and idempotency key, then delete only rows tied to that run. Do not delete approved source fixture rows or prior diagnostic run `6d175b40-8f60-429f-8a29-a047e2a2e333` unless explicitly approved.

### Recommendation

Recommendation remains: **No Gate**.

## Phase 32 Controlled Provider Attempt

Phase 32 re-ran the controlled one-document `vertex_fact_ledger` execution gate for the approved assignment document. It stopped before any provider call because scoped local/staging provider configuration was still not present in the current process environment.

Provider call made: **no**.

Approved IDs:

- org_id: `1307dd95-e7c5-4e08-833e-749444e8f4c8`
- uploaded_file_id: `fc8181e6-766d-49c7-b81b-b5d961160207`
- lease_id: `7b21f353-579d-48e8-b3dd-8e8c49743fe2`
- prior local diagnostic run_id: `6d175b40-8f60-429f-8a29-a047e2a2e333`

### Safe Target Re-Proof

| Check | Result |
| --- | --- |
| REST/API port `127.0.0.1:54321` | reachable |
| DB port `127.0.0.1:54322` | reachable |
| Docker Kong container | `supabase_kong_cre-financial-suite-main` maps `54321->8000` |
| Docker DB container | `supabase_db_cre-financial-suite-main` maps `54322->5432` |
| target type | local |
| production target | no |
| production write endpoint used | no |
| service key used | no |
| `SUPABASE_ACCESS_TOKEN` used | no |

### Scoped Provider Config Gate

No secret values were printed or inspected. Presence-only checks showed:

| Required item | Present / ready |
| --- | --- |
| `ENABLE_DOCUMENT_INTELLIGENCE_V3=true` | no |
| `BUSINESS_EXTRACTION_PROVIDER=vertex_fact_ledger` | no |
| `VERTEX_PROJECT_ID` or `GOOGLE_PROJECT_ID` | no |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | no |
| `GOOGLE_CLIENT_EMAIL` plus `GOOGLE_PRIVATE_KEY` | no |
| required provider config ready | no |

Optional fallback `GEMINI_API_KEY` / `GOOGLE_API_KEY` was also absent.

Because this gate failed, Phase 32 made zero provider attempts, performed no retry, created no new run, and produced no token/cost metadata.

### Source Data Confirmation

Approved local source data is still available for a future one-document run:

| Check | Result |
| --- | --- |
| uploaded file exists | yes |
| lease exists | yes |
| prior diagnostic run exists | yes |
| `docling_raw` present | yes |
| page markers present | yes |
| markdown present | yes |
| document text available | yes |
| canonical layout buildable | yes |
| `normalized_output` present | yes |
| `ui_review_payload` present | yes |
| lease linkage present | yes |
| Azure needed | no |
| parse rerun needed | no |

Current approved diagnostic row counts remain:

| Row set | Count |
| --- | ---: |
| projections | 82 |
| validation drops | 8 |
| claims | 13 |
| evidence | 13 |
| package documents | 1 |
| related document requirements | 1 |

Profile remains `assignment`. The related-document requirement remains `original_lease`, status `missing`, importance `high`.

### Comparison To Prior Run

No provider-backed run was created, so the prior diagnostic run remains unchanged:

| Finding | Status |
| --- | --- |
| tenant_name evidence | unchanged; source-less from Phase 30 |
| invalid signature dates | unchanged; dropped from Phase 29 |
| original lease | missing |
| related-document gap | advisory |
| current review false full-lease blockers | remain |

No advisory audit was rerun against a new run because no new run exists.

### Rollback

Rollback is not needed because Phase 32 created no provider-backed v3 rows.

If a future provider-backed run is created, identify it by its new `run_id` and idempotency key, then delete only rows tied to that run. Do not delete approved source fixture rows or prior diagnostic run `6d175b40-8f60-429f-8a29-a047e2a2e333` unless explicitly approved.

### Recommendation

Recommendation remains: **No Gate**.

## Phase 33 Current Review Profile-Aware Blockers

Phase 33 changed the current Lease Review readiness path so assignment documents no longer inherit full base-lease blocker noise. This is a current-review policy fix only. It does not enable v3 as a hard gate, does not change persisted approval state, and does not change Lease Review business rows.

Approved IDs:

- uploaded_file_id: `fc8181e6-766d-49c7-b81b-b5d961160207`
- lease_id: `7b21f353-579d-48e8-b3dd-8e8c49743fe2`
- local diagnostic run_id: `6d175b40-8f60-429f-8a29-a047e2a2e333`

### Blocker Logic Changed

| Area | Phase 33 behavior |
| --- | --- |
| base lease | Existing `REQUIRED_FIELD_KEYS` remain hard blockers. |
| assignment-like profiles | Assignment/amendment essentials are required; base-lease economics/CAM fields are not hard blockers. |
| unknown CRE documents | Do not default to base lease blockers; show advisory/needs-review context. |
| original lease missing | Advisory current-truth gap, not a fake missing-field failure for every base lease field. |

The false full-lease blocker source was the Lease Review path consuming global `REQUIRED_FIELD_KEYS` for all document profiles. The new policy layer makes that required-key list depend on the detected current-review profile.

### Approved Assignment Expected Behavior

| Check | Result |
| --- | --- |
| profile | `assignment` |
| policy | `assignment_document` |
| apply base lease blockers | no |
| base lease noise still required | none |
| remaining missing required fields | `assignor_name` |
| original lease gap | advisory current-truth gap |
| budget blockers | none |
| CAM blockers | none |

### Tests Added/Updated

- `src/lib/__tests__/leaseReviewCurrentPolicy.test.js`

Coverage includes assignment documents not inheriting base lease blockers, base leases retaining existing blockers, unknown documents not defaulting to base lease blockers, original lease missing as advisory/current-truth gap, existing review resolution semantics, and enrichment banner wiring.

### Files Changed

- `src/lib/leaseReviewCurrentPolicy.js`
- `src/lib/leaseReviewFieldNormalizer.js`
- `src/pages/LeaseReview.jsx`
- `src/lib/__tests__/leaseReviewCurrentPolicy.test.js`
- `docs/document-intelligence-v3-batch-audit-qa.md`
- `docs/document-intelligence-v3-batch-audit-qa.json`

### Recommendation

Recommendation remains: **No Gate**.

## Phase 34 Recommendation

Manually verify the approved assignment Lease Review screen and have business/legal confirm the assignment-specific required-field policy before any approval-gating changes.
## Phase 34 Manual Verification

Phase 34 started the local app and attempted to open the approved assignment Lease Review route:

`http://127.0.0.1:5173/LeaseReview?id=7b21f353-579d-48e8-b3dd-8e8c49743fe2`

The local environment was verified as local-only: frontend Supabase URL host `127.0.0.1`, port `54321`; local Supabase Kong and DB were running; no hosted endpoint, remote read, provider call, extraction rerun, production write, secret/service-key use, or `SUPABASE_ACCESS_TOKEN` use occurred.

The isolated headless browser redirected to `/Login`, so the full visible Lease Review UI checklist was not completed in this run. Manual UI verification status: **blocked by authentication**.

Local current-review policy verification against the approved lease joined to the approved uploaded file did complete:

| Check | Result |
| --- | --- |
| profile | `assignment` |
| policy | `assignment_document` |
| apply base lease blockers | no |
| base lease noise still required | none |
| remaining hard blockers | `assignor_name` |
| advisory gaps | `original_lease_missing` |
| budget blockers | none |
| CAM blockers | none |

Evidence issues remain advisory/needs-review:

| Issue | Result |
| --- | --- |
| claims with evidence | 13 |
| source-backed projections | 18 |
| `tenant_name` | source-less, `needs_review` |
| invalid signature dates | validation drops, not accepted facts |
| unsupported status / lease term values | validation drops, not accepted facts |

Phase 34 report created: `docs/document-intelligence-v3-phase34-manual-verification.md`.

Recommendation remains: **No Gate**.

## Phase 35 Recommendation

Run authenticated local visual verification for the approved assignment Lease Review screen using a user-approved local test session. Confirm the visible Required Review panel, Readiness Summary, Approval Blockers panel, tab tables, action controls, and original lease advisory text. Keep the result advisory-only and do not change approval gating without explicit business/legal signoff.
## Phase 35 Authenticated UI Verification

Phase 35 established a local-only authenticated test session and reached the approved Lease Review screen:

`http://127.0.0.1:5173/LeaseReview?id=7b21f353-579d-48e8-b3dd-8e8c49743fe2`

No deploy, remote read, hosted data change, production write, service-role key, `SUPABASE_ACCESS_TOKEN`, Azure call, Vertex/Gemini call, parse rerun, extraction rerun, approval behavior change, or v3 hard gate occurred.

Visual verification result:

| Check | Result |
| --- | --- |
| authenticated local session established | yes |
| approved Lease Review screen reached | yes |
| profile shown | `assignment` |
| assignment policy copy visible | yes |
| full base-lease economics blockers removed in UI | yes |
| Budget hard blockers visible | no |
| CAM hard blockers visible | no |
| original lease advisory shown | yes |
| tenant_name source-less issue | visible as hard blocker despite visible source text |
| action controls verified | partial; Accept/Edit/Reject icon buttons visible |
| action dropdown verified | no |
| Mark Needs Review / Mark N/A / View Source visible | no |
| enrichment banner verified | yes; banner visible |
| unexpected Type column present | yes |

Visible remaining hard blockers:

- Tenant Name: value present but no valid supporting source text
- Assignor Name: missing value
- Landlord Consent: needs review

Phase 35 report created: `docs/document-intelligence-v3-phase35-authenticated-ui-verification.md`.

Recommendation remains: **No Gate**.

## Phase 36 UI Contract Fix

Phase 36 fixed the remaining Lease Review UI contract gaps identified during authenticated Phase 35 verification.

### Phase 36 Results

| Check | Result |
| --- | --- |
| Type column removed from tab table | yes |
| row action dropdown added | yes |
| dropdown includes Accept/Edit/Mark Needs Review/Mark N/A/Reject/View Source | yes |
| Tenant Name duplicate hard assignment blocker removed | yes; advisory review signal only |
| Landlord Consent duplicate hard assignment blocker removed | yes; advisory review signal only |
| Assignor assignment-essential blocker preserved | yes |
| enrichment banner exactness centralized | yes; pending/running only |
| authenticated visual verification | blocked by local browser profile redirecting to Login |

Report created:

- `docs/document-intelligence-v3-phase36-ui-contract-verification.md`

### Phase 36 Verification

| Check | Result |
| --- | --- |
| focused Lease Review policy/UI tests | passed, 3 files / 12 tests |
| `npm run lint` | passed |
| `npm run typecheck` | passed |
| `npm run build` | passed with existing Vite warnings |
| `npm run test` | passed, 55 files / 590 tests |

No deploy, remote read, production write, service-role key, `SUPABASE_ACCESS_TOKEN`, Azure call, Vertex/Gemini call, parse rerun, extraction rerun, approval behavior change, Lease Review business-row redesign, or v3 hard gate occurred.

Recommendation remains: **No Gate**.

## Phase 37 Recommendation

Run authenticated local visual verification again after providing or recreating an approved local-only auth session. Confirm the visible Approval Blockers panel only shows assignment-essential hard blockers, the row action dropdown options are visible, and the enrichment banner appears only for `pending` or `running` enrichment status.

## Phase 37 Authenticated UI Verification

Phase 37 established a fresh local-only authenticated test session and reached the approved Lease Review screen:

`http://127.0.0.1:5173/LeaseReview?id=7b21f353-579d-48e8-b3dd-8e8c49743fe2`

No deploy, remote read, production write, service-role key, `SUPABASE_ACCESS_TOKEN`, Azure call, Vertex/Gemini call, parse rerun, extraction rerun, approval state change, Lease Review business-row redesign, global provider change, or v3 hard gate occurred.

### Phase 37 Visual Result

| Check | Result |
| --- | --- |
| authenticated local session established | yes |
| approved Lease Review screen reached | yes |
| Type column visible | no |
| action dropdown visible | yes |
| dropdown options verified | Accept, Edit, Mark Needs Review, Mark N/A, Reject, View Source |
| required hard blockers for approved assignment | Assignor Name only |
| Tenant Name hard blocker | no; advisory warning only |
| Landlord Consent hard blocker | no; advisory warning only |
| Landlord Consent For Transfer hard blocker | no |
| base lease economics blockers | no |
| CAM hard blockers | no |
| Budget hard blockers | no |
| original lease advisory/current-truth gap | yes |
| source/page columns visible | yes |
| enrichment banner | visible for the current in-flight fixture |
| console errors | 0 |

### Phase 37 Regression Found And Fixed

Authenticated verification found one real regression after Phase 36: the advisory blocker normalization still used the raw field contract path, so assignment advisory signals could leak into the profile-required panel.

Fix applied:

- `normalizeApprovalBlockers` now uses `currentReviewPolicy.requiredFieldKeys`.
- Assignment advisory gaps stay warnings.
- Assignment documents no longer inherit base-lease Budget/CAM blocker noise in the client estimate.

Focused Lease Review tests were updated to prove `tenant_name`, `landlord_consent`, and `landlord_consent_for_transfer` are not assignment hard blockers.

Report created:

- `docs/document-intelligence-v3-phase37-authenticated-ui-verification.md`

Recommendation remains: **No Gate**.

## Phase 38 Recommendation

Run business/legal review of the verified assignment Lease Review behavior. Confirm that Assignor Name is the correct remaining hard blocker, Tenant Name and Landlord Consent are correctly advisory for this assignment profile, and the original lease gap should remain advisory/current-truth rather than approval-blocking.

## Phase 38 Lease Review Requirements Projection

Phase 38 tested whether Lease Review projects the 12 stated product requirements correctly for the approved assignment document.

**Method note:** this session had no browser automation tool available (no Playwright/Puppeteer/CDP tool registered, none installed in the repo). Per explicit user decision, Phase 38 substituted **code + local data verification**: the real, unmodified `normalizeLeaseReviewData(...)` production function was executed (via a temporary, deleted-after-use Vitest file) against the approved rows read directly and read-only from local Postgres, and rendering-only facts (columns, dropdown wiring, read-only-ness, admin gating) were confirmed by direct source read. This is not a fresh browser/DOM capture; it is explicitly labeled as such in the full report.

Approved IDs:

- uploaded_file_id: `fc8181e6-766d-49c7-b81b-b5d961160207`
- lease_id: `7b21f353-579d-48e8-b3dd-8e8c49743fe2`
- local diagnostic run_id: `6d175b40-8f60-429f-8a29-a047e2a2e333`

### Requirements Tested

| Metric | Count |
| --- | ---: |
| requirements tested | 35 |
| passed | 28 |
| partial | 4 |
| failed | 3 |

### Highest-Priority Gaps Found

1. **Split-brain profile detection (bug):** `detectDocumentProfile(leaseFull)` returns `"unknown"` for the approved document, while `currentReviewPolicy.profile` (a separate, more thorough resolver) correctly returns `"assignment"`. The former gates the Assignment/Amendment/Consent banner and `FULL_LEASE_ONLY_TABS` hiding in `LeaseReview.jsx`, so those do not engage for this document even though blocker/readiness logic correctly does.
2. **Signature dates accepted from the original lease date (bug):** `tenant_signature_date` and `landlord_signature_date` both resolve to `2018-02-01` with `status: "auto_populated"` and `evidenceVerified: true`, sourced from text describing the *original lease date*, not a signature. This is exactly the case the architecture doc's validation rules forbid, and the separate v3 diagnostic layer (Phase 29/30) already drops these two fields correctly — but that fix was never ported to the current-review path users actually see.
3. **`landlord_name` still resolves to literal `"<figure>"` (bug):** the same defect named in the architecture doc's own immediate-fix list, still unresolved.
4. **Extraction Mode column and underlying data model are both missing (bug / partial provider-backed gap):** the tab table has 7 columns, not the 8 required (`Extraction Mode` absent); most standard fields also don't carry an independent explicit/inferred/calculated/reviewer-entered tag in the row model at all.

None of these are approval-gating today — the assignment blocker set (`assignor_name` only) is unaffected — but 2 and 3 mean reviewers can see incorrect-looking values presented as accepted facts.

### Does Lease Review Project The Requirements Correctly?

**Mostly yes for profile-aware blocker/readiness behavior** (Phases 33-37's work holds up under this deeper check), **but no** for full requirements-contract conformance: 3 requirement failures and 4 partial results remain, most notably two cases where incorrect/invalid values are shown as accepted facts rather than needs-review, and the Extraction Mode column called for by the product spec doesn't exist.

Full detail: `docs/document-intelligence-v3-phase38-lease-review-requirements-projection.md`

### Recommendation

Recommendation remains: **No Gate**.

## Phase 39 Recommendation

Fix the two evidence-integrity bugs found in Phase 38 without changing approval-gating behavior: (1) port the existing "original lease date ≠ signature date" validation rule from the v3 diagnostic layer into the current-review field path so `tenant_signature_date`/`landlord_signature_date` stop showing as accepted facts, and (2) apply the invalid-markup (`<figure>`) rejection rule to `landlord_name` and any other field resolver output. Separately, reconcile `detectDocumentProfile` with `currentReviewPolicy`'s profile resolution so the assignment banner and full-lease-tab hiding don't disagree with the blocker logic on the same document. Decide and scope the Extraction Mode column/data-model work as a distinct follow-up, since it likely needs extractor-side (provider-backed) changes beyond a simple UI column add.

## Phase 39 Evidence-Integrity Bug Fixes + Profile Detection Reconciliation

Phase 39 fixed all three Phase 38 bugs in the user-facing Lease Review path only, without changing approval-gating behavior, persisted approval state, or base-lease behavior, and without touching Extraction Mode (deferred to Phase 40).

Approved IDs:

- uploaded_file_id: `fc8181e6-766d-49c7-b81b-b5d961160207`
- lease_id: `7b21f353-579d-48e8-b3dd-8e8c49743fe2`
- local diagnostic run_id: `6d175b40-8f60-429f-8a29-a047e2a2e333`

### Bugs Reproduced And Fixed

| Bug | Reproduced | Fixed |
| --- | --- | --- |
| Split-brain profile detection (`detectDocumentProfile` "unknown" vs `currentReviewPolicy.profile` "assignment") | yes, fixture-level test | yes |
| Signature dates accepted from original-lease-reference text | yes, real document source text | yes |
| `landlord_name` literal `"<figure>"` value | yes, real document source text | yes |

### Fix Summary

- `src/pages/LeaseReview.jsx`: `isAssignmentOnlyDocument` now derives from `normalized.currentReviewPolicy?.profile === "assignment"` instead of a separate `detectDocumentProfile()` call; unused import removed. Base-lease full-lease-signal override behavior is unchanged.
- `src/lib/leaseReviewSchema.js`: added `isMarkupArtifactValue()` — narrow, generic rejection of bare-tag layout artifacts (`<figure>`, `<table>`, `<tr>`, `<td>`, etc.).
- `src/lib/leaseReviewFieldNormalizer.js`: added `isSignatureDateSourcedFromLeaseReference()`, scoped to exactly `tenant_signature_date`/`landlord_signature_date`; `normalizeStandardFields` now rejects markup-artifact values (nulls the value, forces `evidenceVerified: false`, sets `invalidValueRejected: true` and a `validationMessage`) and demotes lease-reference-sourced signature dates to `needs_review` with `evidenceVerified: false` (value retained, not fabricated away).

### Blocker Carve-Out (Design Decision)

Rejecting `landlord_name`'s invalid value would, without a carve-out, have turned it into a **second** hard blocker alongside `assignor_name` (it was already in the assignment profile's `requiredFieldKeys`). Per explicit user decision, `invalidValueRejected` was added as a narrow, single-set-site flag (only inside `normalizeStandardFields`'s markup-rejection branch) read only by `hasRowValue()` and `normalizeApprovalBlockers()`'s two `missingFields`-push sites, purely to keep this display fix from silently expanding the approval-blocker set. It is additive only and cannot mask an independently, genuinely missing field. The signature-date fix (Bug 2) does not use this flag at all — it retains the value, so no carve-out was needed there.

### Phase 38-Style Rerun Result

Re-ran the real `normalizeLeaseReviewData()` against the approved local rows (fresh read-only local Postgres dump, temporary Vitest file deleted after — still no browser tool available this session):

| Check | Before | After |
| --- | --- | --- |
| `isAssignmentOnlyDocument` would resolve to | `false` | `true` |
| `landlord_name` value / status | `"<figure>"` / `needs_review` | `null` / `missing` |
| `tenant_signature_date` status / evidenceVerified | `auto_populated` / `true` | `needs_review` / `false` (value retained) |
| `landlord_signature_date` status / evidenceVerified | `auto_populated` / `true` | `needs_review` / `false` (value retained) |
| `approvalBlockers.missingFields` | `["assignor_name"]` | `["assignor_name"]` (unchanged) |
| `readinessSummary.missingRequiredFields` | `["assignor_name"]` | `["assignor_name"]` (unchanged) |
| `budgetReadiness` / `camReadiness` | ready / ready | ready / ready (unchanged) |

### Tests Added

12 new tests: 4 in `leaseReviewCurrentPolicy.test.js` (profile reconciliation), 8 in `leaseReviewFieldNormalizer.test.js` (signature-date + invalid-markup, including the no-new-blocker regression test).

### Verification

| Check | Result |
| --- | --- |
| Focused `leaseReviewCurrentPolicy.test.js` | 13/13 passed |
| Focused `leaseReviewFieldNormalizer.test.js` | 22/22 passed |
| `npm run lint` | passed, no errors |
| `npm run typecheck` | passed, no errors |
| `npm run build` | passed with pre-existing Vite chunk-size warnings only |
| `npm run test` | passed, 55 files / 602 tests (590 prior + 12 new) |

### Remaining Gaps

- Extraction Mode column/data model — untouched, fully deferred to Phase 40.
- `tenant_name` source-less/needs-review — pre-existing, correct, not a bug.
- `landlord_consent` `evidenceVerified: false` despite clear source text — pre-existing generic evidence-quality behavior, not one of the three named bugs, not changed this phase.

### Recommendation

Recommendation remains: **No Gate**.

## Phase 40 Recommendation

Scope and implement the Extraction Mode column and its underlying explicit/inferred/calculated/reviewer-entered data model. Most standard fields currently carry no such tag at all (only expense/CAM rule-derived fields ever get stamped `"calculated"`), so this likely needs more than a client-only column add — possibly extractor-side (provider-backed) support. Do not conflate with approval-gating changes.

## Phase 40 Extraction Mode Column + Data Model

Phase 40 added the required 8th `Extraction Mode` table column, backed by a real `extractionMode` value on every standard field row, without changing approval-gating behavior, persisted approval state, or base-lease behavior.

Approved IDs:

- uploaded_file_id: `fc8181e6-766d-49c7-b81b-b5d961160207`
- lease_id: `7b21f353-579d-48e8-b3dd-8e8c49743fe2`
- local diagnostic run_id: `6d175b40-8f60-429f-8a29-a047e2a2e333`

### Extraction Mode Vocabulary

| Mode | Meaning |
| --- | --- |
| `explicit` | Directly stated in source text, usable evidence |
| `normalized` | Derived from a direct value via formatting/normalization |
| `inferred` | Inferred from context, not directly stated |
| `calculated` | Computed from other extracted values |
| `reviewer_entered` | Entered/corrected by a human reviewer |
| `manual` | Manually marked/overridden, not enough detail for reviewer_entered |
| `unknown` | Cannot be safely determined — the safe default |

### Fix Summary

- `src/lib/leaseReviewSchema.js`: added `EXTRACTION_MODES`/`EXTRACTION_MODE_LABELS` vocabulary constants.
- `src/lib/leaseReviewFieldNormalizer.js`: added `resolveLeaseReviewExtractionMode()`, grounded entirely in already-computed signals (`resolveExtractionStatus`, `resolveSourceTextQuality`, `hasValidSourceEvidence`, review status) — never fabricates a mode. Wired onto standard field rows (full resolver); dynamic findings/clause records/expense-CAM rule rows default to `unknown` (insufficient structured metadata to resolve safely, matching the task's explicit escape hatch). Critical-dates and budget-preview reference rows inherit the real mode automatically via existing pick/spread mechanisms.
- `src/components/lease-review/LeaseReviewTabTable.jsx`: added the `Extraction Mode` column between Confidence and Page (column order now Field/Term, Value, Status, Confidence, Extraction Mode, Page, Source Text, Action); `colSpan` 7→8. Type column and Action dropdown unchanged.

### Extraction Mode Column Added

| Check | Result |
| --- | --- |
| Extraction Mode column added | yes |
| Type column still hidden | yes |
| Column order matches spec | yes |
| Action dropdown intact | yes |

### Phase 38-Style Rerun Result

Re-ran the real `normalizeLeaseReviewData()` against the approved local rows (fresh read-only local Postgres dump, temporary Vitest file deleted after):

| Field | extractionMode |
| --- | --- |
| `landlord_name` (rejected `<figure>` artifact) | `unknown` — not explicit |
| `tenant_signature_date` / `landlord_signature_date` (sourced from original lease date) | `unknown` — not explicit |
| `assignee_name` / `assignment_effective_date` / `security_deposit` (clean, page-anchored evidence) | `explicit` |
| `tenant_name` / `landlord_consent` (weak/unverified evidence) | `unknown` — correctly not overclaimed |

Extraction mode distribution: 11 `explicit`, 77 `unknown` (most fields on this assignment document are simply absent, not modeled as calculated). `approvalBlockers.missingFields` remains `["assignor_name"]`; `readinessSummary.missingRequiredFields` remains `["assignor_name"]`; `budgetReadiness`/`camReadiness` remain `ready`/`ready`; original lease missing remains advisory/current-truth — all unchanged from Phase 39.

### Tests Added

13 new tests: 10 in `leaseReviewFieldNormalizer.test.js` (resolver behavior, bug non-regression, non-standard-row defaulting, critical-dates/budget-preview inheritance), 3 in `leaseReviewTabTableContract.test.js` (column renders, column order, colSpan).

### Verification

| Check | Result |
| --- | --- |
| Focused `leaseReviewFieldNormalizer.test.js` | 32/32 passed |
| Focused `leaseReviewTabTableContract.test.js` | 5/5 passed |
| Focused `leaseReviewCurrentPolicy.test.js` | 13/13 passed |
| Focused `leaseReviewUiState.test.js` | 1/1 passed |
| `npm run lint` | passed, no errors |
| `npm run typecheck` | passed, no errors |
| `npm run build` | passed with pre-existing Vite chunk-size warnings only |
| `npm run test` | passed, 55 files / 615 tests (602 prior + 13 new) |

### Remaining Unknown-Mode Fields

`status`, `tenant_name`, `lease_term_months`, `landlord_consent`, `all_other_terms_remain_same` — pre-existing weak/unverified evidence, correctly not overclaimed as explicit (consistent with Phases 30/34/37/38 findings). `tenant_signature_date`/`landlord_signature_date` are `unknown` by design (Phase 39's evidence rejection). The remaining 77 populated-`unknown` gap is mostly fields with no value at all on this assignment document.

### Remaining Gaps

- Dynamic findings/clause records/expense-CAM rule rows default to `unknown` by design — no compatible structured metadata to resolve a real mode safely yet.
- `calculated`/`inferred` coverage is limited to what the backend already tags today; broader coverage would need extractor-side (provider-backed) work, out of scope.

### Recommendation

Recommendation remains: **No Gate**.

## Phase 41 Recommendation

Business/legal review of the extraction-mode vocabulary and coverage: confirm the `unknown` default is acceptable for dynamic findings/clause records/expense-CAM rules for now, and decide whether broader `calculated`/`inferred` coverage for standard fields is worth extractor-side (provider-backed) investment.

## Phase 41 Extraction Mode Business/Legal/Product Review

Phase 41 is a review/reporting phase only — no source code was changed. It packages the Extraction Mode column/data model (Phase 40) for business/legal/product sign-off.

Approved IDs:

- uploaded_file_id: `fc8181e6-766d-49c7-b81b-b5d961160207`
- lease_id: `7b21f353-579d-48e8-b3dd-8e8c49743fe2`
- local diagnostic run_id: `6d175b40-8f60-429f-8a29-a047e2a2e333`

### Extraction Mode Review Completed

Yes — full distribution census across all row types (standard fields, dynamic findings, clause records, expense/CAM rules, critical dates, budget preview), plain-English vocabulary/reviewer-meaning table, conservative-coverage analysis, business/legal decision table, and provider-side investment options.

### Extraction Mode Distribution (Approved Document)

| Row type | Total | explicit | unknown | normalized/inferred/calculated/reviewer_entered/manual |
| --- | ---: | ---: | ---: | --- |
| Standard fields | 88 | 11 | 77 | 0 (none present in this document's data) |
| Clause records | 35 | 0 | 35 | 0 |
| Critical dates | 7 | 0 | 7 | 0 |
| Budget preview | 7 | 1 | 6 | 0 |
| All rendered tab rows combined | 148 | 15 | 133 | 0 |

None of `normalized`/`inferred`/`calculated`/`reviewer_entered`/`manual` appear on this document's actual data — a fact about this document, not a resolver defect (all five modes have direct unit-test coverage from Phase 40 proving the code paths are reachable).

### Business/Legal Decisions Needed

10 decisions identified (full table in the Phase 41 report), spanning: whether populated fields may show `unknown`, whether `unknown` should force Needs Review, whether `explicit` should require page-anchored evidence only (no PARTIAL-quality exception), whether `normalized` should require persisting both raw and normalized values, whether `inferred`/`calculated` should require reasoning/formula provenance before being shown, whether `reviewer_entered`/`manual` rows need visible reviewer attribution, whether extraction mode should reach exports/audit logs, and whether it should ever affect approval readiness (recommended: not yet).

### Provider-Side Investment Recommended

**No, not yet.** Recommendation is to keep the conservative client-side resolver and route the business/legal decision table to its decision owners first — investing in provider-side extraction-mode metadata before the vocabulary itself is signed off risks building the wrong thing twice.

### Recommendation

Recommendation remains: **No Gate**.

## Phase 42 Recommendation

Route the Phase 41 decision table to its actual decision owners (Product, Legal, Compliance, Engineering) for sign-off. Do not resolve these decisions unilaterally in code. If decisions can't be collected yet, scope the smallest safe next step that doesn't presuppose an answer (e.g., persisting raw+normalized value pairs for `normalized` rows).

## Phase 42 Final Lease Review Requirements Regression Packet

Phase 42 is a reporting/regression-verification phase only — no source code was changed. It consolidates Phases 33–41 into one final requirements regression packet for the approved assignment document.

Approved IDs:

- uploaded_file_id: `fc8181e6-766d-49c7-b81b-b5d961160207`
- lease_id: `7b21f353-579d-48e8-b3dd-8e8c49743fe2`
- local diagnostic run_id: `6d175b40-8f60-429f-8a29-a047e2a2e333`

### Final Requirements Tested

| Metric | Count |
| --- | ---: |
| requirements tested | 20 |
| passed | 18 |
| partial | 2 |
| failed | 0 |

The 2 Partial rows: Requirement 5 (evidence-first behavior — `landlord_consent`'s `evidenceVerified: false` despite clear-looking source text, never root-caused) and Requirement 11 (Clause Records separation — structurally verified, but content de-duplication only spot-checked on 5 of 35 rows). No requirement fails; the 4 real bugs Phase 38 found were all fixed in Phases 39–40 and reconfirmed.

### Controlled Staging Review Readiness

**Yes**, for the approved assignment document — verified end-to-end via real code execution against real local data across Phases 38–41.

### Approval Gating Readiness

**No.** Extraction mode has zero effect on approval gating by design; Phase 41's decision table (item 9) recommends keeping it that way pending business/legal sign-off. The v3 provider-backed claim/evidence architecture has also never completed a real provider run (Phase 31A/31B both stopped at the credential gate) and is not ready for gate use.

### Remaining Business/Legal Decisions

Phase 41's 10-item decision table (full detail: `docs/document-intelligence-v3-phase41-extraction-mode-business-review.md` §7) remains open, spanning whether `unknown` should force Needs Review, whether `explicit`/`normalized`/`inferred`/`calculated` should have stricter evidence/provenance requirements before display, whether reviewer-entered values need visible attribution, whether extraction mode should reach exports/audit logs, and whether it should ever affect approval readiness (recommended: not yet).

### Remaining Technical Gaps

`landlord_consent` evidence-quality root cause; Clause Records full 35-row content audit; richer inferred/calculated/normalized coverage (provider-backed); dynamic/clause/expense/CAM rows stuck at `unknown` extraction mode (provider-backed); no real `vertex_fact_ledger` provider run has ever executed; no multi-document curated QA set exists (every phase 26–42 has exercised exactly one document).

### Recommendation

Recommendation remains: **No Gate**.

## Phase 43 Recommendation

Two independent tracks: (1) business/legal — collect actual decisions on Phase 41's 10-item table from their named owners; (2) technical — root-cause the `landlord_consent` evidence-quality gap, complete the Clause Records content audit, and begin building a second curated document fixture to test generalization beyond the single approved document. Do not attempt a real `vertex_fact_ledger` provider run without explicit, separate user approval.

## Phase 43 Signoff Decision Packet

Phase 43 is decision/reporting only — no source code was changed. It packages Phase 42's final result (18 Pass / 2 Partial / 0 Fail across 20 requirements) into a signoff packet for business/legal/product/engineering decision owners, and defines two independent next tracks. No new technical requirements were created and the Phase 42 requirements matrix was not reopened or re-scored.

Approved IDs:

- uploaded_file_id: `fc8181e6-766d-49c7-b81b-b5d961160207`
- lease_id: `7b21f353-579d-48e8-b3dd-8e8c49743fe2`
- local diagnostic run_id: `6d175b40-8f60-429f-8a29-a047e2a2e333`

### Signoff Packet Created

Yes — `docs/document-intelligence-v3-phase43-signoff-decision-packet.md`.

### Staging Review Readiness

**Yes**, for the approved assignment document.

### Approval Gating Readiness

**No.** Extraction mode has zero effect on approval gating by design; the v3 provider-backed claim/evidence architecture has never completed a real provider run (Phase 31A/31B both stopped at the credential gate).

### Business/Legal Decisions Open

10-item checklist in the Phase 43 packet §6. 6 items have a clear recommendation (Assignor Name hard blocker, Tenant Name advisory, Transfer/consent advisory, Original Lease advisory, conservative Extraction Mode vocabulary acceptable, Extraction Mode not affecting approval readiness yet); 4 remain genuinely open pending actual owner decisions (Landlord Consent tightening, whether Unknown should force Needs Review, exports/audit-log inclusion timing, and full closure of the Clause Records audit).

### Technical Tracks Recommended

Two independent tracks, neither chosen over the other by this phase: **Track 1** (Lease Review hardening — root-cause `landlord_consent`, complete the Clause Records audit, test a second curated document type, build a small multi-document QA set) and **Track 2** (v3 provider-backed evidence — scoped local/staging Vertex/Gemini credentials, exactly one provider-backed `vertex_fact_ledger` attempt, compare against Phase 29's reconstructed diagnostic claims). Track 2 requires its own separate future user approval before any real provider call.

### Recommendation

Recommendation remains: **No Gate**.

## Phase 44 Recommendation

Pick Track 1 and/or Track 2 from the Phase 43 signoff packet based on business priority. The Lease Review requirements regression track (Phases 33–42) can pause here — 18/20 pass with 2 narrow, already-understood partials is a legitimate stopping point; further requirements-matrix reruns against the same single document would be low-value until either a business/legal decision lands or new document data exists (Track 1) or real provider-backed evidence becomes available to compare against (Track 2).

## Phase 44A Lease Review Hardening

Phase 44A resolved the two open Phase 42 partials via root-cause analysis and a full audit — no source code was changed.

Approved IDs:

- uploaded_file_id: `fc8181e6-766d-49c7-b81b-b5d961160207`
- lease_id: `7b21f353-579d-48e8-b3dd-8e8c49743fe2`
- local diagnostic run_id: `6d175b40-8f60-429f-8a29-a047e2a2e333`

### `landlord_consent` Root Cause

**Validation rule too strict.** `booleanSourceSupportsValue()` (`src/lib/leaseReviewSchema.js`) requires the exact word "consent" (`\bconsent\b`), but the source text uses the conjugated form "consents" — the word-boundary regex doesn't match it, so `resolveSourceTextQuality` returns `INCONSISTENT` instead of `EXACT`, and `evidenceVerified` becomes `false`. Confirmed as the complete explanation (page present, natural boundary would pass). A fix (broaden the regex to match common verb conjugations) is described but not implemented — requires separate approval.

### Clause Records Audited Count

**35 of 35** (full audit, not a sample).

| Classification | Count |
| --- | ---: |
| Valid legal summary | 1 |
| Duplicate standard field | 12 |
| Noisy / low value | 19 |
| Needs review | 3 |

19 of the 35 "noisy" rows include 16 near-exact internal duplicates (same clause shown twice, differing only by a missing page number) — traced to `computeFallbackClauseRows()` unioning 5 separate `lease_fields`-shaped payload maps without deduping on content when the map index differs. A fix is described but not implemented.

### Partials Resolved

- **Partial 1 (`landlord_consent`): root-caused, not resolved.**
- **Partial 2 (Clause Records): audited — the audit task is complete; the audit result found real duplication/noise, now a well-scoped Track 1 follow-up item, not an open unknown.**

### Controlled Staging Review Still Appropriate

**Yes.** Both findings are display/content-quality issues, not correctness or safety issues.

### Approval Gating

**Still no.** `approvalBlockers.missingFields` unchanged (`["assignor_name"]` only).

### Recommendation

Recommendation remains: **No Gate**.

## Phase 44B Recommendation (candidate)

Two small, independent, low-risk fixes are ready for approval as isolated follow-ups if the business wants to act before the rest of Track 1: (1) the `booleanSourceSupportsValue` regex fix, (2) a Clause Records dedup fix (collapse near-exact duplicates, prefer the copy with a non-null `source_page`). Neither is authorized by this report.

## Phase 44A-Fix: landlord_consent + Clause Records Fixes

Phase 44A-Fix implemented both fixes recommended in Phase 44A. No approval-gating behavior changed.

Approved IDs:

- uploaded_file_id: `fc8181e6-766d-49c7-b81b-b5d961160207`
- lease_id: `7b21f353-579d-48e8-b3dd-8e8c49743fe2`
- local diagnostic run_id: `6d175b40-8f60-429f-8a29-a047e2a2e333`

### landlord_consent Regex Fixed

**Yes** — and a second, deeper pre-existing bug was also found and fixed. The planned `booleanSourceSupportsValue()` word-stem widening was necessary but not sufficient: `readFieldEvidence()` never carried a properly-typed `.value` in its returned evidence object (only a stringified `rawValue`, e.g. `"true"` for a `true` boolean), so `sourceTextSupportsValue()`'s `typeof candidate === "boolean"` check silently failed for every boolean field going through the real production path — the regex fix was correct but unreachable there. Fixed by adding `value: resolved?.value ?? null` to `readFieldEvidence()`'s return object, scoped narrowly to `leaseReviewSchema.js` (does not touch `leaseFieldResolver.js`, which is used by several other pages/services). No regression for non-boolean fields (confirmed by full suite).

### Clause Records Dedup Fixed

**Yes.** Root cause confirmed precisely: the old dedup key included `source_page`, so the same field appearing in two of the 5 unioned payload maps with different page-number completeness produced different keys and both survived. Dedup now keys on normalized type+title+text (with a truncated-prefix match helper), preferring the page-bearing/longer copy. Distinct clauses are not merged (verified by dedicated tests).

### Rejected Evidence Handling Fixed

**Yes.** Markup-artifact clause text is suppressed (checked against both resolved value and source text); rows matching the signature-date-from-original-lease pattern get `reviewStatus: "needs_review"` instead of `"pending"` — reusing the existing status vocabulary, no table-contract changes needed.

### Before/After Clause Records Counts

| Metric | Before | After |
| --- | --- | --- |
| Total rows | 35 | 19 |
| `pending` / `needs_review` | 35 / 0 | 16 / 3 |

### Before/After Duplicate/Noisy Counts

16 internal near-exact duplicates removed (exactly matching the Phase 44A audit's finding). 3 rows now correctly flagged `needs_review` instead of shown as clean facts (both signature-date rows, plus "Lease Term Months" which legitimately shares the same original-lease-reference text pattern).

### Approved Document Verification

`landlord_consent`: `evidenceVerified` false→true, status `needs_review`→`auto_populated`, extractionMode `unknown`→`explicit`, value unchanged (`true`). `approvalBlockers.missingFields` remains `["assignor_name"]` — unchanged. `budgetReadiness`/`camReadiness` remain `ready`/`ready`. Original lease missing remains advisory. Assignment/full-lease behavior, Extraction Mode resolver, and table/action contract are all unchanged (not touched this phase).

### Remaining Gaps

`landlord_consent`'s own Clause Records row still duplicates the standard field verbatim (Clause-Records-vs-standard-field duplication was out of scope for this fix, which targeted internal Clause Records duplication only); `tenant_name`'s Clause Records row (also a verbatim duplicate carrying a known weak-evidence concern) wasn't targeted by the two named rejected-evidence guards. Track 1's remaining items (second curated document type, multi-document QA set) are still outstanding.

### Recommendation

Recommendation remains: **No Gate**.

## Phase 44A-Fix Recommended Next Step

Continue Track 1: test at least one more curated document type to check whether these fixes generalize, and begin building a small multi-document QA set. Separately, consider whether the two residual duplication items above warrant their own follow-up.

## Phase 45: Second Document Test (Base Lease)

Phase 45 tested the profile-aware policy against a genuinely second document — no source changes were made or planned this phase (test/verification only). Full report: `docs/document-intelligence-v3-phase45-second-document-base-lease-test.md`.

Candidate: uploaded_file_id `f26f2cb5-4764-496c-a68f-484fc7a41085`, same org as the approved assignment document, `document_subtype: "base_lease"`, unapproved (`review_status: pending`), `enrichment_status: "failed"`. No matching local `leases` row existed for this document; a `leases` row initially provided (`8f41718d-...`) was found to be unrelated (its dates/tenant_name match the *assignment* document's original-lease reference, not this base lease) and was not used.

### Profile Resolution

**Correct.** Resolved to `base_lease` via `document_subtype` and the `uploaded_files` fallback paths in `collectProfileCandidates()`.

### Base-Lease Blockers Apply — Confirmed, With One Real Finding

`applyBaseLeaseBlockers: true` activates correctly. But projecting real data through it surfaced a genuine, pre-existing bug: `normalizeApprovalBlockers()`'s supplementary `policyRequiredKeys` pass (`leaseReviewFieldNormalizer.js:794-806`) checks the base-lease profile's legacy required keys (`premises_address`, `premises_use`, `lease_term`, from `REQUIRED_FIELD_KEYS` in `leaseReviewSchema.js`) directly against `standardFields`, which is keyed by `LEASE_FIELD_CONTRACT`'s newer canonical names (`property_address`, `permitted_use`, `lease_term_months`) — without ever applying the alias table `readFieldValue()` already uses for exactly this mapping. Result: `premises_address` is **structurally always missing**, regardless of whether `property_address` has a real value.

Proven concretely on this document: `property_address` = `"224 S Peters Road Knoxville, TN 37923"`, `status: needs_review` (not missing), `evidenceVerified: true` — yet `approvalBlockers.missingFields` still lists `premises_address`.

**Not fixed this phase** (test/verification only, no source changes made). This gap was invisible in every prior phase because the assignment profile's required-key list never included these three legacy names — it only surfaced once tested against a base-lease document, which is exactly why Track 1's "second document type" step mattered. Recommended as a narrowly-scoped follow-up: alias `policyRequiredKeys` through the same alias table, verified against both this document and the approved assignment document (which must remain unchanged).

### Assignment-Only Policy Correctly Does Not Apply

Zero assignment-specific advisory items (`original_lease_missing`, tenant-name/landlord-consent-in-assignment-context warnings) — all correctly absent for this base lease.

### Economics/CAM/Budget — Correctly Differentiated

| | Assignment (Phase 44A-Fix) | Base lease (Phase 45) |
| --- | --- | --- |
| `budgetReadiness` | `ready` | `blocked` |
| `camReadiness` | `ready` | `needs_review` |
| `budgetBlockers` | 0 | 5 |
| `camBlockers` | 0 | 15 |

The assignment profile treats missing CAM/budget inputs as advisory-only; the base-lease profile correctly treats them as real blockers — this document genuinely has no CAM structure (its own `ui_review_payload.warnings` independently confirms `cam_structure` parsed with all-null values).

### Extraction Mode, Evidence Integrity, Clause Records, Enrichment

- Extraction mode distribution: 16 `explicit` / 72 `unknown` of 88 standard fields.
- Evidence integrity held on two independent real-world rejected values (`landlord_name`, `permitted_use` — both HTML/markup-fragment artifacts, e.g. `"2. Landlord:</td>"`); both correctly surfaced as `missing`/`needs_review`, never as clean values.
- Clause Records count: 0 — this document's payload has no `lease_clauses` array; `computeFallbackClauseRows()` correctly produced zero rows rather than fabricating or crashing.
- `enrichment_status: "failed"` (two Vertex AI 429 resource-exhausted errors) — a genuinely different condition than the approved document; `normalizeLeaseReviewData()` ran cleanly against it with no special-casing needed.

Presentation-only items (Type column hidden, Action dropdown, debug/admin gating, enrichment banner visual rendering) were not independently re-verified via a live UI session this phase (no deploy) — flagged plainly as not re-tested rather than claimed confirmed.

### Comparison Table

| | Assignment (`fc8181e6-...`, approved) | Base lease (`f26f2cb5-...`, unapproved) |
| --- | --- | --- |
| Profile resolved | `assignment` | `base_lease` |
| `approvalBlockers.missingFields` | 1 (`assignor_name`) | 7 (6 genuine, 1 false positive) |
| Advisory gaps | 3 | 0 |
| `budgetReadiness` / `camReadiness` | ready / ready | blocked / needs_review |
| Clause Records | 19 | 0 |
| Extraction mode (explicit/unknown of 88) | 13 / 75 | 16 / 72 |

### Regression Check

No change to the approved assignment document's behavior — this phase made no source changes.

### Recommendation

Recommendation remains: **No Gate**.

## Phase 45 Recommended Next Step

Scope and implement the `premises_address`/`premises_use`/`lease_term` alias fix as its own focused follow-up phase, verified against both documents. Continue building the multi-document QA set (this phase adds one real base-lease data point). Consider approving this base-lease document through the normal review flow if a second fully end-to-end verified (approved) document is wanted — out of scope for this phase, no writes were made.

## Phase 46: Base-Lease Required-Field Alias Fix

Fixed the alias gap found in Phase 45. Full report: `docs/document-intelligence-v3-phase46-base-lease-alias-fix.md`.

**Root cause**: `normalizeApprovalBlockers()` and `buildReadinessSummary()` (`leaseReviewFieldNormalizer.js`) checked required field keys using legacy names (`premises_address`, `premises_use`, `lease_term`) directly against `standardFields`, which is keyed by `LEASE_FIELD_CONTRACT`'s newer canonical names (`property_address`, `permitted_use`, `lease_term_months`) — with no alias resolution, unlike `readFieldValue`/`readFieldEvidence`, which already resolve these exact aliases via the existing `getFieldAliases()` table (`leaseFieldResolver.js`).

**Fix**: added one shared helper, `requiredFieldHasValue(byKey, key)`, that checks every alias from the existing `getFieldAliases()` through the existing `hasRowValue()` gate — reusing the alias table already used elsewhere rather than building a second one. Used in exactly the two call sites with the bug; nothing else touched.

### Alias Bug Fixed

**Yes.**

### Assignment Regression

**None.** Re-ran the real approved-document field/evidence shape (`fc8181e6-.../7b21f353-...`): `missingFields` stays exactly `["assignor_name"]`, `budgetBlockers`/`camBlockers` stay `[]`/`[]`, all three advisory gaps unchanged.

### Base Lease Regression

**None — requiredness preserved, only the false positive removed.** Corrected expectation (only one of the three named keys actually clears for this document's real data):

| Legacy key | Alias | Alias state (real data) | Result |
| --- | --- | --- | --- |
| `premises_address` | `property_address` | populated, evidence-verified | **cleared** |
| `premises_use` | `permitted_use` | rejected markup artifact (null) | still blocks |
| `lease_term` | `lease_term_months` | genuinely null | still blocks |

`approvalBlockers.missingFields`: 7 → **6** (only `premises_address` removed). `budgetBlockers`/`camBlockers` unaffected (different fields entirely).

### Remaining Blockers (base lease, post-fix)

`lease_date`, `landlord_name`, `commencement_date`, `expiration_date`, `premises_use`, `lease_term` — all genuine, no populated alias exists for any of them in this document's real extraction.

### Tests Added

`src/lib/__tests__/leaseReviewFieldNormalizer.test.js` — 9 new tests across 2 `describe` blocks (full file: 52/52 passing): alias resolution for all 3 named pairs; missing-canonical-still-blocks; rejected/markup-artifact and needs_review-with-no-value alias rows do not satisfy; the Phase 39 `invalidValueRejected` carve-out preserved through the alias path with no new leniency; the real Phase 45 base-lease fixture (7→6); and the real approved assignment fixture (`missingFields` stays `["assignor_name"]`).

### Files Changed

`src/lib/leaseReviewFieldNormalizer.js` (the fix), `src/lib/__tests__/leaseReviewFieldNormalizer.test.js` (tests), plus this phase's three doc files.

### Recommendation

**No Gate.**

## Phase 46 Recommended Next Step

Continue Track 1's multi-document QA set. Consider a small follow-up for the `tabSummaries[].missingRequired` per-tab cosmetic under-count noted in the full report (no blocker/gating impact, low priority — not fixed this phase). Consider approving the base-lease document through the normal review flow now that its `premises_address` false positive is resolved.

## Phase 47: Third Document CAM-Heavy Base Lease QA

Phase 47 ran uploaded-file-only Lease Review QA against **Craven Wings Lease Executed 1.pdf**, uploaded_file_id 0155251a-b911-408c-ae83-469d8d6eb534, org_id 1307dd95-e7c5-4e08-833e-749444e8f4c8.

No reliable matching leases row exists, so the run was explicitly labeled uploaded-file-only. It did not use unrelated Narendra Pydi rows 7b21f353 or 8f41718d, did not remote read/write, did not deploy, did not call any provider, and did not rerun parse or extraction.

### Phase 47 Results

| Check | Result |
| --- | --- |
| candidate valid | yes; real Craven Wings / Markets at Choto base lease |
| document_subtype | base_lease |
| parse / normalize | completed |
| enrichment | failed due compute resources, expected for this phase |
| resolved profile | base_lease |
| assignment downgrades applied | no |
| base lease blockers active | yes |
| Phase 46 alias fix | holds; premises_address and lease_term clear via aliases |
| approval readiness | needs_review |
| budget readiness | blocked |
| CAM readiness | needs_review |
| expense/CAM structured rules | 0 expense rules / 0 CAM rules |
| clause records | 0 |
| recommendation | No Gate |

Main gaps found:

- Premises/property address is wrong in normalized output: 3826 MAUpin DR instead of the source premises location at 12350 South Northshore / The Markets at Choto.
- CAM estimate source text contains $5.25 per leasable square foot, but cam_amount is missing.
- Rent Addendum and Security Deposit Addendum exist in source text, but rent and security deposit fields remain missing.
- No structured expense/CAM rule rows or clause records were produced for a CAM-heavy base lease, likely because enrichment failed and fallback coverage is insufficient.
- Several populated fields have source text but are not evidence-verified, or have source text without page numbers.

Report created: docs/document-intelligence-v3-phase47-third-document-test.md.

Recommendation remains: **No Gate**.

## Phase 48 Recommendation

Run a focused CAM/expense-heavy base lease extraction coverage phase. Improve no-provider fallback for CAM estimate, pro-rata taxes/insurance/CAM recoveries, rent addendum, security deposit addendum, and clause summaries; keep approval behavior unchanged until business review confirms quality.

## Phase 48A: CAM-Heavy Base Lease Root Cause

Phase 48A root-caused the Phase 47 gaps for **Craven Wings Lease Executed 1.pdf** using only the approved uploaded file export and pipeline logs. No source code changed, no remote read/write occurred, no provider was called, and parse/extraction were not rerun.

Report created: `docs/document-intelligence-v3-phase48A-cam-heavy-root-cause.md`.

### Phase 48A Findings

| Issue | Classification | Finding |
| --- | --- | --- |
| wrong `property_address` | extraction_wrong_value | Source has the correct premises at 12350 South Northshore / The Markets at Choto, but structured payload selected tenant contact address 3826 MAUpin DR. |
| missing CAM estimate | extraction_missing / fallback_rule_gap | Source contains $5.25 per leasable square foot, but `cam_amount` is null through parsed, normalized, UI payload, and standard fields. |
| missing rent fields | extraction_missing / fallback_rule_gap | Rent Addendum exists in source text, but monthly/annual/rent schedule fields are not projected. |
| missing security deposit | extraction_missing / fallback_rule_gap | Security Deposit Addendum includes $15,535.36 total deposit, but `security_deposit` is null. |
| missing expense/CAM rules | fallback_rule_gap / extraction_missing | Flat tax/insurance/admin fee fields exist, but no structured workflow expense/CAM rule rows are present. |
| missing clause records | extraction_missing / fallback_rule_gap | Source has clause-rich CAM/base-lease language, but no clause records are produced. |
| evidence gaps | evidence_mapping_gap | Some populated fields have source text but lack verified evidence or page numbers after enrichment failure. |

### Phase 48B Proposed Scope

P0: fix property/premises selection so tenant/contact addresses do not satisfy premises address.

P1: add no-provider CAM/expense rule fallback for CAM estimate, pro-rata taxes, insurance, CAM, and admin/management fee language.

P1: add rent addendum and security deposit addendum projection.

P2: add clause-record fallback coverage for CAM-heavy leases.

P2: improve page/evidence completeness when enrichment fails.

Recommendation remains: **No Gate**.

## Phase 48B: CAM-Heavy No-Provider Fallback Fix

Phase 48B implemented narrow Lease Review fallback/projection fixes for the Craven Wings CAM-heavy base lease. No provider call, extraction rerun, deployment, remote read/write, service-key access, global v3 provider change, or approval-gating change occurred.

Report created: `docs/document-intelligence-v3-phase48B-cam-heavy-fallback-fix.md`.

### Phase 48B Results

| Area | Before | After |
| --- | --- | --- |
| property_address | 3826 MAUpin DR | 12350 South Northshore, Knoxville, TN 37922, needs_review |
| security_deposit | missing | 15535.36 from Security Deposit Addendum, needs_review |
| CAM estimate | missing | CAM rule row: $5.25 per leasable square foot |
| expense rules | 0 | 2 fallback rows: taxes and insurance |
| CAM rules | 0 | 3 fallback rows: CAM estimate, pro-rata CAM, admin fee |
| rent schedule | 0 | Rent Addendum schedule rows; monthly_rent not flattened |
| clause records | 0 | 0 by design; no noisy generic clause rows added |

Regression checks passed for the approved assignment document and the Phase 45 base lease. Focused tests were added in `src/lib/__tests__/leaseReviewFieldNormalizer.test.js`.

Recommendation remains: **No Gate**.

## Phase 49: Multi-Document Fallback Regression

Phase 49 regression-tested the Phase 48B no-provider Lease Review fallbacks across the curated local/exported payload set:

- approved assignment: `fc8181e6-766d-49c7-b81b-b5d961160207` / `7b21f353-579d-48e8-b3dd-8e8c49743fe2`
- Phase 45 base lease: `f26f2cb5-4764-496c-a68f-484fc7a41085`
- Craven CAM-heavy base lease: `0155251a-b911-408c-ae83-469d8d6eb534`

No deployment, remote read/write, provider call, parse rerun, extraction rerun, or production write occurred. The phase used only existing local/exported payloads and the existing normalizer.

Report created: `docs/document-intelligence-v3-phase49-multidoc-fallback-regression.md`.

### Phase 49 Results

| Area | Result |
| --- | --- |
| assignment profile/readiness | stable; profile `assignment`, only hard blocker `assignor_name` |
| assignment fallback noise | none; no CAM/rent/security fallback rows created |
| Phase 45 base lease | stable; profile `base_lease`, Phase 46 alias fix still holds |
| Phase 45 fallback noise | none; Phase 48B fallbacks did not create unrelated CAM/rent rows |
| Craven property address | improved to `12350 South Northshore, Knoxville, TN 37922`, `needs_review` |
| Craven security deposit | improved to `$15,535.36`, `needs_review` |
| Craven CAM estimate | present as CAM rule: `$5.25 per leasable square foot` |
| Craven expense/CAM rows | pro-rata taxes, insurance, CAM, and 5 percent admin fee rows present |
| Craven rent schedule | 8 Rent Addendum rows present; `monthly_rent` scalar remains missing by design |
| duplicate CAM/expense rows | none found |
| Clause Records | regression/noise gap remains: Craven produced 34 clause rows |

### Phase 49 Remaining Gaps

- Craven Clause Records did not meet the non-noisy expectation; `clauseRecordsCount = 34`.
- Craven still lacks scalar `monthly_rent`, `square_footage`, `commencement_date`, `expiration_date`, `lease_type`, and `premises_use`.
- Evidence/page completeness remains honest but incomplete for some source-backed fields.

Recommendation remains: **No Gate**.

Recommended Phase 50: run a narrow Clause Records quality/filtering phase that keeps approval behavior unchanged.

## Phase 50: Clause Record Quality Fix

Phase 50 fixed the Clause Records noise regression found in Phase 49. The root cause was `computeFallbackClauseRows` unioning `lease_fields` and extracted document-item payloads into Clause Records even when those facts already belonged in standard fields, Expense/CAM rows, Rent Addendum rows, or Security Deposit rows.

No deployment, remote read/write, provider call, parse rerun, extraction rerun, approval-gating change, or required-field blocker weakening occurred.

Report created: `docs/document-intelligence-v3-phase50-clause-record-quality-fix.md`.

### Phase 50 Results

| Document | Clause Records Before | Clause Records After | Result |
| --- | ---: | ---: | --- |
| approved assignment | 18 | 18 | unchanged; Phase 44A assignment behavior preserved |
| Phase 45 base lease | 27 | 3 | noisy standard-field echoes filtered |
| Craven CAM-heavy base lease | 34 | 3 | regression fixed; low defensible retained summaries |

Retained Craven clauses are distinct legal summaries: assignment/subletting restriction, default cure/remedies, and renewal notice. Craven Expense/CAM/Rent/Security fallback rows remain intact.

Recommendation remains: **No Gate**.

Recommended Phase 51: continue no-provider QA with one more real base lease or run a narrow evidence/page-completeness phase for retained fallback rows, without approval behavior changes.

## Phase 51A: Vertex Provider Preflight

Phase 51A performed a provider-backed extraction preflight only. No VertexAI, Gemini, OpenAI, Azure, parse, extraction, deploy, remote write, production write, or secret-value exposure occurred.

Report created: `docs/document-intelligence-v3-phase51A-vertex-preflight.md`.

### Phase 51A Results

| Area | Result |
| --- | --- |
| safest target environment | local first; staging possible later; production not recommended for first provider call |
| local config presence | required provider keys missing in process env and local env files |
| remote/staging config presence | unknown / inaccessible; not read under this phase's constraints |
| provider test possible now | no |
| preferred one-document target | Craven Wings Lease Executed 1.pdf, uploaded_file_id `0155251a-b911-408c-ae83-469d8d6eb534` |
| provider selection path | `normalize-pdf-output` resolves `BUSINESS_EXTRACTION_PROVIDER=vertex_fact_ledger` or internal debug override; default remains `legacy_hybrid` |
| expected writes if later approved | `uploaded_files` payloads/status/counts, v3 run/claims/evidence/projections/drops, package graph rows if available, pipeline logs |
| approval needed next | explicit one-provider-call approval plus scoped local/staging credentials/config confirmation |

Recommendation remains: **No Gate**.

Recommended Phase 51B: configure scoped local/staging provider credentials and choose one execution mode. Do not run the provider until explicitly approved for exactly one call.

## Phase 51B: Provider Test Setup

Phase 51B prepared the safe provider-backed extraction test environment shape without making any provider call. No VertexAI, Gemini, OpenAI, Azure, parse, extraction, deploy, remote read/write, production write, service-role use, global provider flag change, or secret-value exposure occurred.

Report created: `docs/document-intelligence-v3-phase51B-provider-test-setup.md`.

### Phase 51B Results

| Area | Result |
| --- | --- |
| chosen execution mode | no-DB direct diagnostic harness |
| deferred alternative | DB-writing `normalize-pdf-output` path only if explicitly approved later |
| future target | Craven Wings Lease Executed 1.pdf, uploaded_file_id `0155251a-b911-408c-ae83-469d8d6eb534` |
| local provider config | missing for required provider/project/model/credential keys |
| remote/staging config | unknown / inaccessible; not inspected |
| existing no-DB harness | not found |
| secret hygiene | `.env*` ignored; no tracked credential/private-key/service-account filenames found except `.env.example` template |
| output path readiness | top-level `tmp/` is not currently ignored; Phase 52 must confirm/add an ignored local artifact path before writing diagnostics |
| Phase 52 can run now | no |

### Phase 51B Blockers

1. Required provider configuration is missing locally.
2. Remote/staging secret readiness is unknown.
3. No no-DB direct diagnostic harness exists yet.
4. The future diagnostic output path must be confirmed as ignored before writing `tmp/phase52-vertex-craven-diagnostic.json`.
5. The user has not approved exactly one provider call for Phase 52.

Recommendation remains: **No Gate**.

Recommended Phase 52: only after explicit approval and scoped provider configuration, implement/run a no-DB direct diagnostic harness for exactly one Craven provider call and write only a local ignored diagnostic artifact.

## Phase 51C: Local Artifact Path Hygiene

Phase 51C prepared a safe ignored local artifact path for the future Phase 52 no-DB provider diagnostic output. No provider call, deploy, remote read/write, parse, extraction, secret access, provider behavior change, production write, or diagnostic output creation occurred.

### Phase 51C Results

| Area | Result |
| --- | --- |
| existing suitable ignored path | none specific to Phase 52 provider diagnostics |
| ignore rule added | `/tmp/phase52-*.json` and `/tmp/phase52-*.md` |
| scope | narrow local provider diagnostic artifacts only |
| diagnostic output created | no |
| provider behavior changed | no |

Recommendation remains: **No Gate**.

Recommended Phase 52: only after explicit provider-call approval and scoped provider configuration, write any no-DB diagnostic output under the newly ignored `tmp/phase52-*` artifact path.

## Phase 51D: Provider Env Resolution

Phase 51D documented provider env-name resolution and confirmed the safe path for a first Vertex provider test. No VertexAI, Gemini, OpenAI, Azure, parse, extraction, deploy, remote write, Supabase secret change, provider behavior change, diagnostic output creation, or secret-value exposure occurred.

Report created: `docs/document-intelligence-v3-phase51D-provider-env-resolution.md`.

### Phase 51D Results

| Area | Result |
| --- | --- |
| business extraction provider flag | `BUSINESS_EXTRACTION_PROVIDER`; selects `vertex_fact_ledger`, default remains `legacy_hybrid` |
| parser/layout provider flag | `EXTRACTION_PROVIDER`; separate Azure/parser/layout mode flag and should not be reused for `vertex_fact_ledger` |
| scoped override | `debug_business_extraction_provider` exists, internal-call only |
| zero-DB Edge path | `dry_run=true` + `sample_text` can use scoped override without uploaded-file DB writes, but only tests sample text |
| normal `file_id` normalize path | can use scoped override but writes status, payloads, counts, and possibly v3 side-write; not suitable for first provider call |
| local no-DB harness | possible without DB writes if it imports `runVertexFactLedgerPipeline(...)` directly and uses securely supplied local env credentials |
| Supabase secrets boundary | hosted Supabase secrets require running inside Supabase Edge Function runtime; local harness cannot use them without separately supplying credentials locally |

Recommendation remains: **No Gate**.

Recommended Phase 52: choose the runtime mode first, then only after explicit one-provider-call approval run either a local no-DB harness with secure local credentials or an internal Supabase Edge dry-run sample-text comparison. Do not use the normal `file_id` normalize path for the first provider call.

## Phase 52A: Internal Dry-Run Path

Phase 52A prepared the internal Supabase Edge dry-run invocation path for a future provider test. No VertexAI, Gemini, OpenAI, Azure, parse, extraction, deploy, remote write, Supabase secret change, normal `file_id` normalize call, table write, provider output creation, or secret-value exposure occurred.

Report created: `docs/document-intelligence-v3-phase52A-internal-dry-run-path.md`.

### Phase 52A Results

| Area | Result |
| --- | --- |
| existing exact safe caller found | no |
| nearest existing caller | `pipeline-health-check`, admin-only and already calls `normalize-pdf-output` dry-run |
| nearest caller gap | generic sample text only; does not pass `debug_business_extraction_provider="vertex_fact_ledger"` |
| trusted internal caller pattern | `lease-extraction-worker` uses internal headers, but its normalize call is normal `file_id` path |
| zero-DB branch | confirmed for `dry_run=true` + `sample_text` + no `file_id` |
| scoped override | available only for internal calls |
| one Vertex model request | not guaranteed by existing `vertex_fact_ledger` pipeline |
| Gemini/OpenAI fallback | not called in inspected `vertex_fact_ledger` modules; risk exists only if debug override is not honored and legacy path runs |

### Phase 52A Blocker

One internal dry-run request is possible, but the existing provider pipeline can make multiple Vertex model requests: one profile-classifier call, one or more fact-extraction calls, and possible Vertex model/location retries. Therefore the currently inspected path does not satisfy the user's exact-one-provider-call constraint.

Recommendation remains: **No Gate**.

Recommended Phase 52B: create a minimal admin-only diagnostic wrapper or one-request diagnostic option, with tests proving no `file_id`, no DB writes, no secret output, no Gemini/OpenAI/Azure path, and exactly one provider model request before any Vertex invocation is approved.

## Phase 52B: Single-Request Diagnostic Wrapper

Phase 52B implemented a minimal internal-only diagnostic path capable of making exactly one future Vertex model request. No VertexAI, Gemini, OpenAI, Azure, OCR, parse, extraction, deploy, remote write, Supabase table read/write, provider output creation, global provider flag change, or secret-value exposure occurred.

Report created: `docs/document-intelligence-v3-phase52B-single-request-diagnostic-wrapper.md`.

### Phase 52B Results

| Area | Result |
| --- | --- |
| diagnostic endpoint | `supabase/functions/phase52-vertex-diagnostic/index.ts` |
| low-level helper | `callVertexAISingleRequestDiagnostic(...)` in `supabase/functions/_shared/vertex-ai.ts` |
| authentication | internal-only through existing `isInternalCall(req)` mechanisms |
| accepted inputs | `sample_text`, optional `diagnostic_label` |
| rejected inputs | `file_id`, `uploaded_file_id`, `lease_id`, DB-targeting fields, provider overrides |
| DB access | none; no Supabase client import or table methods |
| provider fallback | disabled; no model/location retry loop, no Gemini/OpenAI/Azure path |
| model request bound | exactly one Vertex `generateContent` request per diagnostic invocation |
| deployment status | not deployed |

### Phase 52B Verification

| Check | Result |
| --- | --- |
| Deno check | passed for focused Phase 52B test file |
| Deno test | passed outside sandbox: 7 focused tests |
| mocked Deno smoke | passed; endpoint/helper imported, `file_id` rejected, helper invoked once, one mocked fetch made |
| `npm run lint` | passed |
| `npm run typecheck` | passed |
| `npm run build` | passed |
| `npm run test` | passed outside sandbox after sandboxed `spawn EPERM`: 56 files / 657 tests |
| provider call | none |
| QA JSON parse | passed |

Recommendation remains: **No Gate**.

Recommended Phase 52C: only after explicit approval, deploy or serve the diagnostic endpoint in an internal environment with configured Vertex credentials, invoke it exactly once with the approved Craven sample, capture sanitized output, and immediately stop.

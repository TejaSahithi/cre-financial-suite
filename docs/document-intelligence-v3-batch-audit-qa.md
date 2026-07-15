# Document Intelligence v3 Batch Advisory Audit QA

Generated: 2026-07-15
Phase: 37
Status: Authenticated local UI verification completed - No Gate

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

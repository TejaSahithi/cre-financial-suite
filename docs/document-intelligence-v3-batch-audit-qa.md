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

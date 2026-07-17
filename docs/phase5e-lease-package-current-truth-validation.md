# Phase 5E - Lease Package Current-Truth Validation

Date: 2026-07-17
Branch: feature/document-intelligence-v3
Phase 5D commit confirmed: 3fd4ea6 Validate Phase 5D source linkage RPC security
Scope: local Supabase only; no Azure, no Vertex, no parser/worker execution, no deployment, no remote Supabase, no provider-default or canonical-layout change.

## 1. Executive Result

Phase 5E is complete with conditions.

The current repo preserves document/source separation and reviewer authority, and v3 package/current-truth diagnostics can identify deterministic supersession candidates for assignment, rent replacement, renewal/expiration, and missing/conflicting related-document context. The diagnostic layer remains advisory and does not replace Lease Review, financial workflows, approval snapshots, or version history.

Condition: there is not yet a load-bearing package-current-truth service or materialized projection that combines base lease + amendments + assignments + renewals + exhibits into the authoritative value set used by Budget Preview, CAM/expense rules, critical dates, and approval snapshots.

## 2. Current Package Architecture

Package graph tables are diagnostic-only and server-owned:

- `document_packages`
- `document_package_documents`
- `document_related_document_requirements`
- `document_relationships`

Authenticated org members have SELECT-only RLS. Service role writes package rows. V3 side-write populates package graph and temporal diagnostics behind `ENABLE_DOCUMENT_INTELLIGENCE_V3`; failures are isolated from canonical Lease Review outputs.

The current business path still uses `uploaded_files.normalized_output`, `uploaded_files.ui_review_payload`, lease `extraction_data`, `workflow_output`, and reviewer `field_reviews`.

## 3. Authority/Current-Truth Matrix

| Item | Current authority | Source preservation | Phase 5E result |
| --- | --- | --- | --- |
| Original document fact | Original upload/run/Lease Review row | Preserved by uploaded_file_id, document profile, evidence fields | Pass |
| Amended value | Reviewer-approved lease field or advisory v3 supersession candidate | Source document identity retained in diagnostics | Pass with conditions |
| Assigned party | Reviewer field value; v3 can propose tenant supersession from assignor/assignee | Assignor remains historical input | Pass with conditions |
| Effective date | V3 timeline/projections when present; not approval authority | Preserved in package diagnostics | Pass with conditions |
| Current value | Reviewer-approved single lease state | Not package-materialized today | Condition |
| Source document | Lease source_file_id plus package document uploaded_file_id | Preserved | Pass |
| Reviewer decision | `field_reviews` | Preserved across refresh/merge | Pass |
| Approved version | approval snapshot/abstract version | Single lease snapshot today | Pass with conditions |
| Superseded value | V3 diagnostic historical claims when supported | Not included in approval snapshot today | Condition |
| Audit history | Existing audit/version rows | Source linkage validated in Phase 5D; package rows diagnostic | Pass with conditions |

## 4. Effective-Date Rules

`temporal-supersession.ts` orders documents by effective date signals in this priority:

1. effective_date
2. assignment_effective_date
3. amendment_date
4. execution_date
5. lease_date
6. document_date

Missing dates create warnings instead of crashes. Equal dates create ambiguous order warnings. The logic does not use filename order as legal authority.

## 5. Base Lease Findings

Base lease facts remain source facts. They are not overwritten by package graph diagnostics. The seeded package retained base lease uploaded_file_id, document profile, document row, and effective date.

## 6. Amendment Findings

Rent amendment diagnostics produced a `monthly_rent` supersession candidate from `amended_base_rent`. The test package preserved CAM share from the base lease when the rent amendment only changed rent and declared all other terms unchanged.

CAM amendment values such as CAM cap and reconciliation deadline can be represented as diagnostic current candidates when no competing value exists. If a competing CAM share appears without an explicit supported supersession rule, the status becomes conflict/needs review rather than silent current truth.

## 7. Assignment Findings

Assignment diagnostics produced a tenant supersession candidate from `assignment_effective_date`, `assignor_name`, and `assignee_name`. The candidate preserved source document identity and effective date. The assignor remains visible as historical input.

## 8. Renewal Findings

Renewal diagnostics produced an expiration-date current candidate from renewal fields. Original expiration remains a separate base document fact and is not erased.

## 9. Exhibit Findings

Exhibit evidence can support premises context, but it is not treated as independent economic authority. Conflicting premises descriptions are flagged as `conflict` with `manual_temporal_review_required` rather than silently selecting the newest source.

## 10. Conflict Handling

Validated behavior:

- explicit supported supersession can produce candidate current truth
- unsupported overlapping values produce `conflict`
- filename order is not used
- newest upload is not sufficient legal authority
- both claims and source document identities are preserved in diagnostics when provided

## 11. Reviewer Authority

Reviewer-approved or edited `field_reviews` remain authoritative over later automated refreshes in the Lease Review merge path. The approval snapshot test confirms reviewer value wins over extracted value for the approved field.

## 12. Financial Workflow Projection

Current financial workflows remain driven by the reviewed single-lease state and existing workflow outputs, not by a package-current-truth projection. This is safe for the current advisory phase, but it means the required package current truth values are not automatically driving Budget Preview, Expense Rules, CAM Rules, critical dates, or approval readiness as a combined package.

## 13. Approval/Version Traceability

Approval snapshots preserve reviewer decisions and the lease source document identity. They do not yet synthesize package identity, per-field effective date, superseded value, or package document profile metadata into every approved field entry.

## 14. Idempotency

Authenticated local integration seeded one six-document package and repeated package/document upserts. Results:

- `document_packages`: 1 row for the package key
- `document_package_documents`: 6 rows for 6 distinct uploaded files
- repeated package upsert returned the same package id
- repeated document upsert did not create a duplicate document row

Package preparation, approval request, document_links, duplicate rules, duplicate critical dates, and duplicate approval version were not rerun in Phase 5E because the phase constraints prohibited parser/worker execution and the current package-current-truth workflow is not load-bearing.

## 15. Tenant Isolation

Authenticated local integration confirmed:

- org A member can read org A package document rows
- org B member reads 0 org A package document rows
- org A member can read org A diagnostic relationship rows
- org B member reads 0 org A diagnostic relationship rows
- authenticated package insert is rejected
- authenticated relationship update does not mutate the server-owned diagnostic row

## 16. Confirmed Defects and Fixes

No implementation defect was fixed in production code.

Two fixture/schema adjustments were made only in the new Phase 5E integration test:

- `document_intelligence_runs.profile_status` must use the existing allowed value `manual_override`
- `uploaded_files.document_subtype` must use legacy routing values such as `amendment`, `assignment`, and `addendum`, while package document rows carry richer v3 profiles

Confirmed product gap: there is no authoritative package-current-truth projection feeding financial workflows and approval snapshots. This is recorded as a condition, not fixed in Phase 5E.

## 17. Migration Decision

No migration created.

A future load-bearing package-current-truth design likely needs:

- a durable package-current-truth table or server-owned RPC output keyed by org/package/lease
- per-field source document id, uploaded_file_id, effective_from/effective_to, reviewer status, superseded value, and conflict status
- compatibility bridge from advisory v3 diagnostics to reviewed Lease Review fields
- idempotent workflow-run table/RPC pattern for package preparation and current-truth calculation
- rollback plan that leaves existing Lease Review and approval snapshots unchanged

## 18. Files Changed

- `supabase/functions/_tests/document-intelligence-v3-phase5e-current-truth.test.ts`
- `scripts/phase5e-lease-package-current-truth-validation.test.js`
- `docs/phase5e-lease-package-current-truth-validation.md`

No Azure parser, Vertex transport, canonical layout, lease-extraction-worker, provider routing, or unrelated CAM/budget formula files were changed.

## 19. Test Results

Preflight:

- Working tree before Phase 5E edits: clean
- Branch: `feature/document-intelligence-v3`
- HEAD before Phase 5E edits: `3fd4ea6`
- Local Supabase: running at `http://127.0.0.1:54321`

Focused baseline before edits:

- `npx vitest run src/components/lease-review/__tests__/SourceFileLink.test.jsx src/components/lease-review/__tests__/phase5dSourceLinkContract.test.js src/lib/__tests__/leaseReviewCurrentPolicy.test.js src/components/lease-review/utils/__tests__/applyLatestExtractionMerge.test.js src/components/lease-review/utils/__tests__/documentIntelligenceV3Diagnostics.test.js`: 5 files passed / 74 tests passed
- `deno test --no-check --allow-env --allow-read --allow-net=0.0.0.0:8000,127.0.0.1:54321 supabase/functions/_tests/document-intelligence-v3-package-graph.test.ts supabase/functions/_tests/document-intelligence-v3-temporal-supersession.test.ts supabase/functions/_tests/document-intelligence-v3-profile-policy.test.ts supabase/functions/_tests/document-intelligence-v3-profile-planner.test.ts supabase/functions/_tests/approve-lease-workflow.test.ts supabase/functions/_tests/review-approve-reviewer-state-preservation.test.ts`: 42 passed / 0 failed

Post-change verification:

- `deno check supabase/functions/_tests/document-intelligence-v3-phase5e-current-truth.test.ts supabase/functions/_shared/extraction/document-intelligence-v3/temporal-supersession.ts supabase/functions/_shared/extraction/document-intelligence-v3/package-graph.ts supabase/functions/_shared/lease-approval-workflow.ts`: PASS
- `npx vitest run scripts/phase5e-lease-package-current-truth-validation.test.js`: 1 file passed / 1 test passed
- `npx vitest run src/components/lease-review/__tests__/SourceFileLink.test.jsx src/components/lease-review/__tests__/phase5dSourceLinkContract.test.js src/lib/__tests__/leaseReviewCurrentPolicy.test.js src/components/lease-review/utils/__tests__/applyLatestExtractionMerge.test.js src/components/lease-review/utils/__tests__/documentIntelligenceV3Diagnostics.test.js scripts/phase5e-lease-package-current-truth-validation.test.js`: 6 files passed / 75 tests passed
- `npm test`: 61 files passed / 675 tests passed
- `npm run lint`: PASS
- `npm run typecheck`: PASS
- `npm run build`: PASS; Vite emitted existing chunk/dynamic import warnings
- `git diff --check`: PASS
- Secret scan of changed tracked and untracked files: PASS, 0 hits

Deno runner status:

- Deno version: 2.7.12 (stable, x86_64-pc-windows-msvc)
- OS: Microsoft Windows NT 10.0.26200.0
- `deno test --no-check --allow-env --allow-read --allow-net=0.0.0.0:8000,127.0.0.1:54321 supabase/functions/_tests/document-intelligence-v3-phase5e-current-truth.test.ts`: BLOCKED by Deno panic before test results
- Existing control command `deno test --no-check --allow-env --allow-read supabase/functions/_tests/document-intelligence-v3-package-graph.test.ts`: same Deno panic
- Panic classification: Windows Deno test-runner client pipe/stdout lifecycle failure, `Unexpected client pipe failure`, invalid handle, panic at `cli\tools\test\channel.rs:252:49`
- No assertion failures were reported before the panic; discovery/result counts were not emitted

Provider/network confirmation:

- No Azure call
- No Vertex call
- No parser execution
- No worker execution
- No deployment
- No remote Supabase access
- Local integration used only `http://127.0.0.1:54321`

## 20. Remaining Risks

- Package-current-truth is advisory only and not yet the financial/approval source of truth.
- Approval snapshots do not yet carry package id, per-field effective date, superseded value, or package document profile metadata for every field.
- CAM cap and reconciliation deadline can be represented as candidates, but unsupported overlapping economics still require manual review or future explicit supersession rules.
- Documents without a shared lease id remain separate `upload:<id>` packages unless an explicit package association exists.
- Deno test runner verification is currently blocked in this Windows session by the known Deno pipe panic, although `deno check`, Vitest integration, full frontend regression, lint, typecheck, and build all passed.

PHASE 5E COMPLETE WITH CONDITIONS
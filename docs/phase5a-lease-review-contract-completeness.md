# Phase 5A - Lease Review Completeness and Upload-to-UI Contract Validation

Date: 2026-07-17

Verdict: PHASE 5A COMPLETE WITH CONDITIONS

## 1. Executive Result

Phase 5A validated the deterministic local contract from upload/extraction outputs into Lease Review tabs and reviewer state. No live Azure call, live Vertex call, deployment, remote Supabase access, migration, provider-default change, legacy removal, approval-gating redesign, broad refactor, or Phase 4F transport work was performed.

`BUSINESS_EXTRACTION_PROVIDER` remains `legacy_hybrid` by default. V3 readiness remains advisory / No Gate.

Two narrow contract gaps were confirmed and fixed:

- Conflicting extracted facts now remain visible as `needs_review` instead of being auto-classified as rejected.
- CAM/recovery classification now includes annual reconciliation, true-up, audit, allocation, pro-rata, and proportionate-share categories.

Condition: browser-level visual validation was not completed in an authenticated seeded local app session. The contract is covered by deterministic normalizer/component-adjacent tests and provider-neutral backend contract tests.

## 2. Current End-to-End Contract

The audited contract is:

`CanonicalDocumentLayout` / compatible parsed layout -> `runBusinessExtraction` -> `ExtractionPipelineResult` -> `buildReviewPayload` / `buildLeaseWorkflowAbstraction` -> `normalized_output` -> `ui_review_payload` -> `review-approve` draft preservation -> `normalizeLeaseReviewData` -> Lease Review tabs, specialized CAM/Expense tables, readiness summaries, and reviewer saves.

Lease Review consumes canonical fields, workflow expense rules, clause records, dynamic extracted document items, review policy metadata, confidence, source page, source text, extraction mode, and reviewer `field_reviews`.

## 3. Field Producer/Consumer Matrix

| Field or record | Producer | Review consumer | Evidence/confidence | Reviewer persistence |
| --- | --- | --- | --- | --- |
| `tenant_name` | extracted field / workflow lease field | Parties & Premises | page, source text, confidence | `field_reviews.tenant_name` |
| `landlord_name` | extracted field / workflow lease field | Parties & Premises | page, source text, confidence | `field_reviews.landlord_name` |
| `property_address` | extracted field / workflow lease field | Parties & Premises | page, source text, confidence | `field_reviews.property_address` |
| `commencement_date` | extracted field / workflow lease field | Dates & Term, Critical Dates reference | page, source text, confidence | `field_reviews.commencement_date` |
| `expiration_date` | extracted field / workflow lease field | Dates & Term, Critical Dates reference | page, source text, confidence | `field_reviews.expiration_date` |
| `monthly_rent` | extracted field / workflow lease field | Rent & Charges, Budget Preview reference | page, source text, confidence | `field_reviews.monthly_rent` |
| `lease_type` | extracted field / workflow lease field | Expenses / Recoveries | page, source text, confidence | `field_reviews.lease_type` |
| CAM/recovery rules | `workflow_output.expense_rules` | CAM Rules | source page/text when present | specialized review rows |
| tax, insurance, utility rules | `workflow_output.expense_rules` | Expenses / Recoveries and specialized tabs | source page/text when present | specialized review rows |
| insurance requirements | extracted fields / dynamic findings | Insurance | page, source text, confidence | field-specific review state |
| renewal/options | extracted fields / clauses | Legal / Options | page, source text, confidence | field-specific review state |
| clause records | `workflow_output.lease_clauses` | Clause Records | page, source text, confidence | clause review rows |
| dynamic findings | `workflow_output.extracted_document_items` | routed business tab | page, source text, confidence | dynamic row review state |

## 4. Tab Ownership Matrix

Lease Review owns these tabs through `LEASE_REVIEW_TABS`: Summary, Parties & Premises, Dates & Term, Rent & Charges, Expenses / Recoveries, CAM Rules, Taxes, Insurance, Utilities, Repairs & Maintenance, Legal / Options, Critical Dates, Notices, Signatures, Documents / Exhibits, Clause Records, Budget Preview, and Extraction Debug.

Primary ownership findings:

- CAM and annual recovery mechanics belong in CAM Rules.
- Non-CAM recoveries and reimbursable operating categories belong in Expenses / Recoveries or the relevant specialized tab.
- Renewal, assignment, amendment, and option terms belong in Legal / Options.
- Clause-level extracted records belong in Clause Records.
- Budget Preview and Summary may reference fields read-only, but should not create a competing editable source of truth.

## 5. Duplicate-Field Findings

No user-facing duplicate editable source of truth was found for the validated fixture rows. Summary, Critical Dates, and Budget Preview may repeat selected values as read-only references. Editable standard field review remains keyed by canonical field identity.

The Phase 5A fixture asserts CAM rows do not duplicate expense rows by shared row key after classification.

## 6. Missing-Projection Findings

Fixed:

- Conflicting facts with `conflict_detected` previously became `rejected`; they now project as `needs_review` and stay visible for reviewer action.
- `annual_reconciliation` and related recovery categories were not classified as CAM by the synchronous normalizer; they now project into CAM review rows.

No fixture-covered optional clauses were fabricated when absent. Empty optional CAM, expense, and dynamic finding collections remain empty.

## 7. CAM and Expense Findings

The review path supports both workflow-derived fallback rules and persisted rule loading. `ExpenseRulesTable` and `CamRulesTable` remain the specialized UI consumers. The synchronous normalizer now aligns more closely with the expense-rule taxonomy by treating reconciliation, true-up, audit, allocation, pro-rata, and proportionate-share categories as CAM/recovery review candidates.

Triple-net fixtures now validate:

- CAM/recovery rules route to CAM Rules.
- Taxes, insurance, and utilities route to Expense Rules / specialized review surfaces.
- Extracted rule rows default to `needs_review`.
- CAM and expense rows do not share the same review key.

## 8. Evidence/Confidence Findings

Lease Review table rows expose Field, Value, Status, Confidence, Extraction Mode, Page, Source Text, and Action. The Phase 5A fixture asserts source page, source text, and confidence projection for standard fields, dynamic findings, CAM rows, and expense rows.

No provider payloads or private lease text were used.

## 9. Profile-Requiredness Findings

Base leases still apply the existing required-field and approval-blocker expectations.

Assignment and amendment-like documents use the current reduced-review policy and do not inherit base-lease blockers for base rent, lease type, CAM, or budget readiness. This audit did not redesign the document-profile taxonomy.

## 10. Reviewer-State Findings

Reviewer state remains authoritative through `field_reviews`. The Phase 5A fixture validates that an automated retry view with a different extracted value does not overwrite an edited field status. Existing backend preservation tests also validate review-state survival through the review-approve path.

## 11. Files Changed

- `src/lib/leaseReviewFieldNormalizer.js`
- `src/lib/__tests__/phase5aLeaseReviewContract.test.js`
- `docs/phase5a-lease-review-contract-completeness.md`

## 12. Test Results

Focused Phase 5A frontend contract:

- Command: `npx vitest run src/lib/__tests__/phase5aLeaseReviewContract.test.js`
- Result: 1 test file passed; 6 tests passed; 0 failed.

Full frontend regression:

- Command: `npm test`
- Result: 57 test files passed; 663 tests passed; 0 failed.

Lint:

- Command: `npm run lint`
- Result: pass; exit code 0.

Typecheck:

- Command: `npm run typecheck`
- Result: pass; exit code 0.

Build:

- Command: `npm run build`
- Result: pass; built in 11.73s.
- Notes: existing dynamic/static import chunk warnings and existing chunk-size warning remained.

Backend contract bundle:

- Runtime: `denoland/deno:2.7.12` in Docker.
- Command: `docker run --rm -v "${PWD}:/workspace" -w /workspace denoland/deno:2.7.12 deno test --allow-env --allow-read --allow-net --no-lock supabase/functions/_tests/business-extraction-orchestrator.test.ts supabase/functions/_tests/business-extraction-acceptance.test.ts supabase/functions/_tests/lease-review-readiness-and-evidence-guarantees.test.ts supabase/functions/_tests/review-approve-reviewer-state-preservation.test.ts`
- Result: `ok | 57 passed | 0 failed (560ms)`.
- Notes: dependency imports were fetched from public Deno package hosts. No Azure or Vertex provider was configured or called. Provider behavior in these tests used dependency-injected/mock seams.

Windows Deno runner note:

- Runtime: Deno 2.7.12 on Windows.
- Result: runner panic during pipe/output handling, classified as tooling/runtime handling rather than assertion failure.

Local HTTP backend integration note:

- A local HTTP integration module was not run because the required local privileged development environment value was intentionally not supplied. No credentials were introduced for Phase 5A.

## 13. Visual/Manual Validation

Browser-level visual validation was not completed because no authenticated seeded local Lease Review session was available within the Phase 5A constraints.

Manual checklist for the next seeded local walkthrough:

- Confirm all Lease Review tab labels render.
- Confirm Field, Value, Status, Confidence, Extraction Mode, Page, Source Text, and Action columns render without overlap.
- Confirm CAM Rules and Expenses / Recoveries rows are separated for a triple-net fixture.
- Confirm conflicting facts appear as `needs_review`.
- Confirm reviewer edit/save/reload preserves edited field state.
- Confirm optional missing clauses are not shown as fabricated values.
- Confirm readiness and blocker counts match document profile expectations.

## 14. Remaining Risks

- Browser validation remains conditional until a seeded authenticated local fixture is opened in the app.
- Live-provider output shape was intentionally not retested in Phase 5A.
- Assignment and amendment profile behavior was validated against the current reduced-review policy, not redesigned.
- Full local HTTP workflow remains dependent on local Supabase/runtime credentials that were not introduced during this phase.

## 15. Next Action

Use a deterministic local seeded Lease Review draft to run the visual/manual checklist, then decide whether the remaining browser-validation condition can be closed without starting provider transport work.

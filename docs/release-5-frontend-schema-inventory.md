# Release 5 Frontend Schema Inventory

Release 5 introduces `ReviewDocumentViewModel` as the frontend contract for lease review. Backend-specific payload selection is centralized in `src/lib/review/useReviewDocument.ts` and `src/lib/review/adapters/`.

| Consumer | Payload access today | Status | Approval/readiness logic | Release 5 action |
| --- | --- | --- | --- | --- |
| `src/pages/LeaseReview.jsx` | Loads uploaded file, calls `useReviewDocument`, bridges VM into legacy-shaped `ui_review_payload` for older normalizers | Mixed orchestration | Existing legacy gates remain; VM approval summary rendered separately | Entry point now uses adapter-selected VM; remaining legacy workflow reads are isolated as migration debt |
| `src/components/lease-review/EnterpriseHeaderIntelligenceBar.jsx` | `ReviewDocumentViewModel` | View model | Uses `document.approval` and `document.coverage` only | Converted |
| `src/components/lease-review/EnterpriseCoverageDashboard.jsx` | `ReviewCoverageViewModel`, `ReviewApprovalViewModel` | View model | Uses backend-derived VM metrics | Converted |
| `src/components/lease-review/EnterpriseFindings.jsx` | `ReviewFindingViewModel[]` | View model | No approval computation | Converted |
| `src/components/lease-review/FieldDrawerIntelligence.jsx` | `ReviewFieldViewModel` | View model | Displays status, evidence, conflict, derivation, reviewer action | Converted |
| `src/components/lease-review/FieldDetailDrawer.jsx` | Legacy row plus optional `reviewField` VM | Mixed UI | Existing reviewer actions still legacy service backed | Canonical intelligence panel receives VM only |
| `src/components/lease-review/LeaseReviewTabTable.jsx` | Normalized rows plus optional `reviewFields` VM map | Mixed UI | Existing quick actions remain legacy service backed | Raw enterprise payload removed from props |
| `src/components/review/*` | `ReviewDocumentViewModel` subtypes | View model | No raw payload access | New shared components |
| `src/lib/review/adapters/*` | Enterprise/legacy payloads | Adapter boundary | Converts backend statuses into VM statuses | Authoritative schema boundary |
| `src/lib/review/useReviewDocument.ts` | V4 endpoint response and uploaded file fallback | Loader boundary | Emits telemetry; classifies schema/generation errors | Authoritative source selector |
| `src/lib/leaseReviewFieldNormalizer.js` | `ui_review_payload`, lease extraction data | Legacy adapter-backed | Computes legacy readiness/readability for old tables | Deferred retirement after full table migration |
| `src/lib/leaseFieldResolver.js` | Lease/extraction legacy shapes | Legacy helper | No canonical projection authority | Deferred retirement |
| `src/lib/leaseReviewSchema.js` | Lease/extraction legacy shapes | Legacy schema helper | Legacy status presentation and acceptance gates | Deferred retirement |
| `src/components/lease-review/ExtractionDebugPanel.jsx` | Raw payloads | Debug allowlist | Diagnostic only | Keep allowlisted |
| `src/services/documentIntelligenceV3Service.js` | V4 response transport | Service boundary | None | Keep allowlisted |

## Boundary Rules

Active review display components should not directly read backend keys such as `ui_review_payload`, `canonicalFieldKey`, or raw canonical/legacy value fallbacks. Those concerns belong in adapter, loader, service, or debug files.

Temporary exceptions remain for `LeaseReview.jsx` orchestration and the legacy normalizer path because the older spreadsheet tables still consume normalized legacy rows during Release 5. The boundary script documents and enforces this narrower migration point so new review components do not add more raw payload dependencies.
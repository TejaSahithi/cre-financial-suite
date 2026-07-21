# Release 4 Canonical Review Authority Audit

## Scope

Release 4 promotes `document_canonical_field_projections` from diagnostics into the backend-owned source for reviewer-facing lease fields. Activation is controlled by `ENABLE_CANONICAL_REVIEW_PAYLOAD` and `ENABLE_CANONICAL_REVIEW_PAYLOAD_STRICT`; default behavior remains legacy.

## A1. Legacy Payload Construction

| Area | Files | Role | Notes |
| --- | --- | --- | --- |
| Normalize writer | `supabase/functions/normalize-pdf-output/index.ts` | Builds and writes `uploaded_files.ui_review_payload` and `normalized_output` | `buildMinimalReviewPayload()` creates durable review fields before enrichment; `buildReviewPayload()` enriches later with workflow/evidence detail. |
| Pipeline safety | `supabase/functions/_shared/extraction/payload-guard.ts`, `business-extraction-acceptance.ts` | Detects meaningful review payloads | Used by recovery/reconciliation so fallback-shaped payloads do not masquerade as durable review output. |
| Frontend resolver | `src/lib/leaseFieldResolver.js` | Reads a multi-source fallback chain | Current practical reviewer authority. Release 4 keeps this intact when canonical authority is off. |
| Lease Review components | `src/pages/LeaseReview.jsx`, `src/components/lease-review/*` | Present, validate, edit, and approve fields | Many consumers read normalized lease objects produced from legacy payloads rather than canonical projections. |
| Debug surfaces | `src/components/lease-review/ExtractionDebugPanel.jsx` | Reads `ui_review_payload` and v3 diagnostics | Diagnostic-only today; Release 4 adds enterprise payload diagnostics beside existing views. |

## A2. Canonical Projection Production

`document_canonical_field_projections` is written by `supabase/functions/_shared/extraction/document-intelligence-v3/side-write.ts` from `extractCanonicalFieldProjections()` in `fact-mapper.ts`.

Current v3 rows use app field keys as canonical keys. Release 4 maps them through `canonical-projection-contract.ts` into the strict vocabulary: `resolved`, `resolved_with_warning`, `needs_review`, `conflict`, `not_found`, `missing`, `missing_source_evidence`, `invalid`, `suppressed`.

Initial version metadata:

| Field | Value |
| --- | --- |
| `projection_schema_version` | `canonical-field-projection-v1` |
| `projection_algorithm_version` | `projection-resolution-v1` |
| enterprise payload schema | `enterprise-review-payload-v1` |

## A3. Frontend Consumers

| Consumer | Current Source | Release 4 Classification |
| --- | --- | --- |
| Lease Review tables/details | normalized lease object from legacy review payload | Adapter-compatible; canonical metadata added through `src/lib/review/enterpriseReviewAdapter.ts`. |
| Dynamic findings | legacy field emptiness/status | Should consume `EnterpriseDynamicFinding[]`; adapter exposes structured findings. |
| Approval summary/blockers | legacy validation state and backend approval helpers | Canonical validator is available but legacy mode remains unchanged while flag is off. |
| CAM / compute previews | mixed normalized lease fields and downstream compute inputs | Release 4 marks compute-relevant registry fields; compute adapters can reject missing/conflict/invalid fields. |
| Extraction debug | uploaded file payload + v3 diagnostics | Enterprise payload coverage/parity can be displayed from the v4 endpoint. |

## A4. Approval And Validation Dependencies

Approval-sensitive assumptions currently include required field presence, date/number parsing, source evidence quality, reviewer edits, and compute prerequisites. Release 4 centralizes these in:

- `canonical-review-field-registry.ts`: required/compute/reviewer-visible classification.
- `canonical-coverage-ledger.ts`: field-level coverage and blocking reasons.
- `canonical-review-validator.ts`: approval eligibility over enterprise payloads.
- `document_field_review_overrides`: reviewer actions without mutating projections.

## A5. Coverage Inventory

The machine-readable inventory shape is implemented as `CanonicalProjectionCoverageInventory` and `buildCoverageInventory()` in `canonical-review-field-registry.ts`.

Migration status meanings:

| Status | Meaning |
| --- | --- |
| `ready` | Projection exists and required evidence is present or not required. |
| `partial` | Configured but not currently reviewer-visible. |
| `missing_projection` | Registry expects canonical authority but no projection exists. |
| `missing_evidence` | Projection exists but required evidence is absent. |
| `unsupported_shape` | Reserved for fields whose shape cannot be represented in the current payload. |
| `legacy_only` | Explicitly configured as legacy authority. |

## Activation Decision

Release 4A is safe to deploy with both flags false. It builds and persists enterprise payloads in shadow mode while reviewers continue seeing legacy data. Hybrid and strict modes are activated independently by environment flags; rollback is `ENABLE_CANONICAL_REVIEW_PAYLOAD=false`.
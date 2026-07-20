# Module: Portfolio / Property / Building / Unit Management

> Generated: 2026-07-20 · Revision: `34563cfaff4271b72d00b0841353dc2792f2f16a` · Canonical score **3.0 / 5**, criticality **12 (High)** — [03](../03-module-catalog-and-maturity.md) · Index: [04](../04-module-deep-dives.md)

## Functional / technical view
The portfolio hierarchy (`portfolios → properties → buildings → units`) is the foundational data model everything else hangs off. Pages: `Portfolios`, `PortfolioInsights`, `Properties`, `PropertyDetail`, `Buildings`, `Units`, `BuildingsUnits`. Tables carry direct `org_id` with correct cascade/set-null semantics (`properties.org_id ON DELETE CASCADE`, `portfolio_id ON DELETE SET NULL` — [08 §1](../08-database-schema-and-ui-gap-analysis.md)). `property/BulkImportModal.jsx` + Vendors/`VendorProfile` round out the entity set. Standard CRUD via `api.js` + `useOrgQuery`.

## Workflow view
Straightforward create/read/update/archive flows; no complex state machine. Deletion cascades are real deletes (no soft-delete — [08 §3](../08-database-schema-and-ui-gap-analysis.md)), so archiving a property removes dependent rows per FK design, not a reversible status flip.

## Assessment
**Strengths:** clean, well-normalized core model; correctly org-scoped; bulk import exists for onboarding large portfolios.
**Weaknesses:** no soft-delete/undo on a data class customers will accidentally delete; unpaginated lists at scale ([06 §2](../06-frontend-backend-integration.md)); minimal test coverage relative to how central this data is.
**Recommended:** soft-delete + restore window (M, P2); pagination (M, P2); CRUD-path tests (S, P2).

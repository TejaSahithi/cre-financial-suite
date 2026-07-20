# Module: CAM Engine (Tier 1)

> Generated: 2026-07-20 · Revision: `34563cfaff4271b72d00b0841353dc2792f2f16a` · Canonical score **2.6 / 5**, criticality **13 (High)** — [03](../03-module-catalog-and-maturity.md) · Index: [04](../04-module-deep-dives.md)

## Functional view
- **Problem:** Common Area Maintenance charge-back calculation — a CRE-specific, high-value differentiator (splitting shared operating costs across tenants per lease terms). **Users:** asset managers, controllers.
- **Inputs:** property CAM config, lease expense rules published to CAM, expense actuals. **Outputs:** per-tenant CAM reconciliation figures.
- **Rules:** rules must be `approved`/`published_to_cam` in the lease-expense-rules table before CAM consumes them (`publish-lease-expense-rule-to-cam`); profile approval workflow (`save-cam-profile`⚠ → `approve-cam-profile`⚠).

## Technical view
- **Components:** pages `CAMDashboard`, `CAMSetup`, `CAMCalculation`; `src/services/camConfig.js`; functions `compute-cam`, `save-cam-profile`⚠, `approve-cam-profile`⚠, `save-property-cam-config`⚠ (⚠ undeclared, [SEC-002](../findings-register.md#sec-002)).
- **DB:** `cam_calculations`, `cam_expense_inputs`, `cam_profiles`; upstream dependency on `lease_expense_rules`/`_values` — the tables lacking direct `org_id` ([TEN-002](../findings-register.md#ten-002)), so CAM inherits that isolation-audit burden.
- **Tests:** thin — no CAM-specific spec found beyond incidental coverage via lease-expense-rule tests.

## Workflow view
```mermaid
flowchart LR
    LER[Approved lease expense rules] -->|publish-lease-expense-rule-to-cam| CFG[CAM profile config]
    CFG -->|save/approve-cam-profile| APPROVED[Approved profile]
    APPROVED -->|compute-cam| CALC[(cam_calculations)]
    CALC --> DASH[CAMDashboard reconciliation view]
```
**Failure path:** unapproved/unpublished rules presumably excluded from compute — exact exclusion logic `UNVERIFIED` (not traced to source in this pass); no automated test proves correct proration. **Recovery:** manual profile correction + recompute.

## Assessment
**Strengths:** models a genuinely CRE-specific, hard-to-replicate workflow; clean separation from raw expense management.
**Weaknesses:** three undeclared functions on a financial-calculation path; inherited indirect-scoping risk from the rules tables; no dedicated test suite despite being a core differentiator; proration correctness unverified by this audit (would need domain-expert test fixtures).
**Recommended:** dedicated CAM proration test suite with known-correct fixtures (M, P1 — this is a "did we get the math right" risk, the worst kind to discover from a customer); declare functions (S, P1); denormalize org_id on rules tables (shared fix with [TEN-002](../findings-register.md#ten-002)).

# 00 — Executive Product Overview

> Generated: 2026-07-20 · Repository revision: `34563cfaff4271b72d00b0841353dc2792f2f16a` (branch `feature/lease-intelligence-enterprise-p1-p8`) · Part of the [Project Audit](README.md)

## One-sentence description
A multi-tenant SaaS that turns commercial-lease PDFs into AI-extracted, human-verified financial data — driving CAM reconciliation, budgeting, expense classification, and variance reporting for CRE finance teams.

## Executive summary
CRE Financial Suite is a React/Supabase application (163 tables, 216 migrations, 82 edge functions, 71 pages) built around a genuinely sophisticated AI lease-abstraction pipeline (Vertex AI, Azure Document Intelligence, Anthropic, Docling) with a best-in-class human review UX. The engineering underneath is disciplined — evidenced by a hardened tenant-resolution model with an in-code record of a fixed security finding, an idempotent Stripe integration, and 685 passing unit tests — but the product has **no CI/CD, no production monitoring, and unverified production deployment state**, and no workflow could be verified end-to-end in this audit's environment. Overall maturity: **2.8 / 5** ([calculation](03-module-catalog-and-maturity.md)). The gap between engineering quality and operational maturity is this product's defining characteristic.

## The apparent customer problem (REPOSITORY-CONFIRMED as built-for, MARKET-VALIDATION-REQUIRED as real)
Commercial lease abstraction — extracting rent schedules, CAM terms, escalations, and critical dates from lease PDFs — is manual, slow, and error-prone work for CRE finance/asset-management teams. The product automates first-pass extraction and structures the human review around evidence citations rather than blind trust in AI output.

## Target customer segments (INFERRED from product structure)
Mid-market commercial real estate owners/operators and their finance/asset-management teams — property counts implied by the portfolio→property→building→unit hierarchy suggest multi-property portfolios, not single-building landlords.

## Primary users & buyer personas
- **User:** CRE analysts/asset managers (upload, review, approve leases; day-to-day workflow).
- **Buyer:** CFO/controller or VP of Asset Management (owns the budgeting/CAM/variance outputs; likely economic buyer).
- **Admin:** org admin (user/role management, settings); **platform operator:** the product's own super-admin (org approval, cross-tenant oversight).

## Jobs to be done
Abstract a lease accurately without re-keying it by hand; get CAM charge-backs right; produce a defensible annual budget; explain variance to ownership/investors; keep an audit trail for disputes.

## Current value proposition
"Upload a lease, get structured evidence-backed data in minutes, not hours of manual abstraction — with a review workflow you can trust because every field shows its source."

## Main product capabilities (see [03](03-module-catalog-and-maturity.md) for maturity scores)
Lease ingestion & AI extraction (3.2) · Lease review & approval (3.3) · CAM engine (2.6) · Expense management (2.7) · Budgeting (2.6) · Revenue/variance (2.5) · Dashboards/reporting (2.4) · Billing (2.7) · Org/RBAC administration (3.1).

## Typical end-to-end customer journey
Signup → email confirm → forced MFA enrollment → org setup wizard → **super-admin approval** → invite team → upload first lease → AI extraction → field-by-field review with evidence → approve → downstream CAM/budget/variance outputs unlock. See [05](05-end-to-end-workflows.md) and [09](09-onboarding-assessment.md) for full traces — no step in this journey could be runtime-verified in this audit ([evidence-index capability matrix](evidence-index.md)).

## What differentiates the product today (REPOSITORY-CONFIRMED)
The lease-review module's evidence-citation UX and approval-blocker workflow — this is materially more careful than a generic "AI extracts a PDF" feature, and it is the highest-scoring, best-tested module in the codebase.

## What may become defensible over time (MARKET-VALIDATION-REQUIRED)
Accumulated structured lease data across customers *could* become a data advantage (better extraction models, benchmark comparisons) — but this requires customer volume and a data-flywheel design not yet evidenced in the repository. See [17](17-billion-dollar-saas-evolution.md).

## Monetization, pricing & packaging (current state + inference)
`organizations.plan` (`starter|professional|enterprise`) + Stripe Checkout exist; `enabled_modules` gates features per org but its link to plan tier was **not confirmed** in code (modules/billing-subscriptions.md) — likely admin-set rather than plan-derived today. No usage-based billing hooks exist ([OPS-007](findings-register.md#ops-007)), which blocks the pricing model (seat-based vs. property-count-based vs. usage-based) most natural for an AI-cost-driven product. **Likely pricing options (MARKET-VALIDATION-REQUIRED):** per-property or per-portfolio-sqft tiers (common in CRE software) combined with an extraction-volume component once metering exists.

## Expansion paths
Accounting-system integrations (the clearest expansion-revenue and retention lever — currently unbuilt, modules/integrations.md); scheduled/emailed reporting; a public API/data-platform play (Path 3 in [17](17-billion-dollar-saas-evolution.md), not recommended before stabilization).

## PLG vs. sales-led considerations
The onboarding journey (forced MFA before value, manual super-admin approval gate) is structurally **sales-led/high-touch**, not product-led — consistent with mid-market CRE buyer norms but worth naming explicitly, since some of the roadmap items (self-serve billing) only pay off if a PLG motion is actually intended.

## Enterprise buyer expectations vs. current state
SSO/SAML/SCIM, SOC 2, SLAs, tested DR — all **MISSING** ([15](15-enterprise-readiness-gap-analysis.md)). These are the standard procurement gate for any mid-market-and-up enterprise deal in this space.

## Key assumptions requiring validation
ICP and willingness to pay; whether extraction accuracy is competitively differentiated (no benchmark data in repo); whether the "500+ properties" landing-page claim ([PRD-002](findings-register.md#prd-002)) is accurate; whether SSO/compliance are actually blocking deals today or are anticipatory investment.

## Product, business-model & technical-constraint risks
See [20-risk-register.md](20-risk-register.md) top-10; the technical constraints most likely to slow commercial growth are the absence of CI/monitoring ([OPS-001](findings-register.md#ops-001)/[OPS-002](findings-register.md#ops-002)) — these gate *any* growth-stage reliability story — and the lack of usage metering, which gates pricing-model flexibility.

## Realistic assessment: does the implementation support the apparent business proposition?
**Partially.** The core value proposition (AI extraction + trustworthy human review) is genuinely well-built and is the strongest evidence this could be a real product. But the surrounding commercial and operational machinery — billing entitlement clarity, usage metering, monitoring, tested deployment — is not yet built to the standard that "sell this to mid-market enterprise CRE finance teams" requires. This is a normal, addressable gap for a product at this stage, not a fundamental flaw — the roadmap in [16](16-product-and-technical-roadmap.md) sequences exactly this closing.

## Business capability map

| Business capability | Target user | User value | Implementing module | Maturity | Evidence | Known gaps |
|---|---|---|---|---|---|---|
| Lease document abstraction | Analyst | Eliminates manual re-keying | [Lease ingestion & extraction](modules/lease-ingestion-extraction.md) | 3.2 | EV-16/17/19 | No scheduler/reaper ([OPS-006](findings-register.md#ops-006)) |
| Trustworthy human review | Analyst/Manager | Confidence in AI output | [Lease review & approval](modules/lease-review-approval.md) | 3.3 | EV-16, review components | Config.toml gaps ([SEC-002](findings-register.md#sec-002)) |
| CAM charge-back accuracy | Controller | Correct tenant billing | [CAM engine](modules/cam-engine.md) | 2.6 | compute-cam | No correctness tests |
| Expense tracking & classification | Analyst | Operating-cost visibility | [Expense management](modules/expense-management.md) | 2.7 | expenseService.js | Worst config.toml gap |
| Budget creation | Controller/CFO | Annual planning | [Budgeting](modules/budgeting.md) | 2.6 | generate-budget | AI/heuristic provenance unlabeled |
| Variance & actuals analysis | CFO | Explain results to ownership | [Revenue/actuals/variance](modules/revenue-actuals-variance.md) | 2.5 | computation_snapshots | Untested math |
| Reporting & dashboards | CFO/Investors | Portfolio visibility | [Dashboards & reporting](modules/dashboards-reporting.md) | 2.4 | Recharts suite | No materialized/scheduled layer |
| Billing & subscriptions | Org admin | Self-serve purchase | [Billing](modules/billing-subscriptions.md) | 2.7 | stripe-webhook | Untested; no self-serve portal |
| Access & tenancy | Org admin | Secure multi-user org | [Orgs/RBAC](modules/orgs-rbac-membership.md) | 3.1 | schema.sql:71-199 | Dual role systems |
| Onboarding & activation | New customer | Time-to-first-value | [Onboarding](modules/onboarding.md) | 2.6 | Onboarding.jsx | Zero funnel telemetry |

## Product narrative

**30-second version:** "We turn commercial lease PDFs into structured, verified financial data — CAM, budgets, and variance reporting — using AI extraction with a review workflow analysts actually trust because every field shows where it came from."

**2-minute version:** Add — the pipeline (Vertex/Azure/Anthropic/Docling, provider-switchable), the review UX (evidence citations, approval blockers), and the downstream financial modules (CAM, expenses, budgets, variance) it feeds. Note the product is genuinely multi-tenant with a hardened tenancy model, but operationally young — no CI/monitoring yet, and production deployment state needs verification before any customer-facing claim.

**10-minute CTO/CEO version:** Everything above, plus: the maturity rubric (2.8/5 overall, [03](03-module-catalog-and-maturity.md)); the five facts in [interim-cto-briefing.md](interim-cto-briefing.md); the three strategic paths in [17](17-billion-dollar-saas-evolution.md); and the immediate 0–30-day stabilization list in [16](16-product-and-technical-roadmap.md) — verify production, close the CI/monitoring gap, and confirm the market-validation questions in [19](19-open-questions-and-validation-plan.md) before committing to a scale-up roadmap.

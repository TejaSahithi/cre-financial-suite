# 04 — Module Deep Dives (Index)

> Generated: 2026-07-20 · Repository revision: `34563cfaff4271b72d00b0841353dc2792f2f16a` (branch `feature/lease-intelligence-enterprise-p1-p8`) · Part of the [Project Audit](README.md)

Full deep-dive documents live in [modules/](modules/), one per module, written at depth proportional to criticality ([03](03-module-catalog-and-maturity.md)). Tier 1 (9 modules) carries the deepest evidence — full functional/technical/workflow/assessment structure with sequence diagrams; the remaining 10 carry proportionate depth. All scores below are copied verbatim from the canonical maturity table and must not diverge from it.

## Tier 1 — deepest evidence (written and cross-checked first)

| Module | Score | Criticality | File |
|---|---|---|---|
| Authentication & MFA | 3.3 | 17 Critical | [auth-mfa.md](modules/auth-mfa.md) |
| Organizations, memberships, RBAC & user management | 3.1 | 17 Critical | [orgs-rbac-membership.md](modules/orgs-rbac-membership.md) |
| Onboarding & access requests | 2.6 | 13 High | [onboarding.md](modules/onboarding.md) |
| Lease ingestion & AI extraction pipeline | 3.2 | 17 Critical | [lease-ingestion-extraction.md](modules/lease-ingestion-extraction.md) |
| Lease review & approval | **3.3 (highest)** | 16 Critical | [lease-review-approval.md](modules/lease-review-approval.md) |
| CAM engine | 2.6 | 13 High | [cam-engine.md](modules/cam-engine.md) |
| Billing & subscriptions | 2.7 | 13 High | [billing-subscriptions.md](modules/billing-subscriptions.md) |
| Audit logging | 2.4 | 11 High | [audit-logging.md](modules/audit-logging.md) |
| Platform & background-job infrastructure | 2.7 | 14 Critical | [background-job-infrastructure.md](modules/background-job-infrastructure.md) |

## Remaining modules

| Module | Score | Criticality | File |
|---|---|---|---|
| Portfolio / property / buildings / units | 3.0 | 12 High | [portfolio-property-management.md](modules/portfolio-property-management.md) |
| Lease-expense rules & classification | 2.8 | 12 High | [lease-expense-rules-classification.md](modules/lease-expense-rules-classification.md) |
| Expense management | 2.7 | 11 High | [expense-management.md](modules/expense-management.md) |
| Budgeting | 2.6 | 11 High | [budgeting.md](modules/budgeting.md) |
| Revenue, actuals & variance | 2.5 | 11 High | [revenue-actuals-variance.md](modules/revenue-actuals-variance.md) |
| Dashboards, analytics & reporting | 2.4 | 10 High | [dashboards-reporting.md](modules/dashboards-reporting.md) |
| Notifications & critical dates | **2.0 (tied-lowest)** | 7 Medium | [notifications-critical-dates.md](modules/notifications-critical-dates.md) |
| Documents & file management | 2.8 | 14 Critical | [documents-file-management.md](modules/documents-file-management.md) |
| Admin & super-admin platform | 2.6 | 13 High | [admin-super-admin.md](modules/admin-super-admin.md) |
| Integrations | **2.0 (tied-lowest)** | 6 Medium | [integrations.md](modules/integrations.md) |

## Cross-module themes (surfaced repeatedly across deep dives)

1. **The config.toml declaration gap concentrates in financial-write modules.** Expense management (9/10 functions undeclared), lease review (7/8), lease-expense rules (5/9) are the worst offenders — exactly the modules where an implicit auth default matters most ([SEC-002](findings-register.md#sec-002)).
2. **Calculation-correctness is unverified in three modules that produce numbers a CFO will trust:** CAM proration, budget heuristics, and revenue/variance comparison. None has dedicated correctness tests. This is flagged as a priority pattern, not three separate coincidences.
3. **The three org_id-less tables ([TEN-002](findings-register.md#ten-002)) sit at the intersection of two modules** (lease-expense rules and CAM) — fixing it once resolves a risk in both deep dives.
4. **Notifications and Integrations are the two lowest-scoring modules for different reasons:** one is a likely silent regression from the Base44 migration (correctness question), the other is an unbuilt strategic capability (roadmap question). Leadership should treat them differently despite the identical score.
5. **The lease-intelligence subsystem (ingestion, review, expense rules, CAM) is meaningfully ahead of the financial-output subsystem (budgeting, revenue/variance, reporting)** — the product currently extracts data better than it explains it.

Related: [03 — Maturity](03-module-catalog-and-maturity.md) · [05 — Workflows](05-end-to-end-workflows.md) · [modules/](modules/)

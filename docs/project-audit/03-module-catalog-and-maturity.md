# 03 — Module Catalog & Maturity Scoring

> Generated: 2026-07-20 · Repository revision: `34563cfaff4271b72d00b0841353dc2792f2f16a` (branch `feature/lease-intelligence-enterprise-p1-p8`) · Part of the [Project Audit](README.md)

**19 modules discovered** (not assumed — derived from pages, services, functions, and tables; see [01](01-repository-and-system-inventory.md)). Deep dives: [04](04-module-deep-dives.md) / [modules/](modules/). Scores below are the **canonical values** used by every other document.

## Scoring method (fixed before scoring)

- **Scale:** 0 Missing · 1 Prototype/stub · 2 Basic happy path · 3 Functional for controlled production · 4 Enterprise-ready · 5 Mature/optimized.
- **14 dimensions** → 7 weighted groups: Product+UX 20% · Backend+API+Data 20% · Security+Tenant-isolation 20% · Reliability+Scalability 15% · Testing 10% · Observability+Ops 10% · Docs+Enterprise 5%.
- **Rules applied:** missing production observability **caps Observability+Ops at 2 suite-wide** ([OPS-002](findings-register.md#ops-002)); no *confirmed* cross-tenant exposure exists, so the enterprise-readiness ≤1 cap does not trigger; UNVERIFIED lowers confidence, not score. "Enterprise-ready" requires security ≥4, tenant isolation ≥4, ops ≥4 and no open Critical findings — **no module qualifies today; the ops cap alone excludes the whole suite**, and none reaches the ≥3 "candidate" bar on ops either.
- **Module criticality** (revenue dependency + data sensitivity + tenant-isolation exposure + workflow centrality + blast radius + enterprise-sales impact, each 0–3; bands: 14–18 Critical, 9–13 High, 5–8 Medium) weights each module's share of the overall score.

## Maturity & criticality table (canonical)

Group scores per module (P+UX / B+A+D / Sec+TI / Rel+Sca / Test / Obs+Ops / Doc+Ent → **weighted**). Evidence for each row: module file in [modules/](modules/) + finding IDs.

| # | Module | P+UX | B+A+D | Sec+TI | Rel+Sca | Test | Obs+Ops | Doc+Ent | **Score** | Criticality | Key evidence / limiting findings |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Authentication & MFA | 4.0 | 4.0 | 3.0 | 3.0 | 2.0 | 1.5 | 2.5 | **3.3** | 17 Critical | EV-04/28; [SEC-004](findings-register.md#sec-004) caps Sec; guards E1-verified |
| 2 | Orgs, memberships, RBAC & user mgmt | 3.5 | 4.0 | 3.0 | 3.0 | 2.5 | 1.5 | 2.5 | **3.1** | 17 Critical | EV-05/07/10/13; dual role systems ([contradictions](contradictions-and-drift.md)) |
| 3 | Onboarding & access requests | 3.0 | 3.0 | 3.0 | 2.5 | 2.0 | 1.5 | 2.0 | **2.6** | 13 High | signup fn (Resend emails), org approval, [09](09-onboarding-assessment.md) |
| 4 | Lease ingestion & AI extraction | 3.5 | 4.0 | 3.0 | 3.0 | 3.0 | 2.0 | 3.0 | **3.2** | 17 Critical | EV-16/17/19/20; e2e broken locally ([OPS-003](findings-register.md#ops-003)) |
| 5 | Lease review & approval | 4.0 | 4.0 | 3.0 | 3.0 | 3.5 | 1.5 | 3.0 | **3.3** | 16 Critical | richest UI+tests; field contracts (69–73 KB schema modules) |
| 6 | Lease-expense rules & classification | 3.0 | 3.5 | 2.5 | 2.5 | 3.0 | 1.5 | 2.5 | **2.8** | 12 High | [TEN-002](findings-register.md#ten-002) tables live here |
| 7 | CAM engine | 3.0 | 3.0 | 3.0 | 2.5 | 2.0 | 1.5 | 2.0 | **2.6** | 13 High | compute-cam + profiles/approve fns (⚠ undeclared, [SEC-002](findings-register.md#sec-002)) |
| 8 | Expense management | 3.0 | 3.0 | 3.0 | 2.5 | 2.5 | 1.5 | 2.0 | **2.7** | 11 High | expenseService 137 KB client-side ([02](02-current-state-architecture.md) decision table) |
| 9 | Budgeting | 3.0 | 3.0 | 3.0 | 2.5 | 2.0 | 1.5 | 2.0 | **2.6** | 11 High | [DATA-001](findings-register.md#data-001) resolved core, residual silent fallback |
| 10 | Revenue, actuals & variance | 2.5 | 3.0 | 3.0 | 2.5 | 2.0 | 1.5 | 2.0 | **2.5** | 11 High | compute-revenue/reconciliation traced statically only |
| 11 | Billing & subscriptions (Stripe) | 2.5 | 3.0 | 3.5 | 3.0 | 1.5 | 1.5 | 2.0 | **2.7** | 13 High | EV-18 idempotent webhook; no entitlement enforcement traced ([modules/billing](modules/billing-subscriptions.md)) |
| 12 | Dashboards, analytics & reporting | 3.0 | 2.5 | 3.0 | 2.5 | 1.5 | 1.0 | 2.0 | **2.4** | 10 High | Recharts suite; no reporting layer ([08](08-database-schema-and-ui-gap-analysis.md) §6) |
| 13 | Notifications & critical dates | 2.0 | 2.0 | 3.0 | 2.0 | 1.0 | 1.0 | 1.5 | **2.0** | 7 Medium | Base44 triggers dead ([ARC-002](findings-register.md#arc-002)); delivery `UNVERIFIED` |
| 14 | Documents & file management | 3.0 | 3.5 | 3.5 | 2.5 | 2.0 | 1.5 | 2.0 | **2.8** | 14 Critical | EV-20 buckets; magic-byte checks; `documents` bucket manual (`PARTIAL`) |
| 15 | Audit logging | 2.5 | 3.0 | 2.5 | 2.5 | 1.5 | 2.0 | 2.0 | **2.4** | 11 High | EV-14/15 drift history; dual actor columns |
| 16 | Admin & super-admin platform | 3.0 | 3.0 | 3.0 | 2.5 | 1.5 | 1.5 | 2.0 | **2.6** | 13 High | acting-org hardened ([TEN-003](findings-register.md#ten-003)) |
| 17 | Integrations (UPS, integrations page) | 2.0 | 2.0 | 3.0 | 2.0 | 1.0 | 1.0 | 1.5 | **2.0** | 6 Medium | single real integration; page largely aspirational (`PARTIAL`) |
| 18 | Portfolio / property / buildings / units | 3.5 | 3.5 | 3.0 | 3.0 | 2.5 | 1.5 | 2.0 | **3.0** | 12 High | core CRUD solid; bulk import modal |
| 19 | Platform & background-job infra | 2.5 | 3.5 | 2.5 | 3.0 | 2.5 | 1.5 | 2.5 | **2.7** | 14 Critical | EV-16/17; no scheduler/reaper; [SEC-003](findings-register.md#sec-003) |

**Detail note:** the 14 individual dimensions (product completeness, UX, backend, API, data model, security, tenant isolation, reliability, scalability, testing, observability, operational readiness, documentation, enterprise readiness) equal their group score above unless a module deep dive states a deviation — deviations and per-dimension evidence live in each [modules/](modules/) file (Tier-1 modules carry the full 14-dimension breakdown).

## Overall product maturity (calculation shown)

Overall = Σ(module score × criticality) ÷ Σ(criticality) = **661.1 ÷ 238 = 2.78 → 2.8 / 5**

| Component | Value |
|---|---|
| Σ criticality (all 19) | 238 |
| Σ (score × criticality) | 661.1 |
| **Overall maturity** | **2.8 / 5 — between "basic happy path" and "functional for controlled production"** |

The working hypothesis ("core modules may fall in the 2–3 range") **held under the rubric**: 17 of 19 modules score 2.0–3.3; only Auth and Lease Review reach 3.3. The binding constraints are uniform: observability/ops (1.0–2.0 everywhere, [OPS-001](findings-register.md#ops-001)/[OPS-002](findings-register.md#ops-002)) and testing depth outside the lease domain.

## Heat map

```
Score:   ▓▓▓ ≥3.0   ▒▒▒ 2.5–2.9   ░░░ <2.5
Auth & MFA            ▓▓▓ 3.3    Lease review          ▓▓▓ 3.3
Ingestion/extraction  ▓▓▓ 3.2    Orgs/RBAC             ▓▓▓ 3.1
Portfolio/property    ▓▓▓ 3.0    Rules/classification  ▒▒▒ 2.8
Documents/files       ▒▒▒ 2.8    Billing               ▒▒▒ 2.7
Expenses              ▒▒▒ 2.7    Jobs infra            ▒▒▒ 2.7
Onboarding            ▒▒▒ 2.6    CAM engine            ▒▒▒ 2.6
Budgeting             ▒▒▒ 2.6    Admin/super-admin     ▒▒▒ 2.6
Revenue/variance      ▒▒▒ 2.5    Dashboards/reporting  ░░░ 2.4
Audit logging         ░░░ 2.4    Notifications         ░░░ 2.0
Integrations          ░░░ 2.0
```

## Rankings & risk lenses

- **Weakest:** Notifications (2.0), Integrations (2.0), Audit logging (2.4), Dashboards/reporting (2.4), Revenue/variance (2.5).
- **Highest-risk (criticality × weakness):** **Platform/jobs infra** (Critical, 2.7 — no scheduler/reaper, internal-secret auth), **Documents/files** (Critical, 2.8 — PII custody), **Audit logging** (High, 2.4 — drift history undermines its purpose), **Billing** (High, 2.7 — revenue path, no tests), **Onboarding** (High, 2.6 — first-impression + activation).
- **Modules blocking enterprise adoption:** Audit logging (trustworthy trail), Auth (SSO/SAML/SCIM `MISSING` — [15](15-enterprise-readiness-gap-analysis.md)), Platform infra (observability/SLA), Billing (entitlements/metering), Admin (support tooling/impersonation controls).
- **Overengineered relative to current value:** the lease-intelligence claims/registry subsystem (~40+ tables, registry snapshot versioning, advisory-audit function family) is far ahead of the rest of the product's maturity — justified only if AI lease abstraction is *the* wedge ([17](17-billion-dollar-saas-evolution.md)); Document-intelligence v3 advisory family duplicates parts of review flow.
- **Strategically important but underdeveloped:** Notifications (retention driver, 2.0), Reporting/analytics (the CFO-facing output layer, 2.4), Billing maturity (monetization, 2.7), Integrations (accounting-system connectors are the obvious moat-builder, 2.0).

Related: [04 — Deep dives](04-module-deep-dives.md) · [05 — Workflows](05-end-to-end-workflows.md) · [15 — Enterprise gaps](15-enterprise-readiness-gap-analysis.md)

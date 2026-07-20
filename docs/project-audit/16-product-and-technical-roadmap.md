# 16 — Product & Technical Roadmap

> Generated: 2026-07-20 · Repository revision: `34563cfaff4271b72d00b0841353dc2792f2f16a` (branch `feature/lease-intelligence-enterprise-p1-p8`) · Part of the [Project Audit](README.md)

**Prioritization model:** `Priority = customer impact + revenue impact + risk reduction + strategic leverage − implementation cost`, each scored 1–5 by the initiative owner at planning time (not pre-scored here — this document sequences by evidence-based urgency, consistent with the P0–P3 labels in the [findings register](findings-register.md)). Every initiative cites its finding ID(s); this document does not introduce new findings.

## 0–30 days: Immediate stabilization

| Initiative | Problem | Evidence | Outcome | Complexity |
|---|---|---|---|---|
| Verify production deployment state | Leadership decisions rest on an unknown | [OPS-005](findings-register.md#ops-005) | Documented delta vs DEPLOY.md; confidence restored | S |
| Reconcile remote schema drift | Corrective migrations exist; remote truth unconfirmed | [TEN-001](findings-register.md#ten-001) | Migrations = ground truth again | S–M |
| Fix local dev/e2e environment | Can't verify anything end-to-end | [OPS-003](findings-register.md#ops-003) | e2e runnable; dev onboarding unblocked | S |
| Stand up CI (lint+typecheck+vitest+audit gate) | 685 tests gate nothing | [OPS-001](findings-register.md#ops-001) | Regressions caught pre-merge | S |
| Add error tracking (Sentry) + uptime check | Production incidents invisible | [OPS-002](findings-register.md#ops-002) | First real detection capability | S |
| Rate-limit + captcha public endpoints | Spam/AI-cost abuse surface | [SEC-008](findings-register.md#sec-008) | Abuse surface closed | S |
| Declare all 82 functions in config.toml | Implicit auth defaults on financial-write paths | [SEC-002](findings-register.md#sec-002) | Explicit, reviewable auth posture | S |
| Hard-fail prod build on missing env | Seed mode can silently eat customer writes | [WKF-002](findings-register.md#wkf-002) | No more silent data loss risk | S |
| Confirm critical-date/expiry alerting status | Possible silent regression from Base44 migration | [notifications module](modules/notifications-critical-dates.md) | Known-good or known-broken, not unknown | S |

## 1–3 months: Foundation

| Initiative | Problem | Evidence | Outcome | Complexity |
|---|---|---|---|---|
| Cross-tenant isolation test suite | No automated proof of tenant boundaries | [SEC-001](findings-register.md#sec-001), [10](10-multi-tenant-saas-readiness.md) | Continuous isolation guarantee | M |
| Separate internal-secret from service-role key | Master DB key doubles as API password | [SEC-003](findings-register.md#sec-003) | Reduced blast radius on leak | M |
| Scheduled worker invocation + job reaper | Stuck pipeline jobs stall silently | [OPS-006](findings-register.md#ops-006) | Reliable extraction pipeline | M |
| Per-tenant AI usage metering | COGS invisible; no usage pricing lever | [OPS-007](findings-register.md#ops-007) | Margin visibility + pricing enablement | M |
| Correctness test suites: CAM proration, budget heuristic, variance calc | Untested financial-math paths ([modules](04-module-deep-dives.md) theme #2) | cam-engine.md, budgeting.md, revenue-actuals-variance.md | Trust in the numbers | M |
| Billing path test coverage (webhook + checkout) | Zero tests on revenue path | modules/billing-subscriptions.md | Confidence in monetization path | M |
| Consolidate dual role systems | memberships.role vs role_definitions/user_roles | [contradictions](contradictions-and-drift.md) | Single access-review source of truth | M |
| Onboarding funnel telemetry | Activation drop-off invisible | [09](09-onboarding-assessment.md) | Data-driven onboarding improvement | S |
| CSP header + XSS renderer audit | localStorage tokens + no CSP | [SEC-004](findings-register.md#sec-004) | Reduced token-theft risk | S |
| Staging environment | No promotion path; migrations tested only in prod | [14](14-devops-infrastructure-and-delivery.md) | Safe migration testing | M |

## 3–6 months: Enterprise readiness

| Initiative | Problem | Evidence | Outcome | Complexity |
|---|---|---|---|---|
| SSO (SAML/OIDC) | Universal procurement gate | [15](15-enterprise-readiness-gap-analysis.md) | Removes hardest sales blocker | M |
| SOC 2 Type I readiness program | No compliance scaffolding | [11 §4](11-security-privacy-and-compliance.md) | Security-review-ready | L |
| Data retention/deletion/export workflows | GDPR/CCPA gap | [08 §3](08-database-schema-and-ui-gap-analysis.md) | Fulfillable erasure/export requests | M |
| Billing entitlements + self-serve portal | Plan→module linkage unverified; no self-serve change/cancel | modules/billing-subscriptions.md | Reduced manual billing ops | M |
| Restore-tested backup/DR runbook | No tested recovery path | [12](12-reliability-scalability-and-operations.md) | Real continuity story for contracts | S |
| Audit-log schema reconciliation | Legacy vs hardened actor columns; drift history | modules/audit-logging.md | Trustworthy audit trail | S–M |
| SCIM provisioning | Enterprise IT lifecycle | [15](15-enterprise-readiness-gap-analysis.md) | Follows SSO | M |

## 6–12 months: Scale & differentiation

| Initiative | Problem | Evidence | Outcome | Complexity |
|---|---|---|---|---|
| Accounting-system integrations (QuickBooks first) | Zero real integrations beyond UPS | modules/integrations.md | Workflow embedding = stickiness | L |
| Pagination/aggregation for large portfolios | Unbounded queries at scale | [06 §2](06-frontend-backend-integration.md) | Enterprise-scale portfolios usable | M |
| Public API surface (curated, versioned) | No partner/ecosystem story | [07 §6](07-api-and-gateway-architecture.md) | Platform optionality | L |
| Scheduled/emailed reporting | CFO-facing output stuck at live-query dashboards | modules/dashboards-reporting.md | Recurring engagement touchpoint | M |
| Load testing + capacity planning | Bottlenecks unmeasured | [12 §4](12-reliability-scalability-and-operations.md) | Confidence at scale | M |

## 12–24 months: Category leadership

| Initiative | Problem | Evidence | Outcome | Complexity |
|---|---|---|---|---|
| Platform/ecosystem strategy evaluation | Lease-intelligence subsystem is far ahead of the rest — is it the wedge? | [17](17-billion-dollar-saas-evolution.md) | Deliberate strategic bet, not accident | Strategic |
| Multi-region / residency options | If EU/regulated buyers materialize | [10](10-multi-tenant-saas-readiness.md) | Addressable geography expands | XL — MARKET-VALIDATION-REQUIRED |
| AI-driven portfolio intelligence (beyond extraction) | Data advantage from accumulated lease abstractions is unexploited | [17](17-billion-dollar-saas-evolution.md) | Defensible data moat | L — MARKET-VALIDATION-REQUIRED |

## Initiative categories (for portfolio balance)

- **Product:** onboarding telemetry, billing self-serve, reporting delivery, accounting integrations.
- **Architecture:** internal-secret separation, role consolidation, org_id denormalization, job scheduler.
- **Security:** CSP, rate limiting, cross-tenant tests, SSO.
- **Data:** correctness test suites, retention/export, audit-log reconciliation.
- **Reliability:** CI, monitoring, DR runbook, staging.
- **Developer productivity:** local-env fix, CI, config.toml cleanup.
- **Go-to-market enablers:** SOC 2, SSO, self-serve billing, accounting integrations.

Every item above should be entered into [prioritized-action-register.md](prioritized-action-register.md) with acceptance criteria before work begins.

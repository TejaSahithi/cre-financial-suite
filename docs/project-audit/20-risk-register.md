# 20 — Risk Register

> Generated: 2026-07-20 · Repository revision: `34563cfaff4271b72d00b0841353dc2792f2f16a` (branch `feature/lease-intelligence-enterprise-p1-p8`) · Part of the [Project Audit](README.md)

**Canonical owner for consolidated risk.** Every risk cites its canonical finding — severity/priority/status live in the [findings register](findings-register.md) and are not restated differently here. Likelihood/Impact: L/M/H. Residual = after currently-existing controls.

## Top 10 risks

| # | Risk | Category | Finding(s) | L | I | Current controls | Mitigation | Owner type | Timeframe | Residual |
|---|---|---|---|---|---|---|---|---|---|---|
| R1 | Production is partially/not deployed; leadership decisions made on a false picture | Delivery / Product | [OPS-005](findings-register.md#ops-005) | M (unknown) | H | DEPLOY.md runbook | Verify remote state now; record delta | Eng lead | days | Low once verified |
| R2 | Remote schema drifts again, reintroducing permissive policies | Data / Tenant-isolation | [TEN-001](findings-register.md#ten-001) | M (precedent) | H | Corrective migrations; sync checklist doc | Change control + automated drift alarm | Eng lead | 2–4 wks | Low–Med |
| R3 | Cross-tenant exposure via a missed org filter in one of 82 service-role functions | Tenant-isolation / Security | [SEC-001](findings-register.md#sec-001), [TEN-002](findings-register.md#ten-002) | M | H | Central `getUserOrgId`; page/property RPCs; RLS on client path | Cross-tenant test suite; per-function audit; FORCE-RLS evaluation | Eng | 1–2 mo | Med→Low |
| R4 | Production incident invisible until customer churn (no monitoring/alerting) | Operational | [OPS-002](findings-register.md#ops-002) | H | H | none | Sentry + uptime + alerts | Eng | 1–2 wks | Low |
| R5 | Regression ships unnoticed (no CI; tests never gate) | Delivery / Quality | [OPS-001](findings-register.md#ops-001), [QA-001](findings-register.md#qa-001) | H | M–H | Local test discipline | CI gates (13 §4) | Eng | 1 wk | Low |
| R6 | AI cost runaway / abuse on unthrottled public endpoints | Operational / Security / Business-model | [SEC-008](findings-register.md#sec-008), [OPS-007](findings-register.md#ops-007) | M–H | M | none (global kill-switch only) | Rate limits, captcha, per-tenant metering | Eng | 2–4 wks | Low |
| R7 | Internal-secret leak grants cross-tenant compute with page checks skipped | Security | [SEC-003](findings-register.md#sec-003) | L | H (Critical impact) | Supabase secret storage | Secret separation + rotation + scoping | Eng | 1–2 mo | Low |
| R8 | Misconfigured prod env silently serves seed data; customer writes lost | Workflow / Data | [WKF-002](findings-register.md#wkf-002) | L–M | H | dev-only banner | Hard-fail prod build w/o env | Eng | days | Low |
| R9 | Single-maintainer key-person risk (one author across history; no CODEOWNERS) | Team / Ownership | [01 §4](01-repository-and-system-inventory.md) (`INFERRED`) | H | H | ~70 phase docs + this audit reduce bus factor | Hire/contract second engineer; docs upkeep | Leadership | 1–3 mo | Med |
| R10 | Enterprise deals stall on SSO/SLA/SOC2 absences | Business-model / Compliance | [15](15-enterprise-readiness-gap-analysis.md) blockers | H (if enterprise ICP) | M–H | none | Sequence per roadmap after market validation | Leadership + Eng | 3–6 mo | Med |

## Full register (additional risks)

| # | Risk | Category | Finding(s) | L | I | Mitigation | Timeframe |
|---|---|---|---|---|---|---|---|
| R11 | Local env broken → dev onboarding + e2e verification blocked | Operational / Quality | [OPS-003](findings-register.md#ops-003) | H (current) | M | Fix grants/migration bootstrap; CI ephemeral-DB job | 1–2 wks |
| R12 | Stuck pipeline jobs stall silently (no scheduler/reaper) | Reliability | [OPS-006](findings-register.md#ops-006) | M | M | Reaper + queue alerting | 2–4 wks |
| R13 | Billing revenue path untested end-to-end | Quality / Business | [13 §3](13-testing-and-quality-engineering.md) | M | M–H | Billing e2e + webhook replay tests | 1–2 mo |
| R14 | XSS → localStorage token theft (no CSP; rich-text renderers) | Security | [SEC-004](findings-register.md#sec-004) | L–M | H | CSP header; renderer audit | 2–4 wks |
| R15 | Client/server authorization models drift (rbac.js vs DB permission tables) | Architecture / Security | [06 §5](06-frontend-backend-integration.md) | M | M | Single source generating both; route-guard tests | 1–3 mo |
| R16 | Untested restore / no DR plan | Operational | [12 §1](12-reliability-scalability-and-operations.md) | L | H | Restore drill + runbook | 1 mo |
| R17 | Vendor concentration: Supabase + 4 AI providers + Stripe + Resend | Dependency | [02 §1](02-current-state-architecture.md) | L | M–H | Provider abstraction already exists for AI; document exit paths | 3–6 mo |
| R18 | Marketing claims unverifiable ("500+ properties") — credibility/legal | Product / Business | [PRD-002](findings-register.md#prd-002) | M | M | Verify or soften copy | days |
| R19 | Stale historical docs quoted as current state in diligence | Product / Delivery | [PRD-001](findings-register.md#prd-001) | M | L–M | "Historical" banners; this audit supersedes | days |
| R20 | Performance unknown at portfolio scale (unpaginated lists, heavy joins) | Scalability | [06 §2](06-frontend-backend-integration.md), [12 §4](12-reliability-scalability-and-operations.md) | M | M | Pagination contract; load test | 1–3 mo |
| R21 | Notifications/critical-date alerts may silently not fire (legacy triggers dead) | Product / Workflow | [ARC-002](findings-register.md#arc-002), W13 | M | M | Verify producers; re-implement expiry alerts | 1 mo |
| R22 | GDPR-style deletion/export requests unfulfillable | Compliance | [11 §4](11-security-privacy-and-compliance.md) | L–M | M–H | Retention + erasure + export workflows | 3–6 mo |

Related: [findings register](findings-register.md) · [prioritized action register](prioritized-action-register.md) · [16 — Roadmap](16-product-and-technical-roadmap.md)

# 15 — Enterprise Readiness Gap Analysis

> Generated: 2026-07-20 · Repository revision: `34563cfaff4271b72d00b0841353dc2792f2f16a` (branch `feature/lease-intelligence-enterprise-p1-p8`) · Part of the [Project Audit](README.md)

**Canonical owner for enterprise capability status.** Maturity scores from [03](03-module-catalog-and-maturity.md); vulnerabilities from [11](11-security-privacy-and-compliance.md). Reminder: under the scoring gate (security ≥4, tenant isolation ≥4, ops ≥4, no open Criticals) **no module is enterprise-ready today**, primarily because operational readiness is capped at 2 suite-wide ([OPS-002](findings-register.md#ops-002)).

## Enterprise capability matrix

Maturity: 0 missing → 5 mature. Complexity: S/M/L/XL.

| Capability | Why enterprises require it | Current implementation | Maturity | Business impact of gap | Next step | Priority | Complexity |
|---|---|---|---|---|---|---|---|
| Multi-tenancy & isolation | Data-security table stakes | Real org model; RLS for client traffic; app-level for functions ([10](10-multi-tenant-saas-readiness.md)) | 3 | Passes design review; fails deep diligence without tests/backstop | Cross-tenant test suite; per-function audit | P1 | M |
| RBAC / fine-grained permissions | Least-privilege mandates | 5 roles + auditor + page/property/portfolio grants; dual systems ([contradictions](contradictions-and-drift.md)) | 3 | Usable; consolidation needed for access reviews | Unify role systems | P2 | M |
| SSO (SAML/OIDC) | Universal procurement gate | `MISSING` (consumer OAuth only) | 0 | **Hard sales blocker** at enterprise tier | Supabase SAML or WorkOS-style broker | P1* | M |
| SCIM provisioning | IT lifecycle automation | `MISSING` | 0 | Blocker for large orgs | After SSO | P2* | M |
| Audit trail | Compliance + forensics | Hardened `audit_logs`; drift history taints trust ([TEN-001](findings-register.md#ten-001)); dual actor columns | 2.5 | Weakens security questionnaire answers | Reconcile schema; retention; immutability story | P1 | M |
| Compliance readiness (SOC 2 path) | Procurement gate | Nothing formalized ([11 §4](11-security-privacy-and-compliance.md)) | 1 | Blocks security review at mid-market+ | Change mgmt + monitoring first (same fixes as OPS-001/002) | P1 | L |
| Data retention / deletion / export | GDPR/CCPA + offboarding | `MISSING` (hard deletes only; no export) | 1 | DPA negotiations stall | Retention policies; tenant export | P2 | M |
| Data residency | EU/regulated buyers | Single US(?) project (`UNVERIFIED` region) | 0 | Limits ICP geography | Defer until demanded (MARKET-VALIDATION-REQUIRED) | P3 | XL |
| Encryption / CMK | Security review | Platform TLS+at-rest; no CMK | 2 | CMK rarely blocking at mid-market | Document posture | P3 | L |
| Backup & recovery / DR | Continuity clauses | Platform backups `UNVERIFIED`; no restore test | 1 | Cannot sign continuity language | Restore test + runbook | P1 | S |
| SLAs | Contract requirement | No monitoring → no honest SLA ([OPS-002](findings-register.md#ops-002)) | 0 | Blocks contracts with uptime clauses | Observability first | P1 | M |
| Observability & incident response | Ops maturity signal | `MISSING` | 0.5 | Silent failures; no IR story | Sentry + alerts + IR doc | P1 | S–M |
| Support tooling / impersonation | CS at scale | Super-admin acting-org (audited) — close | 2.5 | Workable early | Consent-logged impersonation | P3 | M |
| Admin controls | IT governance | Org settings, module toggles, user mgmt | 3 | OK for stage | — | — | — |
| Usage metering | Pricing + abuse + margin | `MISSING` ([OPS-007](findings-register.md#ops-007)) | 0.5 | Can't price on usage; COGS blind | Meter AI per org | P1 | M |
| Billing & entitlements | Monetization backbone | Checkout+webhook solid; entitlement enforcement thin; no portal (W15) | 2.5 | Revenue leakage; manual plan ops | Portal + entitlement middleware | P1 | M |
| Contracts/entitlements mgmt | Enterprise deals | `organizations.plan` + `enabled_modules` only | 1.5 | Manual contract ops | Entitlement table + admin UI | P2 | M |
| Feature flags | Safe rollout | `enabled_modules` (coarse) | 1.5 | Risky releases | Lightweight flag system | P2 | S |
| API platform / webhooks out / integration ecosystem | Stickiness + platform play | `MISSING` public API; 1 integration (UPS); no outbound webhooks | 1 | Blocks the accounting-integration moat ([17](17-billion-dollar-saas-evolution.md)) | OpenAPI on a curated surface | P2 | L |
| Customization / custom fields | Fit variance | `custom-fields` fn + manager UI exist | 2.5 | Decent start | — | P3 | — |
| Localization | Global | `MISSING` (en-only; org tz/currency fields exist) | 1 | US-only ICP fine now | Defer | P3 | L |
| Accessibility | Public-sector/enterprise policy | Radix primitives help; no a11y testing | 1.5 | Occasional blocker | axe in CI | P3 | S |
| Performance / HA | Scale confidence | Unmeasured; platform HA | 2 | Unknown = risk | Load test pipeline | P2 | M |
| Sandbox environments | Enterprise eval | `MISSING` (demo mode exists — could evolve) | 1 | Eval friction | Seeded sandbox org flow | P2 | M |
| Migration tooling | Displace incumbents | Bulk import (properties/expenses); no full-tenant import | 1.5 | Slows competitive rip-outs | Lease-portfolio import kit | P2 | M |
| Security questionnaires | Sales ops | This audit is the first artifact | 1 | Slow security reviews | Maintain answers doc from register | P2 | S |

\* Priority contingent on enterprise pipeline actually existing — MARKET-VALIDATION-REQUIRED.

## Blocker lists (explicit)

- **Sales blockers:** SSO/SAML absence; no SLA capability; no SOC 2 story; unknown prod deployment state ([OPS-005](findings-register.md#ops-005)).
- **Security-review blockers:** change-management evidence (drift precedent, no CI); no monitoring/IR; RLS-bypass asymmetry answer ([SEC-001](findings-register.md#sec-001)); subprocessor/DPA documentation for AI providers.
- **Procurement blockers:** DPA + retention/deletion capability; insurance/continuity language w/o tested backups.
- **Scalability blockers:** unpaginated queries; no queue scheduler ([OPS-006](findings-register.md#ops-006)); no load evidence.
- **Customer-success blockers:** no telemetry (can't see struggling accounts); notifications module at 2.0; no health dashboards.
- **Operational blockers:** everything in [OPS-001](findings-register.md#ops-001)/[OPS-002](findings-register.md#ops-002)/[OPS-003](findings-register.md#ops-003).
- **Expansion-revenue blockers:** no metering ([OPS-007](findings-register.md#ops-007)), thin entitlements, no billing portal.

Related: [16 — Roadmap](16-product-and-technical-roadmap.md) · [11 — Security](11-security-privacy-and-compliance.md) · [10 — Multi-tenancy](10-multi-tenant-saas-readiness.md)

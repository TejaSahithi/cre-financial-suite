# 11 — Security, Privacy & Compliance (Defensive Review)

> Generated: 2026-07-20 · Repository revision: `34563cfaff4271b72d00b0841353dc2792f2f16a` (branch `feature/lease-intelligence-enterprise-p1-p8`) · Part of the [Project Audit](README.md)

**Canonical owner for security vulnerabilities/weaknesses.** Repository-evidence analysis only — no exploitation attempted; no production systems touched. Isolation mechanics → [10](10-multi-tenant-saas-readiness.md); API controls → [07](07-api-and-gateway-architecture.md). No compliance certification is claimed or implied anywhere in this document.

## 1. Security control review

| Domain | State | Evidence | Assessment |
|---|---|---|---|
| Authentication | Supabase Auth: email+password, Google/Microsoft OAuth, magic link; **TOTP MFA enforced via MFAGuard**; security questions; reset-mfa admin fn | EV-04/28 | Strong for stage |
| Session mgmt | Auto-refresh; refresh-before-invoke; logout clears legacy keys | EV-11/12 | OK |
| Token storage | localStorage (`persistSession: true`) | [SEC-004](findings-register.md#sec-004) | Medium risk; standard Supabase-SPA trade-off; **no CSP header** to blunt XSS |
| Password handling | Delegated to Supabase (bcrypt server-side) — platform property | `UNVERIFIED` (platform) | Acceptable |
| Authorization | Client RBAC (rbac.js) + server `assertPageAccess`/`assertPropertyAccess` RPCs + RLS | EV-06/07/13 | Layered but parallel-maintained ([06 §5](06-frontend-backend-integration.md)) |
| Tenant isolation | See [10](10-multi-tenant-saas-readiness.md) | [SEC-001](findings-register.md#sec-001)/[TEN-002](findings-register.md#ten-002) | Asymmetric enforcement |
| Input validation | Ad-hoc per function; UUID regex on org headers; magic-byte file detection | EV-05/20 | `PARTIAL` — no shared schema validation server-side |
| Output encoding / XSS | React default escaping; `react-quill`/`react-markdown` present (sanitization config `UNVERIFIED`); one dead `escapeHtml` (historical F-017) | package.json | `PARTIAL` — verify quill/markdown render paths |
| Injection | supabase-js parameterized queries throughout samples; no raw SQL string concatenation found in sampled functions | samples | Low risk (`PARTIAL` sample) |
| File upload | Magic-byte type detection, MIME allowlist, size caps on artifacts bucket | EV-20 | Good |
| SSRF | No user-supplied URL fetches found in sampled functions (providers use fixed endpoints from env) | samples | Low (`PARTIAL` sample) |
| CSRF | Token-in-header model (not cookies) → CSRF largely N/A; state-changing GETs not observed | arch | OK |
| CORS | Per-function copy-paste; permissive `*` typical in Supabase functions (`UNVERIFIED` per-function values) | [07 §3](07-api-and-gateway-architecture.md) | Needs central policy |
| Secrets | Supabase function secrets + Vercel env; none committed (`.env` committed but contains localhost/anon values only — [OPS-004](findings-register.md#ops-004)); service-role key doubles as internal password | [SEC-003](findings-register.md#sec-003) | Medium |
| Encryption in transit | HTTPS everywhere (platform); HSTS header set in vercel.json | EV-21 | OK |
| Encryption at rest | Supabase platform AES-256 — platform property | `UNVERIFIED` | Standard |
| PII handling | PII in profiles/tenants/vendors/lease docs/extraction artifacts/audit logs (emails, IPs); **no retention/deletion policy**; PII flows to AI subprocessors by design | [SEC-006](findings-register.md#sec-006), [08 §3](08-database-schema-and-ui-gap-analysis.md) | Gap for GDPR-style requests |
| Sensitive logging | `audit_logs` stores user_email + ip_address (by design); function console logs include emails (verifyUser logs) | supabase.ts:84 | Review log-retention |
| Dependency vulns | No lockfile audit run in CI (none exists); `npm audit` not executed by this audit (network-restraint) | [OPS-001](findings-register.md#ops-001) | `UNVERIFIED` — add to CI |
| Supply chain | No pinning policy for Deno esm.sh imports (version-pinned URLs, mixed versions [ARC-004](findings-register.md#arc-004)); no SBOM | functions | `PARTIAL` |
| Audit logging | Hardened schema (severity/source/request_id/before-after) with restrictive insert policy; **drift history is the caveat** | EV-14/15, [TEN-001](findings-register.md#ten-001) | Good design, governance risk |
| Admin access / impersonation | Super-admin acting-org explicit + logged; no consent-based impersonation feature | [TEN-003](findings-register.md#ten-003) | OK for stage |
| Data retention/deletion | `MISSING` — no TTLs, no erasure workflow, hard CASCADE deletes only | [08 §3](08-database-schema-and-ui-gap-analysis.md) | GDPR gap |
| Backups / restore | Supabase platform backups (plan-dependent, `UNVERIFIED`); no restore testing evidence | [12](12-reliability-scalability-and-operations.md) | Gap |
| Webhook verification | Stripe signature verified; no other inbound webhooks | EV-18 | OK |
| Rate limiting / abuse | `MISSING` everywhere incl. public fns (`signup`, `submit-contact`, `send-email`, `extract-document-fields`) | [07 §2](07-api-and-gateway-architecture.md) | High-value fix |
| Environment separation | Single Supabase project discoverable; no staging | [14](14-devops-infrastructure-and-delivery.md) | Gap |
| Security testing | None (no SAST/DAST/dependency scanning; no security tests in suite) | [13](13-testing-and-quality-engineering.md) | Gap |

## 2. Trust boundaries & threat model

Trust-boundary diagram: [02 §10](02-current-state-architecture.md). Tenancy threats: [10 §7](10-multi-tenant-saas-readiness.md). Additional system-level threats:

| Threat | Likelihood | Impact | Current control | Mitigation |
|---|---|---|---|---|
| XSS → token theft from localStorage | Medium (React reduces; quill/markdown surfaces) | High | escaping; security headers; **no CSP** | Add CSP; audit rich-text renderers ([SEC-004](findings-register.md#sec-004)) |
| Abuse of public functions (spam via submit-contact/send-email relay; AI-cost drain via extract-document-fields) | High (internet-exposed, unthrottled) | Medium (cost/reputation) | none | Rate limit + captcha + sender allowlist (**SEC-008**, registered) |
| Service-role/internal-secret leak | Low | Critical (full data + cross-tenant compute) | Supabase secret storage | Separate secrets, rotate, scope ([SEC-003](findings-register.md#sec-003)) |
| Remote-schema drift reintroducing permissive policies | Medium (precedent exists) | High | corrective migrations | Change control + drift monitor ([TEN-001](findings-register.md#ten-001)) |
| Missed org filter in one of 82 functions | Medium | High | central helpers; discipline | Cross-tenant tests; FORCE-RLS evaluation ([SEC-001](findings-register.md#sec-001)) |
| Dependency compromise | Low–Medium | High | none automated | `npm audit`/Dependabot in CI |
| PII exposure via AI subprocessors without DPAs | ? (contracts unknown) | High (GDPR/enterprise) | provider selection env-switchable; kill-switch exists | DPA inventory; document subprocessors (MARKET/LEGAL input needed) |

## 3. Findings classification (canonical IDs)

| Severity | Findings |
|---|---|
| Critical | none open (no confirmed exploit path at frozen commit) |
| High | [TEN-001](findings-register.md#ten-001) drift · [SEC-001](findings-register.md#sec-001) RLS bypass asymmetry · [OPS-001](findings-register.md#ops-001)/[OPS-002](findings-register.md#ops-002) (security-relevant: no detection/response capability) · [OPS-005](findings-register.md#ops-005) unknown prod state |
| Medium | [SEC-002](findings-register.md#sec-002) undeclared fns · [SEC-003](findings-register.md#sec-003) internal-secret patterns · [SEC-004](findings-register.md#sec-004) localStorage tokens + no CSP · **SEC-008** unthrottled public endpoints (this doc §2; added to register) · [TEN-002](findings-register.md#ten-002) indirect scoping · [OPS-003](findings-register.md#ops-003) broken local env |
| Low | [SEC-005](findings-register.md#sec-005) open org creation · [QA-002](findings-register.md#qa-002) lint blind spots · [OPS-004](findings-register.md#ops-004) hygiene |
| Informational | [SEC-006](findings-register.md#sec-006) artifacts custody (positive control, retention gap) · [SEC-007](findings-register.md#sec-007) Google Fonts · [TEN-003](findings-register.md#ten-003) hardened acting-org (positive) |

## 4. Compliance-readiness gaps (no certification claimed)

| Framework | Relevant? | Biggest gaps at frozen commit |
|---|---|---|
| SOC 2 (Type I→II) | Yes — enterprise sales prerequisite | Change management ([TEN-001](findings-register.md#ten-001), no CI), monitoring/alerting ([OPS-002](findings-register.md#ops-002)), access reviews (dual role systems), vendor management (AI subprocessors), evidence collection (none automated) |
| ISO 27001 | Later | ISMS scaffolding entirely absent (policies, risk register — this audit is a starting artifact) |
| GDPR / UK-GDPR | Yes if EU data subjects (CRE tenants' contacts count) | No retention/erasure workflow; subprocessor list/DPAs undocumented; data-export right unimplemented ([08 §3](08-database-schema-and-ui-gap-analysis.md)) |
| CCPA | Yes (US market) | Same deletion/export gaps |
| HIPAA | Not relevant (no PHI in evidence) | — |
| PCI DSS | Out of scope — card data fully delegated to Stripe Checkout (SAQ-A posture, `INFERRED`) | Keep it that way |

## 5. Remediation priorities (mirrors [prioritized-action-register](prioritized-action-register.md))

1. **P0:** verify prod state + schema drift reconciliation ([OPS-005](findings-register.md#ops-005)/[TEN-001](findings-register.md#ten-001)).
2. **P1:** CI with dependency scanning; Sentry; rate-limit + captcha public fns (SEC-008); cross-tenant test pair; declare all functions in config.toml ([SEC-002](findings-register.md#sec-002)).
3. **P2:** CSP header; internal-secret separation ([SEC-003](findings-register.md#sec-003)); retention policies + erasure workflow; org_id denormalization ([TEN-002](findings-register.md#ten-002)); subprocessor/DPA inventory.
4. **P3:** font self-hosting; org-creation quotas ([SEC-005](findings-register.md#sec-005)).

Related: [10 — Multi-tenancy](10-multi-tenant-saas-readiness.md) · [12 — Reliability](12-reliability-scalability-and-operations.md) · [15 — Enterprise gaps](15-enterprise-readiness-gap-analysis.md)

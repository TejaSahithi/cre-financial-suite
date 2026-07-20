# 09 — Onboarding Assessment

> Generated: 2026-07-20 · Repository revision: `34563cfaff4271b72d00b0841353dc2792f2f16a` (branch `feature/lease-intelligence-enterprise-p1-p8`) · Part of the [Project Audit](README.md)

Onboarding as a product workflow (customer), a sales capability (enterprise), and an operational capability (developer). Workflow classifications inherit from [05](05-end-to-end-workflows.md) (W1–W7).

## 1. Customer onboarding — what exists (`CONFIRMED` static; runtime `UNVERIFIED`)

| Step | Implementation | Evidence | State |
|---|---|---|---|
| Account creation | `signup` fn (public), password or OAuth (Google/Microsoft), magic link | W1; `src/services/auth.js` | `CONFIRMED` |
| Email verification | Confirmation email via **Resend** (explicitly bypassing Supabase's 2/hr limit); resend action supported | signup fn comments | `CONFIRMED`; depends on `RESEND_API_KEY` in prod (`UNVERIFIED`) |
| MFA enrollment | Post-confirmation redirect lands on protected page → `MFAGuard` forces TOTP enrollment; `SecurityQuestionsSetup` page + `save-security-questions` fn | EV-28; rbac.js MANDATORY_SETUP_PAGES | `CONFIRMED` — unusually strong for this stage |
| Org setup | `Onboarding.jsx` multi-step wizard; step persisted to sessionStorage + URL + `organizations.onboarding_step` (resumable) | Onboarding.jsx:92-106,170 | `CONFIRMED` |
| Tenant provisioning | Org insert (any authenticated user, [SEC-005](findings-register.md#sec-005)) → `status='onboarding'` | schema.sql:71-123 | `CONFIRMED` |
| Approval gate | `PendingApproval` page; super-admin `approve-organization` (+email); `access_requests` table for request-access flow | W5 | `CONFIRMED` — **human-in-the-loop activation; not self-serve to value** |
| Invitations & roles | `invite-user`/`send-invite`/`accept-invite` fns, `invitations` table, `AcceptInvite` page; roles via memberships + per-member page/property grants | W6/W7 | `CONFIRMED` |
| Data import | Lease upload pipeline (the activation path), `BulkImportModal` for properties, `bulk-create-expenses` | W8/W17 | `CONFIRMED` |
| Guided setup / sample data | `DemoExperience` page + full seed dataset (in-memory demo); `Welcome`/`WelcomeAboard` pages | seedData.js | `PARTIAL` — demo mode ≠ in-product guided setup |
| Progress tracking / activation telemetry | `onboarding_step` in DB only; **no analytics events anywhere** | [OPS-002](findings-register.md#ops-002) | `MISSING` |
| Error recovery | Wizard resumable; OTP-expiry hash errors intercepted (App.jsx:39-63) | W4 | `PARTIAL` |
| Support escalation | `ContactUs` → `submit-contact` (public fn → Resend) | W18-adjacent | `CONFIRMED` basic |

**Time-to-first-value assessment (INFERRED):** the natural activation moment is *first approved lease abstraction*. The path requires: signup → email confirm → TOTP enrollment → org wizard → **manual platform approval** → upload → AI pipeline (needs 4 provider secrets configured) → review → approve. That is a long, gated corridor with two human/config dependencies (approval; extraction secrets). Fine for design-partner motion; hostile to PLG. No measurement exists to know where users stall (`MISSING` telemetry).

**Drop-off points (structural):** email confirm (dependent on Resend config), forced MFA before any value shown, PendingApproval wait, first upload failure surfaces raw pipeline errors ([06 §2](06-frontend-backend-integration.md) error-state gaps).

## 2. Enterprise onboarding

| Capability | State | Evidence |
|---|---|---|
| SSO (SAML/OIDC enterprise IdP) | `MISSING` — only consumer Google/Microsoft OAuth via Supabase | auth.js |
| SCIM provisioning | `MISSING` | — |
| Domain verification / claiming | `MISSING` | — |
| Role mapping for enterprise directories | `MISSING` (manual per-member grants exist) | — |
| Audit requirements | Partial (audit_logs hardened but drift history — [TEN-001](findings-register.md#ten-001)) | EV-14/15 |
| Data migration tooling | `PARTIAL` — bulk import for properties/expenses; no full-tenant import/export | W16/W17 |
| Sandbox environments | `MISSING` — single Supabase project, no staging discoverable | [14](14-devops-infrastructure-and-delivery.md) |
| Security review pack (SOC 2 etc.) | `MISSING` — see [11](11-security-privacy-and-compliance.md) |
| Implementation services / CS handoff | Not represented in product (Stakeholders page is closest) | `INFERRED` |

**Verdict:** enterprise onboarding is essentially not started; the identity items (SSO/SCIM) are the classic procurement blockers ([15](15-enterprise-readiness-gap-analysis.md)).

## 3. Developer onboarding

| Aspect | State | Evidence |
|---|---|---|
| Local setup docs | `CONFIRMED` — README (thorough) + DEPLOY.md runbook | EV-23 |
| Env vars | `.env.example` minimal (2 vars); full function-secret list only in DEPLOY.md prose | `PARTIAL` |
| Seed data / test accounts | Seed dataset for in-memory mode; e2e helper seeds orgs/users **but fails on current local stack** (`42501`) | [OPS-003](findings-register.md#ops-003) — **E1: broken today** |
| Build/run | `npm run dev/build/test` all work (Phase 0, E1) | evidence-index |
| Reproducibility | 216 migrations apply order `UNVERIFIED` locally (blocked by the same grants issue); `scripts/db-reset-two-lanes.sh` exists | `PARTIAL` |
| Common failure modes | Documented informally across ~70 phase docs (historical, stale-risk [PRD-001](findings-register.md#prd-001)) | `PARTIAL` |
| Debugging | ExtractionDebugPanel, pipeline-health-check, phase52 diagnostic fn | `CONFIRMED` tooling exists |

**Verdict:** a new developer can run the frontend in minutes (E1-verified), but **cannot currently run the full stack** — the e2e/seed path fails, and fixing it is the single highest-leverage dev-onboarding action.

## 4. Onboarding maturity score

Module #3 canonical score: **2.6 / 5** ([03](03-module-catalog-and-maturity.md)). Sub-scores: customer flow structure 3 (complete, resumable, gated), activation/telemetry 1 (no measurement), enterprise 1 (identity missing), developer 2.5 (frontend yes / full stack currently broken).

## 5. Improvements that most reduce time-to-value (RECOMMENDED)

1. Fix local-stack reproducibility ([OPS-003](findings-register.md#ops-003)) — unblocks e2e + dev onboarding (S effort).
2. Instrument the funnel (signup→confirm→MFA→wizard→approval→first upload→first approve) with any analytics tool (S–M).
3. Make approval SLA visible in-product; consider auto-approve for invited/known domains (S).
4. Ship an in-product guided first-lease flow using the existing demo assets (M).
5. Publish the full environment/secret matrix as a checked template instead of DEPLOY.md prose (S).

Related: [05 — Workflows](05-end-to-end-workflows.md) · [15 — Enterprise gaps](15-enterprise-readiness-gap-analysis.md)

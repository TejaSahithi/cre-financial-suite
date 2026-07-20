# 05 — End-to-End Workflows

> Generated: 2026-07-20 · Repository revision: `34563cfaff4271b72d00b0841353dc2792f2f16a` (branch `feature/lease-intelligence-enterprise-p1-p8`) · Part of the [Project Audit](README.md)

Each workflow is traced through UI → API → authorization → tenancy → persistence, then classified. **Classification reflects the highest verification level actually achieved, not code presence.** Verification levels per workflow: **S** static path located · **B** app builds (true for all — Phase 0) · **M** manually exercised (mode noted) · **T** automated test exists · **P** persistence verified · **E** error path verified · **A** authorization verified · **I** tenant isolation verified · **Prod** production behavior. The Phase-0 constraint applies: nothing beyond UI rendering/guards could be exercised live (local e2e seeding broken, [OPS-003](findings-register.md#ops-003); remote prohibited), so **P/A/I are static-only (E3) for every workflow** and Prod is Unverified everywhere.

## Verification matrix (18 workflows)

| # | Workflow | S | M | T | P | E | A | I | Classification |
|---|---|---|---|---|---|---|---|---|---|
| W1 | Account creation (signup) | ✅ | ❌ | partial (unit) | E3 | E3 | E3 | E3 | **Partially complete** |
| W2 | Login (password / OAuth / magic link) | ✅ | UI render only (E1) | partial | E3 | E3 | E1 guards | E3 | **Partially complete** |
| W3 | Password / identity recovery | ✅ | ❌ | ❌ | E3 | E3 | E3 | n/a | **Partially complete** |
| W4 | User onboarding (org setup wizard) | ✅ | ❌ | partial | E3 | partial | E3 | E3 | **Partially complete** |
| W5 | Organization creation + approval | ✅ | ❌ | ❌ | E3 | E3 | E3 | E3 | **Partially complete** |
| W6 | Invitation & member joining | ✅ | ❌ | ❌ | E3 | E3 | E3 | E3 | **Partially complete** |
| W7 | Role assignment / user management | ✅ | ❌ | partial | E3 | E3 | E3 | E3 | **Partially complete** |
| W8 | **Main action: lease upload → extraction → review → approve** | ✅ | prior E2E evidence stale; current e2e fails at seed | ✅ (e2e exists; 685 units incl. review contracts) | E3 | E3 (worker error model) | E3 | E3 | **Partially complete** (was E2-verified when phase5f last passed — screenshots in `test-results/` predate breakage) |
| W9 | Main read: dashboards / portfolio / lease lists | ✅ | login-wall E1 only | partial | E3 | partial | E1+E3 | E3 | **Partially complete** |
| W10 | Main update: lease field edit w/ citations | ✅ | ❌ | ✅ unit | E3 | E3 | E3 | E3 | **Partially complete** |
| W11 | Deletion / archival: delete-lease-cascade, delete-expenses | ✅ | ❌ | partial | E3 | E3 | E3 | E3 | **Partially complete**; destructive, no undo ([08](08-database-schema-and-ui-gap-analysis.md) §3) |
| W12 | Administrative action (org approval, reset-mfa, acting-org) | ✅ | ❌ | ❌ | E3 | E3 | E3 | E3 | **Partially complete** |
| W13 | Notification flow | partial | ❌ | ❌ | E3 | ❌ | E3 | E3 | **UI-present / delivery UNVERIFIED**; legacy triggers dead ([ARC-002](findings-register.md#arc-002)) |
| W14 | Billing: checkout → webhook → plan state | ✅ | ❌ | ❌ | E3 | E3 (sig verify, dedupe) | E3 | E3 | **Partially complete** |
| W15 | Subscription change / cancellation | partial | ❌ | ❌ | partial | ❌ | E3 | E3 | **Partially complete → thin**; no customer portal integration found (`MISSING`) |
| W16 | Data export (export-data, xlsx/PDF client) | ✅ | ❌ | ❌ | E3 | ❌ | E3 | E3 | **Partially complete** |
| W17 | Data import (BulkImportModal, bulk-create-expenses) | ✅ | ❌ | partial | E3 | partial | E3 | E3 | **Partially complete** |
| W18 | Integration setup (UPS validate; Integrations page) | ✅ UPS / page thin | ❌ | ❌ | n/a | partial | E3 | n/a | UPS: **Partially complete**; page: **UI-only** |

**Honest summary:** *no workflow can be classified "Complete" under this audit's evidence bar*, because end-to-end runtime verification was impossible in the audited environment (broken local DB grants + prohibited remote). The lease pipeline (W8) has the strongest claim — a real e2e spec, heavy unit coverage, and prior passing screenshots — and is one `supabase db reset` away from E2 verification. This is itself a key finding: **the product's verifiability is currently gated on repairing the local environment ([OPS-003](findings-register.md#ops-003)) and deploying/verifying the remote ([OPS-005](findings-register.md#ops-005)).**

## Selected workflow traces

### W1 — Account creation
`Login`/`RequestAccess` pages → `signup` edge function (**public**, `verify_jwt=false`) → creates auth user via admin client, sends confirmation email via **Resend** (bypassing Supabase's 2/hr email limit — in-code comment), redirect target lands on a protected page so `MFAGuard` forces TOTP enrollment → `handle_new_user()` trigger creates `profiles` row (schema.sql:296-326) → routing via `getUserRoutingState` (App.jsx:141) sends user to Onboarding/PendingApproval.
**Gaps:** public endpoint, no rate limit/captcha ([07](07-api-and-gateway-architecture.md) §2 flag); success depends on `RESEND_API_KEY` being configured in prod (`UNVERIFIED`, historical F-014).

### W4/W5 — Onboarding & org creation
`Onboarding.jsx` multi-step wizard (step persisted in sessionStorage + URL param; resumable) → org insert allowed for any authenticated user (`orgs_insert_authenticated`, [SEC-005](findings-register.md#sec-005)) with `status='onboarding'`, `onboarding_step` tracked in DB → `complete-onboarding` fn → super-admin approval path (`approve-organization`, Resend email) → `PendingApproval` page for the interim.
**Gaps:** no product analytics on step drop-off ([09](09-onboarding-assessment.md)); abandonment visible only in DB rows.

### W8 — Lease pipeline (flagship)
See data-flow diagram in [02 §7](02-current-state-architecture.md). UI: `LeaseUpload`/`EnhancedFileUploader` → `ingest-file` (magic-byte validation, org-scoped storage path, `uploaded_files` + `pipeline_jobs` rows) → `lease-extraction-worker` claims job (internal secret) → `parse-pdf-docling` (Docling/Vision/Azure per env) → `normalize-pdf-output` (+LLM extraction: Vertex or Anthropic; raw payloads → `extraction-artifacts`) → draft claims/findings tables → `LeaseReview` UI (FieldReviewTable, evidence drawers, ApprovalBlockersPanel) → `save-lease-review-draft` (edits) → `review-approve` → lease + financial schedules → downstream (critical dates, rent projection, CAM inputs, rules extraction stage).
**Error paths (static):** per-stage timeout → `failJob` with `error_code`/`retryable`; cancel via `cancel_requested_at` re-check per stage; durability reconciliation distinguishes transient read failure from lost writes (EV-17). **Recovery:** retry ≤3; `send-lease-back-for-reextraction` for human-initiated redo.
**Residual gaps:** no automatic worker scheduling/reaping ([12](12-reliability-scalability-and-operations.md)); artifact retention unlimited ([SEC-006](findings-register.md#sec-006)).

### W14 — Billing
`Pricing`/`Billing` pages → `create-checkout-session` (JWT) → Stripe Checkout → `stripe-webhook` (signature verified, `stripe_events` dedupe on unique violation) → updates org plan state. **Missing links:** no Stripe Customer Portal wiring found for self-serve plan change/cancel (W15 thin); no entitlement enforcement traced from `organizations.plan` to feature gates other than `enabled_modules` (`INFERRED` partial — ModuleAccessContext consumes module flags; plan→modules mapping `UNVERIFIED`).

## Dead ends & inconsistencies found

- `PipelineUpload` page coexists with `LeaseUpload` (legacy alias route — [contradictions](contradictions-and-drift.md)).
- Notifications: UI page + table exist, but no producer beyond email sends was traced; Base44-era lease-expiry triggers were not visibly re-implemented (W13).
- Subscription lifecycle beyond initial checkout is unmodeled in UI (W15).
- In-memory seed mode can make several of these workflows *appear* complete in a demo while persisting nothing ([WKF-002](findings-register.md#wkf-002)) — always confirm environment before demos.

Related: [06 — Integration](06-frontend-backend-integration.md) · [09 — Onboarding](09-onboarding-assessment.md) · [modules/](04-module-deep-dives.md)

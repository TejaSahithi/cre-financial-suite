# 21 — Glossary & Traceability

> Generated: 2026-07-20 · Repository revision: `34563cfaff4271b72d00b0841353dc2792f2f16a` (branch `feature/lease-intelligence-enterprise-p1-p8`) · Part of the [Project Audit](README.md)

## Domain glossary (CRE)
**CAM** — Common Area Maintenance; shared operating costs charged back to tenants per lease terms. **Lease abstraction** — extracting structured terms (rent, escalations, CAM, dates) from a lease document. **Escalation** — contractual rent increase schedule. **Rent roll** — a summary of all leases/rents in a property. **Variance** — difference between budgeted and actual figures. **Portfolio/Property/Building/Unit** — the CRE ownership hierarchy modeled 1:many top-to-bottom.

## Acronym glossary
**RLS** Row-Level Security (Postgres) · **RPC** Remote Procedure Call · **JWT** JSON Web Token · **MFA/TOTP** Multi-Factor Authentication / Time-based One-Time Password · **SSO/SAML/OIDC/SCIM** Single Sign-On / Security Assertion Markup Language / OpenID Connect / System for Cross-domain Identity Management · **CI/CD** Continuous Integration/Deployment · **SLI/SLO** Service Level Indicator/Objective · **DPA** Data Processing Agreement · **SPA** Single-Page Application · **BFF** Backend-for-Frontend · **TTL** Time To Live · **PII** Personally Identifiable Information.

## Entity glossary (selected, [08](08-database-schema-and-ui-gap-analysis.md) has the full ER model)
`organizations` — the SaaS tenant. `memberships` — user↔org↔role join, the only place roles are canonically defined. `tenants` — **CRE domain entity (lease occupants), not a SaaS tenant** — see [contradictions](contradictions-and-drift.md). `leases`, `lease_claims*`, `lease_expense_rules*` — the lease-intelligence data model. `pipeline_jobs` — durable extraction job queue. `audit_logs` — the (hardened, historically drifted) activity trail. `extraction_artifacts` — private bucket for raw AI provider payloads.

## Module glossary
See [03](03-module-catalog-and-maturity.md) for all 19 modules with scores; [modules/](modules/) for deep dives.

## Role & permission glossary
Canonical roles (memberships.role): `super_admin > org_admin > manager > editor > viewer`, plus `auditor`. ~14 legacy role aliases exist in `rbac.js` (`ROLE_ALIASES`) mapping older role names to these. A **second** permission system (`role_definitions`/`user_roles`) also exists — see [contradictions](contradictions-and-drift.md) for the duplication finding.

## Status & lifecycle glossary
- **Organization:** `onboarding → under_review → active → suspended`.
- **Pipeline job:** `queued → running → {completed | failed | cancelled}`, stages `parse → normalize → review_draft → rule_extraction`.
- **Lease-expense rule:** draft → `approval_status`/`review_status` → `published_to_cam`.
- **Uploaded file:** tracked via `processing_status`.

## External integration glossary
**Vertex AI (Gemini)** — Google's AI platform, primary LLM extraction path. **Azure Document Intelligence** — Microsoft's document-parsing service. **Anthropic** — Claude API, alternate/fallback LLM extraction. **Docling** — open-source document parsing library, served via a dedicated API. **Stripe** — billing/payments, checkout + signed webhook. **Resend** — transactional email (chosen over Supabase's built-in email to avoid its 2/hr rate limit). **UPS** — address validation API.

## Traceability matrix (representative rows — full coverage lives across [03](03-module-catalog-and-maturity.md)/[04](04-module-deep-dives.md)/[05](05-end-to-end-workflows.md)/[06](06-frontend-backend-integration.md))

| Business capability | Workflow | UI screen | API | Backend service | DB entity | Event/job | Test | Doc section |
|---|---|---|---|---|---|---|---|---|
| Lease abstraction | W8 | LeaseUpload, LeaseReview | ingest-file, normalize-pdf-output, review-approve | lease-extraction-worker | uploaded_files, pipeline_jobs, lease_claims* | pipeline_jobs lifecycle | e2e (broken locally) + unit | [05](05-end-to-end-workflows.md) W8, [modules/lease-ingestion-extraction.md](modules/lease-ingestion-extraction.md) |
| CAM reconciliation | — | CAMDashboard, CAMSetup | compute-cam, save/approve-cam-profile | — | cam_calculations, cam_profiles | — | none dedicated | [modules/cam-engine.md](modules/cam-engine.md) |
| Org onboarding | W4/W5 | Onboarding, PendingApproval | complete-onboarding, approve-organization | — | organizations | — | partial unit | [09](09-onboarding-assessment.md) |
| Billing | W14 | Pricing, Billing | create-checkout-session, stripe-webhook | — | organizations.plan, stripe_events | Stripe webhook | none | [modules/billing-subscriptions.md](modules/billing-subscriptions.md) |
| Tenant isolation | all | all | all edge functions | `_shared/supabase.ts` | org_id on 160 tables | — | none (cross-tenant) | [10](10-multi-tenant-saas-readiness.md) |
| Audit trail | all mutations | AuditLog | (direct read) | api.js writer | audit_logs | — | none | [modules/audit-logging.md](modules/audit-logging.md) |

Use this pattern to trace any additional feature: business capability → [03](03-module-catalog-and-maturity.md) for the owning module → [modules/](modules/) deep dive for components → [05](05-end-to-end-workflows.md)/[06](06-frontend-backend-integration.md) for the concrete UI-to-DB path → [findings register](findings-register.md) for known issues on that path.

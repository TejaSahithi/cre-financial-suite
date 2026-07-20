# 01 — Repository & System Inventory

> Generated: 2026-07-20 · Repository revision: `34563cfaff4271b72d00b0841353dc2792f2f16a` (branch `feature/lease-intelligence-enterprise-p1-p8`) · Part of the [Project Audit](README.md)

Labels: `CONFIRMED` (verified at frozen commit) · `INFERRED` · `MISSING` · `UNVERIFIED`. Finding IDs refer to the [findings register](findings-register.md).

---

## 1. Repository structure

`CONFIRMED` — The checkout is **triple-nested** ([ARC-001](findings-register.md#arc-001)):

```
cre-financial-suite-main (3)/          ← wrapper: BROKEN .git (info/ only), empty supabase/ skeleton, agent-tool stubs
└── cre-financial-suite-main/          ← THE REAL PROJECT (valid git repo; everything below is relative to here)
    ├── src/                           ← React SPA source
    │   ├── pages/                     ← 71 route pages (file-based routing)
    │   ├── pages.config.js            ← generated page registry (lazy imports)
    │   ├── app/AppRoutes.jsx          ← router + RbacGuard wiring
    │   ├── components/                ← domain components (dashboard/, lease-review/, userManagement/, admin/, ui/…)
    │   ├── services/                  ← data layer: api.js (entity CRUD), edgeFunctions.js, supabaseClient.js, domain services
    │   ├── lib/                       ← rbac.js, AuthContext.jsx, actingOrg.js, orgUtils.js, tenantResolver.js, query-client.js, field contracts
    │   ├── features/access-control/   ← RbacGuard
    │   ├── hooks/                     ← useOrgId, useOrgQuery, useFileStatus, useMfaStatus, …
    │   └── types/index.js             ← ENTITIES map, resolveTableName, ORG_EXEMPT_TABLES
    ├── supabase/
    │   ├── config.toml                ← project id, MFA TOTP, per-function verify_jwt
    │   ├── schema.sql                 ← foundational auth/tenancy (335 lines)
    │   ├── migrations/                ← 216 SQL migrations (20260321… → 20260854…)
    │   └── functions/                 ← 82 edge functions + _shared/ + _tests/
    ├── e2e/                           ← 1 Playwright spec + local-supabase helper
    ├── scripts/                       ← deploy/codegen/integration-test utilities
    ├── docs/                          ← ~70 phase/engineering journals + this audit (docs/project-audit/)
    ├── base44/                        ← DEAD legacy Base44 trigger functions (ARC-002)
    ├── .kiro/specs/                   ← 3 Kiro spec sets (design/requirements/tasks)
    ├── dist/                          ← build output (gitignored, present locally)
    ├── scratch/, tmp/, temp_git_log.txt ← committed throwaways (OPS-004)
    └── cre-financial-suite-main/      ← empty stale scaffold (ARC-001)
```

## 2. Technology summary

| Aspect | Value | Evidence |
|---|---|---|
| Language | JavaScript (JSX) frontend; TypeScript (Deno) edge functions; SQL migrations; 1 Python report script | `CONFIRMED` — package.json, supabase/functions |
| Frontend | React 18.2, Vite 6 (v6.4.1 at runtime), React Router DOM 6.26 (file-based page registry), Tailwind 3.4 + Radix/shadcn, TanStack React Query 5, react-hook-form + zod, Recharts, framer-motion | `CONFIRMED` — [package.json](../../package.json), Phase-0 build log |
| Backend | Supabase: Postgres + Auth (incl. TOTP MFA) + Storage + Edge Functions (Deno) | `CONFIRMED` — supabase/ |
| Domain libs | xlsx, jspdf, html2canvas, pdfjs-dist, mammoth (docx), react-leaflet, three, react-quill | `CONFIRMED` — package.json (three/leaflet/quill consumers not yet traced — `UNVERIFIED` usage depth) |
| Payments | Stripe (`@stripe/react-stripe-js`, checkout session + signature-verified webhook) | `CONFIRMED` — EV-18 |
| AI/extraction | Vertex AI (Gemini), Azure Document Intelligence, Anthropic (`claude-sonnet-4-6`), Docling, Google Vision — provider-switched by env | `CONFIRMED` — EV-19 |
| Email | Resend | `CONFIRMED` — `send-email`, `approve-request` functions |
| Other integrations | UPS address validation | `CONFIRMED` — `validate-address-ups` |
| Package manager / runtime | npm (package-lock.json), Node v24.14.0 verified, Deno (functions) | `CONFIRMED` — Phase 0 |
| Deployment | Vercel (SPA; `vercel.json` security headers + rewrite) frontend; manual `supabase` CLI for DB/functions | `CONFIRMED` — EV-21 |
| CI/CD | **MISSING** — no `.github/`, no pipeline of any kind | [OPS-001](findings-register.md#ops-001) |
| Observability | **MISSING** — no error tracking/metrics/analytics | [OPS-002](findings-register.md#ops-002) |
| Caching | Client: React Query + in-memory TTL cache in `api.js`. Server/edge: none found (`MISSING`) | `CONFIRMED` |
| Queues | None (no pg_cron, no external queue); durable `pipeline_jobs` table + chained function calls | `CONFIRMED` — EV-16 |
| Testing | Vitest (62 files / 685 tests, all pass), Playwright (1 spec, currently failing locally — [OPS-003](findings-register.md#ops-003)) | `CONFIRMED` — Phase 0 |

## 3. Environment-variable categories (names only)

| Category | Variables | Where used |
|---|---|---|
| Frontend | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_STRIPE_PUBLISHABLE_KEY` | Vite build/runtime |
| Supabase platform | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_FUNCTIONS_URL` | edge functions |
| Internal auth | `WORKER_INTERNAL_SECRET` | worker ↔ pipeline functions ([SEC-003](findings-register.md#sec-003)) |
| Google/Vertex | `VERTEX_PROJECT_ID`, `VERTEX_LOCATION`, `VERTEX_MODEL`, `GOOGLE_SERVICE_ACCOUNT_KEY`, `GOOGLE_*`, `GEMINI_*`, `CLOUD_VISION_PDF_*` | extraction |
| Azure | `AZURE_DOCUMENT_INTELLIGENCE_{ENDPOINT,KEY,MODEL_ID,API_VERSION,OUTPUT_FORMAT}`, `STORE_FULL_AZURE_RAW_RESPONSE` | extraction |
| Anthropic / Docling | `ANTHROPIC_API_KEY`; `DOCLING_API_URL`, `DOCLING_API_KEY` | extraction |
| Stripe / Email / UPS | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`; `RESEND_API_KEY`; `UPS_CLIENT_ID`, `UPS_CLIENT_SECRET`, `UPS_BASE_URL` | billing, email, address validation |
| Behavior flags | `EXTRACTION_PROVIDER`, `BUSINESS_EXTRACTION_PROVIDER`, `DISABLE_EXTERNAL_PROVIDER_CALLS`, `NORMALIZE_INLINE_ENRICHMENT`, `LLM_GROUP_CONCURRENCY`, `FRONTEND_URL`, `SITE_URL`, `LOCAL_SUPABASE_RUNTIME` | pipeline configuration |

## 4. Component table

| Component | Location | Purpose | Technology | Entry point | Depends on | Consumers | Deploy unit | Status | Evidence |
|---|---|---|---|---|---|---|---|---|---|
| SPA frontend | `src/` | All user-facing product | React 18/Vite | `index.html` → `src/main.jsx` → `App.jsx` | Supabase JS, edge functions | End users | Vercel | `CONFIRMED` working (builds, renders, guards active — E1) | Phase 0 log |
| Page registry/router | `src/pages.config.js`, `src/app/AppRoutes.jsx` | 71 lazy-loaded routes `/PageName` + RBAC guards | React Router 6 | — | rbac.js | SPA | with SPA | `CONFIRMED` | EV-13 |
| Entity data layer | `src/services/api.js` (1,771 ln) | Generic org-scoped CRUD, audit hooks, cache, seed fallback | supabase-js | — | supabaseClient, types/index.js | ~all pages | with SPA | `CONFIRMED` (fallback risk [WKF-002](findings-register.md#wkf-002)) | EV-25 |
| Edge RPC layer | `src/services/edgeFunctions.js` | JWT refresh + `x-acting-org-id` + invoke | supabase-js functions | — | supabaseClient, actingOrg | domain services | with SPA | `CONFIRMED` | EV-12 |
| Domain services | `src/services/*.js` (parsingEngine 174 KB, expenseService 137 KB, leaseExpenseRuleService 108 KB, …) | Lease/expense/CAM/budget business logic | JS | — | api.js, edgeFunctions.js | pages | with SPA | `CONFIRMED`; size signals logic living client-side | inventory |
| Auth context + RBAC | `src/lib/AuthContext.jsx`, `src/lib/rbac.js`, `src/features/access-control/RbacGuard` | Session, roles, page gating, MFA guard | React context | — | supabase auth | all routes | with SPA | `CONFIRMED` (guards E1-verified for 2 routes) | EV-13, Phase 0 |
| DB schema + RLS | `supabase/schema.sql`, `supabase/migrations/` (216) | 163 tables, org-scoped RLS, 267 SECURITY DEFINER | Postgres | `supabase db push` | — | functions + client | Supabase project | `CONFIRMED` in repo; remote state `UNVERIFIED` ([TEN-001](findings-register.md#ten-001), [OPS-005](findings-register.md#ops-005)) | EV-14/15 |
| Edge functions | `supabase/functions/` (82) | Compute/persist/review/approve pipeline + billing + email + admin | Deno TS | per-function `index.ts` | `_shared/`, external APIs | SPA, worker, Stripe | Supabase functions | `CONFIRMED` in repo; deployment `UNVERIFIED` | EV-02…EV-19 |
| Extraction worker | `supabase/functions/lease-extraction-worker/` | Drains `pipeline_jobs`, stage orchestration | Deno TS | `index.ts` | parse/normalize functions, internal auth | pipeline | Supabase functions | `CONFIRMED` in repo | EV-16/17 |
| Storage buckets | `financial-uploads`, `extraction-artifacts` (+ referenced-but-not-migrated `documents` bucket) | Uploads; raw AI artifacts | Supabase Storage | migrations | — | functions/SPA | Supabase | `CONFIRMED` in repo; `documents` bucket creation is a manual step (`PARTIAL`) | EV-20 |
| E2E suite | `e2e/` | Lease upload→review→approve regression | Playwright + system Chrome | `playwright.config.js` | local Supabase | dev/CI (none) | — | `PARTIAL` — fails on current local stack ([OPS-003](findings-register.md#ops-003)) | Phase 0 |
| Ops scripts | `scripts/` | deploy-edge-functions.ps1, db-reset, registry generators, phase test scripts | mixed | — | — | developers | — | `CONFIRMED` present; unmaintained status `UNVERIFIED` | inventory |
| Self-audit tooling | `generate_audit_report.py`, `CRE_…_Audit_Report.xlsx`, `DEPLOY.md` | Prior audit + deploy runbook | Python/openpyxl | — | — | leadership | — | `CONFIRMED` historical ([PRD-001](findings-register.md#prd-001)) | EV-23 |
| Base44 triggers | `base44/functions/` | Legacy event hooks (audit, lease-expiry notify) | Deno + @base44/sdk | `entry.ts` | Base44 platform | none | none | **Dead** ([ARC-002](findings-register.md#arc-002)) | EV-24 |

Owners: `MISSING` — no CODEOWNERS, no ownership metadata anywhere; commits authored by a single author ("TejaSahithi" per `temp_git_log.txt` history — `INFERRED` single-maintainer project).

## 5. Local development & production deployment process

- **Local (documented in README.md + DEPLOY.md):** `npm install` → `.env` with local/hosted Supabase → `supabase start` + `db reset` for local stack → `npm run dev`. `CONFIRMED` working for frontend; local DB currently in a broken-grant state ([OPS-003](findings-register.md#ops-003)).
- **Production (per DEPLOY.md, UNVERIFIED against remote):** Vercel builds `dist/` from git; `supabase db push` + `supabase functions deploy` + `supabase secrets set` are **manual CLI steps**; storage bucket + auth URL configuration are **manual dashboard steps**. No pipeline enforces order or records what was deployed ([OPS-001](findings-register.md#ops-001), [OPS-005](findings-register.md#ops-005)).

## 6. Duplicates, dead code, coupling & inconsistencies

| Issue | Detail | Finding |
|---|---|---|
| Duplicate trees | wrapper + real repo + inner empty scaffold; wrapper's `supabase/` contains an empty `parse-pdf-docling/` mirroring the real one | [ARC-001](findings-register.md#arc-001) |
| Dead module | `base44/` entire directory (plus stray `Downloads - Shortcut.lnk`) | [ARC-002](findings-register.md#arc-002) |
| Version inconsistency | supabase-js `2.99.2` vs `2.39.0` across functions; `Deno.serve` vs `std/http serve` | [ARC-004](findings-register.md#arc-004) |
| Duplicated toast libs | Both `sonner` and `react-hot-toast` in dependencies | `CONFIRMED` package.json — consolidation candidate |
| Committed throwaways | `temp_git_log.txt`, `tmp/` diagnostics, `scratch/`, committed `.env` | [OPS-004](findings-register.md#ops-004) |
| Tight coupling | Domain services in `src/services/` are very large (100–174 KB) and interleave presentation-adjacent logic with data access; the entity layer (`api.js`) also owns caching + auditing + seeding | `INFERRED` from size/roles; deep dive in [modules/](04-module-deep-dives.md) |
| Naming inconsistency | Domain "tenants" (lease occupants) vs SaaS "tenant" (organization) — the `tenants` table is **not** the tenancy boundary | recorded in [contradictions-and-drift.md](contradictions-and-drift.md) |
| Alias/legacy routes & roles | `PipelineUpload` vs `LeaseUpload`; ~14 legacy role aliases in `rbac.js` (`ROLE_ALIASES`) | recorded in contradictions log |
| Circular dependencies | None detected at import-graph level (build + typecheck clean); not exhaustively analyzed — `UNVERIFIED` | Phase 0 |

Related: [02 — Architecture](02-current-state-architecture.md) · [07 — API & Gateway](07-api-and-gateway-architecture.md) · [08 — Database](08-database-schema-and-ui-gap-analysis.md)

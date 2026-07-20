# Evidence Index

> Generated: 2026-07-20 · Repository revision: `34563cfaff4271b72d00b0841353dc2792f2f16a` (branch `feature/lease-intelligence-enterprise-p1-p8`) · Part of the [Project Audit](README.md)

Structured index of the evidence underpinning the audit. Evidence strength: **E1** runtime-verified · **E2** automated-test-verified · **E3** static path fully traced · **E4** configuration/documentation evidence · **E5** inferred. Confidence: High / Medium / Low.

---

## Phase 0 verification log (frozen revision, sanitized)

Executed 2026-07-20 against commit `34563cf`, Node v24.14.0, npm 11.9.0, Windows 11. Environment safety gate passed before every command: process environment contained no Supabase/Stripe/AI variables; `.env` resolves the Supabase URL to `127.0.0.1` (loopback); `.env.production` contains a literal `YOUR_PROJECT_REF.supabase.co` placeholder (no real remote endpoint anywhere in the tree); `.env.phase52.local` contains backend secret names only (not `VITE_`-prefixed, not loaded by any configured Vite mode). No command was capable of reaching the linked remote project.

| Command | Result | Evidence strength | Notes |
|---|---|---|---|
| `git rev-parse HEAD` / `git status --porcelain` | `34563cfaff4271b72d00b0841353dc2792f2f16a`, clean working tree | E1 | Branch `feature/lease-intelligence-enterprise-p1-p8` |
| `npm run build` (vite build, production mode) | **PASS**, exit 0, ~10 s | E1 | Warning: main chunk 637.26 kB minified (> 500 kB threshold); ~70 lazy route chunks emitted |
| `npm run typecheck` (`tsc -p jsconfig.json`) | **PASS**, exit 0, no output | E1 | |
| `npm run lint` (`eslint . --quiet`) | **PASS**, exit 0, no errors | E1 | Note: config ignores `src/lib/**`, `src/components/ui/**` ([QA-002](findings-register.md#qa-002)) |
| `npm test` (`vitest run src/`) | **PASS**: 62 files, **685/685 tests**, 5.2 s | E1 | |
| `npm run test:e2e:phase5f` (Playwright) | **FAIL**, exit 1: both projects fail during seeding with Postgres `42501 permission denied for table organizations` | E1 | A local Supabase stack was running (auth + REST answered HTTP 200 on `127.0.0.1:54321`); failure indicates the local database lacks grants/migrations, not that the test infra is absent. Failure screenshots are blank (failure precedes navigation). See [OPS-003](findings-register.md#ops-003) |
| `npm run dev` + headless-Chrome probes (loopback-only routing guard) | Landing `/`, `/Landing`, `/Pricing` render full marketing pages; `/Login` renders email/password + Google OAuth form; `/Dashboard` and `/LeaseUpload` render the **login view** for unauthenticated visitors (client-side guard active) | E1 | Only console errors were this probe's deliberate blocking of `fonts.googleapis.com` (external font dependency, [SEC-007](findings-register.md#sec-007)). Marketing copy observed: "The Operating System for Commercial Real Estate Finance", "Trusted by 500+ commercial properties nationwide" ([PRD-002](findings-register.md#prd-002)) |
| Post-run integrity | `git status --porcelain` empty; `package-lock.json` untouched | E1 | Build artifacts land in gitignored `dist/`, `test-results/` |

**Environment note:** because the committed `.env` points at a *running* local Supabase (`127.0.0.1:54321`), the dev server operated in "local-Supabase mode", not pure seed/in-memory mode (the in-memory fallback in [src/services/supabaseClient.js:56-62](../../src/services/supabaseClient.js#L56-L62) only activates when env vars are absent). All probe conclusions are limited accordingly.

## Environment-capability matrix

What each execution environment can and cannot prove. "Prohibited" = barred by the audit's safety rules.

| Capability | Local dev server (this audit) | Local Supabase | Linked remote | Production |
|---|---|---|---|---|
| UI rendering / routing / guards | **Verified (E1)** for probed routes | — | Prohibited | Unverified |
| Authentication (login round-trip) | Not verified (no seedable credentials; e2e seeding failed) | Potentially testable | Prohibited | Unverified |
| DB persistence | Not verified | Potentially testable (blocked by `42501` state) | Prohibited | Unverified |
| RLS enforcement | Not verified | Potentially testable | Prohibited (repository migrations/policies inspected instead — E3/E4) | Unverified |
| Edge functions | Not verified (none invoked) | Potentially testable | Prohibited | Unverified |
| Stripe / email / AI extraction | Not exercised (mock only) | Mock only | Prohibited | Unverified |

---

## Repository-wide counts (reproducible at the frozen commit)

| Metric | Count | How reproduced | Strength |
|---|---|---|---|
| Frontend pages | **71** `.jsx` files in `src/pages/` | `ls src/pages/*.jsx \| wc -l` | E1 |
| DB migrations | **216** files in `supabase/migrations/` | `ls supabase/migrations/*.sql \| wc -l` | E1 |
| Edge function directories | **82** (excluding `_shared`, `_tests`) | `ls -d supabase/functions/*/` | E1 |
| Functions declared in `config.toml` | **45** (`[functions.*]` blocks) → **37 undeclared** | `grep -c '^\[functions\.' supabase/config.toml` | E1 |
| Distinct tables created | **163** across migrations + `schema.sql` | grep `CREATE TABLE`, dedupe names | E1 |
| `ENABLE ROW LEVEL SECURITY` statements | **156** literal (plus dynamic `DO/EXECUTE` loops — see [08](08-database-schema-and-ui-gap-analysis.md)) | grep | E1 |
| `FORCE ROW LEVEL SECURITY` statements | **0** | grep | E1 |
| `SECURITY DEFINER` occurrences | **267** in 108 SQL files | grep | E1 |
| `verify_jwt = false` functions | **8**: `lease-extraction-worker`, `parse-pdf-docling`, `normalize-pdf-output`, `signup`, `send-email`, `submit-contact`, `extract-document-fields`, `stripe-webhook` | grep on `config.toml` | E1 |
| Unit test files / tests | **62 files / 685 tests**, all passing | `npm test` | E1 |
| E2E specs | **1** (`e2e/phase5f/lease-review-workflow.spec.js`) | enumeration | E1 |

## Key evidence records

| # | Finding / fact | File path | Symbol / route | Lines | Interpretation | Strength · Confidence |
|---|---|---|---|---|---|---|
| EV-01 | Real project is the **nested** folder; outer wrapper has broken `.git` (only `info/`), inner `cre-financial-suite-main/cre-financial-suite-main/` is an empty scaffold | `../..` vs wrapper | — | — | Only the nested repo is authoritative; wrapper + innermost copy are stale cruft | E1 · High |
| EV-02 | Service-role admin client used by all edge functions | `supabase/functions/_shared/supabase.ts` | `createAdminClient` | 11–17 | Server-side DB access bypasses RLS (no FORCE RLS anywhere) | E3 · High |
| EV-03 | Internal service auth: `x-internal-service-key` compared to service-role key; synthetic `internal-compute` user | `supabase/functions/_shared/supabase.ts` | `isInternalServiceRequest`, `verifyUser` | 30–38, 44–55 | Service-to-service short-circuit skips user auth AND page-access checks (see EV-06) | E3 · High |
| EV-04 | User JWT verification via `auth.getUser(token)` accepting 3 header sources | `supabase/functions/_shared/supabase.ts` | `verifyUser` | 57–86 | Real token validation; non-standard extra headers `x-user-jwt`, `x-supabase-auth` | E3 · High |
| EV-05 | Org resolution: super-admin **must** send `x-acting-org-id`; multi-org users must select; in-code comment documents fixed audit finding "S2" (silent first-org fallback) | `supabase/functions/_shared/supabase.ts` | `getUserOrgId` | 124–209 | Tenant resolution centralized and hardened; org id from header is validated against membership (non-super-admin) or existence (super-admin) | E3 · High |
| EV-06 | `assertPageAccess` returns immediately for internal service requests | `supabase/functions/_shared/supabase.ts` | `assertPageAccess` | 211–219 | Internal calls bypass fine-grained page permissions by design | E3 · High |
| EV-07 | Org-scoped SECURITY DEFINER helpers: `is_super_admin`, `get_my_org_ids`, `is_org_admin`, `can_write_org_data` | `supabase/schema.sql` | — | 132–166 | Foundation of all RLS policy scoping | E3 · High |
| EV-08 | `organizations` table: `plan`, `status` (onboarding → active), `onboarding_step`, `enabled_modules` | `supabase/schema.sql` | — | 71–85 | Org lifecycle + per-org module gating modeled in DB | E3 · High |
| EV-09 | Any authenticated user may INSERT into `organizations` (`WITH CHECK (auth.uid() IS NOT NULL)`) | `supabase/schema.sql` | `orgs_insert_authenticated` | 121–123 | Self-serve org creation; no quota/abuse control at DB level | E3 · High |
| EV-10 | `memberships`: roles live only here; `UNIQUE(user_id, org_id)`; roles `super_admin\|org_admin\|manager\|editor\|viewer` | `supabase/schema.sql` | — | 169–181 | Membership model is the tenancy backbone | E3 · High |
| EV-11 | Browser Supabase client: `persistSession: true` (tokens in localStorage), null-client in-memory fallback when env missing | `src/services/supabaseClient.js` | `getOrCreateSupabaseClient` | 36–66 | Token storage in localStorage ([SEC-004](findings-register.md#sec-004)); seed mode masks missing backend ([WKF-002](findings-register.md#wkf-002)) | E3 · High |
| EV-12 | Every edge call refreshes JWT and forwards `x-acting-org-id` from stored acting-org state | `src/services/edgeFunctions.js` | `invokeEdgeFunction`, `getActingOrgHeaders` | 5–45 | Client-supplied org context; server validates against membership (EV-05) | E3 · High |
| EV-13 | Frontend RBAC: `PUBLIC_PAGES`, `MANDATORY_SETUP_PAGES`, `MFA_BYPASS_PAGES`, `canAccess`, role→page maps | `src/lib/rbac.js` | — | 136–319 | Client-side authorization layer (UI gating only; server enforcement separate) | E3 · High |
| EV-14 | Remote-only `audit_logs.user_id` column captured after the fact; migration comment states no migration created it | `supabase/migrations/20260708000000_capture_audit_logs_user_id_column.sql` | — | whole file | Confirmed remote-vs-repo schema drift ([TEN-001](findings-register.md#ten-001)) | E4 · High |
| EV-15 | Remote-only wide-open `audit_logs_insert_all` policy dropped; blanket `<table>_all` FOR-ALL policies dropped for 8 core tables | `supabase/migrations/20260708020000_drop_unsafe_audit_logs_insert_all_policy.sql`, `20260709020000_drop_remote_only_blanket_rls_policies.sql` | — | whole files | Drift originated outside migration history; repo now corrective | E4 · High |
| EV-16 | Pipeline job table: stages `parse\|normalize\|review_draft\|rule_extraction`, `status queued…cancelled`, `max_attempts 3`, queue index | `supabase/migrations/20260610120000_pipeline_jobs.sql` | `pipeline_jobs` | whole file | Durable job model; no pg_cron — worker driven | E3 · High |
| EV-17 | Worker: per-stage timeouts (parse 140 s; normalize/enrich 240 s), cancel re-check per stage, durability reconciliation (`durable\|not_durable\|unknown`) | `supabase/functions/lease-extraction-worker/index.ts` | — | ~21–172 | Deliberate reliability engineering in extraction pipeline | E3 · High |
| EV-18 | Stripe webhook: signature verification + `stripe_events` idempotency (unique-violation `23505` handling) | `supabase/functions/stripe-webhook/index.ts` | — | ~40–92 | Correct webhook auth + idempotency pattern | E3 · High |
| EV-19 | Anthropic call in extraction LLM layer (`claude-sonnet-4-6` via `api.anthropic.com`); Vertex AI RS256 service-account JWT signed in-code | `supabase/functions/_shared/extraction/llm-extractor.ts` (~543–579), `_shared/vertex-ai.ts` (~41–81) | — | as noted | Multi-provider AI extraction; provider selected by env (`EXTRACTION_PROVIDER` etc.) | E3 · High |
| EV-20 | Private buckets: `financial-uploads` (org-folder RLS on `storage.objects`); `extraction-artifacts` (default-deny, service-role-only reader via `get-extraction-artifact` + authorization RPC + audit row) | `supabase/migrations/20260403000000_…`, `20260825000300_…`; `supabase/functions/get-extraction-artifact/` | — | whole files | Storage isolation modeled; raw AI payloads (PII) only via audited privileged function | E3 · High |
| EV-21 | No CI/CD: no `.github/` directory at all; deployment via Vercel (`vercel.json`: SPA rewrite + security headers) and manual `supabase` CLI per `DEPLOY.md` | repo root | — | — | No automated gate runs the (passing) test suite | E4 · High |
| EV-22 | No observability dependency (no Sentry/OTel/Datadog/analytics in `package.json`, no snippet in `index.html`) | `package.json`, `index.html` | — | — | Production incidents would be invisible ([OPS-002](findings-register.md#ops-002)) | E4 · High |
| EV-23 | Prior in-repo self-audit: 22 findings (F-001…F-022), maturity 52/100, generated Excel; references "80+ migrations / 60+ functions" — stale vs today's 216/82 | `generate_audit_report.py`, `CRE_Financial_Suite_Audit_Report.xlsx`, `DEPLOY.md` | — | — | Historical context only; counts stale ([PRD-001](findings-register.md#prd-001)) | E4 · High |
| EV-24 | Legacy Base44 platform artifacts: `base44/functions/*/entry.ts` import `npm:@base44/sdk@0.8.20`; zero references from `src/` | `base44/` | — | — | Dead legacy backend, superseded by Supabase functions | E3 · High |
| EV-25 | Entity CRUD layer with org scoping, audit logging, cache and seed fallback; entity→table map + `ORG_EXEMPT_TABLES` | `src/services/api.js` (1,771 lines), `src/types/index.js` | `ENTITIES`, `resolveTableName` | — | Generic data layer enforcing org_id client-side; server RLS is the real boundary | E3 · High |
| EV-26 | Playwright config: system Chrome channel, serial workers, 120 s timeout, webServer via `scripts/phase5f-start-vite.mjs` | `playwright.config.js` | — | 1–37 | E2E harness real but single-workflow | E3 · High |
| EV-27 | Mixed supabase-js pins across functions (e.g. `2.99.2` in `_shared/supabase.ts:2` vs `2.39.0` in `stripe-webhook`) | `supabase/functions/**` | — | — | Version inconsistency ([ARC-004](findings-register.md#arc-004)) | E4 · Medium |
| EV-28 | MFA TOTP enroll+verify enabled platform-wide | `supabase/config.toml` `[auth.mfa.totp]` | — | — | MFA is a real, configured capability (frontend `MFAGuard.jsx`, `useMfaStatus`) | E4 · High |

*This index is appended to by later phases; module deep dives and workflow traces cite additional file:line evidence inline.*

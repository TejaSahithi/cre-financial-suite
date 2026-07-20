# Findings Register (Canonical)

> Generated: 2026-07-20 · Repository revision: `34563cfaff4271b72d00b0841353dc2792f2f16a` (branch `feature/lease-intelligence-enterprise-p1-p8`) · Part of the [Project Audit](README.md)

**This is the single source of truth for audit findings.** All other documents cite these IDs; none restates severity or status independently. Evidence strength: E1 runtime · E2 automated-test · E3 static path traced · E4 config/doc · E5 inferred. Severity ≠ Priority: severity measures harm; priority (P0 immediate / P1 current-quarter / P2 planned / P3 backlog) measures when to act.

Prefixes: SEC security · TEN tenancy · DATA data integrity · WKF workflow · ARC architecture · PRD product · OPS operations · QA quality.

---

## Critical / High severity

### TEN-001 — Remote database schema drifted outside migration history
- **Category:** Tenancy / Data governance · **Status:** Confirmed · **Strength:** E4 · **Confidence:** High
- **Severity:** High · **Priority:** **P0** — *urgency rationale:* until repo and remote agree, every deploy risks reintroducing dropped permissive policies or failing on unexpected columns; blocks trustworthy `db push`.
- **Evidence:** [supabase/migrations/20260708000000_capture_audit_logs_user_id_column.sql](../../supabase/migrations/20260708000000_capture_audit_logs_user_id_column.sql) (in-file comment: remote `audit_logs.user_id` created by no migration); [20260708020000](../../supabase/migrations/20260708020000_drop_unsafe_audit_logs_insert_all_policy.sql) (remote-only `WITH CHECK (true)` insert policy for `authenticated, anon`); [20260709020000](../../supabase/migrations/20260709020000_drop_remote_only_blanket_rls_policies.sql) (blanket `<table>_all` policies on `leases`, `expenses`, `properties`, `buildings`, `portfolios`, `tenants`, `units`, `vendors` dropped). `docs/deploy/schema-sync-checklist.md` exists for this reason.
- **Affected modules:** Audit logging, all core business modules, DevOps.
- **Business impact:** A security reviewer or enterprise customer asking "is your schema change-controlled?" currently gets "no." Past drift included policies that defeated tenant-permission gating.
- **Technical impact:** Migration files cannot be trusted as ground truth for the remote; blind deploys are unsafe.
- **Recommendation:** Run a schema diff against the linked project (outside this audit's scope — remote access prohibited), reconcile into migrations, then enforce migration-only changes (revoke dashboard DDL for humans).
- **Blocking dependency:** Access to remote project. **Remediation status:** Partially remediated in-repo (corrective migrations exist); remote state UNVERIFIED.

### SEC-001 — RLS is bypassed by every edge function; no FORCE ROW LEVEL SECURITY anywhere
- **Category:** Security / Tenancy · **Status:** Confirmed · **Strength:** E3 · **Confidence:** High
- **Severity:** High · **Priority:** P1 — *urgency rationale:* not an active exploit, but it makes application code the sole tenant boundary for all 82 server-side functions; one missed `org_id` filter = cross-tenant exposure.
- **Evidence:** `createAdminClient()` with service-role key is the standard data access in functions ([supabase/functions/_shared/supabase.ts:11-17](../../supabase/functions/_shared/supabase.ts#L11-L17)); `FORCE ROW LEVEL SECURITY` occurs 0 times in 216 migrations + schema.sql (grep, [evidence-index](evidence-index.md)); 156 `ENABLE RLS` statements protect only client-direct access.
- **Affected modules:** All backend modules.
- **Business impact:** Weakens the strongest enterprise claim ("database-enforced isolation"); a defect anywhere in 82 functions can leak tenant data.
- **Technical impact:** Tenant scoping relies on `getUserOrgId()` + per-function discipline instead of a database guarantee.
- **Recommendation:** Adopt user-scoped clients (`createUserScopedClient`, already implemented at [supabase.ts:106-122](../../supabase/functions/_shared/supabase.ts#L106-L122)) for read paths where possible; consider `FORCE RLS` + explicit `SET role` patterns for service paths; add automated cross-tenant tests.
- **Remediation status:** Mitigations exist (centralized `getUserOrgId`, EV-05) but boundary remains app-level.

### OPS-001 — No CI/CD pipeline; the passing test suite gates nothing
- **Category:** Operations · **Status:** Confirmed · **Strength:** E4 (absence) + E1 (tests pass locally) · **Confidence:** High
- **Severity:** High · **Priority:** P1 — cheap to fix, compounding risk while absent.
- **Evidence:** No `.github/` directory exists; no other CI config found; 685 unit tests pass in 5.2 s locally (Phase 0) but nothing runs them on push/PR; deploys are Vercel git-integration (frontend) + manual `supabase` CLI ([DEPLOY.md](../../DEPLOY.md)).
- **Business impact:** Any commit can silently break the product; no deploy repeatability story for enterprise procurement.
- **Technical impact:** Regressions reach `main` unchecked; DB/functions deploys are unversioned manual steps.
- **Recommendation:** GitHub Actions: lint + typecheck + vitest on PR; migration dry-run job; gated `supabase functions deploy`. **Remediation status:** Open.

### OPS-002 — Zero production observability (no error tracking, metrics, analytics, or alerting)
- **Category:** Operations · **Status:** Confirmed · **Strength:** E4 · **Confidence:** High
- **Severity:** High · **Priority:** P1.
- **Evidence:** `package.json` has no Sentry/OTel/Datadog/PostHog/analytics dependency; `index.html` has no snippet; runtime signal is ad-hoc `console.*` plus `_shared/logger.ts` writing to function logs. Audit-report finding F-022 (no error boundary) corroborates crash opacity.
- **Business impact:** Production incidents are invisible until a customer reports them; no SLA can be honestly offered. **Caps operational-readiness maturity at 2 suite-wide** (scoring rule).
- **Technical impact:** No correlation IDs across the extraction pipeline's multi-function chains; debugging relies on Supabase function logs.
- **Recommendation:** Sentry (frontend + Deno functions) + uptime checks + Vercel analytics as a first tranche; request-ID propagation exists partially (`audit_logs.request_id`) to build on. **Remediation status:** Open.

### OPS-005 — Production deployment state unknown; prior audit says migrations/functions were never deployed
- **Category:** Operations · **Status:** **Unverified** (remote access prohibited to this audit) · **Strength:** E4 · **Confidence:** Low
- **Severity:** High (if still true) · **Priority:** **P0** to *verify* — one command (`supabase migration list`) answers it.
- **Evidence:** [DEPLOY.md](../../DEPLOY.md) runbook exists precisely because migrations + functions + secrets were not deployed (self-audit F-002/F-003); `.env.production` still contains a `YOUR_PROJECT_REF` placeholder; project memory (July 2026) records 2 edge-function deploys still pending.
- **Business impact:** If undeployed, the production app is a shell — the single most important fact for any leadership review.
- **Recommendation:** Owner runs the DEPLOY.md checklist against the linked project and records the delta. **Remediation status:** Unknown.

## Medium severity

### SEC-002 — 37 of 82 edge functions are absent from `config.toml`, relying on the implicit `verify_jwt` default
- **Status:** Confirmed · **Strength:** E1 (counts) + E4 · **Confidence:** High · **Severity:** Medium · **Priority:** P1
- **Evidence:** 82 function dirs vs 45 `[functions.*]` blocks ([evidence-index](evidence-index.md)); undeclared set includes deletion/update/persist functions (`delete-*`, `update-expense-*`, `persist-*`, `get-extraction-artifact`, `document-intelligence-v3-*`, …).
- **Impact:** Security posture of 37 functions depends on a platform default rather than explicit declaration; a platform default change or a copy-paste `verify_jwt=false` block would silently alter exposure.
- **Recommendation:** Declare every function explicitly with a comment justifying its auth mode. **Status:** Open.

### SEC-003 — Three header forms accept the service-role key as service-to-service auth on `verify_jwt=false` functions
- **Status:** Confirmed · **Strength:** E3 · **Confidence:** High · **Severity:** Medium · **Priority:** P2
- **Evidence:** `x-internal-service-key == SUPABASE_SERVICE_ROLE_KEY` ([_shared/supabase.ts:30-38](../../supabase/functions/_shared/supabase.ts#L30-L38)); `_shared/internal-auth.ts` additionally accepts `x-worker-secret == WORKER_INTERNAL_SECRET` and `Authorization: Bearer <service-role-key>`; internal requests skip `assertPageAccess` ([supabase.ts:217-219](../../supabase/functions/_shared/supabase.ts#L211-L219)) and can set `x-internal-org-id` freely (`supabase.ts:98-104`).
- **Impact:** The service-role key doubles as an internal API password; any leak = full cross-tenant compute access with page checks skipped. Multiple accepted header forms widen audit surface.
- **Recommendation:** Single dedicated internal secret (never the service-role key), rotated, plus per-function allowlists. **Status:** Open.

### SEC-004 — Session tokens persisted in browser localStorage
- **Status:** Confirmed · **Strength:** E3 · **Confidence:** High · **Severity:** Medium · **Priority:** P2
- **Evidence:** `persistSession: true` in [src/services/supabaseClient.js:48-54](../../src/services/supabaseClient.js#L48-L54) (supabase-js default storage = localStorage, `sb-*` keys); legacy keys cleared at logout (`src/services/auth.js`).
- **Impact:** Any XSS yields token exfiltration. Standard Supabase-SPA trade-off, partially mitigated by strict security headers in [vercel.json](../../vercel.json) — but no CSP header is set.
- **Recommendation:** Add a Content-Security-Policy header; longer-term consider server-side session exchange for enterprise SSO tier. **Status:** Open.

### OPS-003 — Local environment broken: e2e seeding fails with `42501 permission denied for table organizations`
- **Status:** Confirmed (locally) · **Strength:** **E1** · **Confidence:** High · **Severity:** Medium · **Priority:** P1
- **Evidence:** Phase 0 run of `npm run test:e2e:phase5f`: both projects fail in seeding; local Supabase up (auth/REST HTTP 200). Indicates local DB lacks grants or the 216 migrations aren't applied locally — the only e2e safety net cannot run.
- **Impact:** Developer onboarding and regression coverage of the flagship workflow are broken on a fresh/current local stack.
- **Recommendation:** `supabase db reset` reproducibility check + document local bootstrap; add grant checks to `e2e/helpers/phase5fLocalSupabase.mjs`. **Status:** Open.

### TEN-002 — Three org-scoped business tables lack their own `org_id`; isolation is one-hop indirect
- **Status:** Confirmed (exhaustive enumeration at frozen commit) · **Strength:** E3 · **Confidence:** High · **Severity:** Medium · **Priority:** P2
- **Evidence:** Block-level scan of every `CREATE TABLE` in `schema.sql` + 216 migrations: the only org-scoped **business** tables without a direct `org_id` column are `lease_expense_rules`, `lease_expense_values`, `lease_expense_rule_clauses` (all other no-org_id tables are platform/reference data by design: `organizations`, `profiles`, `access_requests`, `contact_requests`, `demo_requests`, `stripe_events`, `user_roles`, and the `*_registry_*`/`*_types`/`*_profiles` reference tables). The three ARE RLS-protected, but via one-hop subqueries — e.g. `lease_expense_rules_select … USING (rule_set_id IN (SELECT id FROM lease_expense_rule_sets WHERE org_id IN (SELECT get_my_org_ids())))`. Major newer tables (`lease_claims`, `extraction_runs`) carry direct `org_id NOT NULL` — the pattern improved over time.
- **Impact:** Isolation for the rules family depends on parent-table joins inside policies — harder to audit, easier to break in refactors, and slower at scale than a direct column check.
- **Recommendation:** Denormalize `org_id` onto the three tables + direct policies; add cross-tenant leak tests. **Status:** Open.

### QA-001 — Single e2e workflow; no enforcement of any test anywhere
- **Status:** Confirmed · **Strength:** E4 · **Confidence:** High · **Severity:** Medium · **Priority:** P1
- **Evidence:** One spec (`e2e/phase5f/lease-review-workflow.spec.js`); no CI (OPS-001); no pre-commit hooks (no `.husky/`).
- **Impact:** 685 passing unit tests give false confidence about integration behavior: auth, billing, CAM, budgets have no end-to-end coverage.
- **Recommendation:** See [13-testing-and-quality-engineering.md](13-testing-and-quality-engineering.md) pyramid. **Status:** Open.

### WKF-002 — Seed-data fallback can silently mask a missing/broken backend
- **Status:** Confirmed (mechanism) · **Strength:** E3 · **Confidence:** High · **Severity:** Medium · **Priority:** P2
- **Evidence:** Null client → in-memory mode with full demo dataset ([src/services/supabaseClient.js:56-62](../../src/services/supabaseClient.js#L56-L62), `src/services/api.js` memory store + `src/services/seedData.js`); only signal is a dev-only amber banner (`src/components/DevModeBanner.jsx`).
- **Impact:** A misconfigured production build renders a convincing, fully-populated app writing to memory — data loss disguised as success (relates to self-audit F-001).
- **Recommendation:** Hard-fail production builds when env vars are absent; make in-memory mode explicit and demo-only. **Status:** Open.

### DATA-001 — Budget AI fallback degrades silently to a heuristic estimate (historical F-007/F-012 largely RESOLVED)
- **Status:** **Resolved** (core) / residual Open (labeling) · **Strength:** E3 (re-verified at frozen commit) · **Confidence:** High · **Severity:** Low (was Medium) · **Priority:** P3
- **Evidence:** Re-verified [supabase/functions/generate-budget/index.ts](../../supabase/functions/generate-budget/index.ts): `budget_year` defaults to `new Date().getFullYear() + 1` (line 288 — the hardcoded-2027 claim F-012 is stale); the Vertex-null fallback calls `estimateBudget(leases, budget_year, historical)` (lines 198–223, 346–352) which derives figures from actual lease rents + historical aggregates with 3% growth and CRE ratio heuristics — **not** the "hardcoded fake numbers" of historical finding F-007.
- **Residual impact:** When Vertex fails, degradation to the heuristic is signaled only by `console.warn`; the HTTP response body is shaped identically to an AI result, so the UI cannot badge the number as an estimate unless `ai_insights` text says so.
- **Recommendation:** Add an explicit `source: "ai" | "heuristic"` field to the response and badge it in the UI. **Status:** Residual open.

### ARC-004 — Inconsistent `@supabase/supabase-js` versions across edge functions
- **Status:** Confirmed · **Strength:** E4 · **Confidence:** High · **Severity:** Medium · **Priority:** P2
- **Evidence:** `2.99.2` in `_shared/supabase.ts:2` vs `2.39.0` in `stripe-webhook/index.ts`; mixed `Deno.serve` vs `std/http serve` entry styles.
- **Impact:** Divergent behavior/bug surface between functions; upgrades untested in aggregate.
- **Recommendation:** Single pinned version via import map. **Status:** Open.

### OPS-006 — No scheduler or reaper for the pipeline job queue; stuck jobs stall silently
- **Status:** Confirmed (absence) · **Strength:** E3 · **Confidence:** High · **Severity:** Medium · **Priority:** P1
- **Evidence:** `pipeline_jobs` is a durable queue (EV-16) but grep finds no pg_cron/scheduled invocation; the worker runs only when invoked by app actions (`INFERRED` trigger path); no reclaim logic for rows stuck `queued`/`running` beyond `available_at` semantics.
- **Business impact:** A customer's upload can silently never process; support discovers it manually.
- **Recommendation:** Scheduled worker invocation (pg_cron or external cron hitting the worker), stuck-job reaper, queue-depth alerting. **Status:** Open.

### OPS-007 — No per-tenant metering of AI/extraction cost
- **Status:** Confirmed (absence) · **Strength:** E4 · **Confidence:** High · **Severity:** Medium · **Priority:** P1 — this is both a COGS-visibility and a pricing-enablement gap.
- **Evidence:** No usage/metering tables or per-org counters found for provider calls; only global env kill-switch `DISABLE_EXTERNAL_PROVIDER_CALLS`; `extraction_runs` provenance rows exist (could be the metering substrate) but no cost/rollup usage found.
- **Business impact:** Gross margin per customer unknown; usage-based pricing impossible; abuse invisible (pairs with [SEC-008](findings-register.md#sec-008)).
- **Recommendation:** Record provider+tokens/pages per `extraction_runs` row; daily per-org rollup; alert thresholds. **Status:** Open.

### SEC-008 — Public, unthrottled endpoints invite spam and AI-cost abuse
- **Status:** Confirmed · **Strength:** E4 (config) + E3 (handlers) · **Confidence:** High · **Severity:** Medium · **Priority:** P1
- **Evidence:** `verify_jwt=false` on `signup`, `submit-contact`, `send-email`, `extract-document-fields` ([supabase/config.toml](../../supabase/config.toml)); no rate limiting, captcha, or sender allowlist found anywhere (grep; [07 §3](07-api-and-gateway-architecture.md)). `send-email` and `submit-contact` trigger Resend sends; `extract-document-fields` can trigger AI-provider calls.
- **Business impact:** Email-relay/spam reputation damage; unbounded AI spend from anonymous traffic; signup flooding.
- **Technical impact:** No abuse controls to tune when it happens; no metrics to even notice ([OPS-002](findings-register.md#ops-002)).
- **Recommendation:** Rate limit by IP+fingerprint, captcha on public forms, restrict `send-email` to internal-secret callers only, require auth on `extract-document-fields` or scope it to the demo flow with strict quotas. **Status:** Open.

## Low / Informational

### SEC-005 — Any authenticated user can create organizations (no quota or verification)
- **Status:** Confirmed · **Strength:** E3 · **Confidence:** High · **Severity:** Low · **Priority:** P3
- **Evidence:** `orgs_insert_authenticated` `WITH CHECK (auth.uid() IS NOT NULL)` ([supabase/schema.sql:121-123](../../supabase/schema.sql#L121-L123)). Mitigated by org `status='onboarding'` + approval flow (`approve-organization` function).
- **Impact:** Junk-org creation/abuse possible; low because approval gates activation.

### SEC-006 — Raw AI-provider payloads (full lease text, PII) stored in `extraction-artifacts` bucket
- **Status:** Confirmed · **Strength:** E3 · **Confidence:** High · **Severity:** Low (control exists) / **Informational**
- **Evidence:** Bucket default-deny, 50 MB, JSON/text only ([20260825000300…](../../supabase/migrations/)); read only via `get-extraction-artifact` after `get_extraction_artifact_authorization` RPC (membership + privileged role) which writes an audit row.
- **Impact:** Positive control worth showcasing; residual risk is retention (no TTL/deletion policy found → feeds GDPR gap in [11](11-security-privacy-and-compliance.md)).

### SEC-007 — External dependency on fonts.googleapis.com at runtime
- **Status:** Confirmed · **Strength:** E1 (observed blocked request in Phase 0 probes) · **Severity:** Info · **Priority:** P3
- **Impact:** Minor privacy/availability dependency; violates a strict-CSP future state. Self-host fonts.

### ARC-001 — Repository is triple-nested with a broken outer git wrapper
- **Status:** Confirmed · **Strength:** E1 · **Severity:** Low · **Priority:** P3
- **Evidence:** Outer `…(3)/` has a `.git` containing only `info/` (git commands fail), empty `supabase/` skeleton and agent-tool stubs; real repo one level down; a third empty `cre-financial-suite-main/cre-financial-suite-main/` scaffold inside it.
- **Impact:** Tooling/human confusion (this audit initially pointed at the wrapper). Delete cruft, work from the real repo root.

### ARC-002 — Legacy Base44 platform artifacts remain in-tree
- **Status:** Confirmed · **Strength:** E3 · **Severity:** Low · **Priority:** P3
- **Evidence:** `base44/functions/{onLeaseChanged,onExpenseAdded,onBudgetChanged}/entry.ts` using `npm:@base44/sdk@0.8.20`; zero imports from `src/` (grep); one stray `Downloads - Shortcut.lnk` inside.
- **Impact:** Dead code implies unmigrated trigger behavior (lease-expiry notifications, audit hooks) may have been lost in the Base44→Supabase migration — worth confirming intent.

### ARC-003 — Main bundle chunk 637 kB minified (>500 kB warning)
- **Status:** Confirmed · **Strength:** E1 (build output) · **Severity:** Low · **Priority:** P3
- **Impact:** Slower first paint; mitigated by per-route lazy chunks already in place.

### QA-002 — ESLint ignores `src/lib/**` and `src/components/ui/**`
- **Status:** Confirmed · **Strength:** E4 · **Severity:** Low · **Priority:** P2
- **Evidence:** `eslint.config.js` ignore list; `src/lib` contains RBAC/auth-critical code that is thus unlinted.
- **Impact:** "Lint passes" overstates coverage precisely where correctness matters most.

### OPS-004 — Committed environment/config hygiene issues
- **Status:** Confirmed · **Strength:** E4 · **Severity:** Low · **Priority:** P2
- **Evidence:** `.env` committed (localhost values — flagged as F-001 historically); `temp_git_log.txt` (UTF-16 git-log dump) committed; `tmp/` Vertex diagnostic JSON captures; `scratch/` dev throwaways; stale `dist/` present locally (gitignored).
- **Impact:** Noise, confusion, and a bad look in due diligence; `.env` committed at all is a process smell even with non-secret values.

### PRD-001 — Prior self-audit and phase docs contain stale counts and superseded claims
- **Status:** Confirmed · **Strength:** E4 · **Severity:** Info · **Priority:** P3
- **Evidence:** `generate_audit_report.py` says "80+ migrations / 60+ functions / maturity 52 of 100"; actual at frozen commit: 216 migrations, 82 functions. ~70 phase docs in `docs/` describe intermediate states.
- **Impact:** Historical docs must not be quoted as current state (this audit treats them as context only).

### PRD-002 — Marketing claims on the landing page are unverifiable from the repository
- **Status:** Confirmed (text exists) / claims MARKET-VALIDATION-REQUIRED · **Strength:** E1 (rendered) · **Severity:** Info · **Priority:** P2 (legal/brand risk if false)
- **Evidence:** Landing page renders "Trusted by 500+ commercial properties nationwide" (Phase 0 probe).
- **Impact:** If the customer count is aspirational, this is a compliance/credibility exposure in enterprise sales.

### TEN-003 — (Positive) Super-admin tenant resolution hardened after internal audit finding "S2"
- **Status:** Confirmed · **Strength:** E3 · **Severity:** Info (strength, not weakness)
- **Evidence:** [supabase/functions/_shared/supabase.ts:124-209](../../supabase/functions/_shared/supabase.ts#L124-L209) — super-admins must name the tenant via `x-acting-org-id`; non-admins validated against active memberships; multi-org users must choose explicitly.
- **Impact:** Demonstrates a working internal security-review loop; cite in security reviews.

---

*Register is append-only during the audit; later phases add WKF-, DATA-, and module-specific findings with the next sequential IDs. Cross-reference: [risk register](20-risk-register.md) (consolidated risk view), [prioritized action register](prioritized-action-register.md) (remediation sequencing).*

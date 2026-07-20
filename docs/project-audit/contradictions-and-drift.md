# Contradictions & Drift

> Generated: 2026-07-20 · Repository revision: `34563cfaff4271b72d00b0841353dc2792f2f16a` (branch `feature/lease-intelligence-enterprise-p1-p8`) · Part of the [Project Audit](README.md)

Per the **no-silent-repair rule**, inconsistencies found during this audit are preserved here rather than quietly resolved in the narrative documents. Each entry names the apparent canonical form without deleting the alternative.

## Documentation vs. code

| Contradiction | Detail | Apparent canonical form | Finding |
|---|---|---|---|
| Prior self-audit counts vs. current repo | `generate_audit_report.py`/README-adjacent claims "~80+ migrations, ~60+ functions, maturity 52/100" | Current: 216 migrations, 82 functions (this audit's counts, reproducible) | [PRD-001](findings-register.md#prd-001) |
| Historical F-007 "hardcoded fake budget numbers" | Re-verified at frozen commit: fallback computes real heuristic figures, not fake numbers | Current code (`estimateBudget`) is canonical; F-007 is stale | [DATA-001](findings-register.md#data-001) |
| Historical F-012 "hardcoded budget_year 2027" | Re-verified: `budget_year` defaults to `getFullYear()+1` | Current code is canonical; F-012 is stale | [DATA-001](findings-register.md#data-001) |
| README/docs describe Base44 legacy patterns in places | `base44/` functions unreferenced from `src/`; product now runs entirely on Supabase | Supabase is canonical; Base44 code is dead, not deleted | [ARC-002](findings-register.md#arc-002) |

## Frontend–backend contract mismatches

| Contradiction | Detail | Finding |
|---|---|---|
| Client RBAC vs. server permission tables | `rbac.js`'s `ROLE_PAGES` (client) and `member_page_permissions`/`can_write_page` (server) are two independently-maintained sources for "who can see/do what" | [06 §5](06-frontend-backend-integration.md), R15 |
| Undeclared edge functions | 37 of 82 functions absent from `config.toml`, relying on an implicit platform default rather than an explicit contract | [SEC-002](findings-register.md#sec-002) |

## Schema-code mismatches (confirmed drift)

| Contradiction | Detail | Finding |
|---|---|---|
| `audit_logs.user_id` | Exists on the remote database; created by no migration in this repository | [TEN-001](findings-register.md#ten-001) |
| Remote-only permissive policies | `audit_logs_insert_all` and blanket `<table>_all` policies existed on the remote project but not in migration history; both since dropped by corrective migrations | [TEN-001](findings-register.md#ten-001) |

## Naming inconsistencies

| Term | Contradiction | Apparent canonical form |
|---|---|---|
| "Tenant" | The database table `tenants` means CRE lease occupants; "multi-tenant" in this audit (and in SaaS usage generally) means `organizations`. The two senses coexist in the same codebase. | Both are intentional and correct in their own domain — flagged so no future reader conflates them |
| Roles | Canonical 5 roles + `auditor` in `memberships.role`, plus ~14 legacy aliases in `ROLE_ALIASES` (rbac.js), plus a **second** system (`role_definitions`/`user_roles`) | `memberships.role` is the schema comment's stated canonical source ("the ONLY place roles live" — schema.sql:169); the second system's relationship to it is unresolved |
| Upload routes | `PipelineUpload` page coexists with `LeaseUpload` | `LeaseUpload` appears to be the active route (referenced in the e2e spec); `PipelineUpload`'s status is `UNVERIFIED` — possibly a legacy alias |

## Duplicated sources of truth

| Duplication | Detail | Finding |
|---|---|---|
| Role/permission systems | `memberships.role` vs. `role_definitions`/`user_roles` | [08 §7](08-database-schema-and-ui-gap-analysis.md) |
| Plan vs. entitlements | `organizations.plan` (Stripe-tier) vs. `organizations.enabled_modules` (feature gate) — no traced code path links them automatically | modules/billing-subscriptions.md |
| Audit-log actor identity | Legacy `user_email`/`user_name` columns vs. hardened `actor_user_id`/`actor_email` | modules/audit-logging.md |
| Toast libraries | Both `sonner` and `react-hot-toast` present in `package.json` | [01 §6](01-repository-and-system-inventory.md) |
| Date libraries | Both `date-fns` and `moment` present | [06 §5](06-frontend-backend-integration.md) |
| supabase-js versions | `2.99.2` (`_shared/supabase.ts`) vs. `2.39.0` (`stripe-webhook`) across edge functions | [ARC-004](findings-register.md#arc-004) |

## Legacy / unused paths

| Item | Status | Finding |
|---|---|---|
| `base44/functions/*` | Dead — Base44 SDK entirely unreferenced from `src/` | [ARC-002](findings-register.md#arc-002) |
| `store-data`/`validate-data`/`parse-file`/`upload-handler` | Possibly superseded by `ingest-file`; overlap not fully resolved in this pass | `INFERRED`, [06 §4](06-frontend-backend-integration.md) |
| Legacy `localStorage` keys (`app_access_token`, `token`) | Cleared at logout but their original write-path was not traced — likely pre-Supabase-singleton-client vestige | `INFERRED` |
| Triple-nested repository | Outer wrapper (broken `.git`) and innermost empty scaffold both contain a copy of `supabase/` that is empty/stale | [ARC-001](findings-register.md#arc-001) |

## Conflicting configuration

| Item | Detail | Finding |
|---|---|---|
| RLS-enable style | Mix of literal `ALTER TABLE … ENABLE ROW LEVEL SECURITY` and dynamic `DO/EXECUTE format()` loops across migrations — both achieve the same effect but complicate static auditing | [08 §4](08-database-schema-and-ui-gap-analysis.md) |
| `.env.production` | Contains a literal `YOUR_PROJECT_REF.supabase.co` placeholder rather than a real value at the frozen commit | [evidence-index](evidence-index.md) |

## Features represented differently across layers

| Feature | Frontend representation | Backend representation | Note |
|---|---|---|---|
| Budget AI fallback | Renders identically to an AI-generated result (no `source` field) | Distinguishes `estimateBudget` heuristic path internally (`console.warn` only) | [DATA-001](findings-register.md#data-001) — the distinction exists server-side but isn't surfaced |
| Critical-date alerting | UI page + data model exist | No confirmed active producer since the Base44 migration | modules/notifications-critical-dates.md |

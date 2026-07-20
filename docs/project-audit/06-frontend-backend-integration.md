# 06 — Frontend ↔ Backend Integration

> Generated: 2026-07-20 · Repository revision: `34563cfaff4271b72d00b0841353dc2792f2f16a` (branch `feature/lease-intelligence-enterprise-p1-p8`) · Part of the [Project Audit](README.md)

How the SPA and Supabase actually talk. Coverage is representative (71 pages × 82 functions can't be enumerated row-by-row without noise); every claim is labeled. API controls canon → [07](07-api-and-gateway-architecture.md).

## 1. API client organization — `CONFIRMED`

Three client layers, all singleton-based on [src/services/supabaseClient.js](../../src/services/supabaseClient.js):

1. **Entity CRUD:** `src/services/api.js` (1,771 lines) — `createEntityService(name)` resolves table via `ENTITIES` map (`src/types/index.js`), injects `org_id` filters, writes audit entries, caches with TTL, and **falls back to an in-memory seeded store when the client is null** ([WKF-002](findings-register.md#wkf-002)).
2. **Edge RPC:** `src/services/edgeFunctions.js` — `invokeEdgeFunction` (JSON) / `invokeEdgeFunctionFormData` (multipart): refreshes the session first, sends `Authorization: Bearer` + `x-acting-org-id`, normalizes error payloads (`{error,message}` → thrown Error) — [edgeFunctions.js:34-102](../../src/services/edgeFunctions.js#L34-L102).
3. **Domain services:** `leaseService`, `expenseService` (137 KB), `leaseExpenseRuleService` (108 KB), `parsingEngine` (174 KB), `billingEngine`, etc. — compose 1+2 into workflows.

## 2. Cross-cutting integration behaviors

| Concern | State | Evidence | Label |
|---|---|---|---|
| Auth token handling | Session auto-refresh + explicit refresh before every function call; tokens in localStorage | EV-11/12; [SEC-004](findings-register.md#sec-004) | `CONFIRMED` |
| Tenant-context propagation | `x-acting-org-id` header on every edge call; direct reads filtered by `org_id` param + RLS | EV-05/12; `useOrgQuery` | `CONFIRMED` |
| Org-switch cache correctness | React Query keys include `orgId` and scope (`[entity, orgId, scoped/global, filter]`) → org switch naturally re-fetches; **no stale-cache defect found** | [src/hooks/useOrgQuery.js:18-23](../../src/hooks/useOrgQuery.js#L18-L23) | `CONFIRMED` (positive) |
| Shared vs duplicated types | No shared contract package — function payload shapes are implicit; frontend `zod` schemas exist for forms, Deno side validates ad-hoc | [07 §3](07-api-and-gateway-architecture.md) | `CONFIRMED` duplication risk |
| Validation alignment | Heavy client contracts for lease review (`leaseReviewSchema.js` 69 KB, normalizers 73 KB) vs server-side merge/persist functions — alignment maintained by convention + unit tests, not shared code | `src/lib/` | `PARTIAL` |
| Error-code handling | Pipeline family: structured `error_code`/`retryable`; elsewhere `{error,message}` strings surfaced via toasts (sonner + react-hot-toast both present) | EV-17 | `PARTIAL` — two conventions, two toast libs |
| Pagination | No uniform pagination contract; list fetches commonly unbounded with client-side filtering; `limit` option exists in `useOrgQuery` | api.js | `PARTIAL` — scale risk on large portfolios |
| Filtering/sorting/search | Client-side within fetched sets predominantly; no server search endpoint (no FTS index usage found) | grep | `PARTIAL` / search `MISSING` |
| File upload | Multipart to `ingest-file` via raw fetch (formdata path), magic-byte validation server-side | EV-12/20 | `CONFIRMED` |
| Streaming / realtime | No WebSockets/SSE/Supabase Realtime subscriptions found; pipeline progress via **polling** (`useFileStatus`, `pipeline-status`) — prior audit F-009/F-013 flagged polling bugs (historical; current code has `useComputeTrigger`/`useFileStatus` rewrites; re-verification `UNVERIFIED`) | hooks | `CONFIRMED` polling model |
| Optimistic updates | Not systematic; mutations invalidate queries | sampled | `PARTIAL` |
| Retry behavior | React Query defaults; no custom retry/backoff on function calls | query-client.js | `PARTIAL` |
| Loading/empty/error states | `initialData: []` masks loading-vs-empty distinction in org queries; Suspense fallback is a single generic spinner for all 71 lazy pages (historical F-019, still the pattern) | useOrgQuery.js:44 | `PARTIAL` |
| API versioning / compatibility | None (function names are contracts) | [07](07-api-and-gateway-architecture.md) | `MISSING` |

## 3. UI-to-API coverage (representative sample)

| UI screen | User action | Frontend handler | Endpoint | Backend handler | DB entities | Status | Gap |
|---|---|---|---|---|---|---|---|
| LeaseUpload | Upload lease PDF | `EnhancedFileUploader` → `invokeEdgeFunctionFormData` | `ingest-file` | `supabase/functions/ingest-file` | `uploaded_files`, `pipeline_jobs`, storage | `CONFIRMED` (static) | none structural |
| LeaseReview | Edit field w/ citation | FieldReviewRow → `save-lease-review-draft` | fn ⚠undeclared | draft tables | lease draft/claims | `CONFIRMED` (unit-tested) | config.toml gap ([SEC-002](findings-register.md#sec-002)) |
| LeaseReview | Approve | ApprovalBlockers gate → `review-approve` | fn | leases, schedules | `CONFIRMED` | — |
| Expenses | Bulk import | `BulkImportModal` | `bulk-create-expenses` ⚠ | expenses | `CONFIRMED` (static) | idempotency `UNVERIFIED` |
| CAMSetup / CAMCalculation | Save/approve profile, compute | camConfig service | `save-cam-profile`⚠, `approve-cam-profile`⚠, `compute-cam` | cam_* tables | `CONFIRMED` (static) | undeclared fns |
| CreateBudget | AI-generate budget | budget flow | `generate-budget` | budgets | `CONFIRMED` (re-verified fallback, [DATA-001](findings-register.md#data-001)) | silent heuristic fallback unlabeled |
| Billing / Pricing | Subscribe | Stripe JS → `create-checkout-session` | fn → Stripe | organizations/billings | `CONFIRMED` (static) | no portal for change/cancel (W15) |
| UserManagement | Invite user | userManagement components | `invite-user` / `send-invite` | invitations, memberships | `CONFIRMED` (static) | — |
| SuperAdmin | Approve org | AdminControlSurfaces | `approve-organization` | organizations | `CONFIRMED` (static) | — |
| AuditLog | Browse trail | direct entity read | PostgREST `audit_logs` (RLS select_admin) | audit_logs | `CONFIRMED` (static) | dual actor columns ([08](08-database-schema-and-ui-gap-analysis.md) §6) |
| Integrations | Configure integrations | page UI | — | — | **UI-only** | no backend surface (W18) |
| Notifications | View notifications | page + table | producer path unclear | notifications | `PARTIAL` | delivery pipeline `UNVERIFIED` (W13) |

## 4. API-to-UI coverage (functions with no/thin UI consumers)

| Endpoint | Intended consumer | Actual consumer found | Note |
|---|---|---|---|
| `phase52-vertex-diagnostic` | developer diagnostics | none in `src/` | ops tool exposed as function (JWT-gated implicit) — candidate for removal/lockdown |
| `document-intelligence-v3-advisory-audit(-batch)` | review advisory surfaces | ExtractionDebugPanel (partial) | advanced surface ahead of UI ([03](03-module-catalog-and-maturity.md) overengineering note) |
| `backfill-lease-evidence` | one-off migration tool | none | operational backfill as public-ish function |
| `store-data` / `validate-data` / `parse-file` / `upload-handler` | earlier-generation ingestion | superseded by `ingest-file` path (`INFERRED`) | legacy overlap → [contradictions](contradictions-and-drift.md) |
| `extract-document-fields` (**public**) | demo/experience flow (`INFERRED`) | DemoExperience references extraction | unauthenticated cost surface — [07 §2](07-api-and-gateway-architecture.md) |

## 5. Explicit checks

- **UI controls that do nothing:** Integrations page configuration affordances (no backend); no other dead primary buttons found in sampled pages (`PARTIAL` sample).
- **Forms sending incomplete payloads:** none found in samples; lease-review contracts are unusually rigorous.
- **Backend without UI:** table above §4.
- **UI states without backend representation:** acting-org selection (client-only, acceptable); onboarding step also mirrored in DB (good).
- **Hardcoded data:** seed dataset (`seedData.js`, 28 KB) — demo-only by design but reachable in prod misconfig ([WKF-002](findings-register.md#wkf-002)); placeholder UUID in ExtractionDebugPanel input (cosmetic).
- **Mock APIs:** in-memory entity store (same finding).
- **Inconsistent enums:** roles legacy aliases (14) vs canonical 5+auditor ([contradictions](contradictions-and-drift.md)); pipeline stage/status enums consistent (CHECK-constrained).
- **Identifiers:** UUIDs consistently; `x-acting-org-id` validated by regex server-side (EV-05).
- **Dates/timezones:** TIMESTAMPTZ + org timezone; both `date-fns` and `moment` in the bundle (duplication, minor).
- **Nullability mismatches:** `initialData: []` hides null/loading distinction (§2).
- **Pagination mismatches:** unbounded lists (§2).
- **UI authorization assumptions:** RBAC page-gating is client-side; server enforces separately via `assertPageAccess` RPCs — the models are parallel but **not generated from a single source** → drift risk between `ROLE_PAGES` (rbac.js) and `member_page_permissions`/`can_write_page` (DB). `CONFIRMED` structural risk, no concrete divergence proven (`UNVERIFIED`).
- **Sensitive over-exposure:** direct PostgREST access means any RLS-readable column is fetchable; no field-level redaction layer. No concrete leak identified (`UNVERIFIED`), but audit_logs' `ip_address`/emails are org-admin-readable by policy design.

Related: [05 — Workflows](05-end-to-end-workflows.md) · [07 — API](07-api-and-gateway-architecture.md) · [08 — Database](08-database-schema-and-ui-gap-analysis.md)

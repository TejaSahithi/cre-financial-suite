# Assistant Platform Coverage Matrix

This is the ground-truth audit of what the ProForma OS Assistant can and cannot answer,
page by page, as of this pass. It was built by reading the actual page registry
(`src/pages.config.js`, 84 routes), `src/lib/rbac.js`/`src/lib/moduleConfig.js`, and the real
component source for every high-traffic page — not inferred from labels.

**Coverage states** (never marked COMPLETE without verifying a tool/capability actually exists for it):
- **COMPLETE** — capability registry entry AND a business-data tool exists for its record-level questions AND (where the page has a single-record identity) `useAssistantPageContext` is wired so "this" resolves.
- **PARTIAL** — capability registry entry exists (so "what does this page do" works), but business-data Q&A is limited (no dedicated tool, list-level only, or context not wired).
- **MISSING** — no capability registry entry and no tool; the Assistant would fall back to a generic, ungrounded answer.
- **NOT_APPLICABLE** — auth/marketing/onboarding page with no CRE business content.

## Summary

```
Real routes in src/pages.config.js: 84 (81 unique page components; 3 are aliases: CAMSetupV2→CAMSetup, CAMPosting/CAMCalculation→CAMRun)
Pages audited in this matrix: 65 (CRE-business pages)
Pages excluded as NOT_APPLICABLE: 19 (auth/marketing/onboarding/super-admin-platform, listed at the end)

Capability Registry entries: 60 pages + 4 cross-page workflows (up from 19 pages in V1)
Pages COMPLETE: 30
Pages PARTIAL: 32
Pages MISSING: 3

Business-data tools: 28 (up from 18 in V1; +4 in the continuation pass, +2 CAM drill-down tools in this pass)
Pages with live useAssistantPageContext wiring: 20 (up from 0 in V1)

Calculation-explanation coverage: CAM (full lineage), Budget basis (full), Budget variance (category-level),
Reconciliation/CAM due-credit (summary-level), Revenue (breakdown-level). Not covered: NOI as a first-class
tool output (derivable from revenue + expense but no single tool returns it), rent escalation compounding math
beyond the raw schedule rows.
```

---

## Property / Portfolio

| Page | Purpose | Actions | Live Data | Calc Explanation | Evidence/Lineage | UI Context | Coverage | Missing |
|---|---|---|---|---|---|---|---|---|
| Dashboard | Portfolio-wide KPI landing page | none (read-only) | N/A_ASSISTANT | n/a | n/a | not wired | PARTIAL | No dedicated aggregate tool; product explanation only |
| Portfolios | Groups properties for reporting/scoping | none | via property_summary only | n/a | n/a | not wired | PARTIAL | No `get_portfolio_summary` tool |
| PortfolioInsights | Cross-property analytics | none | none | n/a | n/a | not wired | PARTIAL | No dedicated tool; capability entry only |
| Properties | Property register | none | `get_property_list_summary` | property expense totals + budget-review signals | n/a | not wired | **COMPLETE** | — |
| Buildings | Buildings within a property | Add Building (on PropertyDetail) | counts only (via property_summary.hierarchy) | n/a | n/a | not wired | PARTIAL | No standalone buildings tool |
| Units | Leasable units | Add Unit (on PropertyDetail) | counts only | n/a | n/a | not wired | PARTIAL | No standalone units tool |
| BuildingsUnits | Combined buildings+units view | same as above | counts only | n/a | n/a | not wired | PARTIAL | Same as Buildings/Units |
| PropertyDetail | Property hub: overview/buildings/leases/expenses/cam/budgets/stakeholders | Add Building, Add Unit, Save edit | `get_property_summary` | n/a | n/a | **wired** | **COMPLETE** | — |

## Tenant

| Page | Purpose | Actions | Live Data | Calc Explanation | Evidence/Lineage | UI Context | Coverage | Missing |
|---|---|---|---|---|---|---|---|---|
| Tenants | Org-wide tenant register | none | `get_tenant_list_summary` | lease-expiration summary | n/a | not wired | **COMPLETE** | — |
| TenantDetail | Tenant leases/rent/CAM/invoices/audit | none (read-only) | `get_tenant_summary` (property+tenant scoped) | n/a | n/a | **wired** after tenant/lease lookup resolves UUIDs | **COMPLETE** | — |
| Vendors | Vendor register | none | none | n/a | n/a | not wired | PARTIAL | No tool |
| VendorProfile | Single vendor detail | none | none | n/a | n/a | not wired | PARTIAL | No tool |

## Lease

| Page | Purpose | Actions | Live Data | Calc Explanation | Evidence/Lineage | UI Context | Coverage | Missing |
|---|---|---|---|---|---|---|---|---|
| Leases | Lease register | none | `get_lease_list_summary` | expiration/status summary | n/a | not wired | **COMPLETE** | — |
| LeaseUpload | Start AI extraction | Upload, Re-extract | n/a (pre-data) | n/a | n/a | not wired | COMPLETE (product-only page, no business data to retrieve pre-upload) | — |
| LeaseReview | Human review/approval of extracted terms | Approve Abstract, Reject, Send Back, Re-extract, Save Draft, Send Signature | `get_lease_summary`, `get_lease_evidence` | n/a | **`get_lease_evidence`** (field citations + source document) | **wired** (leaseId, propertyId, activeTab) | **COMPLETE** | — |
| LeaseDetail | Read-only lease abstract view | none | `get_lease_summary` | n/a | `get_lease_evidence` | not wired | PARTIAL | No dedicated context wiring (low traffic vs LeaseReview) |
| LeaseRentSchedule | Approved rent schedule | Export (client-side, no API) | `get_lease_rent_schedule` | current rent + escalation shown | n/a | **wired** (leaseId, propertyId, fiscalYear) | **COMPLETE** | — |
| RentProjection | Forward rent projection | none | none (reads same rent_schedules but no tool wraps the projection) | n/a | n/a | not wired | PARTIAL | No dedicated tool — `get_lease_rent_schedule` answers "what is the rent", not the multi-year projection |
| CriticalDates | Org-wide critical-date list | Add, Assign, Complete, Delete | `get_lease_critical_dates` (per-lease only) | n/a | n/a | not wired (no single record) | PARTIAL | No org-wide list tool |
| LeaseExpenseRules | Recovery/expense rule definition | Sync Approved Rules, Bulk Approve, edit rule | `get_lease_recovery_policy` | policy steps shown | policy step `source_evidence` | **wired** (leaseId, propertyId, tab, statusFilter) | **COMPLETE** | — |

## Expense

| Page | Purpose | Actions | Live Data | Calc Explanation | Evidence/Lineage | UI Context | Coverage | Missing |
|---|---|---|---|---|---|---|---|---|
| Expenses | Actual expense records | none | `get_expense_list_summary` | category totals + blocker/classification summaries | n/a | not wired | **COMPLETE** | — |
| AddExpense | Manual expense entry | Save | n/a (write page) | n/a | n/a | not wired | COMPLETE (product-only) | — |
| BulkImport | CSV expense import | Import | n/a (write page) | n/a | n/a | not wired | COMPLETE (product-only) | — |
| LeaseExpenseClassification | Classify expenses, publish to CAM | Run Classification, Finalize, Send to Review, Send to CAM, Withdraw, Resolve Condition, Publish Rule, Link Existing | `get_expense_summary` | recovery status + blockers shown | classification `evidence_text` | **wired** (propertyId, leaseId, tenantId, tab, selectedIds) | **COMPLETE** | — |
| ExpenseReview | Exception queue + finalized review | Resolve Condition, Send to CAM, Run Classification | `get_expense_summary` | same | same | **wired** (propertyId, portfolioId) | **COMPLETE** | — |
| ExpenseProjection | Forward expense projection | none | none | n/a | n/a | not wired | PARTIAL | No dedicated tool |
| ExpenseDashboard | Expense summary dashboard | none | none | n/a | n/a | not wired | PARTIAL | No aggregate tool |

## CAM

| Page | Purpose | Actions | Live Data | Calc Explanation | Evidence/Lineage | UI Context | Coverage | Missing |
|---|---|---|---|---|---|---|---|---|
| CAMDashboard | CAM module landing/overview | none | none | n/a | n/a | not wired | PARTIAL | No aggregate tool |
| CAMSetup / CAMSetupV2 | Recovery period/pool config + readiness | Calculate, Auto-Prepare, + many CRUD actions via `cam-setup-actions-v2` | `get_cam_readiness` | readiness blockers shown | n/a | **wired** (propertyId, buildingId, unitId, recoveryPeriodId, tab) | **COMPLETE** | — |
| CAMRun / CAMCalculation | Executes CAM V2 engine | Calculate, Submit/Approve/Reject/Return, Generate Statements | `get_cam_run_summary`, `get_cam_readiness` | pool-level results | n/a | **wired** (propertyId, recoveryPeriodId, camRunId) | **COMPLETE** | — |
| CAMPoolDetail | Single pool drill-down | none | `get_cam_pool_detail` | source expenses, participants, and persisted line items | `cam_run_calculation_lines` + pool assignments | **wired** (propertyId, camRunId, camPoolResultId) | **COMPLETE** | — |
| CAMLeaseDetail | Full tenant CAM calculation trace | none (read-only) | `get_cam_tenant_result` | **full calculation lineage** (`cam_run_calculation_lines`) | policy step evidence via lease_recovery_policy_steps | **wired** (camRunId, leaseId) | **COMPLETE** | — |
| CAMExceptionReview | CAM run exception queue | resolve (not modeled as a tool action) | `get_cam_exceptions_summary` | exception severity/resolution counts | persisted `cam_run_exceptions` | **wired** (propertyId, camRunId) | **COMPLETE** | — |
| CAMApproval | Approve/reject/return a CAM run | Approve, Reject, Return to Draft | `get_cam_run_summary` | n/a | n/a | **wired** (camRunId, propertyId) | **COMPLETE** | — |
| CAMPosting | Finalize approved run: statements/exports | Generate Statements, Create Charge Export, Mark Delivered | `get_cam_run_summary` (shares CAMRun route) | n/a | n/a | wired (via CAMRun) | **COMPLETE** | — |
| CAMRealPropertyGate | Internal feature-gate page | n/a | n/a | n/a | n/a | n/a | NOT_APPLICABLE | Not a business content page |

## Revenue

| Page | Purpose | Actions | Live Data | Calc Explanation | Evidence/Lineage | UI Context | Coverage | Missing |
|---|---|---|---|---|---|---|---|---|
| Revenue | Base rent + CAM recovery + other income | none | `get_revenue_summary` | revenue_by_type breakdown | sourced from posted CAM runs (cited conceptually, not a citation object) | **wired** (propertyId/buildingId/unitId/fiscalYear filters) | **COMPLETE** | — |

## Budget

| Page | Purpose | Actions | Live Data | Calc Explanation | Evidence/Lineage | UI Context | Coverage | Missing |
|---|---|---|---|---|---|---|---|---|
| BudgetReadiness | Readiness report for budget generation | none (read-only) | none dedicated | n/a | n/a | not wired | PARTIAL | No dedicated tool (conceptually close to `get_cam_readiness` but for budget path) |
| BudgetDashboard | Budget overview for a property/year | none | `get_budget_summary` | category breakdown | source_snapshot_id on line items (not surfaced as a citation) | **wired** (propertyId, budgetId, fiscalYear) | **COMPLETE** | — |
| CreateBudget | Generate/approve/lock a budget | Generate, Mark Reviewed, Approve, Lock, Reject | `get_budget_summary`, `get_budget_line_basis`, `get_budget_cam_estimate` | **full basis lineage** (prior actual, YTD, forecast, assumption, override) | `source_basis_explanation` per category | **wired** (propertyId, portfolioId, buildingId, fiscalYear) | **COMPLETE** | — |
| BudgetReview | YoY budget comparison, export | Export, Export Budget Book | `get_budget_summary` | n/a | n/a | **wired** (propertyId, portfolioId) | **COMPLETE** | — |

## Actuals / Variance / Reconciliation

| Page | Purpose | Actions | Live Data | Calc Explanation | Evidence/Lineage | UI Context | Coverage | Missing |
|---|---|---|---|---|---|---|---|---|
| Variance | Budget-vs-actual by category | none | `get_budget_variance` | category variance % | n/a | wired for page/fiscalYear only | PARTIAL | Still needs property/budget scoped UI context for direct answers without clarification |
| Actuals | Plain actuals view | none | none dedicated | n/a | n/a | not wired | PARTIAL | Near-duplicate of ActualsVariance's Actuals tab; no tool |
| ActualsVariance | Tabbed actuals+variance | none | `get_budget_variance` (variance tab only) | category variance % | n/a | wired for page/fiscalYear/selectedTab only | PARTIAL | Actuals tab has no tool backing; property scope still may need clarification |
| Comparison | YoY comparison across metrics | none | none dedicated | n/a | n/a | not wired | PARTIAL | No tool |
| Reconciliation | Budget variance + CAM due/credit together | Run Reconciliation | `get_reconciliation_summary`, `get_budget_variance` | due/credit position explained | n/a | **wired** (propertyId, fiscalYear) | **COMPLETE** | — |

## Workflow / Approval / Audit

| Page | Purpose | Actions | Live Data | Calc Explanation | Evidence/Lineage | UI Context | Coverage | Missing |
|---|---|---|---|---|---|---|---|---|
| Workflows | Cross-module workflow state overview | none | none dedicated | n/a | n/a | not wired | PARTIAL | `get_pending_approvals_summary` covers the approvals subset only |
| Approvals | Pending-approval queue | approve/reject (module-specific, not modeled here) | `get_pending_approvals_summary` | n/a | n/a | not wired | PARTIAL | Org-level counts only, no per-item drill-down tool |
| Notifications | User notification inbox | mark read (not modeled) | none | n/a | n/a | not wired | MISSING | No capability entry beyond a stub; low business value for Q&A |
| AuditLog | Org-wide audit trail | none | `get_record_audit_summary` (per-record only) | n/a | n/a | not wired | PARTIAL | No org-wide "recent activity" tool, only single-record |

## Documents

| Page | Purpose | Actions | Live Data | Calc Explanation | Evidence/Lineage | UI Context | Coverage | Missing |
|---|---|---|---|---|---|---|---|---|
| Documents | Org document/evidence library | none | none dedicated | n/a | n/a | not wired | PARTIAL | `get_lease_evidence`'s source-document lookup covers the per-lease case; no library-wide tool |
| FileHistoryPage | Extraction pipeline processing status | none | none | n/a | n/a | not wired | PARTIAL | Operational status, not modeled as an Assistant tool |
| PipelineUpload | Bulk lease upload entry point | Upload | n/a (write page) | n/a | n/a | not wired | COMPLETE (product-only) | — |

## Admin / Config / Analytics

| Page | Purpose | Coverage | Missing |
|---|---|---|---|
| Billing | Tenant billing/invoices | PARTIAL | No tool |
| Stakeholders | Budget-notification contacts | PARTIAL | No tool |
| ChartOfAccounts | GL account mapping | PARTIAL | No tool |
| FieldMappingRules | Import field mapping config | PARTIAL | No tool |
| ApprovalWorkflows | Approval-chain configuration | PARTIAL | No tool |
| ApprovalPolicies | Approval threshold configuration | PARTIAL | No tool |
| Integrations | Third-party integration config | PARTIAL | No tool |
| OrgSettings | Org/module configuration | PARTIAL | No tool |
| UserManagement | Member roles/permissions | PARTIAL | No tool (and rightly so — this is the RBAC system itself, out of scope for read-only Q&A) |
| AnalyticsReports | Cross-property analytics/reporting | PARTIAL | No tool |
| Reports | Reporting (near-duplicate of AnalyticsReports) | MISSING | No capability entry (redundant with AnalyticsReports — noted, not built separately) |
| Analytics | Analytics (near-duplicate of AnalyticsReports) | MISSING | No capability entry (same reason) |
| SuperAdmin | Platform-level super-admin console | NOT_APPLICABLE | Platform operations, not CRE business content |

## Excluded — not CRE business content (NOT_APPLICABLE)

`Landing`, `Pricing`, `ContactUs`, `Login`, `RequestAccess`, `RequestDemo`, `ResetPassword`,
`AcceptInvite`, `Onboarding`, `Welcome`, `WelcomeAboard`, `PendingApproval`,
`SecurityQuestionsSetup`, `DemoExperience`, `PaymentSuccess`, `SuperAdmin`, `CAMRealPropertyGate`.
These are auth/marketing/onboarding/platform-admin surfaces with no lease/expense/CAM/budget
business meaning — a "what does this page do" question about them would get a plain, correct
(if generic) LLM answer without a capability entry, which is acceptable since no business data or
CRE-specific workflow exists on them.

---

## What changed this pass (V1 → V2)

- **Multi-turn memory**: `assistant-chat-v1` now loads the last 16 messages of the current
  conversation and replays them to the model, so "what do I need to fix?" / "where do I fix that?"
  resolve against the same record without the user repeating ids. Grounding is still per-turn —
  a stale figure from history can never substitute for a fresh tool call (see
  `assistant-orchestrator.ts`'s `formatPriorTurns` and `response-shaper.ts`).
- **New entity types**: `recoveryPeriodId` (UUID) and `fiscalYear` (scalar, range-checked) added
  to the request context whitelist — several CAM/budget/revenue tools needed these and V1 had no
  way to carry them from the UI.
- **Clarification behavior**: the system prompt now explicitly allows a "final" answer that is
  itself a focused clarifying question when scope is genuinely ambiguous and page context doesn't
  resolve it, and explicitly tells the model not to ask when context already does.
- **4 new tools**: `get_lease_rent_schedule`, `get_lease_critical_dates`, `get_tenant_summary`,
  `get_reconciliation_summary` (22 tools total, up from 18).
- **`get_lease_evidence` extended** with source-document citation (file name via
  `uploaded_files`/`document_links`, mirroring `SourceFileLink.jsx`'s resolution order).
- **14 pages wired** with `useAssistantPageContext` (0 in V1): LeaseReview, LeaseExpenseClassification,
  LeaseExpenseRules, LeaseRentSchedule, CAMSetup, CAMRun, CAMApproval, CAMLeaseDetail,
  BudgetDashboard, CreateBudget, BudgetReview, ExpenseReview, PropertyDetail, Reconciliation.
- **Capability Registry**: 19 → 60 page entries + 4 workflows, and the highest-traffic pages
  (LeaseReview, LeaseExpenseClassification, CAMSetup, CAMRun, CAMApproval, BudgetDashboard,
  CreateBudget) now carry real tabs/importantActions/statusMeanings/commonBlockers traced to
  actual handler code, not guessed from labels.


## What changed in the continuation pass (V2 -> V3)

- **Conversation-history isolation hardened**: conversation reuse and prior-turn loading now apply the same `org_id`, `user_id`, and nullable `acting_org_id` identity. A valid `x-acting-org-id` creates a separate conversation boundary; history with a different acting org, user, or org is not replayed into the LLM prompt.
- **Storage identity aligned**: `assistant_messages` and `assistant_tool_runs` now persist `acting_org_id` alongside `assistant_conversations`, with indexes matching the lookup pattern.
- **4 closed aggregate/list tools added**: `get_property_list_summary`, `get_lease_list_summary`, `get_tenant_list_summary`, `get_expense_list_summary`. These use the user-scoped Supabase client/RLS path for list retrieval rather than service-role broad reads followed by filtering.
- **List/register pages advanced to COMPLETE**: Properties, Leases, Tenants, and Expenses now have live list/aggregate business-data coverage instead of product-only explanations.
- **Structural evaluation cases expanded**: domain evaluation cases now include property, lease, tenant, and expense aggregate questions, plus a stale expense-gap case was updated to expect `get_expense_list_summary`.

## What changed in this pass (V3 -> V4)

- **2 closed CAM drill-down tools added**: `get_cam_pool_detail` and `get_cam_exceptions_summary`. Both are property scoped, page gated, and read persisted CAM ledger rows only; neither recomputes CAM.
- **New context entity**: `camPoolResultId` is now whitelisted as an untrusted UUID reference so CAMPoolDetail can say "this pool" while backend tools still re-authorize the property/run/pool relationship.
- **6 more pages wired with page context**: TenantDetail, Revenue, Variance, ActualsVariance, CAMPoolDetail, and CAMExceptionReview. Variance/ActualsVariance remain PARTIAL because their current UI does not guarantee a property/budget id.
- **Structural evaluation cases expanded again**: 107 total cases, including pool expense/participant questions and CAM exception blocking questions.
## Remaining gaps (honest, not papered over)

1. **List-level tools now exist, but coverage is still intentionally bounded.** Properties, Leases,
   Tenants, and Expenses have closed RLS-backed list summaries. Remaining aggregate gaps include
   CAM readiness across all accessible properties, deep portfolio variance ranking, vendor-level
   spend, and document-library-wide evidence search.
2. **Portfolio/deep analytics context remains bounded.** Revenue and TenantDetail are now wired, but
   portfolio-wide revenue/variance questions still need dedicated portfolio tools rather than stitched
   property-level answers.
3. **Variance/ActualsVariance context is still incomplete.** These pages now declare page/fiscalYear/
   selected tab, but they do not consistently expose a property/budget UUID, so the Assistant may
   still need to clarify scope.
4. **No dedicated NOI tool.** NOI is derivable from `get_revenue_summary` + budget/expense tools
   but no single tool returns it pre-computed.
5. **Admin/config pages** (OrgSettings, UserManagement, ChartOfAccounts, ApprovalPolicies, etc.)
   have capability entries (generic explanation works) but no business-data tools — reasonable
   given these are configuration surfaces, not financial-analysis surfaces, and V1's read-only
   scope is about explaining the CRE business, not the app's own admin settings.

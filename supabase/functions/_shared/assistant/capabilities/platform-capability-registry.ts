// @ts-nocheck
/**
 * platform-capability-registry.ts — machine-readable product knowledge
 * (section 17). Grounded in the REAL page set from src/lib/moduleConfig.js
 * and src/lib/rbac.js (ROLE_PAGES) — every `page` key below is a real page
 * name used by those files, not an invented one. This is how the Assistant
 * answers "what does this page do?" WITHOUT retrieving any customer data or
 * reading JSX at runtime.
 *
 * Only capabilities with real, shipped behavior are documented here — no
 * aspirational/planned features.
 */

export interface PlatformCapabilityAction {
  action: string;
  businessMeaning: string;
  prerequisites?: string[];
  blockingConditions?: string[];
  downstreamEffects?: string[];
}

export interface PlatformCapability {
  id: string;
  module: string;
  page: string;
  label: string;
  purpose: string;
  description: string;
  prerequisites?: string[];
  downstreamEffects?: string[];
  relatedPages?: string[];
  /** Real tabs/sections on the page, confirmed against the component source
   * (not guessed from the label) — populated for the highest-traffic pages
   * audited in docs/assistant-platform-coverage.md; absent elsewhere means
   * "not yet audited to that depth", not "has no tabs". */
  tabs?: string[];
  /** Business-significant buttons/actions, traced to their actual handler
   * (service call / edge function) — see docs/assistant-platform-coverage.md
   * for the audit trail. */
  importantActions?: PlatformCapabilityAction[];
  /** Real status/enum values a record on this page can have, with plain-language meaning. */
  statusMeanings?: Record<string, string>;
  commonBlockers?: string[];
  /** Which role/page-permission is typically required, for the Assistant's own understanding — not a security control (assertPageAccess is). */
  permissionContext?: string;
  /** "product" = safe to describe to any authenticated user regardless of
   * page access; "business_data" capabilities never bypass page auth. */
  sensitivity: "product" | "business_data";
}

export const PLATFORM_CAPABILITIES: PlatformCapability[] = [
  {
    id: "dashboard",
    module: "dashboard",
    page: "Dashboard",
    label: "Dashboard",
    purpose: "Portfolio-wide landing page summarizing key metrics across properties.",
    description: "Shows high-level KPIs (occupancy, revenue, expense, budget status) across the organization's properties so a user can spot what needs attention without visiting each module.",
    relatedPages: ["Portfolios", "Properties", "AnalyticsReports"],
    sensitivity: "product",
  },
  {
    id: "portfolios",
    module: "portfolio",
    page: "Portfolios",
    label: "Portfolios",
    purpose: "Groups properties into portfolios for reporting and access scoping.",
    description: "A portfolio is a collection of properties. Portfolio-level access grants can be assigned to users so they see only the properties in portfolios they're authorized for.",
    relatedPages: ["Properties", "PortfolioInsights"],
    sensitivity: "product",
  },
  {
    id: "properties",
    module: "properties",
    page: "Properties",
    label: "Properties",
    purpose: "Core property records — the root entity most other modules (leases, expenses, CAM, budgets) hang off of.",
    description: "Lists and manages properties, each with buildings, units, tenants, and leases underneath it. Most Assistant business-data questions resolve to a specific property.",
    relatedPages: ["Buildings", "Units", "Tenants", "Leases"],
    sensitivity: "product",
  },
  {
    id: "leases",
    module: "leases",
    page: "Leases",
    label: "Leases",
    purpose: "Lease register for a property — commercial lease agreements with tenants.",
    description: "Each lease captures the tenant, term dates, base rent, and (after extraction/review) the approved recovery/expense rules that drive CAM and budget calculations.",
    relatedPages: ["LeaseUpload", "LeaseReview", "LeaseRentSchedule", "CriticalDates", "LeaseExpenseRules"],
    sensitivity: "product",
  },
  {
    id: "lease_upload",
    module: "leases",
    page: "LeaseUpload",
    label: "Lease Upload",
    purpose: "Upload a lease document (PDF) to start AI-assisted extraction.",
    description: "Uploaded documents go through Azure Document Intelligence + an LLM extraction pipeline that proposes lease dates, rent terms, and expense/recovery rules for a human reviewer to confirm.",
    downstreamEffects: ["Creates a draft lease abstract awaiting review in LeaseReview."],
    relatedPages: ["LeaseReview"],
    sensitivity: "product",
  },
  {
    id: "lease_review",
    module: "leases",
    page: "LeaseReview",
    label: "Lease Review",
    purpose: "Human review/approval of AI-extracted lease terms before they become the canonical contractual record.",
    description: "A reviewer confirms or edits extracted fields (dates, rent, recovery rules) with citations back to the source document. Approving here freezes an approved abstract snapshot — the contractual source of truth used everywhere else (CAM, budget, revenue).",
    prerequisites: ["A lease document uploaded via LeaseUpload."],
    downstreamEffects: ["Approved fields become the canonical lease abstract used by expense classification, CAM, and budget."],
    relatedPages: ["LeaseUpload", "LeaseExpenseRules", "LeaseRentSchedule"],
    tabs: ["summary", "parties_premises", "dates_term", "rent_charges", "expenses_recoveries", "cam_rules", "taxes", "insurance", "utilities", "repairs_maintenance", "legal_options", "critical_dates", "notices", "signatures", "documents_exhibits", "clause_records", "material_terms", "budget_preview", "extraction_debug", "extraction_timeline"],
    importantActions: [
      { action: "Approve Abstract", businessMeaning: "Freezes the current field values as the canonical, approved lease abstract.", prerequisites: ["Required fields reviewed"], downstreamEffects: ["Downstream expense classification, CAM, and budget tools now treat this lease's terms as canonical."] },
      { action: "Reject Document", businessMeaning: "Marks the uploaded document as rejected — no abstract is produced from it." },
      { action: "Send Back for Re-extraction", businessMeaning: "Sends the lease back into the extraction pipeline for another AI pass." },
      { action: "Re-extract Lease", businessMeaning: "Forces the extraction pipeline to re-run against the source document." },
      { action: "Save Draft", businessMeaning: "Persists in-progress field edits without approving." },
    ],
    statusMeanings: { draft: "AI-extracted, not yet reviewed", extracted: "extraction complete, awaiting human review", approved: "canonical, used by downstream modules", rejected: "document rejected, no abstract produced" },
    permissionContext: "LeaseReview page access (most non-viewer roles)",
    sensitivity: "product",
  },
  {
    id: "lease_detail",
    module: "leases",
    page: "LeaseDetail",
    label: "Lease Detail",
    purpose: "General-purpose lease abstract/terms read view, distinct from CAMLeaseDetail (which is the CAM-engine run result for a lease).",
    description: "Read view of a lease's approved terms — the non-editing counterpart to LeaseReview.",
    relatedPages: ["LeaseReview", "Leases"],
    sensitivity: "product",
  },
  {
    id: "lease_expense_rules",
    module: "expenses",
    page: "LeaseExpenseRules",
    label: "Lease Expense Rules",
    purpose: "Defines each lease's recoverable-expense rules (caps, exclusions, base year, gross-up, admin fee, tenant vs. landlord responsibility).",
    description: "Once approved, a rule set is materialized into an effective-dated recovery policy that Expense Classification and CAM calculations apply automatically.",
    downstreamEffects: ["Drives automatic expense classification and CAM recovery calculations for the lease."],
    relatedPages: ["LeaseExpenseClassification", "CAMSetup"],
    sensitivity: "product",
  },
  {
    id: "expenses",
    module: "expenses",
    page: "Expenses",
    label: "Expenses",
    purpose: "Actual operating expense records for a property (manual entry or bulk import).",
    description: "Each expense is later classified against the applicable lease recovery rules to determine recoverability, then optionally published (\"sent to CAM\") for inclusion in CAM calculations.",
    relatedPages: ["AddExpense", "BulkImport", "LeaseExpenseClassification"],
    sensitivity: "product",
  },
  {
    id: "lease_expense_classification",
    module: "expenses",
    page: "LeaseExpenseClassification",
    label: "Expense Classification",
    purpose: "Classifies each actual expense as recoverable, non-recoverable, or conditional against the applicable lease recovery rules, then publishes it for CAM.",
    description: "Applies each lease's materialized recovery policy to an actual expense, records the recovery status/reason and supporting evidence, and — once approved — marks the expense \"sent to CAM\" so it feeds CAM calculations. An expense can be blocked from publication if required data (dates, lease linkage, rule coverage) is missing.",
    prerequisites: ["An approved lease with expense/recovery rules.", "An actual expense record."],
    downstreamEffects: ["Approved + published expenses become eligible CAM inputs."],
    relatedPages: ["Expenses", "LeaseExpenseRules", "CAMSetup"],
    importantActions: [
      { action: "Run Classification", businessMeaning: "Applies the lease's recovery policy to an unclassified expense automatically.", prerequisites: ["Approved lease recovery policy"] },
      { action: "Finalize", businessMeaning: "Marks the classification decision as final/approved." },
      { action: "Send to Review", businessMeaning: "Routes the classification to a reviewer instead of finalizing directly." },
      { action: "Send to CAM", businessMeaning: "Publishes the finalized, classified expense as a CAM input (cam_expense_inputs, publication_status='published').", prerequisites: ["Classification finalized"], downstreamEffects: ["Expense becomes eligible for CAM Setup pool assignment and CAM runs."] },
      { action: "Withdraw from CAM", businessMeaning: "Un-publishes a previously sent-to-CAM expense." },
      { action: "Resolve Condition", businessMeaning: "Records a decision for an expense flagged as conditionally recoverable." },
      { action: "Publish Rule", businessMeaning: "Publishes the underlying recovery rule to CAM Setup." },
      { action: "Link Existing Expense", businessMeaning: "Associates an existing expense record with this lease/rule instead of creating a new one." },
    ],
    statusMeanings: { needs_review: "classification pending or flagged for human review", approved: "classification finalized", draft: "not yet finalized" },
    commonBlockers: ["No approved lease recovery policy to apply.", "Classification not yet approved.", "Missing lease linkage.", "Missing expense date."],
    permissionContext: "LeaseExpenseClassification / Expenses page access",
    sensitivity: "product",
  },
  {
    id: "cam_setup",
    module: "cam",
    page: "CAMSetup",
    label: "CAM Setup",
    purpose: "Configures recovery periods and recovery pools for a property before running CAM, and reports readiness (what's blocking a run).",
    description: "A recovery pool groups expense categories that recover together; a recovery period is the billing window. Readiness checks confirm published expenses, materialized policies, and pool configuration are complete before a CAM run can proceed.",
    prerequisites: ["Published, classified expenses.", "Materialized lease recovery policies."],
    downstreamEffects: ["Unblocks CAMRun once readiness passes."],
    relatedPages: ["CAMDashboard", "CAMRun"],
    tabs: ["expenses", "policies", "pools", "parameters", "calculate", "results", "variance", "reconciliation (workbench view)", "Recovery Period / Pools / Participants / Policies / Expenses / Estimates & Adjustments / Readiness (advanced 7-step wizard, view=advanced)"],
    importantActions: [
      { action: "Calculate", businessMeaning: "Runs the CAM V2 engine for the configured property/period.", downstreamEffects: ["Produces a draft CAM run visible in CAM Run."] },
      { action: "Auto-Prepare CAM", businessMeaning: "Automatically assigns published expense inputs to pools and resolves obvious setup gaps." },
    ],
    permissionContext: "CAMSetup page access",
    sensitivity: "product",
  },
  {
    id: "cam_run",
    module: "cam",
    page: "CAMRun",
    label: "CAM Run",
    purpose: "Executes the authoritative CAM V2 calculation engine for a property/period and produces per-tenant recovery results.",
    description: "Applies each tenant's recovery policy (pro-rata share, caps, exclusions, gross-up, admin fee, base year) to the pool's actual expenses, producing an immutable, line-by-line calculation ledger per tenant. This is the single authoritative source for CAM amounts — the Assistant explains these results, it never recalculates them.",
    prerequisites: ["CAM Setup readiness passing."],
    downstreamEffects: ["Produces draft results that move through CAMApproval, then CAMPosting."],
    relatedPages: ["CAMLeaseDetail", "CAMApproval", "CAMPosting"],
    tabs: ["summary", "pools", "leases", "exceptions", "approval", "statements", "lineage"],
    importantActions: [
      { action: "Calculate", businessMeaning: "Executes the CAM engine for the selected property/recovery period." },
      { action: "Submit for Review", businessMeaning: "Moves a calculated run into the approval workflow." },
      { action: "Approve Run / Reject Run / Return to Draft", businessMeaning: "Advances or reverses the run's approval state." },
      { action: "Generate Statements", businessMeaning: "Produces tenant-facing recovery statements from a run.", prerequisites: ["Run approved"] },
    ],
    statusMeanings: { draft: "not yet ready", readiness_failed: "blocked by a setup gap", ready: "ready to calculate", calculating: "engine running", calculated: "results produced, not yet reviewed", under_review: "awaiting approval decision", submitted: "submitted for approval", approved: "approved, not yet posted", posted: "final, immutable except a superseding run", superseded: "replaced by a correction run", voided: "cancelled" },
    permissionContext: "CAMRun page access",
    sensitivity: "product",
  },
  {
    id: "cam_approval",
    module: "cam",
    page: "CAMApproval",
    label: "CAM Approval",
    purpose: "Reviews and approves a completed CAM run's results before posting.",
    description: "A run moves calculated -> under_review -> submitted -> approved. Only approved runs can be posted (which finalizes/statements them). Posted runs are immutable except for a superseding correction run.",
    prerequisites: ["A calculated CAM run from CAMRun."],
    downstreamEffects: ["Approval unlocks CAMPosting; posting finalizes tenant recovery statements."],
    relatedPages: ["CAMRun", "CAMPosting"],
    importantActions: [
      { action: "Approve", businessMeaning: "Approves the run; server-side hard-blocks approval while any blocking exception is open." },
      { action: "Reject / Return to Draft", businessMeaning: "Sends the run back for rework, with a required reason." },
    ],
    commonBlockers: ["Open blocking exceptions on the run (enforced server-side by approve_cam_run, not just hidden in the UI)."],
    permissionContext: "CAMApproval page access (typically manager/admin)",
    sensitivity: "product",
  },
  {
    id: "cam_lease_detail",
    module: "cam",
    page: "CAMLeaseDetail",
    label: "CAM Lease Detail",
    purpose: "Shows one tenant's full CAM calculation trace for a specific run: premises/area, applicable pools, step-by-step lineage (tenant share, gross-up, base year, expense stop, caps, admin fee, residual allocation, estimate reconciliation), and final amount due/credit.",
    description: "Pure read-only display of what run-cam-calculation-v2 already persisted (cam_run_lease_results + cam_run_calculation_lines) — no calculation happens on this page. This is the deepest 'why is this tenant's CAM $X' explanation surface in the product.",
    relatedPages: ["CAMRun", "CAMApproval"],
    sensitivity: "product",
  },
  {
    id: "revenue",
    module: "revenue",
    page: "Revenue",
    label: "Revenue",
    purpose: "Property revenue projection combining base rent, posted CAM recovery, and other income.",
    description: "Base rent comes from approved rent schedules; CAM recovery is sourced from posted CAM run results (never recalculated); other income comes from manually recorded revenue records.",
    relatedPages: ["LeaseRentSchedule", "CAMRun"],
    sensitivity: "product",
  },
  {
    id: "budget_dashboard",
    module: "budgets",
    page: "BudgetDashboard",
    label: "Budget Dashboard",
    purpose: "Overview of a property's budget for a fiscal year — revenue plan, expense plan, and status.",
    description: "A budget bundles a revenue projection, an expense basis (per-category assumptions derived from prior-year actuals and forecasts), and — where applicable — a CAM estimate, into one plan that goes through a review/approval/lock workflow.",
    relatedPages: ["CreateBudget", "BudgetReview", "BudgetReadiness"],
    statusMeanings: { draft: "generated, not yet reviewed", under_review: "awaiting reviewer sign-off", approved: "approved, not yet locked", locked: "frozen plan of record for the year", rejected: "sent back for rework" },
    sensitivity: "product",
  },
  {
    id: "create_budget",
    module: "budgets",
    page: "CreateBudget",
    label: "Create Budget",
    purpose: "Generates a new budget: computes the expense basis, revenue plan, and (if configured) a CAM estimate for the target fiscal year.",
    description: "The expense basis engine derives each category's assumption from prior-year actuals, YTD current-year actuals, and a forecast method, with the reasoning captured for later explanation (\"why did Utilities increase?\"). The CAM estimate reuses the real CAM V2 engine against a projected input, not a separate calculation.",
    downstreamEffects: ["Produces a draft budget awaiting BudgetReview."],
    relatedPages: ["BudgetReview", "BudgetReadiness"],
    tabs: ["generate", "preview", "manage", "scenarios", "planning"],
    importantActions: [
      { action: "Generate Budget", businessMeaning: "Runs compute-revenue/compute-expense readiness then compute-budget to produce the draft plan." },
      { action: "Mark as Reviewed", businessMeaning: "Advances the budget to under_review." },
      { action: "Approve Budget", businessMeaning: "Approves a reviewed budget." },
      { action: "Lock Budget", businessMeaning: "Freezes the budget as the year's plan of record.", downstreamEffects: ["Becomes the comparison baseline in Variance/Reconciliation."] },
      { action: "Reject / Rework", businessMeaning: "Sends the budget back to draft with reviewer comments." },
    ],
    permissionContext: "CreateBudget page access (typically manager/admin for approve/lock)",
    sensitivity: "product",
  },
  {
    id: "budget_review",
    module: "budgets",
    page: "BudgetReview",
    label: "Budget Review",
    purpose: "Read-only year-over-year budget comparison and export.",
    description: "Compares budget categories across fiscal years to spot large swings; primary actions are Export and Export Budget Book, not approve/lock (those live on CreateBudget).",
    prerequisites: ["A generated budget from CreateBudget."],
    downstreamEffects: ["A locked budget becomes the baseline compared-against in Variance/Reconciliation."],
    relatedPages: ["BudgetDashboard", "Variance", "CreateBudget"],
    importantActions: [{ action: "Export / Export Budget Book", businessMeaning: "Produces a downloadable budget workbook." }],
    sensitivity: "product",
  },
  {
    id: "variance",
    module: "actuals_variance",
    page: "Variance",
    label: "Variance",
    purpose: "Compares actual results against the locked budget by category.",
    description: "Surfaces which budget lines are over/under actuals and by how much, so a user can see which assumptions held and which didn't. Read-only — no CAM linkage on this page (see Reconciliation for CAM due/credit).",
    prerequisites: ["A locked budget.", "Actual expenses/revenue for the comparison period."],
    relatedPages: ["Reconciliation", "BudgetDashboard", "ActualsVariance", "Actuals"],
    sensitivity: "product",
  },
  {
    id: "actuals",
    module: "actuals_variance",
    page: "Actuals",
    label: "Actuals",
    purpose: "Plain revenue/expense/NOI actuals view for a property.",
    description: "Near-duplicate of ActualsVariance's Actuals tab as a standalone page — same underlying data, no CAM linkage.",
    relatedPages: ["ActualsVariance", "Variance"],
    sensitivity: "product",
  },
  {
    id: "actuals_variance_tabbed",
    module: "actuals_variance",
    page: "ActualsVariance",
    label: "Actuals & Variance",
    purpose: "Tabbed shell combining the Actuals and Variance views in one page.",
    description: "Contains an Actuals tab and a Variance tab (same logic as the standalone Actuals/Variance pages). No CAM linkage — for CAM due/credit, use Reconciliation.",
    tabs: ["actuals", "variance"],
    relatedPages: ["Actuals", "Variance", "Reconciliation"],
    sensitivity: "product",
  },
  {
    id: "reconciliation",
    module: "reconciliation",
    page: "Reconciliation",
    label: "Reconciliation",
    purpose: "Reconciles budgeted/estimated figures against actual results, including CAM billed-vs-actual due/credit positions.",
    description: "Displayed as \"Operating Budget Variance\": a category-level budget-vs-actual table alongside a Flagged Items panel of tenant CAM true-up adjustments (owed/refund) derived from CAM calculations. This is the ONE page where budget variance and CAM reconciliation appear together — Variance/Actuals/ActualsVariance are CAM-blind.",
    relatedPages: ["Variance", "CAMRun", "CAMApproval"],
    importantActions: [{ action: "Run Reconciliation", businessMeaning: "Computes the reconciliation snapshot (compute-reconciliation) for the selected property/year." }],
    permissionContext: "Reconciliation page access",
    sensitivity: "product",
  },
  {
    id: "workflows_approvals",
    module: "workflows",
    page: "Approvals",
    label: "Approvals",
    purpose: "Central queue of items awaiting approval across modules (leases, expense rules, CAM runs, budgets).",
    description: "Surfaces everything blocked on a human decision so approvers don't have to visit each module separately.",
    relatedPages: ["Workflows"],
    sensitivity: "product",
  },
  {
    id: "workflows",
    module: "workflows",
    page: "Workflows",
    label: "Workflows",
    purpose: "Overview of in-flight, cross-module business processes and their current stage.",
    description: "A broader view than Approvals — shows workflow state (not just pending-approval items) across leases, expenses, CAM, and budgets.",
    relatedPages: ["Approvals"],
    sensitivity: "product",
  },
  {
    id: "portfolio_insights",
    module: "analytics_reports",
    page: "PortfolioInsights",
    label: "Portfolio Insights",
    purpose: "Cross-property analytics and (per the existing Copilot mock) a lease/portfolio Q&A surface.",
    description: "Aggregates metrics across the portfolio rather than a single property.",
    relatedPages: ["Portfolios", "AnalyticsReports"],
    sensitivity: "product",
  },
  {
    id: "buildings",
    module: "properties",
    page: "Buildings",
    label: "Buildings",
    purpose: "Buildings within a property's hierarchy.",
    description: "A property can have multiple buildings, each with its own units.",
    relatedPages: ["Properties", "Units", "BuildingsUnits"],
    sensitivity: "product",
  },
  {
    id: "units",
    module: "properties",
    page: "Units",
    label: "Units",
    purpose: "Leasable units within a building/property, with occupancy status.",
    description: "Units are the leasable spaces tenants occupy via leases.",
    relatedPages: ["Buildings", "Properties", "Leases"],
    sensitivity: "product",
  },
  {
    id: "buildings_units",
    module: "properties",
    page: "BuildingsUnits",
    label: "Buildings & Units",
    purpose: "Combined buildings + units management view.",
    description: "Same underlying data as the separate Buildings/Units pages, presented together.",
    relatedPages: ["Buildings", "Units"],
    sensitivity: "product",
  },
  {
    id: "property_detail",
    module: "properties",
    page: "PropertyDetail",
    label: "Property Detail",
    purpose: "Single-property detail view: overview, buildings, leases, expenses, CAM, budgets, stakeholders.",
    description: "The property-scoped hub most other per-property questions can be answered from — has its own edit/add-building/add-unit actions.",
    tabs: ["overview", "buildings", "leases", "expenses", "cam", "budgets", "stakeholders"],
    importantActions: [
      { action: "Add Building / Add Unit", businessMeaning: "Adds a new building or unit under this property." },
      { action: "Save (edit property)", businessMeaning: "Updates the property's own fields (name, address, type, etc.)." },
    ],
    relatedPages: ["Properties", "Buildings", "Units", "Leases", "Expenses", "CAMDashboard", "BudgetDashboard"],
    sensitivity: "product",
  },
  {
    id: "tenants",
    module: "tenants",
    page: "Tenants",
    label: "Tenants",
    purpose: "Org-wide tenant register.",
    description: "Tenants are org-scoped (not tied to one property in the schema) — a tenant can have leases at multiple properties.",
    relatedPages: ["TenantDetail", "Leases"],
    sensitivity: "product",
  },
  {
    id: "tenant_detail",
    module: "tenants",
    page: "TenantDetail",
    label: "Tenant Detail",
    purpose: "Single-tenant detail view: leases, rent, CAM, invoices, audit history.",
    description: "Read-only (no mutating actions). Identified by tenant name in the current UI, not id — correlates leases by matching tenant_name client-side rather than an FK.",
    tabs: ["leases", "rent", "cam", "invoices", "audit"],
    relatedPages: ["Tenants", "Leases"],
    sensitivity: "product",
  },
  {
    id: "vendors",
    module: "vendors",
    page: "Vendors",
    label: "Vendors",
    purpose: "Vendor register used on expense records.",
    description: "Vendors supply the goods/services behind actual expenses.",
    relatedPages: ["VendorProfile", "Expenses"],
    sensitivity: "product",
  },
  {
    id: "vendor_profile",
    module: "vendors",
    page: "VendorProfile",
    label: "Vendor Profile",
    purpose: "Single-vendor detail view.",
    description: "Vendor contact/category info and related expense history.",
    relatedPages: ["Vendors", "Expenses"],
    sensitivity: "product",
  },
  {
    id: "rent_projection",
    module: "leases",
    page: "RentProjection",
    label: "Rent Projection",
    purpose: "Forward-looking rent projection built from approved rent schedules.",
    description: "Projects monthly/annual rent across leases using the same rent_schedules rows LeaseRentSchedule reads, for a portfolio/property-level forward view.",
    relatedPages: ["LeaseRentSchedule", "Revenue"],
    sensitivity: "product",
  },
  {
    id: "critical_dates",
    module: "leases",
    page: "CriticalDates",
    label: "Critical Dates",
    purpose: "Org-wide list of upcoming lease-related dates needing attention (renewal notice, option exercise, expiration, insurance certificate, etc.).",
    description: "Each date has an owner, due date, and status; can be manually added or derived from lease terms.",
    tabs: ["active", "overdue", "due_soon", "completed", "all"],
    importantActions: [
      { action: "Add Reminder / Assign", businessMeaning: "Creates or assigns ownership of a critical date." },
      { action: "Complete", businessMeaning: "Marks a critical date as done." },
    ],
    statusMeanings: { open: "not yet actioned", completed: "done", dismissed: "no longer relevant" },
    relatedPages: ["Leases", "LeaseReview"],
    sensitivity: "product",
  },
  {
    id: "add_expense",
    module: "expenses",
    page: "AddExpense",
    label: "Add Expense",
    purpose: "Manual entry form for a single actual expense.",
    description: "Alternative to BulkImport for one-off expense entry.",
    downstreamEffects: ["New expense becomes eligible for classification in LeaseExpenseClassification."],
    relatedPages: ["Expenses", "BulkImport", "LeaseExpenseClassification"],
    sensitivity: "product",
  },
  {
    id: "bulk_import",
    module: "expenses",
    page: "BulkImport",
    label: "Bulk Import",
    purpose: "Bulk/CSV import of actual expenses.",
    description: "Higher-volume alternative to AddExpense for importing many expense records at once.",
    downstreamEffects: ["Imported expenses become eligible for classification in LeaseExpenseClassification."],
    relatedPages: ["Expenses", "AddExpense", "LeaseExpenseClassification"],
    sensitivity: "product",
  },
  {
    id: "expense_review",
    module: "expenses",
    page: "ExpenseReview",
    label: "Expense Review",
    purpose: "Exception queue + finalized-expense review across a property scope.",
    description: "Two sections: an Exception Queue (needs-review items) and Finalized Expenses. Same underlying actions as Expense Classification (resolve condition, send to CAM, run classification) at a review-focused altitude.",
    importantActions: [
      { action: "Resolve Condition", businessMeaning: "Records a decision for a conditionally-recoverable expense." },
      { action: "Send to CAM", businessMeaning: "Publishes a finalized expense as a CAM input." },
      { action: "Run Classification", businessMeaning: "Applies the lease recovery policy automatically." },
    ],
    relatedPages: ["Expenses", "LeaseExpenseClassification"],
    sensitivity: "product",
  },
  {
    id: "expense_projection",
    module: "expenses",
    page: "ExpenseProjection",
    label: "Expense Projection",
    purpose: "Forward-looking expense projection for a property.",
    description: "Projects operating expenses forward, related to (but distinct from) the budget expense basis engine.",
    relatedPages: ["Expenses", "CreateBudget"],
    sensitivity: "product",
  },
  {
    id: "expense_dashboard",
    module: "expenses",
    page: "ExpenseDashboard",
    label: "Expense Dashboard",
    purpose: "Summary/overview dashboard for expenses across scope.",
    description: "Aggregate expense metrics, distinct from the row-level Expenses list.",
    relatedPages: ["Expenses", "LeaseExpenseClassification"],
    sensitivity: "product",
  },
  {
    id: "cam_dashboard",
    module: "cam",
    page: "CAMDashboard",
    label: "CAM Dashboard",
    purpose: "Overview/summary of CAM activity across a property or portfolio.",
    description: "Landing page for the CAM module, linking into CAM Setup, Run, and Approval.",
    relatedPages: ["CAMSetup", "CAMRun", "CAMApproval"],
    sensitivity: "product",
  },
  {
    id: "cam_pool_detail",
    module: "cam",
    page: "CAMPoolDetail",
    label: "CAM Pool Detail",
    purpose: "Detail view of a single recovery pool's configuration and results.",
    description: "Pool-level drill-down distinct from the tenant-level CAMLeaseDetail.",
    relatedPages: ["CAMSetup", "CAMRun"],
    sensitivity: "product",
  },
  {
    id: "cam_exception_review",
    module: "cam",
    page: "CAMExceptionReview",
    label: "CAM Exception Review",
    purpose: "Review queue for CAM run exceptions (data/config issues flagged during calculation).",
    description: "Exceptions with severity 'blocking' must be resolved before a run can be approved (enforced server-side).",
    statusMeanings: { blocking: "must resolve before approval", review_required: "should be reviewed", warning: "informational, non-blocking", info: "informational" },
    relatedPages: ["CAMRun", "CAMApproval"],
    sensitivity: "product",
  },
  {
    id: "cam_posting",
    module: "cam",
    page: "CAMPosting",
    label: "CAM Posting",
    purpose: "Finalizes an approved CAM run: generates statements, charge exports, and marks delivery.",
    description: "Shares the CAMRun component/route; posting is the terminal step after CAMApproval — posted runs are immutable except a superseding correction run.",
    prerequisites: ["An approved CAM run."],
    importantActions: [
      { action: "Generate Statements", businessMeaning: "Produces tenant-facing recovery statements." },
      { action: "Create Charge Export", businessMeaning: "Produces a billing/charge export file." },
      { action: "Mark Delivered", businessMeaning: "Records that statements were delivered to tenants." },
    ],
    relatedPages: ["CAMApproval", "CAMRun"],
    sensitivity: "product",
  },
  {
    id: "budget_readiness",
    module: "cam",
    page: "BudgetReadiness",
    label: "Budget Readiness",
    purpose: "Read-only readiness report for whether a property/year is ready for budget generation.",
    description: "Analogous to CAM Setup's readiness check, but for the budget CAM-estimate path — reports what's blocking, never mutates.",
    relatedPages: ["CreateBudget", "CAMSetup"],
    sensitivity: "product",
  },
  {
    id: "comparison",
    module: "comparison",
    page: "Comparison",
    label: "YoY Comparison",
    purpose: "Year-over-year comparison view across financial metrics.",
    description: "Broader comparison surface than Budget Review's YoY budget-only comparison.",
    relatedPages: ["BudgetReview", "AnalyticsReports"],
    sensitivity: "product",
  },
  {
    id: "documents",
    module: "documents",
    page: "Documents",
    label: "Documents",
    purpose: "Org-wide document/evidence library (uploaded lease files and linked records).",
    description: "Backed by uploaded_files + document_links; the source of the file citations get_lease_evidence surfaces.",
    relatedPages: ["LeaseUpload", "LeaseReview"],
    sensitivity: "product",
  },
  {
    id: "notifications",
    module: "notifications",
    page: "Notifications",
    label: "Notifications",
    purpose: "In-app notification inbox for the current user.",
    description: "System-generated alerts (approvals needed, workflow events, etc.).",
    sensitivity: "product",
  },
  {
    id: "file_history",
    module: "leases",
    page: "FileHistoryPage",
    label: "File Pipeline",
    purpose: "Shows the processing pipeline status of uploaded lease files (parsing, extraction, validation stages).",
    description: "Operational visibility into the extraction pipeline, distinct from the business content of LeaseReview.",
    relatedPages: ["LeaseUpload", "LeaseReview"],
    sensitivity: "product",
  },
  {
    id: "pipeline_upload",
    module: "leases",
    page: "PipelineUpload",
    label: "Pipeline Upload",
    purpose: "Alternate/bulk lease document upload entry point feeding the same extraction pipeline as LeaseUpload.",
    description: "Same downstream flow as LeaseUpload — extraction, then LeaseReview.",
    relatedPages: ["LeaseUpload", "FileHistoryPage"],
    sensitivity: "product",
  },
  {
    id: "chart_of_accounts",
    module: "admin",
    page: "ChartOfAccounts",
    label: "Chart of Accounts",
    purpose: "GL account / category mapping configuration used by expense categorization.",
    description: "Maps categories to GL codes; referenced by expense_categories resolution.",
    relatedPages: ["FieldMappingRules", "Expenses"],
    sensitivity: "product",
  },
  {
    id: "approval_workflows",
    module: "admin",
    page: "ApprovalWorkflows",
    label: "Approval Workflows",
    purpose: "Configuration of approval-chain workflows (who approves what, in what order).",
    description: "Admin configuration surface behind the runtime Approvals queue.",
    relatedPages: ["ApprovalPolicies", "Approvals"],
    sensitivity: "product",
  },
  {
    id: "approval_policies",
    module: "admin",
    page: "ApprovalPolicies",
    label: "Approval Policies",
    purpose: "Configuration of approval thresholds/limits by role.",
    description: "Defines who can approve up to what dollar threshold, referenced by authorizationEngine.js's approval-chain resolution.",
    relatedPages: ["ApprovalWorkflows"],
    sensitivity: "product",
  },
  {
    id: "integrations",
    module: "integrations",
    page: "Integrations",
    label: "Integrations",
    purpose: "Third-party integration configuration (accounting systems, etc.).",
    description: "Org-level integration settings.",
    sensitivity: "product",
  },
  {
    id: "org_settings",
    module: "admin",
    page: "OrgSettings",
    label: "Organization Settings",
    purpose: "Org-level configuration: enabled modules, branding, general settings.",
    description: "Controls which modules (moduleConfig.js) are enabled for the organization.",
    sensitivity: "product",
  },
  {
    id: "user_management",
    module: "admin",
    page: "UserManagement",
    label: "User Management",
    purpose: "Manage org members: roles, page/module permissions, invitations.",
    description: "The admin surface behind the RBAC model the Assistant itself is gated by (src/lib/rbac.js, userPermissions.js).",
    permissionContext: "org_admin only",
    sensitivity: "product",
  },
  {
    id: "billing",
    module: "billing",
    page: "Billing",
    label: "Billing",
    purpose: "Tenant billing/invoice records, nested under Tenants in navigation.",
    description: "Invoices and billing status for tenants — related to but distinct from CAM statements generated in CAMPosting.",
    relatedPages: ["Tenants", "TenantDetail", "CAMPosting"],
    sensitivity: "product",
  },
  {
    id: "stakeholders",
    module: "admin",
    page: "Stakeholders",
    label: "Stakeholders",
    purpose: "Manages stakeholder contacts (e.g. for budget-approval notifications).",
    description: "Referenced by CreateBudget's notification logic (normalizeBudgetNotificationRecipients).",
    permissionContext: "super-admin / org-admin",
    relatedPages: ["CreateBudget"],
    sensitivity: "product",
  },
  {
    id: "field_mapping_rules",
    module: "admin",
    page: "FieldMappingRules",
    label: "Field Mapping Rules",
    purpose: "Configuration mapping import/extraction fields to canonical schema fields.",
    description: "Admin configuration for data ingestion, not itself a financial data page.",
    relatedPages: ["ChartOfAccounts", "BulkImport"],
    sensitivity: "product",
  },
  {
    id: "analytics_reports",
    module: "analytics_reports",
    page: "AnalyticsReports",
    label: "Analytics & Reports",
    purpose: "Cross-property analytics and reporting.",
    description: "Broader reporting surface; `Reports` and `Analytics` are related pages in the same module with overlapping/near-duplicate purpose.",
    relatedPages: ["Reports", "Analytics", "PortfolioInsights"],
    sensitivity: "product",
  },
  {
    id: "audit_log",
    module: "admin",
    page: "AuditLog",
    label: "Audit Log",
    purpose: "Org-wide audit trail of who changed what, when.",
    description: "Backed by the audit_logs table — the same source get_record_audit_summary reads, scoped to one record instead of the whole org.",
    permissionContext: "org_admin / auditor roles typically",
    sensitivity: "product",
  },
];

const BY_PAGE = new Map(PLATFORM_CAPABILITIES.map((c) => [c.page, c]));
const BY_ID = new Map(PLATFORM_CAPABILITIES.map((c) => [c.id, c]));

export function getCapabilityByPage(page: string): PlatformCapability | null {
  return BY_PAGE.get(page) ?? null;
}

export function getCapabilityById(id: string): PlatformCapability | null {
  return BY_ID.get(id) ?? null;
}

export function listCapabilitySummaries(): Array<{ id: string; page: string; label: string; purpose: string }> {
  return PLATFORM_CAPABILITIES.map((c) => ({ id: c.id, page: c.page, label: c.label, purpose: c.purpose }));
}

// ---------------------------------------------------------------------------
// Workflow definitions (section 16, get_workflow_definition) — cross-page
// business processes, distinct from single-page capabilities above.
// ---------------------------------------------------------------------------

export interface PlatformWorkflow {
  id: string;
  label: string;
  description: string;
  steps: string[];
  relatedPages: string[];
}

export const PLATFORM_WORKFLOWS: PlatformWorkflow[] = [
  {
    id: "send_to_cam",
    label: "Send an expense to CAM",
    description: "Publishing a classified expense so it becomes an eligible input to CAM calculations.",
    steps: [
      "Expense is recorded (Expenses / BulkImport).",
      "Expense Classification applies the lease's recovery policy and sets recoverability + recovery status.",
      "Once classification is approved, the expense is marked sent_to_cam and becomes a published CAM expense input.",
      "CAM Setup readiness now counts it toward the recovery pool it belongs to.",
      "A CAM Run picks up published inputs for its recovery period and calculates tenant recoveries.",
    ],
    relatedPages: ["LeaseExpenseClassification", "CAMSetup", "CAMRun"],
  },
  {
    id: "lease_to_cam_ready",
    label: "Lease approval to CAM-ready",
    description: "How a newly uploaded lease becomes usable by CAM.",
    steps: [
      "Lease document uploaded (LeaseUpload) and AI-extracted.",
      "Reviewer approves the abstract in LeaseReview — this freezes the canonical lease terms.",
      "Lease Expense Rules are approved, materializing an effective-dated recovery policy.",
      "The lease is now eligible for expense classification and CAM/budget calculations that reference its recovery policy.",
    ],
    relatedPages: ["LeaseUpload", "LeaseReview", "LeaseExpenseRules"],
  },
  {
    id: "cam_run_lifecycle",
    label: "CAM run lifecycle",
    description: "The state machine a CAM run moves through from draft to posted.",
    steps: [
      "draft -> readiness_failed | ready (CAM Setup readiness check)",
      "ready -> calculating -> calculated (CAM Run engine execution)",
      "calculated -> under_review -> submitted -> approved (CAM Approval)",
      "approved -> posted (CAM Posting; posted runs are immutable except a superseding correction run)",
    ],
    relatedPages: ["CAMSetup", "CAMRun", "CAMApproval"],
  },
  {
    id: "budget_lifecycle",
    label: "Budget approval lifecycle",
    description: "The state machine a budget moves through from draft to locked.",
    steps: [
      "draft (generated by Create Budget: expense basis + revenue + optional CAM estimate)",
      "under_review (Budget Review)",
      "approved",
      "locked — becomes the frozen baseline used by Variance/Reconciliation (or rejected, sending it back to draft)",
    ],
    relatedPages: ["CreateBudget", "BudgetReview", "Variance"],
  },
];

export function getWorkflowById(id: string): PlatformWorkflow | null {
  return PLATFORM_WORKFLOWS.find((w) => w.id === id) ?? null;
}

export function listWorkflowSummaries(): Array<{ id: string; label: string; description: string }> {
  return PLATFORM_WORKFLOWS.map((w) => ({ id: w.id, label: w.label, description: w.description }));
}

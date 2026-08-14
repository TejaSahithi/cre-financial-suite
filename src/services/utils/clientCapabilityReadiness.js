import { evaluateFinancialControlsLite } from "./financialControlsLite";

const APPROVED_LEASE_STATUSES = new Set(["approved", "active", "executed", "budget_ready", "signed"]);
const APPROVED_RULE_STATUSES = new Set(["approved"]);
const REVIEW_STATUSES = new Set(["needs_review", "review_required", "pending_review", "draft"]);

function pct(numerator, denominator) {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 100);
}

function statusFromRatio(ratio, hasBlockers = false) {
  if (hasBlockers) return "blocked";
  if (ratio >= 95) return "automated";
  if (ratio >= 70) return "needs_review";
  if (ratio > 0) return "partial";
  return "not_started";
}

function isApprovedLease(lease) {
  return APPROVED_LEASE_STATUSES.has(String(lease?.abstract_status || lease?.status || "").toLowerCase());
}

function hasSnapshotEvidence(lease) {
  const snapshot = lease?.abstract_snapshot;
  const approved = snapshot?.approved;
  if (!approved || typeof approved !== "object") return false;
  return Object.values(approved).some((entry) =>
    entry && typeof entry === "object" && (entry.source_text || entry.exact_source_text || entry.source_page)
  );
}

function hasIndexSignal(rule) {
  return Boolean(
    rule?.index_adjustment_applicable ||
      rule?.index_adjustment_type ||
      rule?.index_name ||
      rule?.cpi_applicable ||
      rule?.cpi_index_name
  );
}

function hasPercentageRentSignal(lease, rentSchedules = []) {
  const text = JSON.stringify([
    lease?.abstract_snapshot?.approved,
    lease?.extraction_data?.fields,
    lease?.extracted_fields,
  ]).toLowerCase();
  return text.includes("percentage_rent") ||
    text.includes("gross sales") ||
    rentSchedules.some((row) => row.lease_id === lease?.id && row.row_type === "percentage_rent");
}

function countBy(items, predicate) {
  return (items || []).filter(predicate).length;
}

function capability({ id, title, priority, status, coverage, done, total, blockers = [], nextAction, evidence = [] }) {
  return {
    id,
    title,
    priority,
    status,
    coverage,
    done,
    total,
    blockers,
    nextAction,
    evidence,
  };
}

export function buildClientCapabilityReadiness({
  leases = [],
  expenseRules = [],
  expenses = [],
  budgets = [],
  camRuns = [],
  criticalDates = [],
  documents = [],
  vendors = [],
  notifications = [],
  rentSchedules = [],
  fiscalYear = new Date().getFullYear(),
} = {}) {
  const approvedLeases = countBy(leases, isApprovedLease);
  const leasesWithEvidence = countBy(leases, hasSnapshotEvidence);
  const leasesWithRentRows = countBy(leases, (lease) => rentSchedules.some((row) => row.lease_id === lease.id && row.status === "approved"));
  const approvedRules = countBy(expenseRules, (rule) => APPROVED_RULE_STATUSES.has(String(rule?.approval_status || rule?.review_status || "").toLowerCase()));
  const rulesNeedingReview = countBy(expenseRules, (rule) => REVIEW_STATUSES.has(String(rule?.approval_status || rule?.review_status || "").toLowerCase()));
  const cpiRules = expenseRules.filter(hasIndexSignal);
  const camEligibleRules = expenseRules.filter((rule) => rule?.cam_eligible === true || String(rule?.cam_eligible).toLowerCase() === "yes");
  const approvedCamRuns = countBy(camRuns, (run) => ["approved", "posted"].includes(String(run?.status || "").toLowerCase()));
  const approvedBudgets = countBy(budgets, (budget) => ["approved", "locked"].includes(String(budget?.status || "").toLowerCase()));
  const percentageRentLeases = leases.filter((lease) => hasPercentageRentSignal(lease, rentSchedules));
  const renewalDates = criticalDates.filter((date) => /renew|option|notice/i.test(String(date?.date_type || date?.type || date?.title || "")));
  const coiDates = criticalDates.filter((date) => /coi|insurance/i.test(String(date?.date_type || date?.type || date?.title || "")));
  const controls = evaluateFinancialControlsLite({ expenses, budgets, expenseRules, fiscalYear });

  const capabilities = [
    capability({
      id: "lease_upload_ai_review",
      title: "Lease upload, extraction, review, and evidence",
      priority: "P0",
      status: statusFromRatio(pct(approvedLeases, leases.length)),
      coverage: pct(approvedLeases, leases.length),
      done: approvedLeases,
      total: leases.length,
      blockers: leases.length - approvedLeases,
      nextAction: approvedLeases === leases.length ? "Preserve current approval flow." : "Finish lease abstract review for pending leases.",
      evidence: [`${leasesWithEvidence} lease(s) include source-backed approved evidence.`],
    }),
    capability({
      id: "effective_dated_rent",
      title: "Effective-dated rent schedules and downstream rent authority",
      priority: "P0/P1",
      status: statusFromRatio(pct(leasesWithRentRows, leases.length)),
      coverage: pct(leasesWithRentRows, leases.length),
      done: leasesWithRentRows,
      total: leases.length,
      blockers: leases.length - leasesWithRentRows,
      nextAction: "Use approved rent schedule rows as the source for budget, billing, and management-fee calculations.",
      evidence: [`${rentSchedules.length} rent schedule row(s) loaded.`],
    }),
    capability({
      id: "expense_cam_rules",
      title: "Recoverability, CAM eligibility, caps, gross-up, and expense rules",
      priority: "P0",
      status: statusFromRatio(pct(approvedRules, Math.max(expenseRules.length, 1)), rulesNeedingReview > 0),
      coverage: pct(approvedRules, Math.max(expenseRules.length, 1)),
      done: approvedRules,
      total: expenseRules.length,
      blockers: rulesNeedingReview,
      nextAction: rulesNeedingReview > 0 ? "Approve or correct remaining lease expense rules before CAM handoff." : "Preserve approved rule-to-CAM publication flow.",
      evidence: [`${camEligibleRules.length} CAM-eligible rule(s).`],
    }),
    capability({
      id: "cam_budget_reconciliation",
      title: "CAM calculation, reconciliation, budget workbook, and approvals",
      priority: "P0",
      status: statusFromRatio(pct(approvedCamRuns + approvedBudgets, Math.max(camRuns.length + budgets.length, 1))),
      coverage: pct(approvedCamRuns + approvedBudgets, Math.max(camRuns.length + budgets.length, 1)),
      done: approvedCamRuns + approvedBudgets,
      total: camRuns.length + budgets.length,
      blockers: Math.max(0, camRuns.length - approvedCamRuns) + Math.max(0, budgets.length - approvedBudgets),
      nextAction: "Keep CAM V2 and budget approval as the financial authority; use readiness page for blockers.",
      evidence: [`${approvedCamRuns} approved/posted CAM run(s).`, `${approvedBudgets} approved/locked budget(s).`],
    }),
    capability({
      id: "financial_controls",
      title: "Financial controls: variance, unbudgeted expenses, and missing recurring invoices",
      priority: "P5/P6",
      status: controls.summary.totalExceptions > 0 ? "needs_review" : "automated",
      coverage: controls.summary.totalExceptions > 0 ? 75 : 100,
      done: Math.max(0, expenses.length - controls.summary.totalExceptions),
      total: expenses.length,
      blockers: controls.summary.totalExceptions,
      nextAction: controls.summary.totalExceptions > 0 ? "Review financial control exceptions before final budget/reconciliation sign-off." : "No control exceptions found from current data.",
      evidence: [
        `${controls.summary.overBudgetCount} over-budget category alert(s).`,
        `${controls.summary.unbudgetedCount} unbudgeted category alert(s).`,
        `${controls.summary.missingRecurringCount} missing recurring invoice alert(s).`,
      ],
    }),
    capability({
      id: "cpi_reference_data",
      title: "CPI/index adjustments with exact series provenance",
      priority: "P3",
      status: cpiRules.length > 0 ? "needs_review" : "partial",
      coverage: cpiRules.length > 0 ? 65 : 35,
      done: cpiRules.length,
      total: Math.max(cpiRules.length, 1),
      blockers: cpiRules.filter((rule) => !rule.index_name && !rule.cpi_index_name).length,
      nextAction: "Resolve CPI series and observation source before automatic calculation; never auto-assume CPI-U vs CPI-W.",
      evidence: [`${cpiRules.length} CPI/index rule(s) detected.`],
    }),
    capability({
      id: "percentage_rent",
      title: "Percentage rent and tenant gross-sales reporting",
      priority: "P4",
      status: percentageRentLeases.length > 0 ? "needs_review" : "partial",
      coverage: percentageRentLeases.length > 0 ? 50 : 25,
      done: percentageRentLeases.length,
      total: Math.max(leases.length, 1),
      blockers: percentageRentLeases.length,
      nextAction: "Create sales-report record workflow before calculating percentage rent.",
      evidence: [`${percentageRentLeases.length} lease(s) with percentage-rent signals.`],
    }),
    capability({
      id: "critical_dates_obligations",
      title: "Renewal reminders, reconciliation deadlines, and obligation scheduling",
      priority: "P4",
      status: renewalDates.length > 0 || notifications.length > 0 ? "partial" : "needs_review",
      coverage: Math.min(90, pct(renewalDates.length + notifications.length, Math.max(leases.length, 1)) + 35),
      done: renewalDates.length + notifications.length,
      total: Math.max(leases.length, 1),
      blockers: renewalDates.length === 0 ? leases.length : 0,
      nextAction: "Use critical dates as the source; add idempotent reminder occurrences for external communication.",
      evidence: [`${renewalDates.length} renewal/notice date(s).`, `${notifications.length} notification row(s).`],
    }),
    capability({
      id: "coi_insurance_compliance",
      title: "COI and insurance compliance",
      priority: "P6",
      status: coiDates.length > 0 ? "partial" : "needs_review",
      coverage: coiDates.length > 0 ? 55 : 25,
      done: coiDates.length,
      total: Math.max(leases.length, 1),
      blockers: Math.max(0, leases.length - coiDates.length),
      nextAction: "Keep lease insurance requirements separate from COI documents; compare only after COI approval.",
      evidence: [`${coiDates.length} COI/insurance critical date(s).`, `${documents.length} document record(s).`],
    }),
    capability({
      id: "vendor_compliance",
      title: "Vendor credentials, jurisdiction eligibility, and service approval",
      priority: "P7",
      status: vendors.length > 0 ? "partial" : "needs_review",
      coverage: vendors.length > 0 ? 45 : 20,
      done: vendors.length,
      total: Math.max(vendors.length, 1),
      blockers: countBy(vendors, (vendor) => !vendor.status || String(vendor.status).toLowerCase() !== "active"),
      nextAction: "Add service/jurisdiction credential checks without assuming a universal county API.",
      evidence: [`${vendors.length} vendor profile(s).`],
    }),
    capability({
      id: "property_takeover_readiness",
      title: "Property onboarding and takeover readiness",
      priority: "P8/P9",
      status: documents.length > 0 && leases.length > 0 ? "partial" : "needs_review",
      coverage: documents.length > 0 && leases.length > 0 ? 60 : 30,
      done: documents.length + leases.length,
      total: Math.max(documents.length + leases.length, 1),
      blockers: countBy(leases, (lease) => !isApprovedLease(lease)),
      nextAction: "Aggregate lease package exceptions, missing amendments, and approval blockers into a takeover readiness workspace.",
      evidence: [`${documents.length} document(s).`, `${leases.length} lease record(s).`],
    }),
  ];

  const summary = {
    automated: countBy(capabilities, (item) => item.status === "automated"),
    needsReview: countBy(capabilities, (item) => item.status === "needs_review"),
    partial: countBy(capabilities, (item) => item.status === "partial"),
    blocked: countBy(capabilities, (item) => item.status === "blocked"),
    averageCoverage: capabilities.length
      ? Math.round(capabilities.reduce((sum, item) => sum + item.coverage, 0) / capabilities.length)
      : 0,
  };

  return { capabilities, controls, summary };
}

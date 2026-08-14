const TERMINAL_STATUSES = new Set([
  "approved",
  "active",
  "verified",
  "resolved",
  "dismissed",
  "satisfied",
  "waived",
  "cancelled",
  "canceled",
  "completed",
  "superseded",
  "compliant",
]);

const NEEDS_REVIEW_STATUSES = new Set(["draft", "pending_review", "submitted", "needs_review", "rejected", "acknowledged", "assigned"]);
const BLOCKED_STATUSES = new Set(["blocked"]);
const OVERDUE_STATUSES = new Set(["overdue", "expired"]);

export const AUTOMATION_INBOX_DOMAINS = [
  { id: "financial-controls", label: "Financial Controls" },
  { id: "obligations", label: "Lease Obligations" },
  { id: "tenant-sales", label: "Tenant Sales" },
  { id: "coi", label: "COI Compliance" },
  { id: "vendor-credentials", label: "Vendor Credentials" },
  { id: "reference-data", label: "CPI / Reference" },
  { id: "lease-charges", label: "Lease Charges" },
  { id: "tenant-reconciliations", label: "Tenant Reconciliations" },
];

function normalizeStatus(status) {
  return String(status || "open").toLowerCase();
}

function normalizeSeverity(value, fallback = "medium") {
  const severity = String(value || fallback).toLowerCase();
  if (["critical", "high", "medium", "low", "info"].includes(severity)) return severity;
  if (severity === "blocking" || severity === "blocked") return "critical";
  return fallback;
}

function todayIso(asOfDate) {
  const value = asOfDate ? new Date(asOfDate) : new Date();
  if (Number.isNaN(value.getTime())) return new Date().toISOString().slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function isPastDate(value, asOfDate) {
  if (!value) return false;
  return String(value).slice(0, 10) < todayIso(asOfDate);
}

function isDueSoon(value, asOfDate, days = 30) {
  if (!value) return false;
  const due = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  const now = new Date(`${todayIso(asOfDate)}T00:00:00Z`);
  if (Number.isNaN(due.getTime()) || Number.isNaN(now.getTime())) return false;
  const diff = Math.round((due.getTime() - now.getTime()) / 86400000);
  return diff >= 0 && diff <= days;
}

function hasReasonCodes(row) {
  return Array.isArray(row?.reason_codes) && row.reason_codes.length > 0;
}

function hasReferenceReason(row) {
  const joined = [
    ...(Array.isArray(row?.reason_codes) ? row.reason_codes : []),
    JSON.stringify(row?.evidence || {}),
    JSON.stringify(row?.inputs || {}),
  ].join(" ");
  return /cpi|reference|observation|series/i.test(joined);
}

function actionUrl(page, params = {}) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  });
  const qs = search.toString();
  return qs ? `/${page}?${qs}` : `/${page}`;
}

function domainLabel(domain) {
  return AUTOMATION_INBOX_DOMAINS.find((item) => item.id === domain)?.label || domain;
}

function item(base) {
  const status = normalizeStatus(base.status);
  const severity = normalizeSeverity(base.severity, status === "blocked" ? "critical" : "medium");
  return {
    ...base,
    id: `${base.sourceTable}:${base.sourceRecordId}`,
    domainLabel: domainLabel(base.domain),
    status,
    severity,
  };
}

function isOpenStatus(status) {
  const normalized = normalizeStatus(status);
  return !TERMINAL_STATUSES.has(normalized);
}

function financialControlItems(rows) {
  return (rows || [])
    .filter((row) => isOpenStatus(row.status))
    .map((row) => item({
      domain: "financial-controls",
      category: row.category || row.code || "financial_control",
      title: row.code || "Financial control finding",
      description: row.policy_decision_snapshot?.reason || row.reason || row.source || "Financial-control finding requires disposition.",
      entityReference: row.category || row.property_id || row.id,
      propertyId: row.property_id || null,
      leaseId: null,
      sourceTable: "financial_control_findings",
      sourceRecordId: row.id,
      actionUrl: actionUrl("AutomationReadiness", { domain: "financial-controls", record: row.id }),
      dueDate: null,
      assignee: row.assignee || null,
      status: row.policy_blocks ? "blocked" : row.status,
      severity: row.policy_blocks ? "critical" : row.severity,
      sourceRow: row,
    }));
}

function obligationItems(rows, asOfDate) {
  return (rows || [])
    .filter((row) => isOpenStatus(row.status))
    .filter((row) => OVERDUE_STATUSES.has(normalizeStatus(row.status)) || isPastDate(row.due_date, asOfDate) || isDueSoon(row.due_date, asOfDate))
    .map((row) => {
      const overdue = OVERDUE_STATUSES.has(normalizeStatus(row.status)) || isPastDate(row.due_date, asOfDate);
      return item({
        domain: "obligations",
        category: "lease_obligation",
        title: overdue ? "Overdue obligation" : "Due obligation",
        description: row.notification_policy || "internal_only",
        entityReference: row.obligation_id || row.lease_id || row.id,
        propertyId: row.property_id || null,
        leaseId: row.lease_id || null,
        sourceTable: "lease_obligation_occurrences",
        sourceRecordId: row.id,
        actionUrl: actionUrl("AutomationReadiness", { domain: "obligations", record: row.id }),
        dueDate: row.due_date || null,
        assignee: row.assignee || null,
        status: overdue ? "overdue" : row.status,
        severity: overdue ? "critical" : "high",
        sourceRow: row,
      });
    });
}

function tenantSalesItems(rows) {
  return (rows || [])
    .filter((row) => isOpenStatus(row.status))
    .map((row) => item({
      domain: "tenant-sales",
      category: "gross_sales_report",
      title: `Sales report ${row.period_start || "-"} to ${row.period_end || "-"}`,
      description: row.evidence?.exception || row.evidence?.reason || "Tenant sales report requires review.",
      entityReference: row.lease_id || row.id,
      propertyId: row.property_id || null,
      leaseId: row.lease_id || null,
      sourceTable: "tenant_sales_reports",
      sourceRecordId: row.id,
      actionUrl: actionUrl("RentProjection", { lease_id: row.lease_id, report: row.id }),
      dueDate: row.period_end || null,
      assignee: row.assignee || null,
      status: row.status,
      severity: normalizeStatus(row.status) === "blocked" ? "critical" : "medium",
      sourceRow: row,
    }));
}

function coiItems(rows, asOfDate) {
  return (rows || [])
    .filter((row) => isOpenStatus(row.status) || isPastDate(row.expiration_date, asOfDate))
    .map((row) => {
      const expired = OVERDUE_STATUSES.has(normalizeStatus(row.status)) || isPastDate(row.expiration_date, asOfDate);
      return item({
        domain: "coi",
        category: "insurance_compliance",
        title: row.insurer || "COI document",
        description: expired ? "COI expired or overdue." : "COI requires compliance review.",
        entityReference: row.lease_id || row.vendor_id || row.id,
        propertyId: row.property_id || null,
        leaseId: row.lease_id || null,
        sourceTable: "coi_documents",
        sourceRecordId: row.id,
        actionUrl: actionUrl("AutomationReadiness", { domain: "coi", record: row.id }),
        dueDate: row.expiration_date || null,
        assignee: row.assignee || null,
        status: expired ? "expired" : row.status,
        severity: expired ? "critical" : "medium",
        sourceRow: row,
      });
    });
}

function vendorCredentialItems(rows, asOfDate) {
  return (rows || [])
    .filter((row) => isOpenStatus(row.status) || isPastDate(row.expiration_date, asOfDate))
    .map((row) => {
      const expired = OVERDUE_STATUSES.has(normalizeStatus(row.status)) || isPastDate(row.expiration_date, asOfDate);
      return item({
        domain: "vendor-credentials",
        category: row.service_type || "vendor_credential",
        title: row.credential_type || "Vendor credential",
        description: expired ? "Credential expired or overdue." : "Vendor credential requires verification.",
        entityReference: row.vendor_id || row.id,
        propertyId: row.property_id || null,
        leaseId: null,
        sourceTable: "vendor_credentials",
        sourceRecordId: row.id,
        actionUrl: actionUrl("Vendors", { vendor_id: row.vendor_id, credential: row.id }),
        dueDate: row.expiration_date || null,
        assignee: row.assignee || null,
        status: expired ? "expired" : row.status,
        severity: expired ? "critical" : "medium",
        sourceRow: row,
      });
    });
}

function referenceItems(seriesRows, observationRows) {
  const series = (seriesRows || [])
    .filter((row) => isOpenStatus(row.status))
    .map((row) => item({
      domain: "reference-data",
      category: "reference_series",
      title: row.display_name || row.series_id || "Reference series",
      description: row.evidence?.reason || "Reference series selection requires approval before CPI-dependent calculations can consume it.",
      entityReference: row.lease_id || row.series_id || row.id,
      propertyId: row.property_id || null,
      leaseId: row.lease_id || null,
      sourceTable: "reference_series_selections",
      sourceRecordId: row.id,
      actionUrl: actionUrl("AutomationReadiness", { domain: "reference-data", record: row.id }),
      dueDate: null,
      assignee: row.assignee || null,
      status: row.status,
      severity: normalizeStatus(row.status) === "blocked" ? "critical" : "high",
      sourceRow: row,
    }));

  const observations = (observationRows || [])
    .filter((row) => isOpenStatus(row.status))
    .map((row) => item({
      domain: "reference-data",
      category: "reference_observation",
      title: `${row.provider || "provider"} ${row.series_id || "series"} ${row.period || ""}`.trim(),
      description: row.evidence?.reason || "Reference observation must be approved before use in financial calculations.",
      entityReference: row.series_id || row.id,
      propertyId: row.property_id || null,
      leaseId: row.lease_id || null,
      sourceTable: "reference_observations",
      sourceRecordId: row.id,
      actionUrl: actionUrl("AutomationReadiness", { domain: "reference-data", record: row.id }),
      dueDate: null,
      assignee: row.assignee || null,
      status: row.status,
      severity: normalizeStatus(row.status) === "blocked" ? "critical" : "high",
      sourceRow: row,
    }));

  return [...series, ...observations];
}

function leaseChargeItems(rows) {
  return (rows || [])
    .filter((row) => isOpenStatus(row.status) || hasReasonCodes(row))
    .filter((row) => normalizeStatus(row.status) !== "calculated" || hasReferenceReason(row) || hasReasonCodes(row))
    .map((row) => item({
      domain: "lease-charges",
      category: row.charge_type || "lease_charge",
      title: `${row.charge_type || "Lease charge"} calculation`,
      description: Array.isArray(row.reason_codes) && row.reason_codes.length ? row.reason_codes.join(", ") : "Persisted lease-charge calculation requires review.",
      entityReference: row.lease_id || row.source_record_id || row.id,
      propertyId: row.property_id || null,
      leaseId: row.lease_id || null,
      sourceTable: row.authoritative_table || "lease_charge_calculations",
      sourceRecordId: row.source_record_id || row.id,
      actionUrl: actionUrl("RentProjection", { lease_id: row.lease_id, charge: row.source_record_id || row.id }),
      dueDate: row.period_end || null,
      assignee: row.assignee || null,
      status: row.status,
      severity: normalizeStatus(row.status) === "blocked" ? "critical" : "medium",
      sourceRow: row,
    }));
}


function cpiRentProposalItems(rows) {
  return (rows || [])
    .filter((row) => isOpenStatus(row.status) || hasReasonCodes(row))
    .map((row) => item({
      domain: "lease-charges",
      category: "cpi_rent_adjustment",
      title: "CPI rent adjustment proposal",
      description: Array.isArray(row.reason_codes) && row.reason_codes.length
        ? row.reason_codes.join(", ")
        : `${row.index_base_period || "base"} to ${row.index_current_period || "current"}: ${row.base_monthly_amount || "-"} -> ${row.proposed_monthly_amount || "review"}`,
      entityReference: row.lease_id || row.id,
      propertyId: row.property_id || null,
      leaseId: row.lease_id || null,
      sourceTable: "cpi_rent_adjustment_proposals",
      sourceRecordId: row.id,
      actionUrl: actionUrl("AutomationReadiness", { domain: "lease-charges", record: row.id }),
      dueDate: row.period_end || null,
      assignee: row.assignee || null,
      status: row.status,
      severity: normalizeStatus(row.status) === "blocked" ? "critical" : "medium",
      sourceRow: row,
    }));
}
function tenantReconciliationItems(rows) {
  return (rows || [])
    .filter((row) => isOpenStatus(row.status) || hasReasonCodes(row))
    .map((row) => item({
      domain: "tenant-reconciliations",
      category: "additional_rent_reconciliation",
      title: `Tenant reconciliation ${row.period_start || ""} to ${row.period_end || ""}`.trim(),
      description: Array.isArray(row.reason_codes) && row.reason_codes.length
        ? row.reason_codes.join(", ")
        : `Final balance ${row.final_balance ?? 0} (${row.balance_disposition || "review"})`,
      entityReference: row.lease_id || row.id,
      propertyId: row.property_id || null,
      leaseId: row.lease_id || null,
      sourceTable: "tenant_reconciliations",
      sourceRecordId: row.id,
      actionUrl: actionUrl("Reconciliation", { domain: "tenant-reconciliations", record: row.id, lease_id: row.lease_id }),
      dueDate: row.period_end || null,
      assignee: row.assignee || null,
      status: row.status,
      severity: normalizeStatus(row.status) === "blocked" ? "critical" : "high",
      sourceRow: row,
    }));
}
function compareItems(a, b) {
  const severityRank = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  const statusRank = { overdue: 0, expired: 0, blocked: 1, pending_review: 2, submitted: 2, needs_review: 2 };
  const statusDiff = (statusRank[a.status] ?? 5) - (statusRank[b.status] ?? 5);
  if (statusDiff !== 0) return statusDiff;
  const severityDiff = (severityRank[a.severity] ?? 5) - (severityRank[b.severity] ?? 5);
  if (severityDiff !== 0) return severityDiff;
  return String(a.dueDate || "9999-12-31").localeCompare(String(b.dueDate || "9999-12-31"));
}

export function buildAutomationExceptionInbox(operationalRows = {}, { filters = {}, asOfDate } = {}) {
  const allItems = [
    ...financialControlItems(operationalRows.financialControls),
    ...obligationItems(operationalRows.occurrences, asOfDate),
    ...tenantSalesItems(operationalRows.salesReports),
    ...coiItems(operationalRows.coi, asOfDate),
    ...vendorCredentialItems(operationalRows.vendorCredentials, asOfDate),
    ...referenceItems(operationalRows.referenceSeries, operationalRows.referenceData),
    ...leaseChargeItems(operationalRows.leaseChargeReadModel || operationalRows.leaseCharges),
    ...cpiRentProposalItems(operationalRows.cpiRentProposals),
    ...tenantReconciliationItems(operationalRows.tenantReconciliations),
  ].sort(compareItems);

  const filteredItems = allItems.filter((item) => {
    if (filters.propertyId && filters.propertyId !== "all" && item.propertyId !== filters.propertyId) return false;
    if (filters.domain && filters.domain !== "all" && item.domain !== filters.domain) return false;
    if (filters.severity && filters.severity !== "all" && item.severity !== filters.severity) return false;
    if (filters.status && filters.status !== "all" && item.status !== filters.status) return false;
    if (filters.assignee && filters.assignee !== "all" && (item.assignee || "unassigned") !== filters.assignee) return false;
    return true;
  });

  const summary = {
    total: allItems.length,
    critical: allItems.filter((item) => item.severity === "critical").length,
    overdue: allItems.filter((item) => item.status === "overdue" || item.status === "expired").length,
    needsReview: allItems.filter((item) => NEEDS_REVIEW_STATUSES.has(item.status)).length,
    blocked: allItems.filter((item) => item.status === "blocked" || BLOCKED_STATUSES.has(item.status)).length,
  };

  const domainCounts = AUTOMATION_INBOX_DOMAINS.map((domain) => ({
    ...domain,
    count: allItems.filter((item) => item.domain === domain.id).length,
  }));

  const filterOptions = {
    domains: AUTOMATION_INBOX_DOMAINS,
    severities: [...new Set(allItems.map((item) => item.severity))],
    statuses: [...new Set(allItems.map((item) => item.status))],
    assignees: [...new Set(allItems.map((item) => item.assignee || "unassigned"))],
  };

  return { items: allItems, filteredItems, summary, domainCounts, filterOptions };
}



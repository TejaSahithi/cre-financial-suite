import { invokeEdgeFunction } from "@/services/edgeFunctions";
import { supabase } from "@/services/supabaseClient";

export async function computePercentageRent({
  leaseId,
  periodStart,
  periodEnd,
  asOfDate = periodEnd,
} = {}) {
  if (!leaseId) throw new Error("computePercentageRent: leaseId is required");
  if (!periodStart || !periodEnd) {
    throw new Error("computePercentageRent: periodStart and periodEnd are required");
  }

  const response = await invokeEdgeFunction("compute-percentage-rent", {
    lease_id: leaseId,
    period_start: periodStart,
    period_end: periodEnd,
    as_of_date: asOfDate,
  });
  return response.data;
}

export async function generateLeaseObligationOccurrences({
  windowStart,
  windowEnd,
  asOfDate = windowStart,
  leaseId = null,
  propertyId = null,
} = {}) {
  if (!windowStart || !windowEnd) {
    throw new Error("generateLeaseObligationOccurrences: windowStart and windowEnd are required");
  }

  const response = await invokeEdgeFunction("generate-obligation-occurrences", {
    window_start: windowStart,
    window_end: windowEnd,
    as_of_date: asOfDate,
    lease_id: leaseId,
    property_id: propertyId,
  });
  return response.data;
}

export async function evaluateCoiCompliance({
  leaseId,
  coiDocumentId = null,
  requirement = null,
  coi = null,
  asOfDate,
  persist = true,
} = {}) {
  if (!leaseId && !coiDocumentId) {
    throw new Error("evaluateCoiCompliance: leaseId or coiDocumentId is required");
  }

  const response = await invokeEdgeFunction("evaluate-coi-compliance", {
    lease_id: leaseId,
    coi_document_id: coiDocumentId,
    requirement,
    coi,
    as_of_date: asOfDate,
    persist,
  });
  return response.data;
}

export async function checkVendorEligibility({
  vendorId,
  serviceType,
  jurisdiction = null,
  asOfDate,
} = {}) {
  if (!vendorId) throw new Error("checkVendorEligibility: vendorId is required");
  if (!serviceType) throw new Error("checkVendorEligibility: serviceType is required");

  const response = await invokeEdgeFunction("check-vendor-eligibility", {
    vendor_id: vendorId,
    service_type: serviceType,
    jurisdiction,
    as_of_date: asOfDate,
  });
  return response.data;
}

export async function runFinancialControls({
  propertyId,
  fiscalYear,
  varianceThresholdPercent,
} = {}) {
  if (!propertyId) throw new Error("runFinancialControls: propertyId is required");
  if (!fiscalYear) throw new Error("runFinancialControls: fiscalYear is required");

  const response = await invokeEdgeFunction("run-financial-controls", {
    property_id: propertyId,
    fiscal_year: fiscalYear,
    variance_threshold_percent: varianceThresholdPercent,
  });
  return response.data;
}

export async function resolveLeaseTerms({ leaseId, asOfDate } = {}) {
  if (!leaseId) throw new Error("resolveLeaseTerms: leaseId is required");
  if (!asOfDate) throw new Error("resolveLeaseTerms: asOfDate is required");

  const response = await invokeEdgeFunction("resolve-lease-terms", {
    lease_id: leaseId,
    as_of_date: asOfDate,
  });
  return response.data;
}

export async function computeManagementFee({ leaseId, periodStart, periodEnd, asOfDate = periodEnd } = {}) {
  if (!leaseId) throw new Error("computeManagementFee: leaseId is required");
  if (!periodStart || !periodEnd) {
    throw new Error("computeManagementFee: periodStart and periodEnd are required");
  }

  const response = await invokeEdgeFunction("compute-management-fee", {
    lease_id: leaseId,
    period_start: periodStart,
    period_end: periodEnd,
    as_of_date: asOfDate,
  });
  return response.data;
}



export async function computeCpiRentAdjustment({ rentScheduleId, ruleId } = {}) {
  if (!rentScheduleId) throw new Error("computeCpiRentAdjustment: rentScheduleId is required");
  if (!ruleId) throw new Error("computeCpiRentAdjustment: ruleId is required");

  const response = await invokeEdgeFunction("compute-cpi-rent-adjustment", {
    rent_schedule_id: rentScheduleId,
    rule_id: ruleId,
  });
  return response.data;
}
export async function resolveReferenceObservation({ provider = "bls", seriesId = null, seriesHint = null, period, leaseId = null, fieldKey = null, status = null } = {}) {
  if (!period) throw new Error("resolveReferenceObservation: period is required");
  const response = await invokeEdgeFunction("resolve-reference-observation", {
    provider,
    series_id: seriesId,
    series_hint: seriesHint,
    period,
    lease_id: leaseId,
    field_key: fieldKey,
    status,
  });
  return response.data;
}
function requireSupabase() {
  if (!supabase) throw new Error("Supabase client is not configured");
  return supabase;
}

export async function listOperationalDomainRows(tableName, { orgId, filters = {}, select = "*", limit = 250 } = {}) {
  const client = requireSupabase();
  let query = client.from(tableName).select(select).limit(limit);
  if (orgId) query = query.eq("org_id", orgId);
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") query = query.eq(key, value);
  });
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}


export async function listLeaseChargeReadModel({
  orgId = null,
  propertyId = null,
  leaseIds = [],
  periodStart = null,
  periodEnd = null,
  statuses = [],
  chargeTypes = [],
  limit = 500,
} = {}) {
  const client = requireSupabase();
  let query = client
    .from("lease_charge_read_model")
    .select("*")
    .order("period_start", { ascending: false })
    .limit(limit);

  if (orgId) query = query.eq("org_id", orgId);
  if (propertyId) query = query.eq("property_id", propertyId);
  if (Array.isArray(leaseIds) && leaseIds.length > 0) query = query.in("lease_id", leaseIds);
  if (periodStart) query = query.gte("period_end", periodStart);
  if (periodEnd) query = query.lte("period_start", periodEnd);
  if (Array.isArray(statuses) && statuses.length > 0) query = query.in("status", statuses);
  if (Array.isArray(chargeTypes) && chargeTypes.length > 0) query = query.in("charge_type", chargeTypes);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}
export async function saveTenantSalesReport(payload) {
  const client = requireSupabase();
  if (!payload?.lease_id && !payload?.leaseId) throw new Error("saveTenantSalesReport: lease_id is required");
  const row = { ...payload, lease_id: payload.lease_id ?? payload.leaseId };
  delete row.leaseId;
  const { data, error } = await client.from("tenant_sales_reports").upsert(row).select("*").single();
  if (error) throw error;
  return data;
}

export async function reviewTenantSalesReport({ reportId, status, reason = null } = {}) {
  if (!reportId) throw new Error("reviewTenantSalesReport: reportId is required");
  if (status === "approved") return approveSalesReport({ reportId, reason });
  if (status === "rejected") return rejectSalesReport({ reportId, reason });
  if (status === "pending_review") return submitSalesReport({ reportId });
  throw new Error("reviewTenantSalesReport: status must be approved, rejected, or pending_review");
}
export async function saveCoiDocument(payload) {
  const client = requireSupabase();
  if (!payload?.lease_id && !payload?.leaseId) throw new Error("saveCoiDocument: lease_id is required");
  const row = { ...payload, lease_id: payload.lease_id ?? payload.leaseId };
  delete row.leaseId;
  const { data, error } = await client.from("coi_documents").upsert(row).select("*").single();
  if (error) throw error;
  return data;
}

export async function reviewCoiDocument({ coiDocumentId, status, reason = null } = {}) {
  if (!coiDocumentId) throw new Error("reviewCoiDocument: coiDocumentId is required");
  if (status === "approved") return approveCoi({ coiDocumentId, reason });
  if (status === "rejected") return rejectCoi({ coiDocumentId, reason });
  throw new Error("reviewCoiDocument: status must be approved or rejected");
}
export async function saveVendorCredential(payload = {}) {
  const credentialId = payload.id ?? payload.credential_id ?? payload.credentialId;
  const command = credentialId ? "editVendorCredential" : "createVendorCredential";
  const response = await runOperationalReviewCommand(command, {
    ...payload,
    credential_id: credentialId,
    vendor_id: payload.vendor_id ?? payload.vendorId,
  });
  return response.credential;
}

export async function reviewVendorCredential({ credentialId, status, reason = null, verificationSource = undefined, verificationUrl = undefined } = {}) {
  if (!credentialId) throw new Error("reviewVendorCredential: credentialId is required");
  if (["approved", "active", "verified"].includes(status)) return verifyVendorCredential({ credentialId, verificationSource, verificationUrl, reason });
  if (status === "rejected") return revokeVendorCredential({ credentialId, reason });
  throw new Error("reviewVendorCredential: status must be verified/approved/active or rejected");
}
export async function updateFinancialControlFinding({ findingId, status, assignee = undefined, reason = null } = {}) {
  if (!findingId) throw new Error("updateFinancialControlFinding: findingId is required");
  if (status === "active" || status === "pending_review") return acknowledgeFinding({ findingId, reason });
  if (status === "blocked" || status === "assigned") return assignFinding({ findingId, assignee: assignee || "Unassigned", reason });
  if (status === "resolved") return resolveFinding({ findingId, reason });
  if (status === "dismissed") return dismissFinding({ findingId, reason });
  throw new Error("updateFinancialControlFinding: invalid status");
}

export async function runOperationalReviewCommand(command, payload = {}) {
  if (!command) throw new Error("runOperationalReviewCommand: command is required");
  const response = await invokeEdgeFunction("operational-review-command", { command, ...payload });
  return response.data;
}

export const createSalesReport = (payload = {}) => runOperationalReviewCommand("createSalesReport", payload);
export const submitSalesReport = ({ reportId, ...payload } = {}) => runOperationalReviewCommand("submitSalesReport", { report_id: reportId, ...payload });
export const approveSalesReport = ({ reportId, reason = null } = {}) => runOperationalReviewCommand("approveSalesReport", { report_id: reportId, reason });
export const rejectSalesReport = ({ reportId, reason } = {}) => runOperationalReviewCommand("rejectSalesReport", { report_id: reportId, reason });

export const acknowledgeFinding = ({ findingId, reason = null } = {}) => runOperationalReviewCommand("acknowledgeFinding", { finding_id: findingId, reason });
export const assignFinding = ({ findingId, assignee, reason = null } = {}) => runOperationalReviewCommand("assignFinding", { finding_id: findingId, assignee, reason });
export const resolveFinding = ({ findingId, reason } = {}) => runOperationalReviewCommand("resolveFinding", { finding_id: findingId, reason });
export const overrideFindingPolicyDecision = ({ findingId, reason } = {}) => runOperationalReviewCommand("overrideFindingPolicyDecision", { finding_id: findingId, reason });
export const dismissFinding = ({ findingId, reason } = {}) => runOperationalReviewCommand("dismissFinding", { finding_id: findingId, reason });

export const approveCoi = ({ coiDocumentId, requirement = null, asOfDate = undefined, reason = null } = {}) => runOperationalReviewCommand("approveCoi", { coi_document_id: coiDocumentId, requirement, as_of_date: asOfDate, reason });
export const rejectCoi = ({ coiDocumentId, reason } = {}) => runOperationalReviewCommand("rejectCoi", { coi_document_id: coiDocumentId, reason });

export const createVendorCredential = (payload = {}) => runOperationalReviewCommand("createVendorCredential", payload);
export const editVendorCredential = ({ credentialId, ...payload } = {}) => runOperationalReviewCommand("editVendorCredential", { credential_id: credentialId, ...payload });

export const verifyVendorCredential = ({ credentialId, verificationSource = undefined, verificationUrl = undefined, reason = null } = {}) => runOperationalReviewCommand("verifyVendorCredential", { credential_id: credentialId, verification_source: verificationSource, verification_url: verificationUrl, reason });
export const revokeVendorCredential = ({ credentialId, reason } = {}) => runOperationalReviewCommand("revokeVendorCredential", { credential_id: credentialId, reason });

export const satisfyObligation = ({ occurrenceId, reason = null } = {}) => runOperationalReviewCommand("satisfyObligation", { occurrence_id: occurrenceId, reason });
export const waiveObligation = ({ occurrenceId, reason } = {}) => runOperationalReviewCommand("waiveObligation", { occurrence_id: occurrenceId, reason });

export async function runTenantReconciliationCommand(command, payload = {}) {
  if (!command) throw new Error("runTenantReconciliationCommand: command is required");
  const response = await invokeEdgeFunction("tenant-reconciliation-command", { command, ...payload });
  return response.data;
}

export const calculateTenantReconciliation = ({ leaseId, periodStart, periodEnd, fiscalYear = undefined, ...payload } = {}) => {
  if (!leaseId) throw new Error("calculateTenantReconciliation: leaseId is required");
  if (!periodStart || !periodEnd) throw new Error("calculateTenantReconciliation: periodStart and periodEnd are required");
  return runTenantReconciliationCommand("calculateReconciliation", {
    lease_id: leaseId,
    period_start: periodStart,
    period_end: periodEnd,
    fiscal_year: fiscalYear,
    ...payload,
  });
};
export const submitTenantReconciliation = ({ reconciliationId } = {}) => runTenantReconciliationCommand("submitReconciliation", { reconciliation_id: reconciliationId });
export const approveTenantReconciliation = ({ reconciliationId, reason = null } = {}) => runTenantReconciliationCommand("approveReconciliation", { reconciliation_id: reconciliationId, reason });
export const rejectTenantReconciliation = ({ reconciliationId, reason } = {}) => runTenantReconciliationCommand("rejectReconciliation", { reconciliation_id: reconciliationId, reason });
export const postTenantReconciliation = ({ reconciliationId } = {}) => runTenantReconciliationCommand("postReconciliation", { reconciliation_id: reconciliationId });

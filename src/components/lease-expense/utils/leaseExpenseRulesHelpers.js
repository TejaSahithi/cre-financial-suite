import { leaseExpenseRuleService } from "@/services/leaseExpenseRuleService";

export const ROW_STATUS_STYLE = {
  mapped: "bg-emerald-100 text-emerald-700",
  manually_added: "bg-blue-100 text-blue-700",
  needs_review: "bg-amber-100 text-amber-800",
  uncertain: "bg-amber-100 text-amber-800",
  unmapped: "bg-slate-100 text-slate-700",
  missing_value: "bg-red-100 text-red-700",
};

export const ROW_STATUS_LABEL = {
  mapped: "Approved",
  manually_added: "Manually Added",
  needs_review: "Needs Review",
  uncertain: "Uncertain",
  unmapped: "Unmapped",
  missing_value: "Missing Value",
};

export const PAYMENT_TREATMENT_OPTIONS = [
  "included_in_base_rent",
  "separately_billed",
  "tenant_direct_contract",
  "reimbursable",
  "not_applicable",
];

export const TRI_STATE_OPTIONS = ["yes", "no", "conditional"];

export const RECOVERY_METHOD_OPTIONS = [
  "not_applicable",
  "pass_through",
  "pro_rata_share",
  "fixed_amount",
  "capped_amount",
  "included_in_base_rent",
];

export const ALLOCATION_OPTIONS = [
  "none",
  "pro_rata_share",
  "square_footage",
  "usage",
  "fixed",
  "direct",
];

export function toNullableNumber(value) {
  if (value === "" || value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function toBooleanString(value) {
  return value ? "yes" : "no";
}

export function fromBooleanString(value) {
  return value === "yes";
}

export function buildRuleEditForm(rule) {
  return {
    category_name: rule?.category_name || rule?.expense_category || "",
    expense_subcategory: rule?.expense_subcategory || rule?.subcategory_name || "",
    included_in_base_rent: toBooleanString(Boolean(rule?.included_in_base_rent)),
    responsibility: rule?.operational_responsibility || rule?.responsibility || "",
    payment_treatment: rule?.payment_treatment || "not_applicable",
    recoverable_from_tenant: rule?.recoverable_from_tenant || leaseExpenseRuleService.getRecoverableDecision(rule) || "no",
    cam_eligible: rule?.cam_eligible || "no",
    recovery_method: rule?.recovery_method || "not_applicable",
    allocation_basis: rule?.allocation_basis || "none",
    cap_type: rule?.cap_type || "",
    cap_percent: rule?.cap_percent == null ? "" : String(rule.cap_percent),
    cap_amount: rule?.cap_amount == null ? "" : String(rule.cap_amount),
    admin_fee_applicable: toBooleanString(Boolean(rule?.admin_fee_applicable)),
    admin_fee_percent: rule?.admin_fee_percent == null ? "" : String(rule.admin_fee_percent),
    gross_up_applicable: toBooleanString(Boolean(rule?.gross_up_applicable)),
    gross_up_percent: rule?.gross_up_percent == null ? "" : String(rule.gross_up_percent),
    reconciliation_required: toBooleanString(Boolean(rule?.reconciliation_required)),
    notes: rule?.notes || "",
  };
}

export function isApprovedRule(rule) {
  return leaseExpenseRuleService.isRuleApproved(rule);
}

export function needsReviewRule(rule) {
  return !isApprovedRule(rule);
}

export function getRecoverableDecision(rule) {
  return leaseExpenseRuleService.getRecoverableDecision(rule);
}

export function normalizeRuleToken(value) {
  return String(value || "").trim().toLowerCase();
}

export function normalizeDisplayKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export const WEAK_SOURCE_PATTERNS = [
  /included in base rent under/i,
  /recoverable under/i,
  /explicit recurring charge extracted/i,
  /lease mentions this category/i,
  /direct reimbursement obligation/i,
  /mixed included and recoverable treatment/i,
  /tenant pays directly under the lease/i,
  /fixed cam amount extracted/i,
  /percentage rent rules were extracted/i,
  /billable exception charge under/i,
];

export const CATEGORY_EVIDENCE_PATTERNS = {
  common_area_maintenance: [/common\s+area\s+maintenance/i, /\bcam\b/i, /operating\s+expenses?/i],
  operating_expenses: [/operating\s+expenses?/i, /common\s+area\s+maintenance/i, /\bcam\b/i],
  real_estate_taxes: [/real\s+estate\s+tax/i, /property\s+tax/i, /\btaxes\b/i, /assessment/i],
  property_insurance: [/property\s+insurance/i, /\binsurance\b/i],
  utilities: [/utilit/i, /electric/i, /water/i, /gas/i, /sewer/i],
  janitorial: [/janitorial/i, /cleaning/i],
  trash_removal: [/trash/i, /refuse/i, /garbage/i],
  security: [/security\s+(?:service|services|patrol|guard|monitoring)/i],
  landscaping: [/landscap/i],
  snow_removal: [/(?:snow|ice)[\s\S]{0,80}removal/i, /snow\s+plowing/i],
  parking: [/parking[\s\S]{0,120}(?:maintenance|repair|lighting|sweeping|striping|snow|common\s+area|operating\s+expense|cam)/i],
  administrative_fees: [/admin(?:istrative)?\s+fee/i],
  management_fees: [/management\s+fee/i, /property\s+management/i],
  capital_expenditures: [/capital[\s\S]{0,120}(?:expenditure|improvement|replacement|amorti|useful\s+life|cost[-\s]?saving|legally\s+required)/i],
  tenant_insurance: [/tenant\b[\s\S]{0,120}\b(?:insurance|liability|certificate)/i, /commercial\s+general\s+liability/i],
  alterations: [/alteration/i, /tenant\s+improvement/i],
  percentage_rent: [/percentage\s+rent/i, /gross\s+sales/i],
  late_fees: [/late\s+(?:fee|charge)/i, /delinquent/i],
  interest: [/default\s+interest/i, /interest\s+on\s+(?:late|delinquent|overdue)/i],
  legal_enforcement_fees: [/legal/i, /attorney/i, /enforcement/i],
  tenant_caused_damage: [/tenant[-\s]?specific/i, /tenant[-\s]?caused/i, /damage/i, /direct\s+billed/i],
  merchant_association_dues: [/merchant\s+association/i, /marketing\s+fund/i],
};

export const CATEGORY_REJECTION_PATTERNS = {
  security: [/security\s+deposit/i, /deposit/i],
  parking: [/premises\s+known\s+as/i, /parking\s+rights/i],
  property_insurance: [/tenant\s+(?:shall|must|will|agrees).{0,80}(?:maintain|carry|obtain).{0,80}insurance/i],
  tenant_insurance: [/landlord.{0,80}property\s+insurance/i, /property\s+insurance.{0,80}(?:reimburs|recover)/i],
  interest: [/capital\s+expenditure/i, /assignment/i],
};

export function isSupersededRule(rule) {
  return [rule?.row_status, rule?.status, rule?.extraction_status]
    .some((value) => normalizeRuleToken(value) === "superseded");
}

export function displayDedupeKey(row) {
  const rule = row?.rule || {};
  return [
    row?.lease?.id || rule.lease_id || "",
    normalizeDisplayKey(rule.normalized_key || rule.expense_category || rule.category_name),
    normalizeDisplayKey(rule.expense_subcategory || rule.subcategory_name),
  ].join("::");
}

export function scoreDisplayRow(row) {
  const rule = row?.rule || {};
  return [
    isApprovedRule(rule) ? 1000 : 0,
    rule.published_to_cam ? 500 : 0,
    normalizeRuleToken(rule.extraction_version) === "lease_rule_pipeline_v3_evidence_aligned" ? 250 : 0,
    normalizeRuleToken(rule.generation_source) === "template_checklist" ? -100 : 0,
    String(rule.exact_source_text || rule.source || "").trim() ? 80 : 0,
    Number.isFinite(Number(rule.confidence_score || rule.confidence))
      ? Math.round(Number(rule.confidence_score || rule.confidence) * 100)
      : 0,
  ].reduce((sum, score) => sum + score, 0);
}

export function hasManualOverrideNote(rule) {
  return String(rule?.notes || rule?.reasoning_summary || "").trim().length > 0;
}

export function isManualOverrideRule(rule) {
  return [
    rule?.created_from,
    rule?.generation_source,
    rule?.source_type,
  ].some((value) => ["manual", "manual_override", "user_override"].includes(normalizeRuleToken(value))) ||
    normalizeRuleToken(rule?.row_status) === "manually_added";
}

export function isHumanApprovedOrManualRule(rule) {
  const weak = isWeakOrFallbackRule(rule);
  const manualWithNote = isManualOverrideRule(rule) && hasManualOverrideNote(rule);
  if (weak) return manualWithNote;
  return isApprovedRule(rule) || manualWithNote;
}

export function getRuleSourceText(rule) {
  const firstClause = Array.isArray(rule?.clauses) ? rule.clauses[0] : null;
  return [
    firstClause?.clause_text,
    firstClause?.source_text,
    firstClause?.evidence_text,
    firstClause?.text,
    rule?.exact_source_text,
    rule?.source_clause_text,
    rule?.source_clause,
    rule?.clause_text,
    rule?.evidence_text,
    rule?.source_text,
    rule?.source,
  ].find((value) => String(value || "").trim()) || "";
}

export function isWeakRuleSourceText(text) {
  const normalized = String(text || "").trim();
  if (!normalized || normalized.length < 18) return true;
  return WEAK_SOURCE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function hasSourcePageEvidence(rule) {
  const page = Number(rule?.source_page ?? rule?.page_number ?? rule?.evidence_page_number);
  if (Number.isFinite(page) && page > 0) return true;
  const firstClause = Array.isArray(rule?.clauses) ? rule.clauses[0] : null;
  const clausePage = Number(firstClause?.page_number);
  return Number.isFinite(clausePage) && clausePage > 0;
}

export function hasStrongLeaseEvidence(rule) {
  const sourceText = getRuleSourceText(rule);
  if (isWeakRuleSourceText(sourceText) && !hasSourcePageEvidence(rule)) return false;
  return sourceSupportsRuleCategory(rule, sourceText);
}

export function sourceSupportsRuleCategory(rule, sourceText) {
  const categoryKey = normalizeDisplayKey(rule.normalized_key || rule.expense_subcategory || rule.expense_category || rule.category_name);
  const text = String(sourceText || "");
  if (!text.trim()) return false;
  const rejectionPatterns = CATEGORY_REJECTION_PATTERNS[categoryKey] || [];
  if (rejectionPatterns.some((pattern) => pattern.test(text))) return false;
  const paymentTreatment = normalizeRuleToken(rule?.payment_treatment);
  const recoveryMethod = normalizeRuleToken(rule?.recovery_method);
  const isIncluded = rule?.included_in_base_rent === true || paymentTreatment === "included_in_base_rent" || recoveryMethod === "included_in_base_rent";
  const isTenantDirect = paymentTreatment === "tenant_direct_contract" || recoveryMethod === "tenant_direct_contract";
  const isExplicitExclusion = rule?.is_excluded === true || /excluded\s+from|not\s+included\s+in/i.test(text);
  if (isIncluded && /included\s+in\s+(?:base\s+)?rent|full[-\s]?service|gross\s+lease|base\s+rent\s+includes/i.test(text)) return true;
  if (isTenantDirect && /tenant\s+(?:shall|must|will|agrees\s+to)|separately\s+metered|direct(?:ly)?\s+to|at\s+tenant'?s\s+(?:sole\s+)?(?:cost|expense)/i.test(text)) return true;
  if (isExplicitExclusion) return true;
  const evidencePatterns = CATEGORY_EVIDENCE_PATTERNS[categoryKey] || [];
  if (evidencePatterns.length === 0) return true;
  return evidencePatterns.some((pattern) => pattern.test(text));
}

export function isWeakOrFallbackRule(rule) {
  const tokens = [
    rule?.generation_source,
    rule?.source_type,
    rule?.created_from,
    rule?.extraction_status,
    rule?.row_status,
    rule?.status,
  ].map(normalizeRuleToken);
  return tokens.some((token) => [
    "template_checklist",
    "weak_evidence",
    "not_found",
    "not_mentioned",
    "amount_only_gap",
    "text_fallback_keyword",
    "text_fallback",
    "unsupported",
    "unsupported_fallback",
    "original_lease_required",
    "missing_source_evidence",
    "inferred",
  ].includes(token));
}

export function isHardCoverageGapRule(rule) {
  const tokens = [
    rule?.generation_source,
    rule?.source_type,
    rule?.created_from,
    rule?.extraction_status,
    rule?.row_status,
    rule?.status,
  ].map(normalizeRuleToken);
  return tokens.some((token) => [
    "template_checklist",
    "not_found",
    "not_mentioned",
    "amount_only_gap",
    "unsupported",
    "unsupported_fallback",
    "original_lease_required",
    "missing_source_evidence",
  ].includes(token));
}

export function isLeaseDerivedRule(rule) {
  if (isSupersededRule(rule)) return false;
  if (isHumanApprovedOrManualRule(rule)) return true;
  if (isHardCoverageGapRule(rule)) return false;
  const generationSource = normalizeRuleToken(rule?.generation_source);
  const sourceType = normalizeRuleToken(rule?.source_type);
  const evidenceAligned = [
    generationSource,
    sourceType,
    normalizeRuleToken(rule?.extraction_version),
  ].some((token) =>
    token.includes("llm") ||
    token.includes("lease_text") ||
    token.includes("evidence_aligned") ||
    token.includes("lease_rule_pipeline_v3") ||
    token.includes("rule_extractor") ||
    token.includes("text_fallback")
  );
  return hasStrongLeaseEvidence(rule) && (evidenceAligned || Boolean(getRuleSourceText(rule)) || hasSourcePageEvidence(rule));
}

export function isCoverageGapRule(rule) {
  if (isSupersededRule(rule)) return false;
  if (isLeaseDerivedRule(rule)) return false;
  return true;
}

export function getCoverageGapLabel(rule) {
  const tokens = [
    rule?.generation_source,
    rule?.source_type,
    rule?.extraction_status,
    rule?.row_status,
    rule?.status,
  ].map(normalizeRuleToken);
  if (tokens.includes("original_lease_required")) return "Original lease required";
  if (tokens.includes("weak_evidence")) return "Weak evidence";
  if (tokens.includes("not_found") || tokens.includes("not_mentioned")) return "Not found in lease / Needs Review";
  if (tokens.includes("template_checklist")) return "Checklist gap / Needs Review";
  if (tokens.includes("amount_only_gap")) return "Amount gap / Needs Review";
  if (tokens.includes("text_fallback_keyword") || tokens.includes("text_fallback")) return "Keyword fallback / Needs Review";
  return "Unsupported category / Needs Review";
}

export function getOperationalResponsibility(rule) {
  return leaseExpenseRuleService.getOperationalResponsibility(rule);
}

export function getSourcePage(rule) {
  return leaseExpenseRuleService.getSourcePage(rule);
}

export function getExactSourceText(rule) {
  return leaseExpenseRuleService.getExactSourceText(rule);
}

export function getRuleValidation(rule) {
  return leaseExpenseRuleService.getRuleValidation(rule);
}

export function getCamPublishStatus(rule, validation) {
  if (rule?.published_to_cam === true) {
    return { label: "CAM Published", tone: "emerald" };
  }

  const blockers = Array.isArray(validation?.publishBlockers) ? validation.publishBlockers : [];

  if (blockers.some((b) => /Already published/i.test(b))) {
    return { label: "Already Published to CAM", tone: "emerald" };
  }

  const reasonOrder = [
    { test: (b) => /Included in rent/i.test(b), reason: "Included in base rent" },
    { test: (b) => /Tenant direct/i.test(b), reason: "Tenant direct responsibility" },
    { test: (b) => /Excluded/i.test(b), reason: "Explicitly excluded" },
    { test: (b) => /Not CAM eligible/i.test(b), reason: "Conditional rule" },
    { test: (b) => /Not recoverable/i.test(b), reason: "Not recoverable" },
    { test: (b) => /Not reviewed/i.test(b), reason: "Awaiting review" },
    { test: (b) => /Not approved/i.test(b), reason: "Awaiting approval" },
  ];

  for (const check of reasonOrder) {
    if (blockers.some(check.test)) {
      return { label: `Not Published to CAM: ${check.reason}`, tone: "amber" };
    }
  }

  if (blockers.some((b) => /Missing lease evidence/i.test(b))) {
    const created = String(rule?.created_from || "").toLowerCase();
    const gen = String(rule?.generation_source || "").toLowerCase();
    const isManualOverride =
      created === "manual" ||
      created === "user_override" ||
      gen === "manual" ||
      gen === "user_override" ||
      String(rule?.row_status || "").toLowerCase() === "manually_added";
    const reason = isManualOverride ? "Manual override note required" : "Missing lease evidence";
    return { label: `Not Published to CAM: ${reason}`, tone: "amber" };
  }

  if (blockers.length === 0) {
    return { label: "Not Published to CAM", tone: "slate" };
  }
  return { label: `Not Published to CAM: ${blockers[0]}`, tone: "amber" };
}

export function getDisplayCamPublishStatus(rule, validation, displayMode) {
  const status = getCamPublishStatus(rule, validation);
  if (
    displayMode === "gaps" &&
    status.tone === "emerald" &&
    !(isHumanApprovedOrManualRule(rule) && hasManualOverrideNote(rule))
  ) {
    return { label: "Not Published to CAM: Needs Review", tone: "amber" };
  }
  return status;
}

export function buildRuleWorkflowPatch(rule, validation, overrides = {}) {
  return {
    included_in_base_rent: validation.includedInBaseRent,
    operational_responsibility: getOperationalResponsibility(rule),
    payment_treatment: validation.paymentTreatment,
    recoverable_from_tenant: validation.recoverableFromTenant,
    cam_eligible: validation.camEligible,
    recovery_method: validation.recoveryMethod,
    allocation_basis: validation.allocationBasis,
    source_page: validation.sourcePage,
    exact_source_text: validation.exactSourceText || null,
    ...overrides,
  };
}

export function buildRuleHierarchyPatch(lease) {
  return {
    org_id: lease?.org_id || null,
    lease_id: lease?.id || null,
    property_id: lease?.property_id || null,
    building_id: lease?.building_id || null,
    unit_id: lease?.unit_id || null,
    tenant_id: lease?.tenant_id || null,
  };
}

export function humanizeToken(value) {
  const text = String(value || "").replace(/[_-]+/g, " ").trim();
  if (!text) return "-";
  return text.replace(/\b\w/g, (char) => char.toUpperCase());
}

export function formatTriState(value) {
  if (!value) return "-";
  if (value === "yes") return "Yes";
  if (value === "no") return "No";
  if (value === "conditional") return "Conditional";
  return humanizeToken(value);
}

export function formatConfidence(value) {
  if (value == null) return "-";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "-";
  return `${Math.round(numeric <= 1 ? numeric * 100 : numeric)}%`;
}

export function truncate(value, length = 140) {
  const text = String(value || "");
  if (!text) return "-";
  return text.length > length ? `${text.slice(0, length)}...` : text;
}

export function pickPreferredRuleSet(ruleSets = [], rulesBySet = new Map()) {
  return leaseExpenseRuleService.pickPreferredRuleSetWithApprovedChildren(ruleSets, rulesBySet);
}

export function getLeaseBuildingId(lease, scope) {
  const unit = lease?.unit_id ? scope.unitById.get(lease.unit_id) ?? null : null;
  return lease?.building_id || unit?.building_id || null;
}

export function buildDisplayRows(ruleSetsByLease, leaseById, categoryById, scopePropertyById) {
  const rows = [];
  for (const entry of ruleSetsByLease) {
    const lease = leaseById.get(entry.leaseId);
    const property = lease?.property_id ? scopePropertyById.get(lease.property_id) ?? null : null;
    for (const rule of entry.rules || []) {
      if (isSupersededRule(rule)) continue;
      rows.push({
        rule,
        ruleSet: entry.ruleSet,
        lease,
        property,
        category: rule.expense_category_id ? categoryById.get(rule.expense_category_id) : null,
      });
    }
  }
  return rows;
}

export function dedupeDisplayRows(rows) {
  const dedupedRows = new Map();
  for (const row of rows) {
    const key = displayDedupeKey(row);
    const existing = dedupedRows.get(key);
    if (!existing || scoreDisplayRow(row) >= scoreDisplayRow(existing)) {
      dedupedRows.set(key, row);
    }
  }
  return [...dedupedRows.values()];
}

export function calculateRuleCounts(flattenedRows) {
  const summary = {
    all: flattenedRows.length,
    recoverable: 0,
    non_recoverable: 0,
    conditional: 0,
    needs_review: 0,
    approved: 0,
  };

  for (const { rule } of flattenedRows) {
    const decision = getRecoverableDecision(rule);
    if (decision === "yes" && !rule.is_excluded) summary.recoverable += 1;
    if (decision === "no" || rule.is_excluded) summary.non_recoverable += 1;
    if (decision === "conditional" && !rule.is_excluded) summary.conditional += 1;
    if (needsReviewRule(rule)) summary.needs_review += 1;
    if (isApprovedRule(rule)) summary.approved += 1;
  }

  return summary;
}

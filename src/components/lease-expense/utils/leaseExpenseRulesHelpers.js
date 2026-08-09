import { leaseExpenseRuleService } from "@/services/leaseExpenseRuleService";
import { normalizeLeaseExpenseRule } from "@/services/utils/leaseExpenseRuleTaxonomy";
import { deriveRuleDecision, isRuleSuperseded, deriveNormalizedContractModel } from "@/services/utils/ruleDecisionEngine";

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
  if (rule.id) return `id::${rule.id}`;
  if (rule.rule_key) return `rule_key::${rule.rule_key}`;
  return [
    row?.lease?.id || rule.lease_id || "",
    normalizeDisplayKey(rule.normalized_key || rule.expense_category || rule.category_name),
    normalizeDisplayKey(rule.expense_subcategory || rule.subcategory_name),
    normalizeDisplayKey(rule.payment_treatment),
    normalizeDisplayKey(rule.recovery_method),
    normalizeDisplayKey(rule.allocation_basis),
    normalizeDisplayKey(rule.rule_type),
    normalizeDisplayKey(rule.source_page),
    normalizeDisplayKey(rule.exact_source_text || rule.source_text || rule.source),
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

// Read-only display of the EXISTING materialize_lease_recovery_policy
// outcome for this rule (auto-triggered on approve) -- never computed by
// redoing the RPC's own hash/eligibility logic, only by reading what it
// already wrote to lease_recovery_policies. `policies` must be pre-sorted
// newest-first by the caller (created_at desc).
//   Ready      -- current materialized policy is active (status='approved').
//   Superseded -- the only/latest policy row(s) for this rule are all
//                 superseded, with no active replacement.
//   Blocked    -- no policy exists yet AND the lease has no premises on
//                 file -- materialization's own real precondition, so this
//                 will not resolve on its own without upstream data.
//   Pending    -- no policy exists yet, but the lease does have premises --
//                 materialization is expected to catch up (e.g. via Prepare
//                 CAM Automatically), just hasn't run yet for this rule.
// The rule's own approval-lifecycle status (distinct from resolveCamPolicyStatus,
// which only describes whether an already-approved rule has a materialized CAM
// recovery policy). Reuses the canonical deriveRuleDecision/isRuleSuperseded
// engine (ruleDecisionEngine.js) instead of reading rule.approval_status
// directly, so "not_applicable" (structurally excluded rules) and superseded
// rules render as such rather than falling through to a generic Approved/Pending
// badge.
const RULE_APPROVAL_STATUS_DISPLAY = {
  approved: { label: "Approved", tone: "emerald" },
  rejected: { label: "Rejected", tone: "red" },
  not_applicable: { label: "Not Applicable", tone: "slate" },
  needs_review: { label: "Needs Review", tone: "amber" },
};

export function resolveRuleApprovalStatusDisplay(rule) {
  // Two independent "superseded" signals exist in this codebase: isRuleSuperseded
  // (row_status/status/extraction_status -- duplicate-clause/draft-version
  // detection) and approval_status='superseded' (set directly by the
  // supersede-duplicate-lease cascade, 20269900000036). Either means the same
  // thing to a reviewer: this rule's terms are no longer the active ones.
  if (isRuleSuperseded(rule) || normalizeRuleToken(rule?.approval_status) === "superseded") {
    return { label: "Superseded", tone: "slate" };
  }
  const status = deriveRuleDecision(rule).status;
  return RULE_APPROVAL_STATUS_DISPLAY[status] || { label: "Draft", tone: "slate" };
}

export function resolveCamPolicyStatus(rule, policies = [], leaseHasPremises = false) {
  if (!isApprovedRule(rule)) return null;
  if (policies.length === 0) {
    return leaseHasPremises
      ? { label: "CAM Policy Pending", tone: "amber" }
      : { label: "CAM Policy Blocked", tone: "red" };
  }
  const current = policies[0];
  if (current.status === "approved") return { label: "CAM Policy Ready", tone: "emerald" };
  if (current.status === "superseded") return { label: "CAM Policy Superseded", tone: "slate" };
  if (current.status === "rejected") return { label: "CAM Policy Blocked", tone: "red" };
  return { label: "CAM Policy Pending", tone: "amber" };
}

// ---------------------------------------------------------------------------
// Simplified-view derivations for the main Lease Expense Rules table.
//
// These are presentation-only groupings on top of the existing
// deriveNormalizedContractModel()/deriveRuleDecision() engine
// (ruleDecisionEngine.js) — no financial/approval logic lives here. The
// model's own recovery_treatment / cam_participation / actual_expense_expected
// vocabularies were already an exact 1:1 fit for the simplified Treatment /
// CAM / Actual Expense columns, so this just labels and (for Contract
// Status / Policy Status) folds a couple of adjacent states together for a
// single badge instead of the previous two-or-three-badge stack.
// ---------------------------------------------------------------------------

export const TREATMENT_LABELS = {
  pooled_recovery: "Landlord Recoverable",
  direct_recovery: "Direct Recovery",
  direct_bill: "Direct Bill",
  tenant_direct: "Tenant Direct",
  included_in_rent: "Included in Rent",
  compliance_only: "Compliance Only",
  nonrecoverable: "Nonrecoverable",
  conditional: "Conditional",
};

export const CAM_STATUS_LABELS = {
  eligible: "Eligible",
  conditional: "Conditional",
  not_applicable: "N/A",
  blocked: "Blocked",
};

export const ACTUAL_EXPENSE_LABELS = {
  yes: "Expected",
  no: "Not Expected",
  conditional: "Conditional",
};

export const CONTRACT_STATUS_LABELS = {
  approved: "Approved",
  rejected: "Rejected",
  needs_review: "Needs Review",
  superseded: "Superseded",
};

// Treatments where nothing is ever pooled/published to CAM — a landlord
// recovery policy is structurally not a thing for these, not merely absent.
const NON_CAM_PARTICIPATING_TREATMENTS = new Set([
  "tenant_direct", "included_in_rent", "compliance_only", "direct_bill", "nonrecoverable",
]);

/** Treatment + CAM + Actual Expense — one label each, straight off the existing contract model. */
export function getSimplifiedRuleView(rule) {
  const model = deriveNormalizedContractModel(rule);
  return {
    treatment: model.recovery_treatment,
    treatmentLabel: TREATMENT_LABELS[model.recovery_treatment] || humanizeToken(model.recovery_treatment),
    cam: model.cam_participation,
    camLabel: CAM_STATUS_LABELS[model.cam_participation] || humanizeToken(model.cam_participation),
    actualExpense: model.actual_expense_expected,
    actualExpenseLabel: ACTUAL_EXPENSE_LABELS[model.actual_expense_expected] || humanizeToken(model.actual_expense_expected),
    model,
  };
}

/**
 * Single Contract Status badge (Needs Review / Approved / Rejected /
 * Superseded), replacing the previous "Approved" + "Approved Contractual
 * Rule" double badge. `superseded` is checked ahead of deriveRuleDecision
 * because the decision engine folds it into "draft" (see
 * ruleDecisionEngine.js's deriveRuleStatus). `draft` (not yet reviewed) and
 * `not_applicable` (reviewed, determined to be a non-recoverable/no-action
 * term) both fold into the nearest of the four requested values — Needs
 * Review and Rejected respectively — since this table intentionally exposes
 * only four contract-status values.
 */
export function getContractStatus(rule) {
  if (isRuleSuperseded(rule)) {
    return { value: "superseded", label: CONTRACT_STATUS_LABELS.superseded, tone: "slate" };
  }
  const { status } = deriveRuleDecision(rule);
  const value = status === "draft" ? "needs_review" : status === "not_applicable" ? "rejected" : status;
  const tone = value === "approved" ? "emerald" : value === "rejected" ? "red" : "amber";
  return { value, label: CONTRACT_STATUS_LABELS[value] || humanizeToken(value), tone };
}

/**
 * CAM recovery-policy materialization status, gated by treatment first:
 * non-participating treatments always read "Not Required" regardless of
 * what resolveCamPolicyStatus would otherwise compute (there is nothing to
 * materialize for a tenant-direct or included-in-rent term). Otherwise
 * defers to the existing resolveCamPolicyStatus (Ready/Pending/
 * Blocked/Superseded, only meaningful once the rule itself is approved),
 * and attaches a human reason to a Blocked result so it's never shown bare.
 */
export function getPolicyStatus(rule, policies = [], leaseHasPremises = false) {
  const model = deriveNormalizedContractModel(rule);
  if (NON_CAM_PARTICIPATING_TREATMENTS.has(model.recovery_treatment)) {
    return { label: "Not Required", tone: "slate", reason: null };
  }
  const base = resolveCamPolicyStatus(rule, policies, leaseHasPremises);
  if (!base) return null;
  if (base.label !== "CAM Policy Blocked") return { ...base, reason: null };
  const reason = policies.length === 0
    ? (leaseHasPremises
      ? "No recovery policy has been materialized for this approved rule yet."
      : "Lease has no premises/area on file — required before a recovery policy can be materialized.")
    : "The materialized recovery policy for this rule was rejected.";
  return { ...base, reason };
}

// Read-only match status for an actual-expense classification row (matched_
// classification / actual_missing_rule rowType only -- coverage-gap rows
// have no expense to match against and return null). Describes the OUTCOME
// of matching this ONE actual expense against approved lease rules/policies
// -- it never creates a second row per lease or per matched rule; the
// underlying buildClassificationRows() one-row-per-approved-actual-expense
// invariant is unchanged, this only adds a display field to that same row.
const MATCH_STATUS_DISPLAY = {
  no_policy_required: { label: "No Policy Required", tone: "slate" },
  needs_review: { label: "Needs Review", tone: "amber" },
  no_policy_coverage: { label: "No Policy Coverage", tone: "red" },
  multiple_policy_matches: { label: "Multiple Policy Matches", tone: "amber" },
  direct_tenant_policy_found: { label: "Direct Tenant Policy Found", tone: "emerald" },
  policy_coverage_found: { label: "Policy Coverage Found", tone: "emerald" },
};

export function resolveMatchStatus(row) {
  if (row?.rowType !== "matched_classification" && row?.rowType !== "actual_missing_rule") return null;

  if (!row.rule) {
    if (row.camEligible === "no") return { state: "no_policy_required", ...MATCH_STATUS_DISPLAY.no_policy_required };
    if (row.camEligible === "needs_review") return { state: "needs_review", ...MATCH_STATUS_DISPLAY.needs_review };
    return { state: "no_policy_coverage", ...MATCH_STATUS_DISPLAY.no_policy_coverage };
  }
  if ((row.matchCandidateCount || 0) > 1) {
    return { state: "multiple_policy_matches", ...MATCH_STATUS_DISPLAY.multiple_policy_matches };
  }
  if (leaseExpenseRuleService.getBillingTreatment(row.rule) === "direct_bill") {
    return { state: "direct_tenant_policy_found", ...MATCH_STATUS_DISPLAY.direct_tenant_policy_found };
  }
  return { state: "policy_coverage_found", ...MATCH_STATUS_DISPLAY.policy_coverage_found };
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
      const normalizedRule = normalizeLeaseExpenseRule(rule);
      rows.push({
        rule: normalizedRule,
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

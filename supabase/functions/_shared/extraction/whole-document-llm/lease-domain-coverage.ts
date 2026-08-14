// @ts-nocheck

export const LEASE_DOMAIN_COVERAGE_VERSION = "lease-commercial-domain-coverage-v1";

export type LeaseDomainCoverageStatus =
  | "source_backed"
  | "needs_review"
  | "not_stated_after_review"
  | "partial"
  | "failed"
  | "not_attempted";

export interface LeaseDomainCoverageEntry {
  domainKey: string;
  label: string;
  status: LeaseDomainCoverageStatus;
  criticalFor: string[];
  fixedFieldsExpected: string[];
  fixedFieldsFound: string[];
  fixedFieldsNeedsReview: string[];
  fixedFieldsNotStated: string[];
  dynamicFindingCount: number;
  expenseRuleCandidateCount: number;
  sourceBackedEvidenceCount: number;
  processedGroups: string[];
  skippedGroups: string[];
  failedGroups: string[];
  warnings: string[];
}

export interface LeaseDomainCoverageLedger {
  version: typeof LEASE_DOMAIN_COVERAGE_VERSION;
  architecture: string;
  completeDocumentReviewed: boolean;
  domains: LeaseDomainCoverageEntry[];
  totals: {
    domainCount: number;
    sourceBacked: number;
    needsReview: number;
    notStatedAfterReview: number;
    partial: number;
    failed: number;
    notAttempted: number;
  };
}

interface LeaseDomainDefinition {
  domainKey: string;
  label: string;
  criticalFor: string[];
  fixedFields: string[];
  groupNames: string[];
  dynamicPattern: RegExp;
  expensePattern?: RegExp;
}

const DOMAIN_DEFINITIONS: LeaseDomainDefinition[] = [
  {
    domainKey: "rent_schedule",
    label: "Base rent, rent schedules, charges, and abatements",
    criticalFor: ["lease", "budget"],
    fixedFields: [
      "monthly_rent",
      "annual_rent",
      "rent_per_sf",
      "billing_frequency",
      "security_deposit",
      "free_rent_months",
      "ti_allowance",
      "amended_base_rent_for_additional_year",
    ],
    groupNames: ["rent_amounts", "deposit_and_escalation", "fees_and_charges", "term_length_and_incentives"],
    dynamicPattern: /\b(base\s+rent|minimum\s+rent|rent\s+schedule|free\s+rent|abatement|security\s+deposit|tenant\s+improvement|ti\s+allowance|amortiz)/i,
  },
  {
    domainKey: "cam_recoveries",
    label: "CAM and operating expense recoveries",
    criticalFor: ["cam", "budget", "reconciliation"],
    fixedFields: ["cam_amount", "base_year", "expense_stop"],
    groupNames: ["expense_recovery", "deposit_and_escalation", "cam_structure"],
    dynamicPattern: /\b(cam|common\s+area|operating\s+expense|additional\s+rent|expense\s+stop|base\s+year|reconciliation|recover)/i,
    expensePattern: /\b(cam|common_area|operating|recovery|recoverable|additional_rent)\b/i,
  },
  {
    domainKey: "pro_rata_vacancy",
    label: "Pro-rata share, allocation basis, vacancy, and occupancy adjustment",
    criticalFor: ["cam", "budget"],
    fixedFields: ["square_footage", "building_rsf"],
    groupNames: ["premises_and_use", "cam_structure", "expense_recovery"],
    dynamicPattern: /\b(pro[-\s]?rata|proportionate\s+share|tenant'?s\s+share|rentable\s+area|building\s+rsf|occupancy|vacancy|allocation\s+basis)\b/i,
    expensePattern: /\b(pro[-_]?rata|proportionate|allocation|occupancy|vacancy|share)\b/i,
  },
  {
    domainKey: "caps_exclusions",
    label: "Caps, exclusions, controllable expenses, and recoverability limits",
    criticalFor: ["cam", "budget", "reconciliation"],
    fixedFields: ["cam_cap_type", "cam_cap_pct"],
    groupNames: ["cam_structure", "expense_recovery"],
    dynamicPattern: /\b(cap|capped|controllable|excluded|exclusion|non[-\s]?recoverable|capital\s+expenditure|limitation)\b/i,
    expensePattern: /\b(cap|controllable|excluded|exclusion|nonrecoverable|capital)\b/i,
  },
  {
    domainKey: "gross_up_management_fee",
    label: "Gross-up, administrative fee, and management fee rules",
    criticalFor: ["cam", "budget"],
    fixedFields: ["gross_up_enabled", "gross_up_threshold", "admin_fee_pct", "management_fee_basis"],
    groupNames: ["cam_structure"],
    dynamicPattern: /\b(gross[-\s]?up|grossed\s+up|management\s+fee|administrative\s+fee|admin\s+fee)\b/i,
    expensePattern: /\b(gross[-_]?up|management|administrative|admin_fee)\b/i,
  },
  {
    domainKey: "taxes",
    label: "Real estate tax responsibility and recovery",
    criticalFor: ["cam", "budget", "reconciliation"],
    fixedFields: ["tax_responsibility", "responsibility_taxes"],
    groupNames: ["expense_recovery", "utilities_and_responsibility"],
    dynamicPattern: /\b(real\s+estate\s+tax|property\s+tax|taxes|assessment)\b/i,
    expensePattern: /\b(tax|assessment)\b/i,
  },
  {
    domainKey: "insurance",
    label: "Insurance, COI, additional insured, and waiver requirements",
    criticalFor: ["lease", "cam", "operations"],
    fixedFields: [
      "insurance_responsibility",
      "responsibility_insurance",
      "property_insurance_responsibility",
      "tenant_insurance_required",
      "general_liability_min",
      "waiver_of_subrogation",
      "additional_insureds_required",
    ],
    groupNames: ["insurance", "expense_recovery", "utilities_and_responsibility"],
    dynamicPattern: /\b(insurance|certificate\s+of\s+insurance|coi|additional\s+insured|waiver\s+of\s+subrogation|liability|coverage|policy)\b/i,
    expensePattern: /\b(insurance|liability|coverage|coi|insured)\b/i,
  },
  {
    domainKey: "hvac_vendor_obligations",
    label: "HVAC, vendor, repair, maintenance, utility, and service obligations",
    criticalFor: ["operations", "expense", "cam"],
    fixedFields: [
      "hvac_responsibility",
      "responsibility_repairs",
      "responsibility_utilities",
      "electric_responsibility",
      "water_sewer_responsibility",
      "utility_reimbursement_amount",
      "water_sewer_reimbursement_amount",
    ],
    groupNames: ["cam_structure", "utilities_and_responsibility", "expense_recovery"],
    dynamicPattern: /\b(hvac|vendor|maintenance|repair|replace|service\s+contract|utility|electric|water|sewer|janitorial|trash|landscap|snow)\b/i,
    expensePattern: /\b(hvac|vendor|maintenance|repair|utility|electric|water|sewer|janitorial|trash|landscap|snow|service)\b/i,
  },
  {
    domainKey: "cpi_escalations",
    label: "CPI, fixed escalations, index adjustments, and timing",
    criticalFor: ["rent", "budget"],
    fixedFields: ["escalation_rate", "escalation_type", "escalation_timing"],
    groupNames: ["deposit_and_escalation", "rent_amounts"],
    dynamicPattern: /\b(cpi|consumer\s+price\s+index|index|escalat|increase|adjustment|anniversary)\b/i,
  },
  {
    domainKey: "percentage_rent",
    label: "Percentage rent, breakpoints, sales reporting, and audit rights",
    criticalFor: ["rent", "budget", "reconciliation"],
    fixedFields: [],
    groupNames: ["rent_amounts", "fees_and_charges"],
    dynamicPattern: /\b(percentage\s+rent|gross\s+sales|breakpoint|natural\s+breakpoint|sales\s+report|sales\s+audit)\b/i,
  },
  {
    domainKey: "options_critical_dates",
    label: "Options, notices, cure periods, defaults, and critical dates",
    criticalFor: ["lease", "operations", "budget"],
    fixedFields: [
      "renewal_options",
      "renewal_type",
      "renewal_notice_months",
      "termination_notice_months",
      "option_exercise_deadline",
      "early_termination_option",
      "right_of_first_refusal",
      "default_cure_period",
    ],
    groupNames: ["legal_options", "renewal_and_notice_dates", "term_dates", "term_length_and_incentives"],
    dynamicPattern: /\b(renewal|option|notice|termination|cure|default|critical\s+date|deadline|rofr|right\s+of\s+first|audit\s+right)\b/i,
  },
  {
    domainKey: "parties_premises_term",
    label: "Parties, premises, term, use, and core lease identity",
    criticalFor: ["lease", "cam", "budget"],
    fixedFields: [
      "tenant_name",
      "landlord_name",
      "property_name",
      "property_address",
      "unit_number",
      "square_footage",
      "lease_type",
      "permitted_use",
      "start_date",
      "commencement_date",
      "end_date",
      "expiration_date",
      "rent_commencement_date",
      "lease_term_months",
    ],
    groupNames: [
      "party_entities",
      "premises_identity",
      "term_dates",
      "execution_and_rent_commencement_dates",
      "premises_and_use",
      "term_length_and_incentives",
    ],
    dynamicPattern: /\b(tenant|landlord|premises|leased\s+premises|commencement|expiration|term|permitted\s+use|square\s+feet|rentable)\b/i,
  },
];

function normalizeString(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function toSet(values: unknown): Set<string> {
  return new Set((Array.isArray(values) ? values : []).map((value) => normalizeString(value)).filter(Boolean));
}

function itemText(item: Record<string, unknown>): string {
  return [
    item.field_key,
    item.label,
    item.business_area,
    item.businessArea,
    item.business_meaning,
    item.businessMeaning,
    item.value,
    item.normalized_value,
    item.raw_value,
    item.source_text,
    item.sourceQuote,
    item.category,
    item.expense_category,
    item.expense_subcategory,
    item.obligationKind,
    item.obligation_kind,
    item.recovery_treatment,
    item.recoveryTreatment,
    item.amount_formula,
    item.amountFormula,
    item.inclusions,
    item.exclusions,
    item.audit_right,
  ].map((value) => Array.isArray(value) ? value.join(" ") : normalizeString(value)).join(" ");
}

function hasReviewStatus(status: unknown): boolean {
  const value = normalizeString(status).toLowerCase();
  return ["needs_review", "manual_review", "ambiguous", "conflicting", "conflict", "illegible", "provisional"].includes(value);
}

export function buildLeaseDomainCoverage(args: {
  architecture: string;
  completeDocumentReviewed: boolean;
  requestedFieldKeys?: string[];
  fieldStatuses?: Record<string, unknown>;
  evidenceAnchors?: Array<Record<string, unknown>>;
  dynamicItems?: Array<Record<string, unknown>>;
  expenseRuleCandidates?: Array<Record<string, unknown>>;
  processedGroupNames?: string[];
  skippedGroupNames?: string[];
  failedGroupNames?: string[];
}): LeaseDomainCoverageLedger {
  const requested = toSet(args.requestedFieldKeys);
  const processedGroups = toSet(args.processedGroupNames);
  const skippedGroups = toSet(args.skippedGroupNames);
  const failedGroups = toSet(args.failedGroupNames);
  const fieldStatuses = args.fieldStatuses ?? {};
  const evidenceAnchors = Array.isArray(args.evidenceAnchors) ? args.evidenceAnchors : [];
  const dynamicItems = Array.isArray(args.dynamicItems) ? args.dynamicItems : [];
  const expenseRuleCandidates = Array.isArray(args.expenseRuleCandidates) ? args.expenseRuleCandidates : [];

  const domains = DOMAIN_DEFINITIONS.map((definition): LeaseDomainCoverageEntry => {
    const expectedFields = definition.fixedFields.filter((field) => requested.size === 0 || requested.has(field));
    const foundFields: string[] = [];
    const reviewFields: string[] = [];
    const notStatedFields: string[] = [];

    for (const field of expectedFields) {
      const status = normalizeString(fieldStatuses[field]).toLowerCase();
      if (!status) continue;
      if (status === "not_stated" || status.startsWith("not_stated")) notStatedFields.push(field);
      else if (hasReviewStatus(status)) reviewFields.push(field);
      else foundFields.push(field);
    }

    const sourceBackedEvidence = evidenceAnchors.filter((anchor) =>
      definition.fixedFields.includes(String(anchor?.field_key ?? "")) &&
      anchor?.source_text &&
      anchor?.quote_verified !== false
    );
    const matchingDynamic = dynamicItems.filter((item) => definition.dynamicPattern.test(itemText(item)));
    const matchingRules = expenseRuleCandidates.filter((rule) => {
      const text = itemText(rule);
      return definition.expensePattern ? definition.expensePattern.test(text) : definition.dynamicPattern.test(text);
    });
    const domainProcessedGroups = definition.groupNames.filter((name) => processedGroups.has(name));
    const domainSkippedGroups = definition.groupNames.filter((name) => skippedGroups.has(name));
    const domainFailedGroups = definition.groupNames.filter((name) => failedGroups.has(name));
    const anyReview =
      reviewFields.length > 0 ||
      matchingDynamic.some((item) => hasReviewStatus(item?.review_status ?? item?.extraction_status ?? item?.status)) ||
      matchingRules.some((rule) => hasReviewStatus(rule?.review_status ?? rule?.extraction_status ?? rule?.status ?? rule?.row_status));
    const anySourceBacked =
      foundFields.length > 0 ||
      sourceBackedEvidence.length > 0 ||
      matchingDynamic.length > 0 ||
      matchingRules.length > 0;

    const warnings: string[] = [];
    let status: LeaseDomainCoverageStatus;
    if (domainFailedGroups.length > 0) {
      status = "failed";
      warnings.push("one_or_more_domain_groups_failed");
    } else if (domainSkippedGroups.length > 0) {
      status = domainProcessedGroups.length > 0 ? "partial" : "not_attempted";
      warnings.push("one_or_more_domain_groups_not_processed");
    } else if (anyReview) {
      status = "needs_review";
    } else if (anySourceBacked) {
      status = "source_backed";
    } else if (args.completeDocumentReviewed) {
      status = "not_stated_after_review";
    } else {
      status = domainProcessedGroups.length > 0 ? "partial" : "not_attempted";
    }

    if (definition.fixedFields.length === 0 && matchingDynamic.length === 0 && args.completeDocumentReviewed) {
      warnings.push("domain_depends_on_dynamic_findings");
    }

    return {
      domainKey: definition.domainKey,
      label: definition.label,
      status,
      criticalFor: definition.criticalFor,
      fixedFieldsExpected: expectedFields,
      fixedFieldsFound: foundFields,
      fixedFieldsNeedsReview: reviewFields,
      fixedFieldsNotStated: notStatedFields,
      dynamicFindingCount: matchingDynamic.length,
      expenseRuleCandidateCount: matchingRules.length,
      sourceBackedEvidenceCount: sourceBackedEvidence.length,
      processedGroups: domainProcessedGroups,
      skippedGroups: domainSkippedGroups,
      failedGroups: domainFailedGroups,
      warnings,
    };
  });

  const totals = {
    domainCount: domains.length,
    sourceBacked: domains.filter((d) => d.status === "source_backed").length,
    needsReview: domains.filter((d) => d.status === "needs_review").length,
    notStatedAfterReview: domains.filter((d) => d.status === "not_stated_after_review").length,
    partial: domains.filter((d) => d.status === "partial").length,
    failed: domains.filter((d) => d.status === "failed").length,
    notAttempted: domains.filter((d) => d.status === "not_attempted").length,
  };

  return {
    version: LEASE_DOMAIN_COVERAGE_VERSION,
    architecture: args.architecture,
    completeDocumentReviewed: Boolean(args.completeDocumentReviewed),
    domains,
    totals,
  };
}


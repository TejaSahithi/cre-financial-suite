export const LEASE_EXPENSE_RULE_GROUPS = Object.freeze({
  BASE_RENT_ADDITIONAL_RENT: "base_rent_additional_rent",
  CAM_OPERATING_EXPENSES: "cam_operating_expenses",
  TAXES: "taxes",
  INSURANCE: "insurance",
  UTILITIES: "utilities",
  REPAIRS_MAINTENANCE: "repairs_maintenance",
  SERVICES: "services",
  CAPITAL_EXPENSES: "capital_expenses",
  EXCLUSIONS_NON_RECOVERABLE: "exclusions_non_recoverable",
  ALLOCATION_RULES: "allocation_rules",
  EXPENSE_NOTICES_DEADLINES: "expense_notices_deadlines",
  OTHER_TENANT_CHARGES: "other_tenant_charges",
});

const GROUP_LABELS = {
  [LEASE_EXPENSE_RULE_GROUPS.BASE_RENT_ADDITIONAL_RENT]: "Base Rent / Additional Rent",
  [LEASE_EXPENSE_RULE_GROUPS.CAM_OPERATING_EXPENSES]: "CAM / Operating Expenses",
  [LEASE_EXPENSE_RULE_GROUPS.TAXES]: "Taxes",
  [LEASE_EXPENSE_RULE_GROUPS.INSURANCE]: "Insurance",
  [LEASE_EXPENSE_RULE_GROUPS.UTILITIES]: "Utilities",
  [LEASE_EXPENSE_RULE_GROUPS.REPAIRS_MAINTENANCE]: "Repairs and Maintenance",
  [LEASE_EXPENSE_RULE_GROUPS.SERVICES]: "Services",
  [LEASE_EXPENSE_RULE_GROUPS.CAPITAL_EXPENSES]: "Capital Expenses",
  [LEASE_EXPENSE_RULE_GROUPS.EXCLUSIONS_NON_RECOVERABLE]: "Exclusions / Non-Recoverable Items",
  [LEASE_EXPENSE_RULE_GROUPS.ALLOCATION_RULES]: "Allocation Rules",
  [LEASE_EXPENSE_RULE_GROUPS.EXPENSE_NOTICES_DEADLINES]: "Expense Notices / Deadlines",
  [LEASE_EXPENSE_RULE_GROUPS.OTHER_TENANT_CHARGES]: "Other Tenant Charges",
};

function textOf(...values) {
  return values
    .filter((value) => value !== null && value !== undefined && value !== "")
    .map((value) => String(value))
    .join(" ")
    .trim();
}

function normalizeToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function firstPresent(...values) {
  return values.find((value) => value !== null && value !== undefined && value !== "") ?? null;
}

function getFirstClause(rule) {
  return Array.isArray(rule?.clauses) && rule.clauses.length > 0 ? rule.clauses[0] : null;
}

export function getRuleSourceText(rule) {
  const clause = getFirstClause(rule);
  const text = firstPresent(
    rule?.exact_source_text,
    rule?.source_text,
    rule?.source_clause,
    rule?.clause_text,
    rule?.source,
    clause?.clause_text,
  );
  return text ? String(text).replace(/\s+/g, " ").trim() : null;
}

export function getRuleSourcePage(rule) {
  const clause = getFirstClause(rule);
  const page = firstPresent(
    rule?.source_page,
    rule?.page_number,
    rule?.page,
    clause?.page_number,
    clause?.source_page,
  );
  const numeric = Number(page);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

export function getRuleConfidence(rule) {
  const clause = getFirstClause(rule);
  const value = firstPresent(rule?.confidence_score, rule?.confidence, clause?.confidence);
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function mentions(haystack, regex) {
  return regex.test(haystack);
}

export function inferLeaseExpenseRuleGroup(rule = {}) {
  const category = normalizeToken(firstPresent(
    rule.rule_group,
    rule.expense_category,
    rule.normalized_key,
    rule.category_name,
    rule.expense_subcategory,
    rule.subcategory_name,
    rule.rule_type,
  ));
  const sourceText = getRuleSourceText(rule) || "";
  const haystack = `${category} ${textOf(rule.category_name, rule.expense_category, rule.expense_subcategory, rule.rule_type, sourceText)}`.toLowerCase();

  if (
    rule?.is_excluded === true ||
    mentions(haystack, /\b(exclusion|excluded|non[_\s-]?recoverable|not[_\s-]?recoverable|debt[_\s-]?service|depreciation|leasing[_\s-]?commission|tenant[_\s-]?improvement|income[_\s-]?tax|franchise[_\s-]?tax|fine|penalt)/)
  ) {
    return LEASE_EXPENSE_RULE_GROUPS.EXCLUSIONS_NON_RECOVERABLE;
  }
  if (mentions(haystack, /\b(pro[_\s-]?rata|proportionate[_\s-]?share|rentable[_\s-]?square|occupied[_\s-]?square|building[_\s-]?share|project[_\s-]?share|fixed[_\s-]?percentage|direct[_\s-]?billed|separately[_\s-]?metered|annual[_\s-]?reconciliation|allocation)\b/)) {
    return LEASE_EXPENSE_RULE_GROUPS.ALLOCATION_RULES;
  }
  if (mentions(haystack, /\b(statement[_\s-]?deadline|audit[_\s-]?deadline|objection[_\s-]?deadline|payment[_\s-]?deadline|reconciliation[_\s-]?deadline|annual[_\s-]?statement|audit[_\s-]?right|notice[_\s-]?deadline|true[_\s-]?up)\b/)) {
    return LEASE_EXPENSE_RULE_GROUPS.EXPENSE_NOTICES_DEADLINES;
  }
  if (mentions(haystack, /\b(cam|common[_\s-]?area(?:[_\s-]?maintenance|[_\s-]?expense)?|operating[_\s-]?expenses?|building[_\s-]?expenses?|property[_\s-]?expenses?|reimbursable|recoverable|recovery|pass[_\s-]?through|gross[_\s-]?up|expense[_\s-]?cap|controllable|non[_\s-]?controllable|management[_\s-]?fee|admin(?:istrative)?[_\s-]?fee|base[_\s-]?year|expense[_\s-]?stop|estimated[_\s-]?cam)\b/)) {
    return LEASE_EXPENSE_RULE_GROUPS.CAM_OPERATING_EXPENSES;
  }
  if (mentions(haystack, /\b(real[_\s-]?estate[_\s-]?tax(?:es)?|property[_\s-]?tax(?:es)?|assessment|special[_\s-]?assessment|tax[_\s-]?increase|tax[_\s-]?pass|tenant[_\s-]?tax(?:es)?|excluded[_\s-]?tax(?:es)?|taxes)\b/)) {
    return LEASE_EXPENSE_RULE_GROUPS.TAXES;
  }
  if (mentions(haystack, /\b((?:property|tenant|landlord|liability)?[_\s-]?insurance|premium|liability|additional[_\s-]?insured|subrogation|deductible)\b/)) {
    return LEASE_EXPENSE_RULE_GROUPS.INSURANCE;
  }
  if (mentions(haystack, /\b(utilities|utility|electric|electricity|gas|water|sewer|trash|internet|telecom|metered|submetered)\b/)) {
    return LEASE_EXPENSE_RULE_GROUPS.UTILITIES;
  }
  if (mentions(haystack, /\b(repairs?|maintenance|hvac(?:[_\s-]?maintenance)?|roof|structure|structural|plumbing|electrical|doors?|windows?|interior|replacement|capital[_\s-]?repair)\b/)) {
    return LEASE_EXPENSE_RULE_GROUPS.REPAIRS_MAINTENANCE;
  }
  if (mentions(haystack, /\b(janitorial|security|landscap|snow|pest|trash[_\s-]?removal|parking|signage|cleaning|elevator)\b/)) {
    return LEASE_EXPENSE_RULE_GROUPS.SERVICES;
  }
  if (mentions(haystack, /\b(capital[_\s-]?(expense|expenditure|improvement|cost)|amorti[sz]ed|code[_\s-]?compliance|energy[_\s-]?saving)\b/)) {
    return LEASE_EXPENSE_RULE_GROUPS.CAPITAL_EXPENSES;
  }
  if (mentions(haystack, /\b(base[_\s-]?rent|additional[_\s-]?rent|rent[_\s-]?escalation|late[_\s-]?(fee|charge)|interest|returned[_\s-]?payment|administrative[_\s-]?fee)\b/)) {
    return LEASE_EXPENSE_RULE_GROUPS.BASE_RENT_ADDITIONAL_RENT;
  }
  if (mentions(haystack, /\b(parking[_\s-]?fee|storage[_\s-]?fee|signage[_\s-]?fee|after[_\s-]?hours[_\s-]?hvac|key[_\s-]?card|card[_\s-]?fee|maintenance[_\s-]?charge)\b/)) {
    return LEASE_EXPENSE_RULE_GROUPS.OTHER_TENANT_CHARGES;
  }

  return LEASE_EXPENSE_RULE_GROUPS.OTHER_TENANT_CHARGES;
}

export function getRuleGroupLabel(ruleOrGroup) {
  const group = typeof ruleOrGroup === "string" ? ruleOrGroup : inferLeaseExpenseRuleGroup(ruleOrGroup);
  return GROUP_LABELS[group] || "Other Tenant Charges";
}

export function inferResponsibleParty(rule = {}) {
  const raw = normalizeToken(firstPresent(rule.responsible_party, rule.operational_responsibility, rule.responsibility));
  if (["tenant", "lessee", "tenant_direct", "tenant_direct_contract"].includes(raw)) return "tenant";
  if (["landlord", "lessor", "owner", "landlord_non_recoverable", "landlord_recoverable"].includes(raw)) return "landlord";
  if (["shared", "conditional", "pro_rata", "proportionate_share"].includes(raw)) return "shared";

  const text = getRuleSourceText(rule) || "";
  if (/\btenant\b.{0,80}\b(pay|reimburse|responsible|maintain|repair)/i.test(text)) return "tenant";
  if (/\blandlord\b.{0,80}\b(pay|provide|responsible|maintain|repair)/i.test(text)) return "landlord";
  if (/\b(shared|pro rata|proportionate share|allocated)\b/i.test(text)) return "shared";
  return "unknown";
}

export function inferRecoverable(rule = {}) {
  const raw = normalizeToken(firstPresent(rule.recoverable, rule.recoverable_from_tenant, rule.rule_classification));
  if (["yes", "true", "recoverable"].includes(raw)) return true;
  if (["no", "false", "non_recoverable", "excluded", "not_applicable"].includes(raw) || rule?.is_excluded === true) return false;
  return "unknown";
}

export function inferRuleStatus(rule = {}) {
  const raw = normalizeToken(firstPresent(rule.status, rule.review_status, rule.row_status, rule.extraction_status));
  const sourceText = getRuleSourceText(rule);
  if (!sourceText && ["mapped", "extracted", "accepted", "reviewed"].includes(raw)) return "needs_review";
  if (raw === "reviewed") return "approved";
  if (raw) return raw;
  return sourceText ? "needs_review" : "not_found";
}

export function normalizeLeaseExpenseRule(rule = {}) {
  const sourceText = getRuleSourceText(rule);
  const group = inferLeaseExpenseRuleGroup(rule);
  const normalizedRule = firstPresent(
    rule.normalized_rule,
    rule.reasoning_summary,
    rule.lease_treatment,
    rule.notes,
    sourceText,
    rule.category_name,
    rule.expense_category,
  );

  return {
    ...rule,
    rule_group: group,
    rule_group_label: getRuleGroupLabel(group),
    responsible_party: inferResponsibleParty(rule),
    recoverable: inferRecoverable(rule),
    normalized_rule: normalizedRule ? String(normalizedRule) : null,
    source_page: getRuleSourcePage(rule),
    source_text: sourceText,
    exact_source_text: rule.exact_source_text || sourceText,
    confidence: getRuleConfidence(rule),
    confidence_score: firstPresent(rule.confidence_score, getRuleConfidence(rule)),
    status: inferRuleStatus(rule),
  };
}

export function isCamTaxonomyRule(rule = {}) {
  const normalized = rule.rule_group ? rule : normalizeLeaseExpenseRule(rule);
  if (normalized.rule_group === LEASE_EXPENSE_RULE_GROUPS.CAM_OPERATING_EXPENSES) return true;
  if (normalized.rule_group === LEASE_EXPENSE_RULE_GROUPS.ALLOCATION_RULES) return true;
  if (normalized.rule_group === LEASE_EXPENSE_RULE_GROUPS.EXPENSE_NOTICES_DEADLINES) return true;

  const text = textOf(
    normalized.expense_category,
    normalized.category_name,
    normalized.rule_type,
    normalized.source_text,
  ).toLowerCase();
  return /\b(cam|common area|operating expense|recovery|recoveries|reimbursable|gross-up|gross up|admin fee|management fee|expense cap)\b/.test(text);
}

export function splitRulesForLeaseReview(rules = []) {
  const normalized = (rules || []).map(normalizeLeaseExpenseRule);
  return {
    expenseRules: normalized.filter((rule) => !isCamTaxonomyRule(rule)),
    camRules: normalized.filter(isCamTaxonomyRule),
  };
}





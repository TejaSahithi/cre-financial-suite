import {
  asNumber,
  asArray,
  firstPresent,
  normalizeCategoryKey,
  humanizeLabel,
  normalizeRuleSource
} from "./leaseExpenseRuleParsers";

export const CANONICAL_EXPENSE_CATEGORY_CONFIG = [
  {
    canonicalKey: "common_area_maintenance",
    categoryName: "Common Area Maintenance",
    aliases: ["cam", "common_area_maintenance", "common area maintenance"],
  },
  {
    canonicalKey: "real_estate_taxes",
    categoryName: "Real Estate Taxes",
    aliases: ["property_tax", "real_estate_taxes", "taxes", "taxes_real_estate", "property taxes"],
  },
  {
    canonicalKey: "property_insurance",
    categoryName: "Property Insurance",
    aliases: ["insurance", "property_insurance", "property insurance"],
  },
  {
    canonicalKey: "repairs_maintenance",
    categoryName: "Repairs & Maintenance",
    aliases: [
      "maintenance",
      "repairs",
      "repairs_maintenance",
      "interior_repairs",
      "exterior_repairs",
      "roof_structure",
      "foundation_structure",
      "hvac",
    ],
  },
  {
    canonicalKey: "legal_enforcement_fees",
    categoryName: "Legal / Enforcement Fees",
    aliases: [
      "legal_fees",
      "enforcement_fees",
      "attorneys_fees",
      "legal_default_costs",
      "legal_enforcement_fees",
    ],
  },
  {
    canonicalKey: "utilities",
    categoryName: "Utilities",
    aliases: ["utilities", "utility"],
  },
  {
    canonicalKey: "electricity",
    parentKey: "utilities",
    categoryName: "Utilities",
    subcategoryName: "Electricity",
    aliases: ["electricity", "electric"],
  },
  {
    canonicalKey: "water",
    parentKey: "utilities",
    categoryName: "Utilities",
    subcategoryName: "Water",
    aliases: ["water"],
  },
  {
    canonicalKey: "sewer",
    parentKey: "utilities",
    categoryName: "Utilities",
    subcategoryName: "Sewer",
    aliases: ["sewer"],
  },
  {
    canonicalKey: "gas",
    parentKey: "utilities",
    categoryName: "Utilities",
    subcategoryName: "Gas",
    aliases: ["gas"],
  },
];

export const EXCLUDED_LEASE_EXPENSE_RULE_KEYS = new Set(["base_rent", "monthly_rent", "annual_rent", "additional_rent"]);

export const GENERIC_SOURCE_PATTERNS = [
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

export const RULE_AUTO_APPROVE_CONFIDENCE_THRESHOLD = 0.80;

export function deriveRuleExactSourceText(rule) {
  const firstClause = asArray(rule?.clauses)[0];
  return firstPresent(
    firstClause?.clause_text,
    firstClause?.source_text,
    firstClause?.evidence_text,
    firstClause?.text,
    rule?.exact_source_text,
    rule?.source_clause,
    rule?.clause_text,
    rule?.evidence_text,
    rule?.source_text,
  );
}

export function deriveRuleSourcePage(rule) {
  const directPage = Number(rule?.source_page ?? rule?.page_number ?? rule?.evidence_page_number);
  if (Number.isFinite(directPage) && directPage > 0) return directPage;
  const firstClause = asArray(rule?.clauses)[0];
  const clausePage = Number(firstClause?.page_number);
  if (Number.isFinite(clausePage) && clausePage > 0) return clausePage;
  return null;
}

export function deriveRuleConfidence(rule) {
  return asNumber(firstPresent(rule?.confidence, rule?.confidence_score)) ?? 0.7;
}

export function normalizeConfidenceScore(value) {
  const numeric = asNumber(value);
  if (numeric == null) return null;
  if (numeric <= 1) return Math.max(0, Math.min(1, numeric));
  return Math.max(0, Math.min(1, numeric / 100));
}

export function extractRuleValue(rule) {
  return asNumber(rule?.final_value ?? rule?.manual_value ?? rule?.extracted_value);
}

export function extractRuleClauses(rule, leaseId, ruleId) {
  const explicitClauses = asArray(rule?.clauses);
  if (explicitClauses.length > 0) {
    return explicitClauses
      .map((clause) => {
        const clauseText = String(
          clause?.clause_text ??
            clause?.source_text ??
            clause?.evidence_text ??
            clause?.text ??
            ""
        ).trim();
        if (!clauseText) return null;
        return {
          lease_expense_rule_id: ruleId,
          lease_id: leaseId,
          page_number: Number.isFinite(Number(clause?.page_number)) ? Number(clause.page_number) : null,
          clause_type: clause?.clause_type || "supporting_text",
          clause_text: clauseText,
          confidence: asNumber(clause?.confidence ?? rule?.confidence),
        };
      })
      .filter(Boolean);
  }

  const source = normalizeRuleSource(rule?.exact_source_text || rule?.source);
  if (!source) return [];

  return [{
    lease_expense_rule_id: ruleId,
    lease_id: leaseId,
    page_number: Number.isFinite(Number(rule?.source_page ?? rule?.page_number ?? rule?.evidence_page_number))
      ? Number(rule.source_page ?? rule.page_number ?? rule.evidence_page_number)
      : null,
    clause_type: "supporting_text",
    clause_text: source,
    confidence: asNumber(rule?.confidence),
  }];
}

export function isWeakSourceText(text) {
  const normalized = String(text || "").trim();
  if (!normalized || normalized.length < 18) return true;
  return GENERIC_SOURCE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function hasStrongRuleEvidence(rule) {
  const text = deriveRuleExactSourceText(rule);
  if (isWeakSourceText(text)) return false;

  const hasPage = Number.isFinite(Number(deriveRuleSourcePage(rule)));
  const textIsLongEnough = String(text || "").trim().length > 30;

  return hasPage || textIsLongEnough;
}

export function deriveRuleCategoryName(rule) {
  return (
    firstPresent(
      rule?.category_name,
      rule?.expense_category,
      rule?.category,
      rule?.key,
      rule?.normalized_key && humanizeLabel(rule.normalized_key),
    ) || "Uncategorized"
  );
}

export function deriveRuleSubcategoryName(rule) {
  return firstPresent(rule?.subcategory_name, rule?.expense_subcategory);
}

export function deriveRuleNormalizedKey(rule, index = 0) {
  return (
    normalizeCategoryKey(
      rule?.normalized_key ||
      rule?.fallback_category_key ||
      rule?.expense_subcategory ||
      rule?.expense_category ||
      rule?.category ||
      rule?.key ||
      `lease_rule_${index + 1}`
    ) || `lease_rule_${index + 1}`
  );
}

export function resolveCanonicalExpenseCategory(rule, index = 0) {
  const candidates = [
    rule?.expense_subcategory,
    rule?.expense_category,
    rule?.category_name,
    rule?.subcategory_name,
    rule?.category,
    rule?.key,
    rule?.normalized_key,
    rule?.fallback_category_key,
  ]
    .map(normalizeCategoryKey)
    .filter(Boolean);

  for (const candidate of candidates) {
    for (const config of CANONICAL_EXPENSE_CATEGORY_CONFIG) {
      if (config.aliases.some((alias) => normalizeCategoryKey(alias) === candidate)) {
        return {
          canonicalKey: config.parentKey || config.canonicalKey,
          normalizedKey: config.parentKey || config.canonicalKey,
          categoryName: config.categoryName,
          subcategoryName: config.subcategoryName || null,
        };
      }
    }
  }

  const fallbackKey = deriveRuleNormalizedKey(rule, index);
  return {
    canonicalKey: fallbackKey,
    normalizedKey: fallbackKey,
    categoryName: humanizeLabel(deriveRuleCategoryName(rule)),
    subcategoryName: deriveRuleSubcategoryName(rule),
  };
}

export function isRuleExcludedFromLeaseExpenses(rule, canonicalKey) {
  return EXCLUDED_LEASE_EXPENSE_RULE_KEYS.has(canonicalKey) ||
    EXCLUDED_LEASE_EXPENSE_RULE_KEYS.has(normalizeCategoryKey(rule?.expense_category)) ||
    EXCLUDED_LEASE_EXPENSE_RULE_KEYS.has(normalizeCategoryKey(rule?.category_name)) ||
    EXCLUDED_LEASE_EXPENSE_RULE_KEYS.has(normalizeCategoryKey(rule?.normalized_key));
}


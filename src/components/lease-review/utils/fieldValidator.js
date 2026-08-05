/**
 * Lease Review — Field-level validation helpers.
 *
 * These validators catch bad extraction outputs that would otherwise show as
 * legitimate values in the review table (e.g. Property Name = "Yes").
 * They are intentionally narrow: only validate patterns with confirmed
 * extraction failure modes. Do not add speculative guards.
 *
 * Every exported function must have a test in fieldValidator.test.js.
 */

import { LEASE_FIELD_OPTIONS } from "../../../lib/leaseFieldOptions.js";

// Values that look like booleans / placeholders and are never valid in a
// text-field context (property name, party name, etc.).
const BOOLEAN_STRINGS = new Set([
  "yes", "no", "true", "false", "y", "n",
  "na", "n/a", "none", "null", "unknown", "tbd", "not specified",
]);

// Generic single-word role labels the extractor sometimes returns when it
// cannot find the actual entity name.
const GENERIC_NAME_LABELS = new Set([
  "tenant", "landlord", "lessor", "lessee", "owner",
  "assignee", "assignor", "guarantor", "manager", "agent",
  "landlord_name", "tenant_name", "property_name",
]);

/** Field keys whose values must be plain numbers (no currency symbols). */
const NUMERIC_KEYS = new Set([
  "square_footage", "building_rsf", "renewal_notice_months",
  "termination_notice_months", "free_rent_months", "late_fee_grace_days",
  "lease_term_months", "rent_per_sf", "base_year", "default_cure_period",
  "mechanics_lien_cure_period", "estoppel_certificate_deadline",
  "holdover_rent_multiplier",
]);

/** Field keys whose values must be parseable as money. */
const CURRENCY_KEYS = new Set([
  "monthly_rent", "annual_rent", "security_deposit", "cam_amount",
  "ti_allowance", "expense_stop", "general_liability_min",
  "late_fee_amount", "returned_payment_fee_amount", "application_fee_amount",
  "administrative_fee_amount", "pet_fee_amount", "pet_rent_amount",
  "parking_fee_amount", "assignment_consideration",
  "amended_base_rent_for_additional_year", "utility_reimbursement_amount",
  "water_sewer_reimbursement_amount",
]);

/** Field keys that must be a valid ISO date (YYYY-MM-DD). */
const DATE_KEYS = new Set([
  "commencement_date", "expiration_date", "lease_date",
  "rent_commencement_date", "option_exercise_deadline",
  "assignment_effective_date", "start_date", "end_date",
  "tenant_signature_date", "landlord_signature_date",
]);

/** Field keys whose values are percentages stored as plain numbers. */
const PERCENT_KEYS = new Set([
  "escalation_rate", "late_fee_percent", "cam_cap_pct", "admin_fee_pct",
  "gross_up_threshold", "tenant_pro_rata_share", "renewal_escalation_percent",
]);

/** Field keys whose values must be clear boolean answers. */
const BOOLEAN_KEYS = new Set([
  "gross_up_enabled", "tenant_insurance_required", "waiver_of_subrogation",
  "additional_insureds_required", "right_of_first_refusal",
  "early_termination_option", "renewal_option", "termination_option",
  "landlord_consent",
]);

const RESPONSIBILITY_KEYS = new Set([
  "responsibility_taxes", "tax_responsibility",
  "responsibility_insurance", "insurance_responsibility",
  "property_insurance_responsibility",
  "responsibility_utilities", "electric_responsibility",
  "water_sewer_responsibility",
  "responsibility_repairs", "maintenance_responsibility",
  "hvac_responsibility",
]);

const SELECT_OPTION_KEYS = {
  lease_type: "lease_type",
  billing_frequency: "billing_frequency",
  escalation_type: "escalation_type",
  escalation_timing: "escalation_timing",
  cam_cap_type: "cam_cap_type",
  management_fee_basis: "management_fee_basis",
  renewal_type: "renewal_type",
};

const SELECT_VALUE_ALIASES = {
  lease_type: {
    nnn: "triple_net",
    "triple net": "triple_net",
    "triple-net": "triple_net",
    nn: "double_net",
    "double net": "double_net",
    "single net": "single_net",
    "full service gross": "full_service",
    "full-service": "full_service",
  },
  billing_frequency: {
    annually: "annual",
    yearly: "annual",
    "per year": "annual",
    "per month": "monthly",
    "each month": "monthly",
    "one-time": "one_time",
    once: "one_time",
  },
};

function parseAccountingNumber(value, { allowPercent = false, allowUnitWords = false } = {}) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  let s = String(value ?? "").trim().toLowerCase();
  if (!s) return null;
  if (allowUnitWords) {
    s = s.replace(/\b(?:rentable|usable|square|sq\.?|feet|foot|sf|rsf|usf|months?|mos?|days?|yrs?|years?)\b/g, "");
  }
  s = s.replace(/^\((.*)\)$/, "-$1").replace(/[$,\s]/g, "");
  if (allowPercent) s = s.replace(/%$/, "");
  if (!/^-?\d+(?:\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function isRealIsoDate(str) {
  const match = String(str || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

function isBooleanLike(value) {
  if (typeof value === "boolean") return true;
  const s = String(value ?? "").trim().toLowerCase();
  return /^(yes|no|true|false|y|n|1|0)$/.test(s);
}

function isSupportedResponsibilityValue(value) {
  const s = String(value ?? "").trim().toLowerCase().replace(/[_-]+/g, " ");
  if (!s) return false;
  if (s.length > 120) return false;
  return /\b(tenant|landlord|lessor|lessee|shared|both|included|pro rata|reimburse|reimbursement|separate(?:ly)? metered|cap|base year)\b/.test(s);
}

function normalizeEnumText(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_\u2010-\u2015-]+/g, " ")
    .replace(/\s+/g, " ");
}

function isAllowedSelectValue(fieldKey, value) {
  const optionKey = SELECT_OPTION_KEYS[fieldKey];
  if (!optionKey) return true;
  const normalized = normalizeEnumText(value);
  if (!normalized) return true;
  const aliasValue = SELECT_VALUE_ALIASES[fieldKey]?.[normalized];
  const options = LEASE_FIELD_OPTIONS[optionKey] || [];
  return options.some((option) => {
    const optionValue = normalizeEnumText(option.value);
    const optionLabel = normalizeEnumText(option.label);
    return normalized === optionValue || normalized === optionLabel || aliasValue === option.value;
  });
}

function normalizeEvidenceText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[()]/g, " ")
    .replace(/[$,%]/g, " ")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function evidenceNumericTokens(value) {
  const tokens = new Set();
  for (const match of String(value ?? "").matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const raw = match[0];
    const numeric = Number(raw.replace(/,/g, ""));
    tokens.add(raw.replace(/,/g, ""));
    if (Number.isFinite(numeric)) {
      tokens.add(String(numeric));
      if (Number.isInteger(numeric)) tokens.add(String(Math.trunc(numeric)));
    }
  }
  return tokens;
}

function sourceContainsNumber(value, sourceText) {
  const valueNumbers = evidenceNumericTokens(value);
  if (valueNumbers.size === 0) return false;
  const sourceNumbers = evidenceNumericTokens(sourceText);
  return [...valueNumbers].some((token) => sourceNumbers.has(token));
}

function sourceContainsIsoDate(value, sourceText) {
  const raw = String(value ?? "").trim();
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const slash = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/);
  const monthText = raw.match(/^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2}),?\s+(\d{4})$/i);
  let year;
  let month;
  let day;
  if (iso) {
    [, year, month, day] = iso;
  } else if (slash) {
    month = slash[1].padStart(2, "0");
    day = slash[2].padStart(2, "0");
    year = slash[3].length === 2 ? `20${slash[3]}` : slash[3];
  } else if (monthText) {
    const monthNames = [
      "january", "february", "march", "april", "may", "june",
      "july", "august", "september", "october", "november", "december",
    ];
    const cleanedMonth = monthText[1].toLowerCase().replace(/\.$/, "");
    const monthIndex = monthNames.findIndex((name) => name.startsWith(cleanedMonth));
    if (monthIndex < 0) return false;
    month = String(monthIndex + 1).padStart(2, "0");
    day = monthText[2].padStart(2, "0");
    year = monthText[3];
  } else {
    return false;
  }
  const source = normalizeEvidenceText(sourceText);
  const monthNames = [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
  ];
  const monthName = monthNames[Number(month) - 1];
  return source.includes(year) && source.includes(String(Number(day))) &&
    (source.includes(monthName) || source.includes(String(Number(month))));
}

function genericEvidenceSupportsValue(value, sourceText) {
  const source = normalizeEvidenceText(sourceText);
  const valueText = normalizeEvidenceText(value);
  if (!source || !valueText) return false;
  if (source.includes(valueText)) return true;
  if (sourceContainsIsoDate(value, sourceText)) return true;
  if (sourceContainsNumber(value, sourceText)) return true;
  const tokens = valueText.split(" ").filter((token) => token.length >= 3 && !/^\d+$/.test(token));
  if (tokens.length >= 2 && tokens.every((token) => source.includes(token))) return true;
  return tokens.length === 1 && source.includes(tokens[0]);
}

function fieldCuePattern(fieldKey) {
  const cues = {
    lease_type: /\b(?:gross|full\s*service|triple\s*net|nnn|double\s*net|single\s*net|modified\s*gross|net\s+lease|rent\s+includes)\b/i,
    monthly_rent: /\b(?:monthly\s+rent|base\s+rent|rent\s*:|per\s+month|\/mo|monthly)\b/i,
    annual_rent: /\b(?:annual\s+rent|yearly\s+rent|per\s+year|per\s+annum|annual)\b/i,
    security_deposit: /\bsecurity\s+deposit\b/i,
    late_fee_amount: /\b(?:late\s+fee|late\s+charge)\b/i,
    late_fee_percent: /\b(?:late\s+fee|late\s+charge)\b/i,
    escalation_rate: /\b(?:increase|escalat|renewal|anniversary|cpi)\b/i,
    escalation_type: /\b(?:increase|escalat|renewal|anniversary|cpi|fair\s+market|fixed)\b/i,
    escalation_timing: /\b(?:anniversary|calendar\s+year|fiscal\s+year|renewal|increase|escalat)\b/i,
    renewal_escalation_percent: /\b(?:increase|escalat|renewal|anniversary)\b/i,
    billing_frequency: /\b(?:monthly|quarterly|annual|annually|per\s+month|per\s+year|installments?)\b/i,
    square_footage: /\b(?:rentable|usable|square\s+feet|sq\.?\s*ft|\bsf\b|\brsf\b|premises)\b/i,
    building_rsf: /\b(?:building|rentable|square\s+feet|\bsf\b|\brsf\b)\b/i,
    lease_term: /\b(?:lease\s+term|term|months?|years?|commencement|expiration)\b/i,
    lease_term_months: /\b(?:lease\s+term|term|months?|years?|commencement|expiration)\b/i,
    renewal_notice_months: /\b(?:renewal|extend|extension|anniversary).{0,80}\b(?:notice|days?|months?|before)\b|\b(?:notice|days?|months?|before).{0,80}\b(?:renewal|extend|extension|anniversary)\b/i,
    termination_notice_months: /\b(?:termination|terminate|cancel).{0,80}\b(?:notice|days?|months?|before)\b|\b(?:notice|days?|months?|before).{0,80}\b(?:termination|terminate|cancel)\b/i,
    commencement_date: /\b(?:commencement\s+date|start\s+date|commence|term\s+commences)\b/i,
    start_date: /\b(?:commencement\s+date|start\s+date|commence|term\s+commences)\b/i,
    expiration_date: /\b(?:expiration\s+date|expiry|end\s+date|expire|term\s+ends)\b/i,
    end_date: /\b(?:expiration\s+date|expiry|end\s+date|expire|term\s+ends)\b/i,
    rent_commencement_date: /\b(?:rent\s+commencement|rent\s+start|rent\s+begins)\b/i,
    lease_date: /\b(?:lease\s+date|date\s*:|made\b|entered\s+into\b|executed\b)/i,
    landlord_consent: /\b(?:landlord).{0,80}\bconsent\w*\b|\bconsent\w*.{0,80}\blandlord\b/i,
    landlord_consent_for_transfer: /\b(?:landlord).{0,80}\bconsent\w*\b|\bconsent\w*.{0,80}\blandlord\b/i,
    tenant_signature_date: /\b(?:tenant|signature|signed|by:|date)\b/i,
    landlord_signature_date: /\b(?:landlord|signature|signed|by:|date)\b/i,
    tenant_insurance_required: /\b(?:tenant|lessee).{0,80}\b(?:insurance|coverage|certificate|liability)\b|\b(?:insurance|coverage|certificate|liability).{0,80}\b(?:tenant|lessee)\b/i,
    general_liability_min: /\b(?:general\s+liability|liability|coverage|insurance|per\s+occurrence|aggregate)\b/i,
    additional_insureds_required: /\badditional\s+insured/i,
    waiver_of_subrogation: /\bwaiv\w*.{0,40}\bsubrogation\b|\bsubrogation\b.{0,40}\bwaiv\w*/i,
    cam_amount: /\b(?:cam|common\s+area|operating\s+expense|full\s+service|included\s+in\s+rent|no\s+separate)\b/i,
    cam_cap_type: /\b(?:cam|common\s+area|cap|cumulative|non\s*cumulative|compounding)\b/i,
    cam_cap_pct: /\b(?:cam|common\s+area|cap|percent|%)\b/i,
    admin_fee_pct: /\b(?:admin(?:istrative)?\s+fee|management\s+fee|cam|operating\s+expense|%)\b/i,
    management_fee_basis: /\b(?:management\s+fee|admin(?:istrative)?\s+fee|cam|operating\s+expense)\b/i,
    gross_up_enabled: /\b(?:gross\s*up|occupancy|cam|operating\s+expense)\b/i,
    gross_up_threshold: /\b(?:gross\s*up|occupancy|cam|operating\s+expense|%)\b/i,
    base_year: /\bbase\s+year\b/i,
    expense_stop: /\b(?:expense\s+stop|stop\s+amount|base\s+amount|operating\s+expense)\b/i,
  };
  return cues[fieldKey] || null;
}

function normalizedEnumEvidenceSupportsValue(fieldKey, value, sourceText) {
  const source = normalizeEvidenceText(sourceText);
  const valueText = normalizeEnumText(value);
  if (fieldKey === "lease_type") {
    const patterns = {
      gross: /\bgross\b|\bfull\s+service\b|\brent\s+includes\b|\bincluded\s+in\s+rent\b/,
      full_service: /\bfull\s+service\b|\brent\s+includes\b|\bincluded\s+in\s+rent\b/,
      triple_net: /\btriple\s+net\b|\bnnn\b/,
      nnn: /\btriple\s+net\b|\bnnn\b/,
      modified_gross: /\bmodified\s+gross\b/,
      double_net: /\bdouble\s+net\b|\bnn\b/,
      single_net: /\bsingle\s+net\b/,
    };
    return Boolean(patterns[valueText]?.test(source));
  }
  if (fieldKey === "escalation_type") {
    const patterns = {
      fixed_pct: /\b(?:increase|escalat).{0,80}(?:%|percent)\b|\b(?:%|percent).{0,80}\b(?:increase|escalat)\b/,
      cpi: /\bcpi\b|consumer\s+price\s+index/,
      stepped: /\bstep(?:ped)?\b|schedule/,
      fmv: /fair\s+market\s+value|\bfmv\b/,
      none: /\bno\s+(?:increase|escalation)\b|\bnone\b/,
    };
    return Boolean(patterns[valueText]?.test(source));
  }
  if (fieldKey === "escalation_timing") {
    const patterns = {
      lease_anniversary: /anniversary/,
      calendar_year: /calendar\s+year|january\s+1|jan\.?\s+1/,
      fiscal_year: /fiscal\s+year/,
    };
    return Boolean(patterns[valueText]?.test(source));
  }
  if (fieldKey === "billing_frequency") {
    const patterns = {
      monthly: /monthly|per\s+month|each\s+month|installments?\s+due.{0,40}first\s+day|first\s+day\s+of\s+(?:each|every)\s+(?:calendar\s+)?month/i,
      quarterly: /quarterly|per\s+quarter/,
      annual: /annual|annually|per\s+year|yearly/,
      one_time: /one\s*time|one\s+time|single\s+payment/,
    };
    return Boolean(patterns[valueText]?.test(source));
  }
  return false;
}

function noticeMonthEvidenceSupportsValue(value, sourceText) {
  if (sourceContainsNumber(value, sourceText)) return true;
  const n = parseAccountingNumber(value);
  if (!Number.isFinite(n)) return false;
  const source = normalizeEvidenceText(sourceText);
  if (n === 1 && /\b(?:30|thirty)\s+days?\b/.test(source)) return true;
  if (n === 2 && /\b(?:60|sixty)\s+days?\b/.test(source)) return true;
  if (n === 3 && /\b(?:90|ninety)\s+days?\b/.test(source)) return true;
  return false;
}

function responsibilityEvidenceSupportsValue(value, sourceText) {
  const source = normalizeEvidenceText(sourceText);
  const valueText = normalizeEvidenceText(value).replace(/_/g, " ");
  if (!/\b(?:rent\s+includes|included\s+in\s+rent|full\s+service|shall\s+pay|shall\s+reimburse|responsible\s+for|at\s+(?:tenant|landlord|lessor|lessee)\s+(?:sole\s+)?(?:cost|expense)|shall\s+maintain|shall\s+provide|separately\s+metered)\b/.test(source)) {
    return false;
  }
  if (/\b(?:tenant|landlord|lessor|lessee)\b/.test(valueText)) {
    return /\bincluded\s+in\s+rent\b|\bfull\s+service\b|\brent\s+includes\b/.test(source) ||
      valueText.split(" ").some((token) => ["tenant", "landlord", "lessor", "lessee"].includes(token) && source.includes(token));
  }
  return genericEvidenceSupportsValue(value, sourceText) || /\bshared\b|\bboth\b|\bpro\s+rata\b|\breimburse\b|\bseparately\s+metered\b/.test(source);
}

function sourceLooksLikeRentScheduleRow(sourceText) {
  const raw = String(sourceText || "");
  const source = normalizeEvidenceText(raw);
  const hasMoney = /\$\s*\d[\d,]*(?:\.\d{2})?/.test(raw);
  const hasDateRange = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|20\d{2})\b.{0,40}(?:-|to|through|thru).{0,40}\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|20\d{2})\b/i.test(raw);
  return hasMoney && (hasDateRange || /\b(?:base\s+rent|rent\s+schedule|rent\s+period)\b/.test(source));
}

function fieldCueFallbackSupports(fieldKey, value, sourceText) {
  const normalizedKey = String(fieldKey || "").trim().toLowerCase();
  const source = normalizeEvidenceText(sourceText);
  if (["monthly_rent", "annual_rent"].includes(normalizedKey)) {
    return sourceContainsNumber(value, sourceText) && sourceLooksLikeRentScheduleRow(sourceText);
  }
  if (normalizedKey === "billing_frequency") {
    const normalizedValue = normalizeEnumText(value);
    if (normalizedValue === "monthly") {
      return /\b(?:first\s+day\s+of\s+(?:each|every)\s+(?:calendar\s+)?month|monthly\s+installments?|each\s+month|per\s+month)\b/.test(source);
    }
  }
  return false;
}
export function validateFieldEvidenceSupport(fieldKey, value, evidence = {}) {
  if (value === null || value === undefined || value === "") return { valid: true };
  const typeValidation = validateFieldValue(fieldKey, value);
  if (!typeValidation.valid) return typeValidation;

  const extractionStatus = String(evidence.extractionStatus ?? evidence.extraction_status ?? "").toLowerCase();
  const evidenceType = String(evidence.evidenceType ?? evidence.evidence_type ?? "").toLowerCase();
  if (/^(calculated|derived|computed)$/.test(extractionStatus) || /^(derived|calculated)$/.test(evidenceType)) return { valid: true };
  if (evidence.derivationTrace || evidence.derivation_trace) return { valid: true };
  const sourceFieldKeys = evidence.sourceFieldKeys ?? evidence.source_field_keys;
  if (Array.isArray(sourceFieldKeys) && sourceFieldKeys.length > 0) return { valid: true };

  const sourceText = evidence.sourceText ?? evidence.source_text ?? evidence.sourceClause ?? evidence.source_clause ?? "";
  if (!String(sourceText || "").trim()) {
    return { valid: false, reason: "Extracted value has no source text, so it cannot be trusted as a filled value." };
  }

  const normalizedKey = String(fieldKey || "").trim().toLowerCase();
  const cue = fieldCuePattern(normalizedKey);
  if (cue && !cue.test(String(sourceText)) && !fieldCueFallbackSupports(normalizedKey, value, sourceText)) {
    return { valid: false, reason: `Source text does not contain the expected ${normalizedKey.replace(/_/g, " ")} context.` };
  }

  if (normalizedKey === "landlord_consent" || normalizedKey === "landlord_consent_for_transfer") {
    const source = normalizeEvidenceText(sourceText);
    const supportsConsent = /\blandlord\b/.test(source) && /\bconsent\w*\b/.test(source) &&
      /\b(?:assign\w*|transfer\w*|sublet\w*|sublease\w*|assumption)\b/.test(source);
    return supportsConsent
      ? { valid: true }
      : { valid: false, reason: "Source text does not support landlord consent for transfer." };
  }
  if (["lease_type", "escalation_type", "escalation_timing", "billing_frequency"].includes(normalizedKey)) {
    if (!normalizedEnumEvidenceSupportsValue(normalizedKey, value, sourceText)) {
      return { valid: false, reason: `Source text does not support the normalized ${normalizedKey.replace(/_/g, " ")} value.` };
    }
    return { valid: true };
  }

  if (RESPONSIBILITY_KEYS.has(normalizedKey)) {
    if (!responsibilityEvidenceSupportsValue(value, sourceText)) {
      return { valid: false, reason: `Source text does not support the normalized ${normalizedKey.replace(/_/g, " ")} responsibility.` };
    }
    return { valid: true };
  }

  if (normalizedKey === "renewal_notice_months" || normalizedKey === "termination_notice_months") {
    if (!noticeMonthEvidenceSupportsValue(value, sourceText)) {
      return { valid: false, reason: `Source text does not support the normalized ${normalizedKey.replace(/_/g, " ")} value.` };
    }
    return { valid: true };
  }

  if (DATE_KEYS.has(normalizedKey) || normalizedKey.endsWith("_date")) {
    if (!sourceContainsIsoDate(value, sourceText)) {
      return { valid: false, reason: `Source text does not support the normalized ${normalizedKey.replace(/_/g, " ")} date.` };
    }
    return { valid: true };
  }

  if (NUMERIC_KEYS.has(normalizedKey) || CURRENCY_KEYS.has(normalizedKey) || PERCENT_KEYS.has(normalizedKey)) {
    if (!sourceContainsNumber(value, sourceText)) {
      return { valid: false, reason: `Source text does not support the normalized ${normalizedKey.replace(/_/g, " ")} number.` };
    }
    return { valid: true };
  }

  if (!genericEvidenceSupportsValue(value, sourceText)) {
    return { valid: false, reason: `Source text does not support the normalized ${normalizedKey.replace(/_/g, " ")} value.` };
  }
  return { valid: true };
}
/**
 * Validate a single extracted field value.
 *
 * @param {string} fieldKey  - Schema field key (e.g. "property_name").
 * @param {unknown} value    - Extracted value to validate.
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateFieldValue(fieldKey, value) {
  if (value === null || value === undefined || value === "") {
    return { valid: true }; // absence is a missing-field issue, not invalid
  }

  const str = String(value).trim();
  const lower = str.toLowerCase();

  if (!isAllowedSelectValue(fieldKey, value)) {
    return {
      valid: false,
      reason: `"${str}" is not an allowed value for ${fieldKey.replace(/_/g, " ")}.`,
    };
  }

  if (BOOLEAN_KEYS.has(fieldKey)) {
    if (!isBooleanLike(value)) {
      return {
        valid: false,
        reason: `"${str}" is not a valid yes/no value for ${fieldKey.replace(/_/g, " ")}.`,
      };
    }
  }

  if (RESPONSIBILITY_KEYS.has(fieldKey)) {
    if (!isSupportedResponsibilityValue(value)) {
      return {
        valid: false,
        reason: `"${str}" is not a clear responsibility value for ${fieldKey.replace(/_/g, " ")}.`,
      };
    }
  }

  if (fieldKey === "tenant_contact_phone" || fieldKey.endsWith("_phone") || fieldKey === "phone") {
    const digitCount = str.replace(/\D/g, "").length;
    if (digitCount < 7 || digitCount > 15) {
      return {
        valid: false,
        reason: `"${str}" is not a valid phone number.`,
      };
    }
  }

  // ── Text/name fields: reject boolean-like strings ──────────────────────────
  const isNameOrTextKey =
    fieldKey === "property_name" ||
    fieldKey === "premises_use" ||
    fieldKey.endsWith("_name") ||
    fieldKey.endsWith("_address");

  if (isNameOrTextKey && BOOLEAN_STRINGS.has(lower)) {
    return {
      valid: false,
      reason: `"${str}" is not a valid ${fieldKey.replace(/_/g, " ")} — looks like a boolean or placeholder.`,
    };
  }

  // ── Name fields: reject generic role labels ─────────────────────────────────
  if (isNameOrTextKey && GENERIC_NAME_LABELS.has(lower)) {
    return {
      valid: false,
      reason: `"${str}" is a generic label, not a real name. The extractor may not have found the actual value.`,
    };
  }

  // ── Name fields: reject legal-clause text ────────────────────────────────────
  // The extractor sometimes finds a clause mentioning the concept (e.g. broker
  // commissions, transfer premiums) and returns the clause body instead of the
  // actual entity name. Two patterns are matched:
  //   (a) Long strings with legal markers (Article 14.3 "Transfer Premium" text
  //       showing up as Broker Name is the confirmed example from this codebase)
  //   (b) Strings that start with a numbered clause reference (e.g. "14.3 ...")
  if (fieldKey.endsWith("_name")) {
    // Short verb-phrase artifacts (e.g. "hereby leases Premises to",
    // "hereby assigns to") — the extractor grabbed a sentence fragment
    // near the party definition instead of the entity name itself.
    if (/\b(hereby leases|hereby assigns|hereby subleases|leases (?:the )?premises to|assigns? (?:the )?lease)\b/i.test(str)) {
      return {
        valid: false,
        reason: `Value looks like a lease-action phrase, not an entity name. Edit with the correct landlord or tenant name.`,
      };
    }
  }
  if (fieldKey.endsWith("_name") && str.length > 80) {
    const legalClausePattern = /\b(shall not|shall be|without consent|attorneys['']? fees?|compensation|hereinafter|pursuant to|indemnif|subletting|sublease|no Transfer|fair market value|Transfer Premium)\b/i;
    if (legalClausePattern.test(str)) {
      return {
        valid: false,
        reason: `Value looks like extracted clause text, not a name. Edit with the correct value.`,
      };
    }
  }
  // Numbered article/clause references are never entity names.
  if (fieldKey.endsWith("_name") && /^\d+\.\d+\s/.test(str)) {
    return {
      valid: false,
      reason: `Value starts with a clause reference — the extractor matched the wrong section. Edit with the correct value.`,
    };
  }

  // ── Name fields: reject suspiciously long values ──────────────────────────────
  // Real entity names are short; anything over 120 chars is almost always a
  // concatenated extraction or a clause fragment.
  if (fieldKey.endsWith("_name") && str.length > 120) {
    return {
      valid: false,
      reason: `Value is too long (${str.length} chars) for a name — may be a concatenated extraction. Edit with the correct value.`,
    };
  }

  // ── Name fields: reject signature-block artifacts ─────────────────────────────
  // When the extractor reads a signature block like "By: Morgan Reyes  Date"
  // it sometimes includes " Date" or " By:" as part of the name.
  if (fieldKey.endsWith("_name") && /\bDate\s*$/.test(str)) {
    return {
      valid: false,
      reason: `Value ends with "Date" — likely a signature-block artifact. Edit with just the name.`,
    };
  }

  // ── Address fields: reject numbered-list concatenations ──────────────────────
  // Summary-table extractions sometimes grab multiple rows: the address row
  // plus the rows below it (Tenant:, Landlord:, etc.). Detect the numbered
  // list pattern that appears when this happens.
  if (fieldKey.endsWith("_address") && /\d+\.\s+(?:Tenant|Landlord|Address|Premises|Lessee|Lessor)\b/i.test(str)) {
    return {
      valid: false,
      reason: `Value appears to contain multiple summary-table rows. Edit with just the address.`,
    };
  }

  // ── Address fields: reject suspiciously long values ───────────────────────────
  if (fieldKey.endsWith("_address") && str.length > 200) {
    return {
      valid: false,
      reason: `Value is too long (${str.length} chars) for an address — may be a multi-row extraction. Edit with the correct value.`,
    };
  }

  // ── Suite / floor fields: reject common word fragments ───────────────────────
  // The extractor sometimes grabs the word following "Suite" or "Floor" in a
  // sentence — e.g. "space in the Building" → suite_number = "in", or
  // "per leasable square foot" when it hits a rent sentence. These are
  // confirmed extraction failure modes observed in production leases.
  const ARTICLE_PREPOSITIONS = new Set([
    "in", "at", "of", "the", "a", "an", "on", "by", "to", "for",
    "with", "and", "or", "is", "as", "be", "not", "no", "per",
  ]);
  if (fieldKey === "suite_number" || fieldKey === "floor") {
    // Check exact match (single word) or first word of multi-word value.
    const firstWord = lower.split(/\s+/)[0];
    if (ARTICLE_PREPOSITIONS.has(lower) || ARTICLE_PREPOSITIONS.has(firstWord)) {
      return {
        valid: false,
        reason: `"${str}" is not a valid ${fieldKey.replace(/_/g, " ")} — looks like a word fragment from surrounding lease text. Edit with the correct value.`,
      };
    }
  }

  // ── Numeric keys ─────────────────────────────────────────────────────────────
  if (NUMERIC_KEYS.has(fieldKey)) {
    const n = parseAccountingNumber(value, { allowUnitWords: true });
    if (!Number.isFinite(n) || n < 0) {
      return {
        valid: false,
        reason: `"${str}" is not a valid number for ${fieldKey.replace(/_/g, " ")}.`,
      };
    }
    if (fieldKey === "square_footage" && n === 0) {
      return { valid: false, reason: "Square footage cannot be zero." };
    }
  }

  // ── Currency keys ─────────────────────────────────────────────────────────────
  if (CURRENCY_KEYS.has(fieldKey)) {
    const n = parseAccountingNumber(value);
    if (!Number.isFinite(n) || n < 0) {
      return {
        valid: false,
        reason: `"${str}" is not a valid currency amount for ${fieldKey.replace(/_/g, " ")}.`,
      };
    }
  }

  // ── Percent keys ─────────────────────────────────────────────────────────────
  if (PERCENT_KEYS.has(fieldKey)) {
    const n = parseAccountingNumber(value, { allowPercent: true });
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      return {
        valid: false,
        reason: `"${str}" is not a valid percentage for ${fieldKey.replace(/_/g, " ")}.`,
      };
    }
  }

  // ── Date keys ─────────────────────────────────────────────────────────────────
  if (DATE_KEYS.has(fieldKey) || fieldKey.endsWith("_date")) {
    if (typeof value === "string") {
      if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
        // Preferred ISO format — validate exact calendar components so
        // rollover dates like 2024-02-30 are rejected.
        if (!isRealIsoDate(str)) {
          return { valid: false, reason: `"${str}" is not a valid calendar date.` };
        }
      } else {
        // Human-readable format (e.g. "September 8, 2020") — check if it
        // can be parsed at all. If yes, flag as needing normalization but
        // don't hard-block the review; if it's completely unparseable, reject.
        const parsed = new Date(str);
        if (Number.isNaN(parsed.getTime())) {
          return {
            valid: false,
            reason: `"${str}" is not a recognized date format (expected YYYY-MM-DD).`,
          };
        }
        // Parseable but not normalized — warn so the reviewer can save it
        // in the correct format via Edit.
        const iso = new Date(Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()))
          .toISOString()
          .slice(0, 10);
        return {
          valid: false,
          reason: `Date should be in YYYY-MM-DD format — edit to "${iso}".`,
        };
      }
    }
  }

  return { valid: true };
}

/**
 * Determine source_quality for a field at display time.
 *
 * "exact"   — labeled row or snippet that ends at a sentence boundary
 * "partial" — mid-sentence fragment (should be marked needs_review)
 * "derived" — value calculated from other fields, no direct quote possible
 * "missing" — no source text available for a field that has a value
 */
export function computeSourceQuality(value, sourceText, extractionStatus) {
  if (!value && value !== 0) return "missing";
  if (/^(calculated|derived|computed)/i.test(String(extractionStatus || ""))) return "derived";
  if (!sourceText) return "missing";
  if (/^[A-Za-z][^:\n]{0,80}:\s\S/.test(sourceText)) return "exact";
  if (/[.!?]["']?\s*$/.test(sourceText)) return "exact";
  return "partial";
}

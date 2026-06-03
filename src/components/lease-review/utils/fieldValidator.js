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
  "lease_term_months",
]);

/** Field keys whose values must be parseable as money. */
const CURRENCY_KEYS = new Set([
  "monthly_rent", "annual_rent", "security_deposit", "cam_amount",
  "ti_allowance", "expense_stop", "general_liability_min",
]);

/** Field keys that must be a valid ISO date (YYYY-MM-DD). */
const DATE_KEYS = new Set([
  "commencement_date", "expiration_date", "lease_date",
  "rent_commencement_date", "option_exercise_deadline",
  "assignment_effective_date",
]);

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

  // ── Numeric keys ─────────────────────────────────────────────────────────────
  if (NUMERIC_KEYS.has(fieldKey)) {
    const n = Number(String(value));
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
    const n = Number(String(value).replace(/[$,\s]/g, ""));
    if (!Number.isFinite(n) || n < 0) {
      return {
        valid: false,
        reason: `"${str}" is not a valid currency amount for ${fieldKey.replace(/_/g, " ")}.`,
      };
    }
  }

  // ── Date keys ─────────────────────────────────────────────────────────────────
  if (DATE_KEYS.has(fieldKey) || fieldKey.endsWith("_date")) {
    // Values from the extraction pipeline are in YYYY-MM-DD format.
    if (typeof value === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(str)) {
      return {
        valid: false,
        reason: `"${str}" is not a recognized date format (expected YYYY-MM-DD).`,
      };
    }
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(str)) {
      const d = new Date(`${str}T00:00:00Z`);
      if (Number.isNaN(d.getTime())) {
        return { valid: false, reason: `"${str}" is not a valid calendar date.` };
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

export const EVIDENCE_ALIGNED_EXTRACTION_VERSION = "lease_rule_pipeline_v3_evidence_aligned";
export const LEGACY_EXTRACTION_VERSION = "v1.2026.05.19";

export function asNumber(val) {
  if (val === null || val === undefined || val === "") return null;
  if (typeof val === 'number') return val;
  const str = String(val).replace(/[^0-9.-]/g, '');
  if (!str) return null;
  const num = Number(str);
  return isNaN(num) ? null : num;
}

export function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function normalizeFrequency(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (["monthly", "quarterly", "yearly"].includes(raw)) return raw;
  return "yearly";
}

export function normalizeRuleSource(value) {
  const raw = String(value || "").trim();
  return raw || null;
}

export function normalizeCategoryToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function normalizeCategoryKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function humanizeLabel(value) {
  const text = String(value || "")
    .replace(/[_-]+/g, " ")
    .trim();
  if (!text) return "Uncategorized";
  return text.replace(/\b\w/g, (char) => char.toUpperCase());
}

export function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

export function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

export function firstPresent(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    return value;
  }
  return null;
}

export function isLlmGeneratedRule(rule) {
  return [
    rule?.source_type,
    rule?.generation_source,
    rule?.created_from,
    rule?.extraction_source,
  ].some((value) => normalizeText(value).includes("llm"));
}

export function isApprovedWorkflowStatus(value) {
  return normalizeText(value) === "approved";
}

export function isEvidenceAlignedVersion(value) {
  return normalizeText(value) === EVIDENCE_ALIGNED_EXTRACTION_VERSION;
}


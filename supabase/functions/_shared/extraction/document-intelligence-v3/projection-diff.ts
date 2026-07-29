// @ts-nocheck
/**
 * Document Intelligence v3 — Projection Diff (Release 2)
 *
 * Compares the live `ui_review_payload.records[0].standard_fields[]` (the
 * "legacy" side reviewers actually see today) against a v3 run's
 * `document_canonical_field_projections` rows (the "canonical" side) on a
 * per-field basis, with type-aware value normalization. Diagnostic only —
 * never persisted, never read by the review UI.
 *
 * Reuses the P2 claims-ledger's existing normalization machinery
 * (claims/adapters/claim-normalization.ts, claims/concept-registry.ts's
 * inferValueType) rather than re-deriving a parallel money/date/percent
 * parser.
 *
 * Percent convention: this platform stores percent-typed fields as the raw
 * percent number (5 means "5%"), confirmed from schemas.ts's admin_fee_pct
 * (min:0,max:30) and llm-extractor.ts's explicit prompt instruction ("Return
 * only the number (e.g. 5 for 'five percent (5%)')"). normalizePercentage()
 * already implements exactly this convention — do not "fix" it to a 0-1
 * decimal-fraction convention, which would be wrong for this schema.
 *
 * Status vocabularies are NOT reconciled here: legacy `standard_fields[].status`
 * comes from buildReviewField()/computeFieldStatus() in normalize-pdf-output
 * (an app-level vocabulary), while canonical `document_canonical_field_projections.status`
 * is the DB CHECK-constrained 5-value enum (missing/auto_populated/needs_review/
 * reviewer_confirmed/reviewer_edited). statusMatch is a plain string-equality
 * signal for reviewers to interpret, not a semantic mapping between the two
 * vocabularies -- building that mapping is out of scope for this release.
 */

import { getSchema, type FieldDef } from "../schemas.ts";
import { normalizeByStrategy } from "../claims/adapters/claim-normalization.ts";
import { inferValueType } from "../claims/concept-registry.ts";
import type { ModuleType } from "../types.ts";

export const CRITICAL_FIELD_KEYS: readonly string[] = [
  "landlord_name",
  "tenant_name",
  "commencement_date",
  "expiration_date",
  "monthly_rent",
  "lease_term_months",
  "admin_fee_pct",
  "responsibility_taxes",
  "renewal_notice_months",
  "option_exercise_deadline",
];

export type DifferenceType =
  | "exact_match"
  | "normalized_match"
  | "legacy_only"
  | "canonical_only"
  | "value_conflict"
  | "status_conflict"
  | "evidence_conflict";

export type Materiality = "critical" | "material" | "informational";

export type ComparisonStatus = "available" | "unavailable_no_fact_ledger" | "unavailable_no_projections";

export interface ProjectionDiff {
  documentId: string;
  fieldKey: string;
  legacyValue: unknown;
  canonicalValue: unknown;
  legacyStatus: string | null;
  canonicalStatus: string | null;
  legacyConfidence: number | null;
  canonicalConfidence: number | null;
  legacySourcePage: number | null;
  canonicalSourcePage: number | null;
  valueMatch: boolean;
  statusMatch: boolean;
  evidencePageMatch: boolean;
  differenceType: DifferenceType;
  materiality: Materiality;
  dateAmbiguous: boolean;
}

/**
 * Presence check that treats 0, false, and other falsy-but-real values as
 * present. Plain `Boolean(value)`/`!value` would wrongly classify a real
 * `0` or `false` extraction as "missing".
 */
export function hasComparableValue(value: unknown): boolean {
  return value !== null && value !== undefined && !(typeof value === "string" && value.trim() === "");
}

const AMBIGUOUS_SLASH_DATE_RE = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/;

/**
 * A numeric slash-form date (e.g. "01/02/2026") is structurally ambiguous
 * between MM/DD and DD/MM whenever both components are <=12 -- there is no
 * way to tell which convention produced it from the string alone. ISO
 * ("2026-01-02") and named-month ("Jan 2, 2026") forms are never ambiguous.
 */
export function isAmbiguousDateFormat(raw: unknown): boolean {
  if (raw == null) return false;
  const match = String(raw).trim().match(AMBIGUOUS_SLASH_DATE_RE);
  if (!match) return false;
  const a = Number.parseInt(match[1], 10);
  const b = Number.parseInt(match[2], 10);
  return a <= 12 && b <= 12;
}

const NUMBER_VALUE_TYPE_TO_STRATEGY: Record<string, string> = {
  money: "money_to_decimal",
  decimal: "decimal_parse",
  percentage: "percentage_to_decimal",
  integer: "integer_parse",
};

/**
 * field.type is authoritative for date/boolean/enum. For type:"number",
 * schemas.ts doesn't distinguish money vs. percent vs. plain decimal/integer
 * -- concept-registry.ts's inferValueType(fieldKey) (a naming-convention
 * regex already used for the P2 claims ledger) fills that gap.
 */
export function classifyFieldNormalization(
  field: FieldDef | null | undefined,
  fieldKey: string,
): { strategy: string; valueType: string } {
  const type = field?.type;
  if (type === "date") return { strategy: "date_to_iso", valueType: "date" };
  if (type === "boolean") return { strategy: "boolean_parse", valueType: "boolean" };
  if (type === "enum") return { strategy: "string_trim", valueType: "enum" };
  if (type === "number") {
    const inferred = inferValueType(fieldKey);
    const strategy = NUMBER_VALUE_TYPE_TO_STRATEGY[inferred] ?? "decimal_parse";
    return { strategy, valueType: inferred in NUMBER_VALUE_TYPE_TO_STRATEGY ? inferred : "decimal" };
  }
  return { strategy: "string_trim", valueType: "string" };
}

function normEqual(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a === b;
}

function compareEnumValues(
  legacyValue: unknown,
  canonicalValue: unknown,
  field: FieldDef | null | undefined,
): { valueMatch: boolean; differenceType: DifferenceType } {
  const norm = (v: unknown) => String(v).trim().toLowerCase();
  const legacyNorm = norm(legacyValue);
  const canonicalNorm = norm(canonicalValue);
  if (legacyNorm === canonicalNorm) {
    return { valueMatch: true, differenceType: "exact_match" };
  }
  const enumValues = field?.enumValues ?? [];
  const canonicalOf = (v: string) => enumValues.find((e) => norm(e) === v) ?? null;
  const legacyCanon = canonicalOf(legacyNorm);
  const canonicalCanon = canonicalOf(canonicalNorm);
  if (legacyCanon && canonicalCanon && legacyCanon === canonicalCanon) {
    return { valueMatch: true, differenceType: "normalized_match" };
  }
  return { valueMatch: false, differenceType: "value_conflict" };
}

export interface FieldValueComparison {
  valueMatch: boolean;
  differenceType: DifferenceType;
  dateAmbiguous: boolean;
  valueType: string;
}

export function compareFieldValues(
  legacyValue: unknown,
  canonicalValue: unknown,
  field: FieldDef | null | undefined,
  fieldKey: string,
): FieldValueComparison {
  const legacyPresent = hasComparableValue(legacyValue);
  const canonicalPresent = hasComparableValue(canonicalValue);
  const { strategy, valueType } = classifyFieldNormalization(field, fieldKey);

  if (!legacyPresent && !canonicalPresent) {
    return { valueMatch: true, differenceType: "exact_match", dateAmbiguous: false, valueType };
  }
  if (legacyPresent && !canonicalPresent) {
    return { valueMatch: false, differenceType: "legacy_only", dateAmbiguous: false, valueType };
  }
  if (!legacyPresent && canonicalPresent) {
    return { valueMatch: false, differenceType: "canonical_only", dateAmbiguous: false, valueType };
  }

  if (valueType === "enum") {
    const { valueMatch, differenceType } = compareEnumValues(legacyValue, canonicalValue, field);
    return { valueMatch, differenceType, dateAmbiguous: false, valueType };
  }

  const rawEqual = String(legacyValue).trim() === String(canonicalValue).trim();
  if (rawEqual) {
    return { valueMatch: true, differenceType: "exact_match", dateAmbiguous: false, valueType };
  }

  const legacyNorm = normalizeByStrategy(strategy, legacyValue);
  const canonicalNorm = normalizeByStrategy(strategy, canonicalValue);
  const dateAmbiguous = valueType === "date" && (isAmbiguousDateFormat(legacyValue) || isAmbiguousDateFormat(canonicalValue));

  if (normEqual(legacyNorm, canonicalNorm)) {
    return { valueMatch: true, differenceType: "normalized_match", dateAmbiguous, valueType };
  }
  return { valueMatch: false, differenceType: "value_conflict", dateAmbiguous, valueType };
}

/**
 * Materiality is driven by the field's own value/status agreement, not by
 * evidence-page agreement alone -- a page mismatch on an otherwise-matching
 * value can indicate a duplicate clause, a summary vs. operative clause, an
 * amendment, or a page-numbering offset, none of which mean the extracted
 * VALUE is wrong. Per review correction 4, evidence_conflict alone is always
 * informational regardless of whether the field is critical.
 */
export function classifyMateriality(
  fieldKey: string,
  differenceType: DifferenceType,
  field: FieldDef | null | undefined,
): Materiality {
  if (differenceType === "exact_match" || differenceType === "normalized_match") return "informational";
  if (differenceType === "evidence_conflict") return "informational";

  const isCritical = CRITICAL_FIELD_KEYS.includes(fieldKey);
  if (isCritical) return "critical";

  // Derived directly from the passed-in field def, not re-looked-up by key
  // via getFieldEvidencePolicy(fieldKey, moduleType) -- that function's own
  // lookup is keyed by moduleType, not usable here where only the resolved
  // FieldDef is in scope (same reasoning as the Release 1 fix to
  // evaluateCandidateForField(), which had the identical bug).
  const policy = field?.evidencePolicy ?? (field?.domain ? "advisory" : "unconfigured");
  if (policy === "enforced" || policy === "advisory") return "material";
  return "informational";
}

interface LegacyFieldRecord {
  field_key: string;
  value?: unknown;
  status?: string | null;
  confidence?: number | null;
  evidence?: { source_page?: number | null; source_text?: string | null } | null;
}

interface CanonicalProjectionRecord {
  field_key: string;
  value?: unknown;
  normalized_value?: unknown;
  status?: string | null;
  confidence?: number | null;
  source_page?: number | null;
  source_text?: string | null;
}

function pageMatch(a: number | null, b: number | null): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return a === b;
}

export interface BuildProjectionDiffResult {
  diffs: ProjectionDiff[];
  comparisonStatus: ComparisonStatus;
}

/**
 * hasClaims distinguishes the two "nothing to compare" reasons the run
 * itself can tell us: no claims were ever extracted for this run (Mode A /
 * legacy_hybrid — expected, see the Two Test Modes section of the release
 * plan) vs. claims existed but none became canonical field projections (a
 * real gap worth investigating). Both leave canonicalProjections empty, but
 * they are not the same situation and must not be reported identically.
 */
export function buildProjectionDiff(args: {
  documentId: string;
  legacyFields: LegacyFieldRecord[];
  canonicalProjections: CanonicalProjectionRecord[];
  hasClaims: boolean;
  moduleType: ModuleType;
}): BuildProjectionDiffResult {
  const { documentId, legacyFields, canonicalProjections, hasClaims, moduleType } = args;

  if (canonicalProjections.length === 0) {
    return {
      diffs: [],
      comparisonStatus: hasClaims ? "unavailable_no_projections" : "unavailable_no_fact_ledger",
    };
  }

  const schema = getSchema(moduleType);
  const legacyByKey = new Map(legacyFields.map((f) => [f.field_key, f]));
  const canonicalByKey = new Map(canonicalProjections.map((p) => [p.field_key, p]));
  const allKeys = new Set([...legacyByKey.keys(), ...canonicalByKey.keys()]);

  const diffs: ProjectionDiff[] = [];
  for (const fieldKey of allKeys) {
    const field = schema[fieldKey] ?? null;
    const legacy = legacyByKey.get(fieldKey) ?? null;
    const canonical = canonicalByKey.get(fieldKey) ?? null;

    const legacyValue = legacy?.value ?? null;
    const canonicalValue = canonical?.normalized_value ?? canonical?.value ?? null;
    const legacySourcePage = legacy?.evidence?.source_page ?? null;
    const canonicalSourcePage = canonical?.source_page ?? null;

    const valueComparison = compareFieldValues(legacyValue, canonicalValue, field, fieldKey);
    const legacyStatus = legacy?.status ?? null;
    const canonicalStatus = canonical?.status ?? null;
    const statusMatch = legacyStatus === canonicalStatus;
    const evidencePageMatch = pageMatch(legacySourcePage, canonicalSourcePage);

    let differenceType = valueComparison.differenceType;
    // Value agreement is the primary axis; status/evidence conflicts are
    // only surfaced as their own differenceType when the value itself
    // already agrees (a value_conflict/legacy_only/canonical_only already
    // explains the disagreement more usefully than a status/evidence note).
    if ((differenceType === "exact_match" || differenceType === "normalized_match") && !statusMatch) {
      differenceType = "status_conflict";
    } else if ((differenceType === "exact_match" || differenceType === "normalized_match") && !evidencePageMatch) {
      differenceType = "evidence_conflict";
    }

    diffs.push({
      documentId,
      fieldKey,
      legacyValue,
      canonicalValue,
      legacyStatus,
      canonicalStatus,
      legacyConfidence: legacy?.confidence ?? null,
      canonicalConfidence: canonical?.confidence ?? null,
      legacySourcePage,
      canonicalSourcePage,
      valueMatch: valueComparison.valueMatch,
      statusMatch,
      evidencePageMatch,
      differenceType,
      materiality: classifyMateriality(fieldKey, differenceType, field),
      dateAmbiguous: valueComparison.dateAmbiguous,
    });
  }

  return { diffs, comparisonStatus: "available" };
}

export interface ProjectionDiffSummary {
  comparisonStatus: ComparisonStatus;
  fieldCount: number | null;
  exactMatchRate: number | null;
  normalizedMatchRate: number | null;
  materialConflictCount: number | null;
  criticalFieldAgreementRate: number | null;
  ambiguousDateCount: number | null;
  evidencePageMismatchCount: number | null;
  materialityBreakdown: Record<Materiality, number> | null;
}

/**
 * When comparisonStatus !== "available", every rate is null (not 0) --
 * "nothing to compare" must never render as "0% agreement", which would
 * misrepresent an expected, unavailable comparison as total disagreement.
 */
export function summarizeProjectionDiff(diffs: ProjectionDiff[], comparisonStatus: ComparisonStatus): ProjectionDiffSummary {
  if (comparisonStatus !== "available") {
    return {
      comparisonStatus,
      fieldCount: null,
      exactMatchRate: null,
      normalizedMatchRate: null,
      materialConflictCount: null,
      criticalFieldAgreementRate: null,
      ambiguousDateCount: null,
      evidencePageMismatchCount: null,
      materialityBreakdown: null,
    };
  }

  const total = diffs.length;
  const exactMatches = diffs.filter((d) => d.differenceType === "exact_match").length;
  const normalizedMatches = diffs.filter((d) => d.differenceType === "normalized_match").length;
  const materialConflicts = diffs.filter((d) => d.materiality === "material" || d.materiality === "critical").length;
  const ambiguousDateCount = diffs.filter((d) => d.dateAmbiguous).length;
  const evidencePageMismatchCount = diffs.filter((d) => !d.evidencePageMatch).length;

  const criticalDiffs = diffs.filter((d) => CRITICAL_FIELD_KEYS.includes(d.fieldKey));
  const criticalAgreeing = criticalDiffs.filter((d) => d.valueMatch).length;

  const materialityBreakdown: Record<Materiality, number> = { critical: 0, material: 0, informational: 0 };
  for (const d of diffs) materialityBreakdown[d.materiality] += 1;

  return {
    comparisonStatus,
    fieldCount: total,
    exactMatchRate: total > 0 ? exactMatches / total : null,
    normalizedMatchRate: total > 0 ? (exactMatches + normalizedMatches) / total : null,
    materialConflictCount: materialConflicts,
    criticalFieldAgreementRate: criticalDiffs.length > 0 ? criticalAgreeing / criticalDiffs.length : null,
    ambiguousDateCount,
    evidencePageMismatchCount,
    materialityBreakdown,
  };
}

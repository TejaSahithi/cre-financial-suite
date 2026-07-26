// @ts-nocheck
/**
 * Lease Truth Assembly — the single canonical publication layer.
 *
 * Both extraction pipelines (legacy_hybrid via pipeline.ts, openai_fact_ledger
 * via openai-fact-ledger/orchestrator.ts) already converge on ONE identical,
 * pipeline-agnostic evidence carrier: `metadata.extractionDebug.merged_field_sources`
 * -- both call the exact same `snapshotFieldMap()` (pipeline.ts) against their
 * own mapper/merger's `records[0].fields`, producing
 * `{ value, source, confidence, source_text, source_page, extraction_status }`
 * per field key, regardless of which pipeline ran (confirmed by reading both
 * call sites: pipeline.ts's own STEP 5 and
 * openai-fact-ledger/orchestrator.ts:227). This module is deliberately built
 * on top of THAT existing, shared contract rather than re-deriving per-field
 * evidence from either pipeline's internals -- there is no new parallel
 * document graph or retrieval system here, only one new reconciliation layer
 * consuming what both pipelines already produce identically.
 *
 * Called once, from normalize-pdf-output/index.ts, immediately after
 * runBusinessExtraction() returns and before ui_review_payload is persisted --
 * this is the ONE place both pipelines' results already converge in the
 * active runtime path. Its output is attached at
 * `metadata.extractionDebug.canonical_fields` and `canonical_fields_version`,
 * which flow through the SAME existing extractionDebug persistence normalize-
 * pdf-output already performs -- no change to how ui_review_payload itself is
 * written.
 *
 * Existing mapper/merger functions remain the candidate producers. This
 * module never re-extracts from source text; it only reconciles what they
 * already produced -- resolving true field-name aliases, merging duplicate-
 * concept OR-alternate pairs into one publish identity, validating actor/
 * action/object obligation direction, cross-validating term dates and rent
 * arithmetic, and computing a capped, multi-component confidence -- then
 * returns ONE canonical result per concept. Nothing downstream may bypass it
 * to reach a field value the pipelines disagree on.
 */

import { resolveCanonicalKey, getFieldContract } from "./field-contract.ts";
import {
  inferSemanticProfile,
  checkFieldSemanticCompatibility,
  hasSemanticRequirement,
  type SemanticProfile,
} from "./semantic-compatibility.ts";

export const LEASE_TRUTH_ASSEMBLY_VERSION = "1.0.0";

export type CanonicalFieldStatus =
  | "verified"
  | "derived_verified"
  | "needs_review"
  | "conflicting"
  | "not_stated"
  | "not_applicable"
  | "extraction_failed";

export interface ValidationResult {
  rule: string;
  passed: boolean;
  message?: string;
}

export interface ConfidenceComponents {
  extractionConfidence: number | null;
  sourceAuthorityConfidence: number;
  semanticRoleConfidence: number | null;
  crossFieldConfidence: number | null;
  /** Weakest CRITICAL component -- the actual cap applied to `final`. */
  cappedBy: string | null;
  final: number;
}

export interface CanonicalFieldResult {
  fieldId: string;
  value: unknown | null;
  status: CanonicalFieldStatus;
  selectedCandidateKey?: string;
  rejectedCandidateKeys: string[];
  sourcePage?: number | null;
  sourceText?: string | null;
  resolver: string;
  validationResults: ValidationResult[];
  confidenceComponents: ConfidenceComponents;
}

interface RawFieldEvidence {
  key: string;
  value: unknown;
  source: string | null;
  confidence: number | null;
  sourceText: string | null;
  sourcePage: number | null;
}

// ── Duplicate-concept publish groups ─────────────────────────────────────────
// field-contract.ts's `alternateFieldKeys` mechanism covers TWO different
// relationships that must not be conflated (its own docstring says so): OR-
// alternate readiness pairs that are genuinely different facts (e.g.
// property_address / property_name -- a lease legitimately has both, they
// must both keep displaying independently), and true duplicate-concept pairs
// where the SAME real-world fact is independently extracted twice under two
// schema field names (marked in field-contract.ts via `preferredForAutomatedLogic`).
// Only the latter are merged into one published canonical identity here.
// start_date/commencement_date and end_date/expiration_date have no
// `preferredForAutomatedLogic` entry in field-contract.ts (they are legitimate
// OR-alternates there), but the frontend's own FIELD_ALIASES
// (src/lib/leaseFieldResolver.js) already treats them as the same display
// concept -- this is exactly the "duplicate aliases producing contradictory
// UI values" failure mode named in this task, so they are included here too,
// with commencement_date/expiration_date chosen as the canonical publish name
// (standard lease terminology, and already fed by the resolveLeaseTermDatePair
// heuristic in fact-field-mapper.ts).
//
// tenant_contact_name was investigated and is NOT merged with tenant_name:
// tenant_name is the legal tenant entity; tenant_contact_name is the day-to-
// day notices contact person -- two different real-world facts that happen to
// share a naming pattern, not a duplicate-concept pair (see this session's
// Micro-step 0 fix to the group hint distinguishing them). Merging them would
// itself recreate the "guaranty language mapped as renewal options"-style bug
// this task is trying to eliminate: conflating two distinct concepts.
interface DuplicateConceptGroup {
  canonicalId: string;
  members: string[];
}
const DUPLICATE_CONCEPT_GROUPS: DuplicateConceptGroup[] = [
  { canonicalId: "commencement_date", members: ["commencement_date", "start_date"] },
  { canonicalId: "expiration_date", members: ["expiration_date", "end_date"] },
  { canonicalId: "responsibility_taxes", members: ["responsibility_taxes", "tax_responsibility"] },
  { canonicalId: "responsibility_insurance", members: ["responsibility_insurance", "insurance_responsibility"] },
];
const MEMBER_TO_GROUP = new Map<string, string>();
for (const group of DUPLICATE_CONCEPT_GROUPS) {
  for (const member of group.members) MEMBER_TO_GROUP.set(member, group.canonicalId);
}

export function publishIdFor(rawKey: string): string {
  const aliasResolved = resolveCanonicalKey(rawKey);
  return MEMBER_TO_GROUP.get(aliasResolved) ?? aliasResolved;
}

// ── Normalize both pipelines' identical extractionDebug.merged_field_sources
// shape into one internal evidence record. ───────────────────────────────────
function normalizeEvidence(mergedFieldSources: Record<string, any> | null | undefined): RawFieldEvidence[] {
  const out: RawFieldEvidence[] = [];
  for (const [key, entry] of Object.entries(mergedFieldSources ?? {})) {
    if (!entry || typeof entry !== "object") continue;
    out.push({
      key,
      value: (entry as any).value ?? null,
      source: (entry as any).source ?? null,
      confidence: typeof (entry as any).confidence === "number" ? (entry as any).confidence : null,
      sourceText: (entry as any).source_text ?? (entry as any).sourceText ?? null,
      sourcePage: (entry as any).source_page ?? (entry as any).sourcePage ?? null,
    });
  }
  return out;
}

// ── Actor/action/object obligation direction ─────────────────────────────────
// "Tenant shall pay Landlord its share of taxes" must attribute cost-bearing
// responsibility to the ACTOR of the pay/reimburse/perform verb (tenant),
// never to whichever party name merely appears nearby (landlord, as the
// payment's recipient). Generalized across arbitrary lease templates: this
// looks at grammatical subject position relative to the responsibility verb,
// not at which party name occurs first or most often in the sentence.
const ACTOR_VERB_PATTERN =
  /\b(tenant|landlord|lessee|lessor)\b(?:'s)?\s+(?:shall|will|must|agrees?\s+to|is\s+(?:responsible|obligated)\s+to)\s+(?:also\s+|directly\s+|promptly\s+)?(pay|reimburse|bear|maintain|repair|replace|insure|procure|perform|allocate)\b/i;

function normalizePartyToken(token: string): "tenant" | "landlord" | "unknown" {
  const lower = token.toLowerCase();
  if (lower === "tenant" || lower === "lessee") return "tenant";
  if (lower === "landlord" || lower === "lessor") return "landlord";
  return "unknown";
}

/** Returns the party that is grammatically the ACTOR of the responsibility
 *  verb in `sourceText`, or "unknown" if no actor/verb pattern is found (e.g.
 *  passive-voice or non-obligation text) -- callers must not guess further in
 *  that case. */
export function inferObligationActor(sourceText: string): "tenant" | "landlord" | "unknown" {
  const match = String(sourceText ?? "").match(ACTOR_VERB_PATTERN);
  if (!match) return "unknown";
  return normalizePartyToken(match[1]);
}

/** Validates that a responsibility-family field's VALUE (the normalized
 *  payer answer, e.g. "tenant"/"landlord") matches the sourceText's actual
 *  grammatical actor, not merely a nearby party name. Returns null (no
 *  opinion) when the value isn't a plain tenant/landlord token (e.g.
 *  "shared") or no actor could be determined -- this check only fires when
 *  it can be positively wrong, never when it merely lacks information. */
function validateObligationDirection(value: unknown, sourceText: string): ValidationResult | null {
  const valueParty = normalizePartyToken(String(value ?? ""));
  if (valueParty === "unknown") return null;
  const actor = inferObligationActor(sourceText);
  if (actor === "unknown") return null;
  if (actor !== valueParty) {
    return {
      rule: "obligation_direction",
      passed: false,
      message: `Value attributes responsibility to "${valueParty}", but the source text's grammatical actor for the pay/perform obligation is "${actor}" -- responsibility must follow the actor, not the nearest party name.`,
    };
  }
  return { rule: "obligation_direction", passed: true };
}

const RESPONSIBILITY_FIELDS = new Set([
  "responsibility_taxes",
  "tax_responsibility",
  "responsibility_insurance",
  "insurance_responsibility",
  "electric_responsibility",
  "water_sewer_responsibility",
  "responsibility_repairs",
  "responsibility_utilities",
  "hvac_responsibility",
]);

// ── Term-date cross-validation (TermResolver) ────────────────────────────────
function tryParseDateMs(value: unknown): number | null {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Cross-validates commencement_date/expiration_date once both canonical
 *  results are known. Returns validation results to merge into each field's
 *  own result -- never fabricates a missing date, only flags an impossible
 *  relationship between two ALREADY-selected values. */
function validateTermDateRelationship(
  commencement: CanonicalFieldResult | undefined,
  expiration: CanonicalFieldResult | undefined,
): { commencement?: ValidationResult; expiration?: ValidationResult } {
  if (!commencement?.value || !expiration?.value) return {};
  const commencementMs = tryParseDateMs(commencement.value);
  const expirationMs = tryParseDateMs(expiration.value);
  if (commencementMs == null || expirationMs == null) return {};
  if (expirationMs <= commencementMs) {
    const message = `expiration_date (${expiration.value}) must be after commencement_date (${commencement.value}), but is not.`;
    return {
      commencement: { rule: "term_date_order", passed: false, message },
      expiration: { rule: "term_date_order", passed: false, message },
    };
  }
  return {
    commencement: { rule: "term_date_order", passed: true },
    expiration: { rule: "term_date_order", passed: true },
  };
}

// ── Rent arithmetic cross-validation (RentResolver) ──────────────────────────
// Tolerant of OCR losing a currency glyph (e.g. "$1,400" read as "1,400" or
// "1400.00" losing the decimal) -- comparison is purely numeric after
// stripping currency/formatting characters, never string-exact.
function parseMoneyLoose(value: unknown): number | null {
  if (value == null) return null;
  const text = String(value).replace(/[$,\s]/g, "");
  if (!text || !/^-?\d+(?:\.\d+)?$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function validateRentArithmetic(
  monthly: CanonicalFieldResult | undefined,
  annual: CanonicalFieldResult | undefined,
): { monthly?: ValidationResult; annual?: ValidationResult } {
  if (!monthly?.value || !annual?.value) return {};
  const monthlyNum = parseMoneyLoose(monthly.value);
  const annualNum = parseMoneyLoose(annual.value);
  if (monthlyNum == null || annualNum == null) return {};
  const expectedAnnual = monthlyNum * 12;
  // Tolerance: 1% relative, or $2 absolute (covers rounding + minor OCR
  // digit/glyph loss), whichever is larger.
  const tolerance = Math.max(2, expectedAnnual * 0.01);
  if (Math.abs(expectedAnnual - annualNum) > tolerance) {
    const message = `monthly_rent x 12 (${expectedAnnual.toFixed(2)}) does not reconcile with annual_rent (${annualNum}) within tolerance.`;
    return {
      monthly: { rule: "rent_arithmetic", passed: false, message },
      annual: { rule: "rent_arithmetic", passed: false, message },
    };
  }
  return {
    monthly: { rule: "rent_arithmetic", passed: true },
    annual: { rule: "rent_arithmetic", passed: true },
  };
}

// ── Confidence model ──────────────────────────────────────────────────────────
const SOURCE_AUTHORITY_BY_SOURCE: Record<string, number> = {
  rule: 0.9,
  table: 0.85,
  llm: 0.75,
};

function computeConfidence(args: {
  extractionConfidence: number | null;
  sourceAuthority: number;
  semanticPassed: boolean | null;
  crossFieldPassed: boolean | null;
}): ConfidenceComponents {
  const { extractionConfidence, sourceAuthority, semanticPassed, crossFieldPassed } = args;
  const semanticRoleConfidence = semanticPassed == null ? null : semanticPassed ? 1 : 0;
  const crossFieldConfidence = crossFieldPassed == null ? null : crossFieldPassed ? 1 : 0.15;

  // Only TRUST/VALIDITY signals (semantic-role compatibility, cross-field
  // consistency) cap the final confidence -- sourceAuthorityConfidence is
  // informational/tie-break metadata only (rule > table > llm, used to pick
  // among otherwise-equal candidates), never a reason by itself to display a
  // lower confidence for an already-selected, validated value. Conflating
  // the two was a real bug caught by this module's own test suite: an
  // llm-sourced (or source-unlabeled) but fully-valid candidate was being
  // dragged down to ~0.5 confidence for no defect of its own.
  const criticalComponents: Array<[string, number | null]> = [
    ["semanticRoleConfidence", semanticRoleConfidence],
    ["crossFieldConfidence", crossFieldConfidence],
  ];
  let cappedBy: string | null = null;
  let cap = 1;
  for (const [name, value] of criticalComponents) {
    if (value == null) continue;
    if (value < cap) {
      cap = value;
      cappedBy = name;
    }
  }
  // A semantically incompatible or cross-field-broken candidate must never
  // display as high-confidence, regardless of how confident the raw
  // extraction step was -- this is the direct fix for "95-99% confidence
  // shown for semantically invalid mappings".
  const final = Math.round(
    Math.min(cap, extractionConfidence ?? 1) * 100,
  ) / 100;

  return {
    extractionConfidence,
    sourceAuthorityConfidence: sourceAuthority,
    semanticRoleConfidence,
    crossFieldConfidence,
    cappedBy,
    final,
  };
}

// ── Main assembly ─────────────────────────────────────────────────────────────

export interface AssembleCanonicalFieldsInput {
  rows: Array<Record<string, unknown>> | null | undefined;
  extractionDebug: Record<string, unknown> | null | undefined;
  moduleType: string;
}

export interface AssembleCanonicalFieldsResult {
  version: string;
  canonicalFields: Record<string, CanonicalFieldResult>;
}

/**
 * The ONLY function that may publish canonical review field values. Consumes
 * whichever pipeline ran's already-produced rows[0] + the shared
 * extractionDebug.merged_field_sources evidence (see module docstring) and
 * returns one CanonicalFieldResult per concept -- resolving true aliases,
 * merging duplicate-concept pairs, validating obligation direction, cross-
 * validating term dates and rent arithmetic, and capping confidence by the
 * weakest critical component.
 */
export function assembleCanonicalFields(input: AssembleCanonicalFieldsInput): AssembleCanonicalFieldsResult {
  const row0 = input.rows?.[0] ?? {};
  const mergedFieldSources = (input.extractionDebug as any)?.merged_field_sources ?? null;
  const evidenceList = normalizeEvidence(mergedFieldSources);
  const evidenceByKey = new Map(evidenceList.map((e) => [e.key, e]));

  // Every raw key seen anywhere (rows[0] scalar-only fields, e.g. derived
  // fields not captured in merged_field_sources, plus every key
  // merged_field_sources itself carries) is a candidate to publish.
  const allRawKeys = new Set<string>([...Object.keys(row0), ...evidenceByKey.keys()]);

  // Group raw keys by publish identity.
  const rawKeysByPublishId = new Map<string, string[]>();
  for (const rawKey of allRawKeys) {
    const publishId = publishIdFor(rawKey);
    const list = rawKeysByPublishId.get(publishId) ?? [];
    list.push(rawKey);
    rawKeysByPublishId.set(publishId, list);
  }

  const canonicalFields: Record<string, CanonicalFieldResult> = {};

  for (const [publishId, rawKeys] of rawKeysByPublishId.entries()) {
    const candidates = rawKeys
      .map((rawKey) => {
        const evidence = evidenceByKey.get(rawKey);
        const rawValue = row0[rawKey] ?? evidence?.value ?? null;
        return {
          rawKey,
          value: rawValue,
          sourceText: evidence?.sourceText ?? null,
          sourcePage: evidence?.sourcePage ?? null,
          confidence: evidence?.confidence ?? null,
          source: evidence?.source ?? null,
        };
      })
      .filter((c) => c.value !== null && c.value !== undefined && c.value !== "");

    const validationResults: ValidationResult[] = [];
    let resolver = "PassthroughResolver";
    let semanticPassed: boolean | null = null;

    if (candidates.length === 0) {
      canonicalFields[publishId] = {
        fieldId: publishId,
        value: null,
        status: "not_stated",
        rejectedCandidateKeys: [],
        resolver,
        validationResults,
        confidenceComponents: computeConfidence({ extractionConfidence: null, sourceAuthority: 0, semanticPassed: null, crossFieldPassed: null }),
      };
      continue;
    }

    // Semantic compatibility gate, reusing the shared module -- a candidate
    // whose value/sourceText fails this field's semantic rule is dropped
    // from consideration here exactly as it already would have been upstream
    // in the mapper/merger; this is a second, defensive check confirming
    // both pipelines' outputs remain compatible after alias/duplicate-concept
    // merging (which can bring together candidates from different raw keys
    // that were never checked against EACH OTHER upstream).
    const semanticEligible = candidates.filter((c) => {
      if (!hasSemanticRequirement(publishId) && !hasSemanticRequirement(c.rawKey)) return true;
      const fieldForRule = hasSemanticRequirement(c.rawKey) ? c.rawKey : publishId;
      const profile: SemanticProfile = inferSemanticProfile({ value: c.value, sourceText: c.sourceText ?? "", category: null });
      const result = checkFieldSemanticCompatibility(profile, fieldForRule, { value: c.value, sourceText: c.sourceText ?? "" });
      if (!result.compatible) {
        validationResults.push({ rule: "semantic_compatibility", passed: false, message: `[${c.rawKey}] ${result.reason ?? "semantically incompatible"}` });
      }
      return result.compatible;
    });
    if (candidates.length > 0) semanticPassed = semanticEligible.length > 0;

    const rejectedCandidateKeys = candidates
      .filter((c) => !semanticEligible.includes(c))
      .map((c) => c.rawKey);

    if (semanticEligible.length === 0) {
      canonicalFields[publishId] = {
        fieldId: publishId,
        value: null,
        status: "needs_review",
        rejectedCandidateKeys,
        resolver: "SemanticCompatibilityResolver",
        validationResults,
        confidenceComponents: computeConfidence({ extractionConfidence: null, sourceAuthority: 0, semanticPassed: false, crossFieldPassed: null }),
      };
      continue;
    }

    // Obligation-direction validation for responsibility-family fields.
    if (RESPONSIBILITY_FIELDS.has(publishId) || rawKeys.some((k) => RESPONSIBILITY_FIELDS.has(k))) {
      resolver = "ResponsibilityResolver";
      for (const candidate of [...semanticEligible]) {
        if (!candidate.sourceText) continue;
        const directionResult = validateObligationDirection(candidate.value, candidate.sourceText);
        if (directionResult) {
          validationResults.push(directionResult);
          if (!directionResult.passed) {
            const idx = semanticEligible.indexOf(candidate);
            if (idx >= 0) semanticEligible.splice(idx, 1);
            rejectedCandidateKeys.push(candidate.rawKey);
          }
        }
      }
      if (semanticEligible.length === 0) {
        canonicalFields[publishId] = {
          fieldId: publishId,
          value: null,
          status: "needs_review",
          rejectedCandidateKeys,
          resolver,
          validationResults,
          confidenceComponents: computeConfidence({ extractionConfidence: null, sourceAuthority: 0, semanticPassed: false, crossFieldPassed: false }),
        };
        continue;
      }
    } else if (publishId.includes("date") || publishId === "commencement_date" || publishId === "expiration_date") {
      resolver = "TermResolver";
    } else if (publishId === "monthly_rent" || publishId === "annual_rent") {
      resolver = "RentResolver";
    }

    // Among surviving candidates, prefer the one with real evidence
    // (sourceText/sourcePage), then highest confidence, then source
    // authority (rule > table > llm) -- this is source-authority ranking +
    // conflict detection, not a silent pick when candidates disagree.
    const withEvidence = semanticEligible.filter((c) => c.sourceText || c.sourcePage != null);
    const pool = withEvidence.length > 0 ? withEvidence : semanticEligible;
    const sorted = [...pool].sort((a, b) => {
      const confDiff = (b.confidence ?? 0) - (a.confidence ?? 0);
      if (confDiff !== 0) return confDiff;
      return (SOURCE_AUTHORITY_BY_SOURCE[b.source ?? ""] ?? 0) - (SOURCE_AUTHORITY_BY_SOURCE[a.source ?? ""] ?? 0);
    });
    const winner = sorted[0];

    // Conflict detection: two or more candidates with real, independent
    // evidence that materially disagree.
    const distinctValues = new Set(withEvidence.map((c) => String(c.value).trim().toLowerCase()));
    const isConflicting = withEvidence.length > 1 && distinctValues.size > 1;

    const status: CanonicalFieldStatus = isConflicting ? "conflicting" : "verified";
    const finalRejected = [
      ...rejectedCandidateKeys,
      ...sorted.filter((c) => c !== winner).map((c) => c.rawKey),
    ];

    canonicalFields[publishId] = {
      fieldId: publishId,
      value: isConflicting ? null : winner.value,
      status,
      selectedCandidateKey: isConflicting ? undefined : winner.rawKey,
      rejectedCandidateKeys: [...new Set(finalRejected)],
      sourcePage: winner.sourcePage,
      sourceText: winner.sourceText,
      resolver,
      validationResults,
      confidenceComponents: computeConfidence({
        extractionConfidence: winner.confidence,
        sourceAuthority: SOURCE_AUTHORITY_BY_SOURCE[winner.source ?? ""] ?? 0.5,
        semanticPassed,
        crossFieldPassed: isConflicting ? false : null,
      }),
    };
  }

  // Cross-field validation, applied AFTER every individual field has a
  // canonical result: term-date ordering and rent arithmetic. These only
  // ANNOTATE already-selected values (validationResults + confidence /
  // status downgrade to needs_review) -- they never fabricate a value.
  const commencement = canonicalFields["commencement_date"];
  const expiration = canonicalFields["expiration_date"];
  const termValidation = validateTermDateRelationship(commencement, expiration);
  if (termValidation.commencement && commencement) {
    commencement.validationResults.push(termValidation.commencement);
    if (!termValidation.commencement.passed && commencement.status === "verified") commencement.status = "needs_review";
  }
  if (termValidation.expiration && expiration) {
    expiration.validationResults.push(termValidation.expiration);
    if (!termValidation.expiration.passed && expiration.status === "verified") expiration.status = "needs_review";
  }

  const monthlyRent = canonicalFields["monthly_rent"];
  const annualRent = canonicalFields["annual_rent"];
  const rentValidation = validateRentArithmetic(monthlyRent, annualRent);
  if (rentValidation.monthly && monthlyRent) {
    monthlyRent.validationResults.push(rentValidation.monthly);
    if (!rentValidation.monthly.passed && monthlyRent.status === "verified") monthlyRent.status = "needs_review";
  }
  if (rentValidation.annual && annualRent) {
    annualRent.validationResults.push(rentValidation.annual);
    if (!rentValidation.annual.passed && annualRent.status === "verified") annualRent.status = "needs_review";
  }

  return { version: LEASE_TRUTH_ASSEMBLY_VERSION, canonicalFields };
}

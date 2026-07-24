// @ts-nocheck
/**
 * Candidate-decision engine (Release 1 of the document-coverage architecture
 * audit) — the ONE shared function used by every place a candidate value is
 * checked against its target field's domain, replacing three previously
 * separate/absent mechanisms:
 *   - merger.ts#mergeField() had no domain check at all (confidence/priority only)
 *   - fact-field-mapper.ts#scoreFactAgainstField() had no domain check at all
 *     (pure longest-keyword-substring scoring against field labels)
 *   - normalize-pdf-output/index.ts#isLlmSourceTextRelevantToField() had a
 *     domain check, but hardcoded to exactly 2 field families
 *
 * Root cause this fixes: nothing in the live pipeline checked that a
 * candidate's source-text/clause-category matched the target field's domain,
 * so e.g. a late-payment clause mentioning "administrative fee" could win
 * the admin_fee_pct (CAM management fee) slot on keyword length alone.
 *
 * Design constraints (from review): rejected-category/pattern matches are
 * the only hard vetoes. An allowed-category match is a strong positive
 * signal, never a requirement — a clause can legitimately span domains and
 * the upstream classifier can be imperfect, so an unexpected-but-not-
 * rejected category routes to "needs_review", not an automatic reject.
 * "advisory" fields (domain known, no enforcement configured yet) report
 * the same signal but are capped at "needs_review" — they never hard-reject.
 * "unconfigured" fields (no domain at all) are fully unconstrained —
 * current pre-Release-1 behavior, preserved exactly.
 */

import type { FieldDef } from "./schemas.ts";
import type { ModuleType, CandidateReasonCode } from "./types.ts";

// Bumped only when the decision order/semantics in evaluateCandidateForField
// change in a way that could shift historical accept/reject/needs_review
// outcomes — surfaced in Release 2's diagnostics_context so a projection
// diff taken against an older engine version isn't silently assumed
// comparable to one taken after a semantics change.
export const CANDIDATE_DECISION_VERSION = "release-1";

export type CandidateDecision = "accept" | "reject" | "needs_review" | "unconstrained";

export interface EvidenceValidationResult {
  valid: boolean;
  decision: CandidateDecision;
  domainMatch: boolean | null;
  categoryMatch: boolean | null;
  matchedAllowedCategories: string[];
  matchedRejectedCategories: string[];
  matchedRequiredTerms: string[];
  matchedRejectedTerms: string[];
  reasons: string[];
  reasonCodes: CandidateReasonCode[];
}

function bareCategory(factCategory: string | null | undefined): string | null {
  if (!factCategory) return null;
  const bare = factCategory.startsWith("clause:") ? factCategory.slice("clause:".length) : factCategory;
  return bare === "default" ? null : bare;
}

function unconstrained(reason: string): EvidenceValidationResult {
  return {
    valid: true,
    decision: "unconstrained",
    domainMatch: null,
    categoryMatch: null,
    matchedAllowedCategories: [],
    matchedRejectedCategories: [],
    matchedRequiredTerms: [],
    matchedRejectedTerms: [],
    reasons: [reason],
    reasonCodes: ["MODEL_ONLY_UNSUPPORTED"],
  };
}


function compactText(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function isHeadingOnlySourceText(value: unknown): boolean {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text || text.includes(":") || text.includes(";")) return false;
  if (/\b(?:shall|must|may|will|agrees?|covenants?|represents?|warrants?|located|pay|paid|provide|maintain|repair|insure|assign|sublet|terminate|renew|commence|expire|deposit|due)\b/i.test(text)) return false;
  const hasSectionPrefix = /^\s*(?:section|article|paragraph)?\s*\d{1,3}[A-Z]?\s*[\).:-]/i.test(text);
  const withoutNumber = text.replace(/^\s*(?:section|article|paragraph)?\s*\d{1,3}[A-Z]?\s*[\).:-]?\s*/i, "").trim();
  const words = withoutNumber.replace(/[.]+$/g, "").split(/\s+/).filter(Boolean);
  if (!withoutNumber || withoutNumber.length > 80) return false;
  if (words.length === 1 && !hasSectionPrefix) return false;
  if (words.length === 0 || words.length > 8) return false;
  const titleWords = words.filter((word) => !/^(?:and|or|of|the|a|an|to|for|in|on|with)$/i.test(word));
  if (!titleWords.every((word) => /^[A-Z0-9]/.test(word))) return false;
  return /^[A-Z][A-Za-z0-9 &'\/().-]+\.?$/.test(withoutNumber);
}
function valueFoundInEvidence(value: unknown, sourceText: string): boolean {
  const valueText = compactText(value);
  if (!valueText || !sourceText) return false;
  const evidenceText = compactText(sourceText);
  return evidenceText.includes(valueText) || evidenceText.includes(valueText.replace(/[#]/g, ""));
}

function semanticPolicyFindings(fieldKey: string, value: unknown, sourceText: string): Array<{ decision: "reject" | "needs_review"; reason: string; code: CandidateReasonCode }> {
  const findings: Array<{ decision: "reject" | "needs_review"; reason: string; code: CandidateReasonCode }> = [];
  const valueText = compactText(value);
  const text = compactText(sourceText);
  const hasUtilityPaymentAnchor = /\b(?:electric(?:ity|al)?\s+(?:service|charges?|costs?|utilities|meter|submeter|payment|bills?)|power\s+(?:service|charges?|costs?|meter|payment)|utilities?|metered|submetered|direct\s+payment|pay\s+(?:for\s+)?electric)\b/i.test(sourceText);
  const hasRepairOnlyElectricAnchor = /\b(?:electrical\s+(?:wiring|systems?|fixtures?|equipment)|repair|maintain|maintenance|replace|damage)\b/i.test(sourceText) && !hasUtilityPaymentAnchor;

  if (isHeadingOnlySourceText(sourceText)) {
    findings.push({ decision: "reject", reason: `${fieldKey} evidence is only a section heading, not an operative lease statement`, code: "HEADING_ONLY" });
  }

  if ((fieldKey === "tenant_name" || fieldKey === "landlord_name") && valueText) {
    const signatureOnly = /\b(?:signed|signature|printed\s+name|by:)\b/i.test(sourceText)
      && !/\b(?:between|by\s+and\s+between|herein\s+called|called\s+["']?(?:tenant|landlord)|landlord\s*\)|tenant\s*\))\b/i.test(sourceText);
    const weakNameShape = /^[a-z]+(?:\s+[a-z]+){0,2}$/.test(String(value ?? "").trim())
      && !/\b(?:llc|inc|corp|company|co\.?|lp|llp|realty|crossing|holdings|properties|restaurant|wings)\b/i.test(String(value ?? ""));
    if (signatureOnly || weakNameShape) {
      findings.push({ decision: "reject", reason: `${fieldKey} requires party-identification evidence; signature block/OCR fragments are insufficient`, code: signatureOnly ? "WRONG_CLAUSE_CATEGORY" : "VALUE_SHAPE_INVALID" });
    }
  }
  if ((fieldKey === "unit_number" || fieldKey === "suite_number" || fieldKey === "floor") && valueText) {
    const first = valueText.split(/\s+/)[0];
    if (/^(?:in|at|of|the|and|to|from|for|with|on|by|as|is|be|not|no|per|premises|tenant|landlord)$/.test(first)) {
      findings.push({ decision: "reject", reason: `${fieldKey} value "${value}" is a word fragment, not a suite/unit/floor identifier`, code: "VALUE_SHAPE_INVALID" });
    }
  }

  if (fieldKey === "property_name") {
    const badTimingFragment = /\b(?:one\s*\(1\)\s+day|calendar\s+year|\bdays?\b|\bshall\b|\bmust\b|\bmay\b)\b/i.test(String(value ?? ""));
    const legitimatePropertyContext = /\b(?:shopping\s+center|building|plaza|center|mall|development|project|complex|park|village)\b/i.test(String(value ?? ""));
    if (badTimingFragment && !legitimatePropertyContext) {
      findings.push({ decision: "reject", reason: `property_name value "${value}" looks like timing/obligation text, not a property name`, code: "VALUE_SHAPE_INVALID" });
    }
    if (sourceText && /\b(?:parking|common\s+area|calendar\s+year|one\s*\(1\)\s+day)\b/i.test(sourceText) && !/\b(?:premises|property\s+name|shopping\s+center\s+known\s+as|located\s+in)\b/i.test(sourceText)) {
      findings.push({ decision: "reject", reason: "property_name evidence came from parking/common-area timing text instead of premises/property identification", code: "WRONG_CLAUSE_CATEGORY" });
    }
  }

  if (["responsibility_insurance", "insurance_responsibility", "property_insurance_responsibility"].includes(fieldKey)) {
    if (/\b(?:waiver\s+of\s+subrogation|subrogat(?:e|ion)|indemnif|casualty\s+proceeds|limitation\s+of\s+liability)\b/i.test(sourceText)) {
      findings.push({ decision: "reject", reason: `${fieldKey} cannot be supported by waiver/subrogation/indemnity evidence`, code: "WRONG_CLAUSE_CATEGORY" });
    }
  }

  if (fieldKey === "electric_responsibility" || fieldKey === "responsibility_utilities") {
    if (hasRepairOnlyElectricAnchor) {
      findings.push({ decision: "reject", reason: `${fieldKey} requires utility-payment or metering evidence; repair-only electrical wording is insufficient`, code: "WRONG_CLAUSE_CATEGORY" });
    }
  }

  if (fieldKey === "landlord_consent" || fieldKey === "landlord_consent_for_transfer" || fieldKey === "assignment_provisions") {
    const conditionalConsent = /\b(?:in\s+the\s+event|if|when)\s+the\s+landlord\s+shall\s+consent\b|\bif\s+landlord\s+consents?\b|\bsubject\s+to\s+landlord'?s\s+consent\b/i.test(sourceText);
    const soleDiscretion = /\bsole\s+(?:and\s+)?absolute\s+discretion\b|\bwithhold\s+consent\s+for\s+any\s+reason\b/i.test(sourceText);
    if ((conditionalConsent || soleDiscretion) && /\b(?:shall|must)\s+consent\b/i.test(String(value ?? ""))) {
      findings.push({ decision: "reject", reason: "conditional or discretionary assignment consent was converted into a mandatory consent obligation", code: conditionalConsent ? "CONDITIONAL_LANGUAGE" : "SCOPE_MATCH" });
    } else if (conditionalConsent || soleDiscretion) {
      findings.push({ decision: "needs_review", reason: "assignment consent evidence contains conditional/discretionary modality and requires review", code: conditionalConsent ? "CONDITIONAL_LANGUAGE" : "SCOPE_MATCH" });
    }
  }

  if (fieldKey === "additional_insureds_required" && /^additional insureds?$/i.test(String(sourceText ?? "").trim())) {
    findings.push({ decision: "reject", reason: "additional insured heading alone is not operative evidence", code: "HEADING_ONLY" });
  }

  if (value != null && sourceText && !valueFoundInEvidence(value, sourceText) && /^(?:property_name|unit_number|suite_number|cam_cap_pct|admin_fee_pct|gross_up_threshold|general_liability_min)$/.test(fieldKey)) {
    findings.push({ decision: "needs_review", reason: `candidate value "${value}" was not found verbatim in the cited evidence`, code: "MODEL_ONLY_UNSUPPORTED" });
  }

  return findings;
}
export function evaluateCandidateForField(args: {
  field: FieldDef;
  fieldKey: string;
  moduleType: ModuleType;
  value?: unknown;
  sourceText: string | null | undefined;
  /** "clause:<type>" if known (fact-ledger path); undefined on the legacy
   *  rule/table/LLM path, which never has a classified category. */
  factCategory?: string | null;
  confidence?: number;
  sourceType?: "rule" | "table" | "llm" | "fact_ledger";
}): EvidenceValidationResult {
  const { field, fieldKey, sourceText } = args;
  // Derived directly from the passed-in field object, not re-looked-up by
  // fieldKey via getSchema(moduleType) -- the caller already resolved this
  // exact FieldDef (merger.ts/fact-field-mapper.ts both fetch it from the
  // same schema before calling in), and re-deriving by key would silently
  // misbehave for any FieldDef that isn't reachable at that exact key (e.g.
  // an overridden or ad-hoc field definition, or a unit test fixture).
  const policy: "enforced" | "advisory" | "unconfigured" =
    field.evidencePolicy ?? (field.domain ? "advisory" : "unconfigured");

  if (policy === "unconfigured") {
    return unconstrained(`evidencePolicy is unconfigured for ${fieldKey} — no check possible`);
  }

  const rejectedCategories = field.rejectedClauseCategories ?? [];
  const allowedCategories = field.allowedClauseCategories ?? [];
  const rejectedPatterns = field.rejectedEvidencePatterns ?? [];
  const rejectedValuePatterns = field.rejectedValuePatterns ?? [];
  const requiredPatterns = field.requiredEvidencePatterns ?? [];
  const category = bareCategory(args.factCategory);
  const text = String(sourceText ?? "");
  const valueText = args.value == null ? "" : String(args.value);

  const reasons: string[] = [];
  let decision: CandidateDecision = "unconstrained";
  let domainMatch: boolean | null = null;
  let categoryMatch: boolean | null = null;
  const matchedAllowedCategories: string[] = [];
  const matchedRejectedCategories: string[] = [];
  const matchedRequiredTerms: string[] = [];
  const matchedRejectedTerms: string[] = [];
  const reasonCodes: CandidateReasonCode[] = [];

  // Step 2: classified category explicitly rejected — hard veto.
  if (category && rejectedCategories.includes(category)) {
    matchedRejectedCategories.push(category);
    decision = "reject";
    categoryMatch = false;
    reasons.push(`fact category "clause:${category}" is rejected for ${fieldKey}`);
    reasonCodes.push("WRONG_CLAUSE_CATEGORY");
  }

  // Step 3: source text matches a field-specific exclusion pattern — hard
  // veto, independent of category (fires on the legacy path too, which
  // never has a classified category).
  if (decision !== "reject" && text) {
    for (const pattern of rejectedPatterns) {
      if (pattern.test(text)) {
        matchedRejectedTerms.push(pattern.source);
        decision = "reject";
        reasons.push(`source text matched a rejected evidence pattern for ${fieldKey}: ${pattern.source}`);
        reasonCodes.push("WRONG_CLAUSE_CATEGORY");
        break;
      }
    }
  }

  // Step 3b: the candidate's own VALUE (not its surrounding sourceText)
  // structurally doesn't belong in this field — e.g. a numeric measurement
  // string landing in a short-name field. Independent of category/sourceText
  // signal, since the clause the value came from can be entirely legitimate
  // for this field while the specific value still isn't.
  if (decision !== "reject" && valueText) {
    for (const pattern of rejectedValuePatterns) {
      if (pattern.test(valueText)) {
        matchedRejectedTerms.push(pattern.source);
        decision = "reject";
        reasons.push(`value matched a rejected value pattern for ${fieldKey}: ${pattern.source}`);
        reasonCodes.push("VALUE_SHAPE_INVALID");
        break;
      }
    }
  }

  // Step 4: classified category explicitly allowed — strong positive, not
  // a requirement.
  if (decision !== "reject" && category && allowedCategories.includes(category)) {
    matchedAllowedCategories.push(category);
    decision = "accept";
    categoryMatch = true;
    domainMatch = true;
    reasons.push(`fact category "clause:${category}" is allowed for ${fieldKey}`);
    reasonCodes.push("CORRECT_CLAUSE_CATEGORY");
  }

  // Step 5: classified category present, non-default, allow-list non-empty,
  // and the category is in neither list — cross-domain, but not
  // automatically wrong (a paragraph can span domains, the classifier can
  // be imperfect). Flag for review rather than reject or silently accept.
  if (decision !== "reject" && decision !== "accept" && category && allowedCategories.length > 0) {
    categoryMatch = false;
    decision = "needs_review";
    reasons.push(`fact category "clause:${category}" is neither allowed nor rejected for ${fieldKey}`);
    reasonCodes.push("WRONG_CLAUSE_CATEGORY");
  }

  // Step 6: no usable category (legacy path, or fact-ledger classified as
  // clause:default) — fall back to text signal.
  if (decision === "unconstrained") {
    if (text) {
      for (const pattern of requiredPatterns.length > 0 ? requiredPatterns : []) {
        if (pattern.test(text)) matchedRequiredTerms.push(pattern.source);
      }
      if (matchedRequiredTerms.length === 0) {
        for (const label of field.labels ?? []) {
          if (label.length >= 3 && text.toLowerCase().includes(label.toLowerCase())) {
            matchedRequiredTerms.push(label);
          }
        }
      }
    }
    if (matchedRequiredTerms.length > 0) {
      domainMatch = true;
      reasons.push(`source text matched a required/label term for ${fieldKey}`);
      reasonCodes.push("HAS_EVIDENCE", "VALUE_SHAPE_VALID");
      decision = "accept";
    } else if (policy === "enforced") {
      decision = "needs_review";
      reasons.push(`no category available and no required/label term matched for ${fieldKey} (enforced policy)`);
      reasonCodes.push("MODEL_ONLY_UNSUPPORTED");
    } else {
      decision = "unconstrained";
    }
  }


  // Stage A semantic field policies: targeted legal/evidence guards for known
  // high-risk failure modes. These run after base evidence policy so high
  // confidence cannot override wrong-domain, heading-only, conditional, or
  // value-shape failures.
  if (sourceText) {
    for (const finding of semanticPolicyFindings(fieldKey, args.value, sourceText)) {
      reasons.push(finding.reason);
      reasonCodes.push(finding.code);
      if (finding.decision === "reject") {
        decision = "reject";
        domainMatch = false;
        break;
      }
      if (decision !== "reject") {
        decision = "needs_review";
      }
    }
  }
  // Step 7: advisory fields report the same signal but never hard-reject —
  // the configuration gap is intentional and visible (see
  // getEvidencePolicyCoverage), not silently enforced everywhere at once.
  if (policy === "advisory" && decision === "reject") {
    decision = "needs_review";
    reasons.push("downgraded from reject to needs_review: field policy is advisory, not enforced");
  }

  return {
    valid: decision !== "reject",
    decision,
    domainMatch,
    categoryMatch,
    matchedAllowedCategories,
    matchedRejectedCategories,
    matchedRequiredTerms,
    matchedRejectedTerms,
    reasons,
    reasonCodes: [...new Set(reasonCodes)],
  };
}

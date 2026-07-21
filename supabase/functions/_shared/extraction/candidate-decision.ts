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
import type { ModuleType } from "./types.ts";

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
  };
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
  const requiredPatterns = field.requiredEvidencePatterns ?? [];
  const category = bareCategory(args.factCategory);
  const text = String(sourceText ?? "");

  const reasons: string[] = [];
  let decision: CandidateDecision = "unconstrained";
  let domainMatch: boolean | null = null;
  let categoryMatch: boolean | null = null;
  const matchedAllowedCategories: string[] = [];
  const matchedRejectedCategories: string[] = [];
  const matchedRequiredTerms: string[] = [];
  const matchedRejectedTerms: string[] = [];

  // Step 2: classified category explicitly rejected — hard veto.
  if (category && rejectedCategories.includes(category)) {
    matchedRejectedCategories.push(category);
    decision = "reject";
    categoryMatch = false;
    reasons.push(`fact category "clause:${category}" is rejected for ${fieldKey}`);
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
  }

  // Step 5: classified category present, non-default, allow-list non-empty,
  // and the category is in neither list — cross-domain, but not
  // automatically wrong (a paragraph can span domains, the classifier can
  // be imperfect). Flag for review rather than reject or silently accept.
  if (decision !== "reject" && decision !== "accept" && category && allowedCategories.length > 0) {
    categoryMatch = false;
    decision = "needs_review";
    reasons.push(`fact category "clause:${category}" is neither allowed nor rejected for ${fieldKey}`);
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
      decision = "accept";
    } else if (policy === "enforced") {
      decision = "needs_review";
      reasons.push(`no category available and no required/label term matched for ${fieldKey} (enforced policy)`);
    } else {
      decision = "unconstrained";
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
  };
}

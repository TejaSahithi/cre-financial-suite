// @ts-nocheck
/**
 * Domain readiness evaluation for the adaptive fact-ledger extractor
 * (openai-fact-ledger/adaptive-extractor.ts).
 *
 * Answers, per bounded LLM-call domain (section-router.ts's LlmCallDomain):
 * "given only what was resolved WITHOUT an LLM call, is this domain already
 * confidently resolved, or does it need one narrow, domain-scoped Azure
 * OpenAI call?" Reuses fact-field-mapper.ts's existing scoring + semantic-
 * compatibility gate (via mapFactsToStandardFields) rather than
 * re-implementing candidate resolution -- this module only interprets that
 * existing output through a per-domain readiness lens.
 */

import { mapFactsToStandardFields } from "./openai-fact-ledger/fact-field-mapper.ts";
import type { Fact } from "./openai-fact-ledger/types.ts";
import type { LlmCallDomain } from "./section-router.ts";
import type { ModuleType } from "./types.ts";

export interface DomainReadiness {
  domain: LlmCallDomain;
  criticalFactsPresent: boolean;
  authoritativeSourcesPresent: boolean;
  semanticRolesComplete: boolean;
  conflictsPresent: boolean;
  deterministicValidationPassed: boolean;
  requiresLlm: boolean;
  escalationReasons: string[];
}

// Fields whose absence alone is enough to call a domain "not ready."
// expenses_and_cam and legal_rights_and_dates deliberately have no entry
// here -- many leases legitimately have no CAM recovery or renewal-option
// provisions at all, so "nothing found" must not by itself force an LLM
// call; only "content was routed here but didn't resolve cleanly" does (see
// evaluateDomainReadiness's empty-facts branch below).
const CRITICAL_FIELDS_BY_DOMAIN: Partial<Record<LlmCallDomain, string[]>> = {
  core_terms: ["tenant_name", "landlord_name", "commencement_date", "expiration_date", "square_footage"],
  rent_and_charges: ["monthly_rent"],
  operating_obligations: ["responsibility_repairs"],
};

/**
 * Evaluates whether `domain` can skip its Azure OpenAI call, using only the
 * deterministic (no-LLM) facts already routed to it.
 */
export function evaluateDomainReadiness(args: {
  domain: LlmCallDomain;
  moduleType: ModuleType;
  deterministicFacts: Fact[];
  hasRoutedSectionContent: boolean;
}): DomainReadiness {
  const { domain, moduleType, deterministicFacts, hasRoutedSectionContent } = args;
  const escalationReasons: string[] = [];

  if (deterministicFacts.length === 0) {
    if (!hasRoutedSectionContent) {
      // No section content was even routed to this domain -- most likely
      // this concept genuinely does not apply to this lease (e.g. no CAM
      // clause at all). Do not escalate an empty, inapplicable domain.
      return {
        domain,
        criticalFactsPresent: false,
        authoritativeSourcesPresent: false,
        semanticRolesComplete: false,
        conflictsPresent: false,
        deterministicValidationPassed: true,
        requiresLlm: false,
        escalationReasons: [],
      };
    }
    escalationReasons.push("Section content was routed to this domain, but no deterministic candidate could be resolved from it.");
    return {
      domain,
      criticalFactsPresent: false,
      authoritativeSourcesPresent: false,
      semanticRolesComplete: false,
      conflictsPresent: false,
      deterministicValidationPassed: false,
      requiresLlm: true,
      escalationReasons,
    };
  }

  const mapped = mapFactsToStandardFields({ facts: deterministicFacts, moduleType });
  const fields = mapped.records[0]?.fields ?? {};
  const criticalFieldKeys = CRITICAL_FIELDS_BY_DOMAIN[domain] ?? [];

  const missingCritical = criticalFieldKeys.filter((key) => fields[key]?.value == null);
  const criticalFactsPresent = missingCritical.length === 0;
  if (!criticalFactsPresent) {
    escalationReasons.push(`Missing critical field(s) for ${domain}: ${missingCritical.join(", ")}.`);
  }

  // For domains with no fixed critical-field list, "authoritative" means at
  // least one field actually resolved with real evidence; for domains WITH
  // a critical list, every critical field must have real evidence.
  const fieldsToCheck = criticalFieldKeys.length > 0
    ? criticalFieldKeys.map((key) => [key, fields[key]] as const)
    : Object.entries(fields);
  const resolvedEntries = fieldsToCheck.filter(([, field]) => field?.value != null);
  const authoritativeSourcesPresent = resolvedEntries.length > 0 && resolvedEntries.every(
    ([, field]) => Boolean((field as any)?.sourceText || (field as any)?.sourcePage != null),
  );
  if (resolvedEntries.length > 0 && !authoritativeSourcesPresent) {
    escalationReasons.push(`A resolved field in ${domain} lacks real source evidence (sourceText/sourcePage).`);
  }
  if (resolvedEntries.length === 0 && criticalFieldKeys.length === 0) {
    escalationReasons.push(`Section content was routed to ${domain}, but no field resolved from it deterministically.`);
  }

  // Conflict detection uses fieldProvenance's competingCandidates (tracked
  // fields only) -- a candidate that clears this field's own shape/semantic
  // guard and remains genuinely competitive by score, i.e. a real ambiguity
  // -- NOT mapped.rejectedCandidates, which is a broad audit trail that
  // includes candidates correctly filtered out for being a WRONG match
  // (e.g. an annual_rent fact's raw text containing the word "rent" enough
  // to log a rejected-candidate entry against monthly_rent, despite the
  // guard correctly rejecting it as the wrong amount). Treating every such
  // entry as an unresolved conflict would escalate domains that are, in
  // fact, already correctly and unambiguously resolved.
  const relevantFieldKeys = criticalFieldKeys.length > 0 ? criticalFieldKeys : Object.keys(fields);
  const provenanceForConflicts = mapped.fieldProvenance ?? {};
  const conflictsPresent = relevantFieldKeys.some((key) => (provenanceForConflicts[key]?.competingCandidates?.length ?? 0) > 0);
  if (conflictsPresent) {
    escalationReasons.push(`A field in ${domain} has a genuinely competing candidate (same shape/semantic guard passed, different value) that was not clearly resolved.`);
  }

  // semanticRolesComplete: reuse fieldProvenance's shapeGuard when this field
  // is one fact-field-mapper.ts tracks provenance for; a field with no
  // tracked semantic rule cannot fail a check that doesn't apply to it.
  const provenance = mapped.fieldProvenance ?? {};
  const semanticRolesComplete = relevantFieldKeys.every((key) => {
    const entry = provenance[key];
    return !entry || entry.shapeGuard?.passed !== false;
  });
  if (!semanticRolesComplete) {
    escalationReasons.push(`A field's deterministic candidate in ${domain} failed a semantic-compatibility check.`);
  }

  const hasAnyResolution = resolvedEntries.length > 0 || criticalFactsPresent;
  const deterministicValidationPassed =
    criticalFactsPresent && authoritativeSourcesPresent && !conflictsPresent && semanticRolesComplete && hasAnyResolution;
  const requiresLlm = !deterministicValidationPassed;

  return {
    domain,
    criticalFactsPresent,
    authoritativeSourcesPresent,
    semanticRolesComplete,
    conflictsPresent,
    deterministicValidationPassed,
    requiresLlm,
    escalationReasons,
  };
}

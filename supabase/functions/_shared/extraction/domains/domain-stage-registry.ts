// @ts-nocheck
/**
 * Bounded-enrich stage dispatch lookup (Phase 4.5).
 *
 * Purpose-built for normalize-pdf-output/index.ts's handleBoundedEnrichStage()
 * dispatch boundary: replaces the 5 hardcoded
 * `case "enrich_evidence_<domain>":` labels with one generic
 * isEnrichEvidenceDomainStage()/getDomainForEnrichStage() branch. Additive to
 * domain-registry.ts's existing STAGE_TO_LLM_CALL_DOMAIN/
 * ENRICH_EVIDENCE_DOMAIN_STAGES exports (those stay as they are, used by
 * stage-sequence.ts and other consumers) -- this module exists so the
 * dispatch site has a fail-loud, typo-proof lookup rather than reaching into
 * a plain Record directly.
 */

import { DOMAIN_REGISTRY, type LlmCallDomain } from "./domain-registry.ts";

export type EnrichEvidenceDomainStage = NonNullable<(typeof DOMAIN_REGISTRY)[number]["boundedEnrichStageName"]>;

const STAGE_TO_DOMAIN = new Map<string, LlmCallDomain>(
  DOMAIN_REGISTRY
    .filter((d) => d.participatesInBoundedEnrichment && d.boundedEnrichStageName)
    .map((d) => [d.boundedEnrichStageName as string, d.id]),
);

/**
 * Type predicate -- deliberately a registry membership check, NOT
 * stage.startsWith("enrich_evidence_"). A typo'd or future non-domain stage
 * name matching that prefix (e.g. "enrich_evidence_expense_and_cam", one
 * character off from the real "expenses_and_cam") must not silently become
 * a runtime domain dispatch.
 */
export function isEnrichEvidenceDomainStage(stage: string): stage is EnrichEvidenceDomainStage {
  return STAGE_TO_DOMAIN.has(stage);
}

/**
 * Fails loud, mirrors getDomainDefinition()'s style -- an unresolvable stage
 * here means isEnrichEvidenceDomainStage was bypassed or the registry and
 * this lookup have drifted, both programming errors, never something to
 * silently default around.
 */
export function getDomainForEnrichStage(stage: EnrichEvidenceDomainStage): LlmCallDomain {
  const domain = STAGE_TO_DOMAIN.get(stage);
  if (!domain) throw new Error(`No domain registered for bounded-enrich stage: ${stage}`);
  return domain;
}

// @ts-nocheck
/**
 * Extraction domain registry (Phase 4) — the single source of truth
 * replacing the previously-scattered hardcoded 5-domain assumptions in
 * section-router.ts (LLM_CALL_DOMAINS/DOMAIN_THRESHOLDS),
 * domain-readiness.ts (CRITICAL_FIELDS_BY_DOMAIN), adaptive-extractor.ts
 * (DOMAIN_CONCEPTS), and enrich-bounded-stage/stage-sequence.ts
 * (ENRICH_EVIDENCE_DOMAIN_STAGES). Every value in the 5 definitions below
 * is a verbatim copy of what those files had (see
 * _tests/fixtures/legacy-domain-configuration.ts for the frozen snapshot
 * domain-registry-byte-compatibility.test.ts diffs this against) -- adding
 * a 6th domain here is now a registry-entry change, not a cross-cutting
 * edit across 5 files (with the deliberate exception of
 * normalize-pdf-output/index.ts's bounded-enrich `switch`, which still
 * needs its own dispatch-shape change first -- see the plan's Phase 4.5).
 */

import type { ExtractionDomainDefinition } from "./domain-definition.ts";
import { coreTermsDomain } from "./definitions/core-terms.ts";
import { rentAndChargesDomain } from "./definitions/rent-and-charges.ts";
import { expensesAndCamDomain } from "./definitions/expenses-and-cam.ts";
import { operatingObligationsDomain } from "./definitions/operating-obligations.ts";
import { legalRightsAndDatesDomain } from "./definitions/legal-rights-and-dates.ts";
// Phase 5: 5 shadow-only expense specialists -- all enabled:false (never in
// LLM_CALL_DOMAINS / the authoritative escalation loop), authorityMode:"shadow",
// domainFamily:"expense_specialist". See getExpenseSpecialistDefinitionsInOrder()
// and the Phase 5 plan's grounding correction #1.
import { camAndOperatingExpensesDomain } from "./definitions/expense-specialists/cam-and-operating-expenses.ts";
import { taxesDomain } from "./definitions/expense-specialists/taxes.ts";
import { insuranceDomain } from "./definitions/expense-specialists/insurance.ts";
import { utilitiesDomain } from "./definitions/expense-specialists/utilities.ts";
import { repairsAndMaintenanceDomain } from "./definitions/expense-specialists/repairs-and-maintenance.ts";

export const DOMAIN_REGISTRY = [
  coreTermsDomain,
  rentAndChargesDomain,
  expensesAndCamDomain,
  operatingObligationsDomain,
  legalRightsAndDatesDomain,
  camAndOperatingExpensesDomain,
  taxesDomain,
  insuranceDomain,
  utilitiesDomain,
  repairsAndMaintenanceDomain,
] as const;

/** Derived FROM the registry, not the other way around -- this is what lets
 *  domain-definition.ts stay generic with no import of this type. */
export type LlmCallDomain = (typeof DOMAIN_REGISTRY)[number]["id"];

const DOMAIN_BY_ID = new Map<string, ExtractionDomainDefinition>(DOMAIN_REGISTRY.map((d) => [d.id, d]));

export function getEnabledDomainDefinitionsInOrder(): ExtractionDomainDefinition[] {
  return DOMAIN_REGISTRY.filter((d) => d.enabled).toSorted((a, b) => a.executionOrder - b.executionOrder);
}

export function getEnabledDomainIdsInOrder(): LlmCallDomain[] {
  return getEnabledDomainDefinitionsInOrder().map((d) => d.id as LlmCallDomain);
}

/**
 * The Phase 5 expense specialists, in executionOrder. Filtered by BOTH
 * domainFamily AND authorityMode -- domainFamily alone would be a narrower,
 * still-adequate filter today, but authorityMode alone would silently
 * absorb any OTHER future shadow-mode domain a later feature adds. These
 * domains are enabled:false (see grounding correction #1 in the Phase 5
 * plan) so they never appear in getEnabledDomain*() / LLM_CALL_DOMAINS --
 * this is the explicit iteration list the shadow-orchestration hook uses
 * instead.
 */
export function getExpenseSpecialistDefinitionsInOrder(): ExtractionDomainDefinition[] {
  return DOMAIN_REGISTRY
    .filter((d) => d.domainFamily === "expense_specialist" && d.authorityMode === "shadow")
    .toSorted((a, b) => a.executionOrder - b.executionOrder);
}

/**
 * Fails loud, never returns undefined-as-if-fine. An unknown domain here is
 * a programming/configuration defect (e.g. a typo'd domain id reaching this
 * lookup), not something to silently default around -- in particular,
 * adaptive-extractor.ts's prompt builder must never fall back to an empty
 * promptConcepts string for a domain it doesn't recognize.
 */
export function getDomainDefinition(id: LlmCallDomain): ExtractionDomainDefinition {
  const def = DOMAIN_BY_ID.get(id);
  if (!def) throw new Error(`Unknown extraction domain: ${id}`);
  return def;
}

/**
 * Runs at module load (see validateDomainRegistry() call at the bottom of
 * this file) -- a malformed registry throws before any lease is ever
 * processed, not on first use deep inside a request.
 */
export function validateDomainRegistry(registry: readonly ExtractionDomainDefinition[] = DOMAIN_REGISTRY): void {
  const ids = new Set<string>();
  const executionOrders = new Set<number>();
  const stageNames = new Set<string>();

  for (const definition of registry) {
    if (ids.has(definition.id)) {
      throw new Error(`Duplicate extraction domain: ${definition.id}`);
    }
    if (executionOrders.has(definition.executionOrder)) {
      throw new Error(`Duplicate domain execution order: ${definition.executionOrder}`);
    }
    if (definition.boundedEnrichStageName && stageNames.has(definition.boundedEnrichStageName)) {
      throw new Error(`Duplicate bounded-enrichment stage: ${definition.boundedEnrichStageName}`);
    }
    ids.add(definition.id);
    executionOrders.add(definition.executionOrder);
    if (definition.boundedEnrichStageName) stageNames.add(definition.boundedEnrichStageName);
  }

  for (const definition of registry) {
    for (const dependency of definition.dependencies) {
      if (!ids.has(dependency)) {
        throw new Error(`${definition.id} has unknown dependency: ${dependency}`);
      }
    }
  }

  // Phase 4.5: a domain claiming bounded-enrichment participation must
  // actually be dispatchable -- catches exactly the mistake a new Phase 5
  // specialist could make (participatesInBoundedEnrichment: true left set
  // while boundedEnrichStageName is still null during shadow rollout).
  for (const definition of registry) {
    if (definition.enabled && definition.participatesInBoundedEnrichment && !definition.boundedEnrichStageName) {
      throw new Error(`${definition.id} participates in bounded enrichment but has no boundedEnrichStageName`);
    }
  }

  // Phase 5: authority-mode integrity.
  const idsForAuthorityCheck = new Set(registry.map((d) => d.id));
  for (const definition of registry) {
    // A domain can't simultaneously be "the source of truth" and "off".
    if (definition.authorityMode === "authoritative" && !definition.enabled) {
      throw new Error(`${definition.id} is authorityMode:"authoritative" but enabled:false`);
    }
    // A shadow domain must have something real to extract structured output into.
    if (definition.authorityMode === "shadow" && !definition.schemaName) {
      throw new Error(`${definition.id} is authorityMode:"shadow" but has no schemaName`);
    }
    // evidenceSourceDomains/shadowRunsAfter must reference real registry ids.
    for (const sourceId of definition.evidenceSourceDomains) {
      if (!idsForAuthorityCheck.has(sourceId)) {
        throw new Error(`${definition.id} has unknown evidenceSourceDomains entry: ${sourceId}`);
      }
    }
    for (const afterId of definition.shadowRunsAfter) {
      if (!idsForAuthorityCheck.has(afterId)) {
        throw new Error(`${definition.id} has unknown shadowRunsAfter entry: ${afterId}`);
      }
      // A shadow domain may depend on an authoritative domain's timing,
      // never on another shadow domain's -- that would be an ambiguous
      // ordering (which shadow domain would fire first?).
      const afterDefinition = registry.find((d) => d.id === afterId);
      if (afterDefinition && afterDefinition.authorityMode === "shadow") {
        throw new Error(`${definition.id}'s shadowRunsAfter references another shadow domain: ${afterId}`);
      }
    }
  }
}

validateDomainRegistry();

/** enrich-bounded-stage/stage-sequence.ts's former hand-written
 *  ENRICH_EVIDENCE_DOMAIN_STAGES literal -- now derived. */
export const ENRICH_EVIDENCE_DOMAIN_STAGES: string[] = getEnabledDomainDefinitionsInOrder()
  .flatMap((d) => (d.boundedEnrichStageName ? [d.boundedEnrichStageName] : []));

/** normalize-pdf-output/index.ts's former hand-written
 *  STAGE_TO_LLM_CALL_DOMAIN literal -- now derived. The switch statement
 *  that consumes this (its case labels) is intentionally NOT generated from
 *  this registry -- see the plan's Phase 4.5 note. */
export const STAGE_TO_LLM_CALL_DOMAIN: Record<string, LlmCallDomain> = Object.fromEntries(
  getEnabledDomainDefinitionsInOrder().flatMap((d) => (d.boundedEnrichStageName ? [[d.boundedEnrichStageName, d.id]] : [])),
);

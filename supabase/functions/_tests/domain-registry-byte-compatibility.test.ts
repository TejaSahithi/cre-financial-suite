// @ts-nocheck
// Domain registry (Phase 4) — byte-compatibility proof against the FROZEN
// legacy snapshot (_tests/fixtures/legacy-domain-configuration.ts), copied
// from the real hand-written constants before this refactor touched them.
// This is the actual "zero functional change" gate, not just "it compiles."

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  DOMAIN_REGISTRY,
  ENRICH_EVIDENCE_DOMAIN_STAGES,
  getDomainDefinition,
  getEnabledDomainIdsInOrder,
} from "../_shared/extraction/domains/domain-registry.ts";
import {
  DOMAIN_THRESHOLDS,
  LLM_CALL_DOMAINS,
} from "../_shared/extraction/section-router.ts";
import {
  ENRICH_STAGE_SEQUENCE,
  EXPENSES_AND_CAM_EVIDENCE_SUBSTAGES,
} from "../_shared/extraction/enrich-bounded-stage/stage-sequence.ts";
import {
  LEGACY_CRITICAL_FIELDS,
  LEGACY_DOMAIN_IDS,
  LEGACY_ENRICH_EVIDENCE_DOMAIN_STAGES,
  LEGACY_ENRICH_STAGE_SEQUENCE,
  LEGACY_PROMPT_CONCEPTS,
  LEGACY_ROUTING_THRESHOLDS,
  LEGACY_STAGE_TO_LLM_CALL_DOMAIN,
} from "./fixtures/legacy-domain-configuration.ts";

Deno.test("byte-compat: getEnabledDomainIdsInOrder() matches the legacy LLM_CALL_DOMAINS order exactly", () => {
  assertEquals(getEnabledDomainIdsInOrder(), [...LEGACY_DOMAIN_IDS]);
});

Deno.test("byte-compat: section-router.ts's re-exported LLM_CALL_DOMAINS also matches", () => {
  assertEquals([...LLM_CALL_DOMAINS], [...LEGACY_DOMAIN_IDS]);
});

Deno.test("byte-compat: every domain's criticalFields deep-equals the legacy CRITICAL_FIELDS_BY_DOMAIN entry", () => {
  for (const id of LEGACY_DOMAIN_IDS) {
    const definition = getDomainDefinition(id as any);
    assertEquals(
      [...definition.criticalFields],
      LEGACY_CRITICAL_FIELDS[id],
      `criticalFields mismatch for ${id}`,
    );
  }
});

Deno.test("byte-compat: every domain's promptConcepts is character-identical to the legacy DOMAIN_CONCEPTS entry", () => {
  for (const id of LEGACY_DOMAIN_IDS) {
    const definition = getDomainDefinition(id as any);
    assertEquals(
      definition.promptConcepts,
      LEGACY_PROMPT_CONCEPTS[id],
      `promptConcepts mismatch for ${id}`,
    );
    // Belt and suspenders: exact character count too, in case assertEquals
    // ever normalized whitespace under the hood for these two calls.
    assertEquals(
      definition.promptConcepts.length,
      LEGACY_PROMPT_CONCEPTS[id].length,
    );
  }
});

Deno.test("byte-compat: DOMAIN_THRESHOLDS deep-equals the legacy routing thresholds", () => {
  for (const id of LEGACY_DOMAIN_IDS) {
    assertEquals(
      DOMAIN_THRESHOLDS[id],
      LEGACY_ROUTING_THRESHOLDS[id],
      `routingThreshold mismatch for ${id}`,
    );
  }
});

Deno.test("byte-compat: ENRICH_EVIDENCE_DOMAIN_STAGES deep-equals the legacy array", () => {
  assertEquals(ENRICH_EVIDENCE_DOMAIN_STAGES, [
    ...LEGACY_ENRICH_EVIDENCE_DOMAIN_STAGES,
  ]);
});

Deno.test("runtime sequence: preserves legacy domain stages but expands Expenses/CAM into smaller evidence sub-stages", () => {
  const expandedLegacy = LEGACY_ENRICH_STAGE_SEQUENCE.flatMap((stage) =>
    stage === "enrich_evidence_expenses_and_cam"
      ? [...EXPENSES_AND_CAM_EVIDENCE_SUBSTAGES, stage]
      : [stage]
  );
  assertEquals([...ENRICH_STAGE_SEQUENCE], expandedLegacy);
});

Deno.test("byte-compat: every registry domain's boundedEnrichStageName maps back to the legacy STAGE_TO_LLM_CALL_DOMAIN entry", () => {
  for (
    const [stage, domainId] of Object.entries(LEGACY_STAGE_TO_LLM_CALL_DOMAIN)
  ) {
    const definition = DOMAIN_REGISTRY.find((d) =>
      d.boundedEnrichStageName === stage
    );
    assertEquals(
      definition?.id,
      domainId,
      `stage ${stage} should map to domain ${domainId}`,
    );
  }
});

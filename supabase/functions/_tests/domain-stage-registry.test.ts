// @ts-nocheck
// Bounded-enrich dispatch lookup (Phase 4.5) — isEnrichEvidenceDomainStage /
// getDomainForEnrichStage, the registry-membership check that replaces the
// static `case "enrich_evidence_<domain>":` labels in
// normalize-pdf-output/index.ts's handleBoundedEnrichStage() switch.

import { assert, assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  isEnrichEvidenceDomainStage,
  getDomainForEnrichStage,
} from "../_shared/extraction/domains/domain-stage-registry.ts";
import { LEGACY_ENRICH_EVIDENCE_DOMAIN_STAGES, LEGACY_STAGE_TO_LLM_CALL_DOMAIN, LEGACY_ENRICH_STAGE_SEQUENCE } from "./fixtures/legacy-domain-configuration.ts";

const NON_DOMAIN_STAGES = LEGACY_ENRICH_STAGE_SEQUENCE.filter(
  (stage) => !(LEGACY_ENRICH_EVIDENCE_DOMAIN_STAGES as readonly string[]).includes(stage),
);

Deno.test("isEnrichEvidenceDomainStage: true for all 5 real evidence-domain stage names", () => {
  for (const stage of LEGACY_ENRICH_EVIDENCE_DOMAIN_STAGES) {
    assert(isEnrichEvidenceDomainStage(stage), `expected ${stage} to be a domain stage`);
  }
});

Deno.test("isEnrichEvidenceDomainStage: false for all 5 non-domain stage names", () => {
  assertEquals(NON_DOMAIN_STAGES.length, 5, "sanity check on the fixture split");
  for (const stage of NON_DOMAIN_STAGES) {
    assert(!isEnrichEvidenceDomainStage(stage), `expected ${stage} to NOT be a domain stage`);
  }
});

Deno.test("isEnrichEvidenceDomainStage: false for a one-character typo of a real stage name (not a prefix guess)", () => {
  // Exactly the danger case called out in the Phase 4.5 spec: "expense_and_cam"
  // instead of the real "expenses_and_cam" -- a stage.startsWith("enrich_evidence_")
  // check would wrongly accept this; a registry-membership check must not.
  assert(!isEnrichEvidenceDomainStage("enrich_evidence_expense_and_cam"));
});

Deno.test("isEnrichEvidenceDomainStage: false for an unrelated string", () => {
  assert(!isEnrichEvidenceDomainStage("not_a_real_stage"));
  assert(!isEnrichEvidenceDomainStage(""));
});

Deno.test("getDomainForEnrichStage: resolves the correct domain id for each of the 5 real stages", () => {
  for (const [stage, domainId] of Object.entries(LEGACY_STAGE_TO_LLM_CALL_DOMAIN)) {
    assertEquals(getDomainForEnrichStage(stage as any), domainId);
  }
});

Deno.test("getDomainForEnrichStage: throws (never returns undefined) for a stage that isn't domain-registered", () => {
  assertThrows(() => getDomainForEnrichStage("not_a_real_stage" as any), Error, "No domain registered for bounded-enrich stage");
});

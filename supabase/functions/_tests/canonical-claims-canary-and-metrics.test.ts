// @ts-nocheck
// MLB shadow-canary additions: org-allowlist gating for both new Phase 2/3
// flags, plus CanonicalClaimMetrics / MultiLabelRoutingMetrics summary
// diagnostics used as the canary's pass/fail gate.

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { shouldBuildCanonicalClaims } from "../_shared/extraction/openai-fact-ledger/canonical-claims-mode.ts";
import { shouldComputeMultilabelRouting } from "../_shared/extraction/openai-fact-ledger/multilabel-routing-mode.ts";
import { computeCanonicalClaimMetrics } from "../_shared/extraction/canonical/claim-metrics.ts";
import { mapperResultToClaims, verifierResultToClaims, type ClaimIdentityContext } from "../_shared/extraction/canonical/claim-converters.ts";
import { routeSectionsMultiLabel, buildRoutingShadowDiagnostics, buildMultiLabelRoutingMetrics } from "../_shared/extraction/section-router.ts";
import type { ExtractedField } from "../_shared/extraction/types.ts";

function fakeEnv(vars: Record<string, string>) {
  return { get: (key: string) => vars[key] };
}

// ── Canary gating ─────────────────────────────────────────────────────────

Deno.test("shouldBuildCanonicalClaims: false whenever the top-level flag is off, regardless of allowlist", () => {
  const env = fakeEnv({ LEASE_CANONICAL_CLAIMS_ORG_ALLOWLIST: "org-1" });
  assert(!shouldBuildCanonicalClaims({ orgId: "org-1", generationId: "gen-1" }, env));
});

Deno.test("shouldBuildCanonicalClaims: org on the allowlist -> true", () => {
  const env = fakeEnv({ LEASE_CANONICAL_CLAIMS_V1: "active", LEASE_CANONICAL_CLAIMS_ORG_ALLOWLIST: "org-1" });
  assert(shouldBuildCanonicalClaims({ orgId: "org-1", generationId: "gen-1" }, env));
  assert(!shouldBuildCanonicalClaims({ orgId: "org-99", generationId: "gen-1" }, env));
});

Deno.test("shouldComputeMultilabelRouting: false whenever the top-level flag is off, regardless of allowlist", () => {
  const env = fakeEnv({ LEASE_MULTILABEL_ROUTING_ORG_ALLOWLIST: "org-1" });
  assert(!shouldComputeMultilabelRouting({ orgId: "org-1", generationId: "gen-1" }, env));
});

Deno.test("shouldComputeMultilabelRouting: org on the allowlist -> true", () => {
  const env = fakeEnv({ LEASE_MULTILABEL_ROUTING_V1: "active", LEASE_MULTILABEL_ROUTING_ORG_ALLOWLIST: "org-1" });
  assert(shouldComputeMultilabelRouting({ orgId: "org-1", generationId: "gen-1" }, env));
  assert(!shouldComputeMultilabelRouting({ orgId: "org-99", generationId: "gen-1" }, env));
});

// ── computeCanonicalClaimMetrics ─────────────────────────────────────────────

const CONTEXT: ClaimIdentityContext = { organizationId: "org-1", fileId: "file-1", generationId: "gen-1", extractionRunId: "run-1" };

Deno.test("computeCanonicalClaimMetrics: a healthy conversion reports all-zero gate metrics", () => {
  const originalFields: Record<string, ExtractedField> = {
    electric_responsibility: { value: "tenant", source: "llm", confidence: 0.9, sourceText: "q", sourcePage: 1, extractionStatus: "extracted" },
    monthly_rent: { value: 1400, source: "llm", confidence: 0.9, sourceText: "q2", sourcePage: 2, extractionStatus: "extracted" },
  };
  const claims = mapperResultToClaims({
    domain: "expenses_and_cam",
    assignments: {
      electric_responsibility: { value: "tenant", sourceText: "q", sourcePage: 1, confidence: 0.9, notStated: false },
      monthly_rent: { value: 1400, sourceText: "q2", sourcePage: 2, confidence: 0.9, notStated: false },
    },
    context: CONTEXT,
  });
  const metrics = computeCanonicalClaimMetrics({ originalFields, claims });
  assertEquals(metrics.totalClaims, 2);
  assertEquals(metrics.conversionValueMismatches, 0);
  assertEquals(metrics.duplicateClaimIds, 0);
  assertEquals(metrics.lostFieldCodes, []);
});

Deno.test("computeCanonicalClaimMetrics: a rejected claim is excluded from conversionValueMismatches (it's supposed to vanish)", () => {
  const originalFields: Record<string, ExtractedField> = {
    insurance_responsibility: { value: "landlord", source: "llm", confidence: 0.9, sourceText: "q", sourcePage: 4, extractionStatus: "extracted" },
  };
  const claims = mapperResultToClaims({
    domain: "expenses_and_cam",
    assignments: { insurance_responsibility: { value: "landlord", sourceText: "q", sourcePage: 4, confidence: 0.9, notStated: false } },
    context: CONTEXT,
  });
  const rejected = verifierResultToClaims(claims, [{ field: "insurance_responsibility", decision: "null", reason: "not clearly assigned" }]);
  const metrics = computeCanonicalClaimMetrics({ originalFields, claims: rejected });
  assertEquals(metrics.conversionValueMismatches, 0, "a rejected claim's disappearance from claimsToLegacyFields is intentional, not a mismatch");
});

Deno.test("computeCanonicalClaimMetrics: lostFieldCodes catches a populated field with no corresponding claim", () => {
  const originalFields: Record<string, ExtractedField> = {
    electric_responsibility: { value: "tenant", source: "llm", confidence: 0.9, sourceText: "q", sourcePage: 1, extractionStatus: "extracted" },
    water_sewer_responsibility: { value: "tenant", source: "llm", confidence: 0.9, sourceText: "q", sourcePage: 1, extractionStatus: "extracted" },
  };
  // Only one of the two fields produced a claim -- simulates a regression.
  const claims = mapperResultToClaims({
    domain: "expenses_and_cam",
    assignments: { electric_responsibility: { value: "tenant", sourceText: "q", sourcePage: 1, confidence: 0.9, notStated: false } },
    context: CONTEXT,
  });
  const metrics = computeCanonicalClaimMetrics({ originalFields, claims });
  assertEquals(metrics.lostFieldCodes, ["water_sewer_responsibility"]);
});

Deno.test("computeCanonicalClaimMetrics: duplicateClaimIds is nonzero when two claims accidentally share an id", () => {
  const originalFields: Record<string, ExtractedField> = {};
  const claims = mapperResultToClaims({
    domain: "expenses_and_cam",
    assignments: { a: { value: "tenant", sourceText: "q", sourcePage: 1, confidence: 0.9, notStated: false } },
    context: CONTEXT,
  });
  const duplicated = [claims[0], { ...claims[0] }];
  const metrics = computeCanonicalClaimMetrics({ originalFields, claims: duplicated });
  assertEquals(metrics.duplicateClaimIds, 1);
});

// ── buildMultiLabelRoutingMetrics ────────────────────────────────────────────

Deno.test("buildMultiLabelRoutingMetrics: reasonable bounds on a mixed-topic document", () => {
  const docling = {
    text_blocks: [
      { block_index: 0, type: "paragraph", text: "Tenant shall pay its Proportionate Share of Operating Expenses, real estate taxes, and Additional Rent as set forth in this Lease.", page: 1 },
      { block_index: 1, type: "paragraph", text: "In Witness Whereof, the parties have executed this Lease as of the date first written above.", page: 10 },
    ],
  };
  const blocks = routeSectionsMultiLabel(docling).blocks;
  const diagnostics = buildRoutingShadowDiagnostics(blocks);
  const metrics = buildMultiLabelRoutingMetrics(blocks, diagnostics);
  assertEquals(metrics.totalBlocks, 2);
  assert(metrics.maximumTargetsPerBlock <= 3);
  assert(metrics.averageTargetsPerBlock >= 0);
});

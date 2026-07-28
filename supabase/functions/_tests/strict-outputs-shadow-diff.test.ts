// @ts-nocheck
// Strict Structured Outputs pilot — evidence-aware diff + shadow-metrics tests.
//
// Covers computeFieldDiffs/computeShadowMetrics (pure functions, no I/O),
// the post-verification enrichment pass (enrichFieldDiffsWithPostVerification/
// mergePostVerificationMetrics -- added after a real production bug was found
// during this pilot's own first canary run: comparing strict output against
// the mapper's PRE-verification proposal instead of what the authoritative
// pipeline actually concluded made a downstream propagation defect look like
// an extraction disagreement), and runExpensesAndCamStrictOutputsShadow's
// canary/no-provenance skip behavior.

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  computeFieldDiffs,
  computeShadowMetrics,
  enrichFieldDiffsWithPostVerification,
  mergePostVerificationMetrics,
  runExpensesAndCamStrictOutputsShadow,
} from "../_shared/extraction/openai-fact-ledger/strict-outputs-shadow.ts";

// ── computeFieldDiffs ────────────────────────────────────────────────────────

Deno.test("computeFieldDiffs: matching values on both sides -> sameValue true, counted as agreement-eligible", () => {
  const diffs = computeFieldDiffs(
    ["cam_amount"],
    { cam_amount: { value: "1200", sourceText: "CAM shall be $1,200 annually." } },
    { cam_amount: { status: "explicit", value: "1200", rawValue: "$1,200", sourceNodeIds: [], sourceQuote: "CAM shall be $1,200 annually.", uncertaintyReason: null } },
  );
  assertEquals(diffs.length, 1);
  assertEquals(diffs[0].sameValue, true);
  assertEquals(diffs[0].rawMapperHasEvidence, true);
  assertEquals(diffs[0].strictHasEvidence, true);
  assertEquals(diffs[0].postVerificationValue, null, "not knowable until enrichFieldDiffsWithPostVerification runs");
  assertEquals(diffs[0].strictVsVerifiedAgreement, null);
  assertEquals(diffs[0].authoritativeDroppedDownstream, null);
});

Deno.test("computeFieldDiffs: authoritative populated, strict abstains (not_found) -- surfaced as a real disagreement signal, not silently dropped", () => {
  const diffs = computeFieldDiffs(
    ["cam_amount"],
    { cam_amount: { value: "1200", sourceText: "CAM shall be $1,200 annually." } },
    { cam_amount: { status: "not_found", value: null, rawValue: null, sourceNodeIds: [], sourceQuote: null, uncertaintyReason: null } },
  );
  assertEquals(diffs[0].rawMapperValue, "1200");
  assertEquals(diffs[0].strictValue, null);
  assertEquals(diffs[0].strictStatus, "not_found");
  assertEquals(diffs[0].sameValue, false);
});

Deno.test("computeFieldDiffs: strict finds a value authoritative missed entirely", () => {
  const diffs = computeFieldDiffs(
    ["insurance_min_coverage"],
    { insurance_min_coverage: undefined },
    { insurance_min_coverage: { status: "explicit", value: "2000000", rawValue: "$2,000,000", sourceNodeIds: [], sourceQuote: "Tenant shall carry $2,000,000 in general liability coverage.", uncertaintyReason: null } },
  );
  assertEquals(diffs[0].rawMapperValue, null);
  assertEquals(diffs[0].strictValue, "2000000");
  assertEquals(diffs[0].rawMapperStatus, "not_assigned");
});

Deno.test("computeFieldDiffs: a field neither side populated is not treated as a disagreement", () => {
  const diffs = computeFieldDiffs(
    ["tax_cap_pct"],
    { tax_cap_pct: undefined },
    { tax_cap_pct: { status: "not_found", value: null, rawValue: null, sourceNodeIds: [], sourceQuote: null, uncertaintyReason: null } },
  );
  assertEquals(diffs[0].rawMapperValue, null);
  assertEquals(diffs[0].strictValue, null);
  assertEquals(diffs[0].sameValue, true, "null vs null must count as agreement (both correctly abstained), not disagreement");
});

Deno.test("computeFieldDiffs: illegible status is treated like not_found for value comparison purposes", () => {
  const diffs = computeFieldDiffs(
    ["admin_fee_pct"],
    { admin_fee_pct: { value: "15", sourceText: "Admin fee: 15% of CAM." } },
    { admin_fee_pct: { status: "illegible", value: "??", rawValue: "???", sourceNodeIds: [], sourceQuote: "garbled scan", uncertaintyReason: "OCR artifact" } },
  );
  assertEquals(diffs[0].strictValue, null, "illegible must not surface a garbled value as a real strictValue");
});

// ── enrichFieldDiffsWithPostVerification ─────────────────────────────────────

Deno.test("enrichFieldDiffsWithPostVerification: a value that survives verification unchanged agrees or disagrees with strict on the REAL post-verification value", () => {
  const raw = computeFieldDiffs(
    ["tax_responsibility"],
    { tax_responsibility: { value: "tenant", sourceText: "Tenant does pay for all taxes." } },
    { tax_responsibility: { status: "explicit", value: "tenant", rawValue: "tenant", sourceNodeIds: [], sourceQuote: "q", uncertaintyReason: null } },
  );
  const enriched = enrichFieldDiffsWithPostVerification(raw, { tax_responsibility: { value: "tenant" } });
  assertEquals(enriched[0].postVerificationValue, "tenant");
  assertEquals(enriched[0].strictVsVerifiedAgreement, true);
  assertEquals(enriched[0].authoritativeDroppedDownstream, false);
});

Deno.test("enrichFieldDiffsWithPostVerification: the exact real bug this was built to catch -- rawMapper had a value, verifier never explicitly nulled it, but it's absent post-verification", () => {
  const raw = computeFieldDiffs(
    ["electric_responsibility"],
    { electric_responsibility: { value: "tenant", sourceText: "Tenant does pay for all electricity." } },
    { electric_responsibility: { status: "explicit", value: "tenant", rawValue: "tenant", sourceNodeIds: [], sourceQuote: "q", uncertaintyReason: null } },
  );
  // Field key absent entirely from the post-verification fields object --
  // and NOT because the verifier explicitly decided "null" on it.
  const enriched = enrichFieldDiffsWithPostVerification(raw, {}, new Set());
  assertEquals(enriched[0].postVerificationValue, null);
  assertEquals(enriched[0].authoritativeDroppedDownstream, true, "a real proposed value that silently vanished with no explicit verifier decision must be flagged");
});

Deno.test("enrichFieldDiffsWithPostVerification: an EXPLICIT verifier null decision is never counted as a drop", () => {
  const raw = computeFieldDiffs(
    ["insurance_responsibility"],
    { insurance_responsibility: { value: "landlord", sourceText: "Rent includes property insurance." } },
    { insurance_responsibility: { status: "explicit", value: "landlord", rawValue: "landlord", sourceNodeIds: [], sourceQuote: "q", uncertaintyReason: null } },
  );
  const enriched = enrichFieldDiffsWithPostVerification(raw, {}, new Set(["insurance_responsibility"]));
  assertEquals(enriched[0].postVerificationValue, null);
  assertEquals(enriched[0].authoritativeDroppedDownstream, false, "an intentional verifier rejection is a real decision, not a defect");
});

Deno.test("enrichFieldDiffsWithPostVerification: a field the mapper never proposed a value for is never flagged as dropped", () => {
  const raw = computeFieldDiffs(
    ["base_year"],
    { base_year: undefined },
    { base_year: { status: "not_found", value: null, rawValue: null, sourceNodeIds: [], sourceQuote: null, uncertaintyReason: null } },
  );
  const enriched = enrichFieldDiffsWithPostVerification(raw, {});
  assertEquals(enriched[0].authoritativeDroppedDownstream, false);
});

// ── computeShadowMetrics ─────────────────────────────────────────────────────

Deno.test("computeShadowMetrics: aggregates agreement/disagreement/abstention counts correctly across a mixed diff set", () => {
  const fieldDiffs = computeFieldDiffs(
    ["a", "b", "c", "d"],
    {
      a: { value: "1", sourceText: "x" }, // both populated, agree
      b: { value: "2", sourceText: "x" }, // both populated, disagree
      c: { value: "3", sourceText: "x" }, // authoritative only
      d: undefined, // strict only
    },
    {
      a: { status: "explicit", value: "1", rawValue: "1", sourceNodeIds: [], sourceQuote: "q", uncertaintyReason: null },
      b: { status: "explicit", value: "99", rawValue: "99", sourceNodeIds: [], sourceQuote: "q", uncertaintyReason: null },
      c: { status: "not_found", value: null, rawValue: null, sourceNodeIds: [], sourceQuote: null, uncertaintyReason: null },
      d: { status: "ambiguous", value: "4", rawValue: "4", sourceNodeIds: [], sourceQuote: "q", uncertaintyReason: "two readings" },
    },
  );
  const metrics = computeShadowMetrics({ schemaVersion: "expenses-and-cam-v1", status: "success", fieldDiffs, latencyMs: 100, inputTokens: 10, outputTokens: 5 });
  assertEquals(metrics.valueAgreementCount, 1);
  assertEquals(metrics.valueDisagreementCount, 1);
  assertEquals(metrics.authoritativeNonNullStrictNull, 1);
  assertEquals(metrics.authoritativeNullStrictNonNull, 1);
  assertEquals(metrics.strictAmbiguousCount, 1);
  assertEquals(metrics.strictNotFoundCount, 1);
  assertEquals(metrics.schemaCompliant, true);
  assertEquals(metrics.strictVsVerifiedAgreementCount, null, "not knowable until mergePostVerificationMetrics runs");
});

Deno.test("computeShadowMetrics: a non-success status reports schemaCompliant false", () => {
  const metrics = computeShadowMetrics({ schemaVersion: "expenses-and-cam-v1", status: "refusal", fieldDiffs: [], latencyMs: 50, inputTokens: 1, outputTokens: 0 });
  assertEquals(metrics.schemaCompliant, false);
});

// ── mergePostVerificationMetrics ─────────────────────────────────────────────

Deno.test("mergePostVerificationMetrics: counts agreement/disagreement/drops from the ENRICHED diffs, distinct from the raw-mapper comparison", () => {
  const raw = computeFieldDiffs(
    ["tax_responsibility", "electric_responsibility", "water_sewer_responsibility"],
    {
      tax_responsibility: { value: "tenant", sourceText: "x" },
      electric_responsibility: { value: "tenant", sourceText: "x" },
      water_sewer_responsibility: { value: "tenant", sourceText: "x" },
    },
    {
      tax_responsibility: { status: "explicit", value: "tenant", rawValue: "tenant", sourceNodeIds: [], sourceQuote: "q", uncertaintyReason: null },
      electric_responsibility: { status: "explicit", value: "tenant", rawValue: "tenant", sourceNodeIds: [], sourceQuote: "q", uncertaintyReason: null },
      water_sewer_responsibility: { status: "explicit", value: "landlord", rawValue: "landlord", sourceNodeIds: [], sourceQuote: "q", uncertaintyReason: null },
    },
  );
  const metrics = computeShadowMetrics({ schemaVersion: "v1", status: "success", fieldDiffs: raw, latencyMs: 1, inputTokens: 1, outputTokens: 1 });
  // tax_responsibility: survives verification unchanged -> agrees with strict.
  // electric_responsibility: silently dropped (the real bug) -> counted as a drop, not an agreement/disagreement.
  // water_sewer_responsibility: verifier explicitly nulled it -> a real decision, not a drop, and not comparable (postVerificationValue null).
  const enriched = enrichFieldDiffsWithPostVerification(
    raw,
    { tax_responsibility: { value: "tenant" } },
    new Set(["water_sewer_responsibility"]),
  );
  const merged = mergePostVerificationMetrics(metrics, enriched);
  assertEquals(merged.strictVsVerifiedAgreementCount, 1);
  assertEquals(merged.strictVsVerifiedDisagreementCount, 0);
  assertEquals(merged.authoritativeDroppedDownstreamCount, 1);
});

// ── runExpensesAndCamStrictOutputsShadow: skip behavior ─────────────────────

Deno.test("runExpensesAndCamStrictOutputsShadow: returns null when no provenance context is supplied (no orgId to canary-gate on)", async () => {
  const record = await runExpensesAndCamStrictOutputsShadow({
    orgId: "org-1",
    generationId: "gen-1",
    moduleType: "lease",
    evidenceText: "irrelevant",
    domainFieldDefs: [],
    authoritativeAssignments: {},
    provenance: undefined,
  });
  assertEquals(record, null);
});

Deno.test("runExpensesAndCamStrictOutputsShadow: returns null when the canary gate does not admit this org/generation (flag off by default)", async () => {
  const record = await runExpensesAndCamStrictOutputsShadow({
    orgId: "org-1",
    generationId: "gen-1",
    moduleType: "lease",
    evidenceText: "irrelevant",
    domainFieldDefs: [],
    authoritativeAssignments: {},
    provenance: { supabaseAdmin: {}, context: { orgId: "org-1", uploadedFileId: "f1", generationId: "gen-1", extractionRunId: "r1", stageRunId: "s1", stageAttempt: 1, operation: "test" } },
  });
  assert(record === null, "LEASE_STRICT_OUTPUTS_V1 defaults off, so no call should fire and no record should be produced");
});

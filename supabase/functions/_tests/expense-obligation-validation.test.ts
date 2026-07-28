// @ts-nocheck
// Phase 6A structural validation + evidence verification tests
// (expense-obligation-validation.ts, 6A.4).

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  validateExpenseObligationStructure,
  applyStructuralValidation,
  verifyExpenseObligationEvidence,
  applyExpenseObligationEvidenceVerification,
} from "../_shared/extraction/canonical/financial/expense-obligation-validation.ts";
import { camSpecialistToExpenseObligations } from "../_shared/extraction/canonical/financial/expense-obligation-converters.ts";

const CONTEXT = { organizationId: "org-1", fileId: "file-1", generationId: "gen-1", extractionRunId: "run-1" };

function camObligation(overrides: Record<string, unknown> = {}) {
  return camSpecialistToExpenseObligations(
    [{
      category: "common_area_maintenance", responsibleParty: "tenant", paymentMechanism: "additional_rent",
      allocationMethod: "pro_rata_share", amountType: "fixed", amount: 1200, percentage: null, cap: null,
      inclusions: [], exclusions: [], reconciliationFrequency: null, auditRight: null,
      status: "explicit", sourcePage: 1, sourceQuote: "CAM shall be $1,200 annually.",
      ...overrides,
    }],
    CONTEXT, "cam-obligation-v1",
  )[0];
}

// ── Structural rules ──────────────────────────────────────────────────────────

Deno.test("validateExpenseObligationStructure: fixed_amount without amount is structurally INVALID (excluded, not just flagged)", () => {
  const o = camObligation({ amountType: "fixed", amount: null });
  const outcome = validateExpenseObligationStructure(o);
  assertEquals(outcome.valid, false);
  assertEquals(outcome.invalidReason, "fixed_amount_without_amount");
});

Deno.test("validateExpenseObligationStructure: pro_rata_share allocation without a responsible party -> review reason, still valid", () => {
  const o = camObligation({ responsibleParty: "not_stated", allocationMethod: "pro_rata_share" });
  const outcome = validateExpenseObligationStructure(o);
  assertEquals(outcome.valid, true);
  assert(outcome.reviewReasons.includes("allocation_present_without_responsible_party"));
});

Deno.test("validateExpenseObligationStructure: percentage cap without a value -> review reason", () => {
  const o = camObligation({ cap: { type: "cumulative_percentage", value: null, appliesTo: null } });
  const outcome = validateExpenseObligationStructure(o);
  assert(outcome.reviewReasons.includes("percentage_cap_without_percentage"));
});

Deno.test("validateExpenseObligationStructure: a clean obligation has no review reasons", () => {
  const o = camObligation();
  const outcome = validateExpenseObligationStructure(o);
  assertEquals(outcome.valid, true);
  assertEquals(outcome.reviewReasons, []);
});

Deno.test("applyStructuralValidation: invalid obligations are dropped and counted separately from valid ones", () => {
  const valid = camObligation();
  const invalid = camObligation({ amountType: "fixed", amount: null });
  const result = applyStructuralValidation([valid, invalid]);
  assertEquals(result.valid.length, 1);
  assertEquals(result.invalidCount, 1);
});

Deno.test("applyStructuralValidation: review reasons are merged onto the obligation, requiresReview set", () => {
  const o = camObligation({ responsibleParty: "not_stated", allocationMethod: "pro_rata_share" });
  const result = applyStructuralValidation([o]);
  assertEquals(result.valid[0].requiresReview, true);
  assert(result.valid[0].reviewReasons.includes("allocation_present_without_responsible_party"));
});

// ── Evidence verification ────────────────────────────────────────────────────

Deno.test("verifyExpenseObligationEvidence: an obligation with zero evidence entries is invalid", () => {
  const o = { ...camObligation(), evidence: [] };
  const result = verifyExpenseObligationEvidence(o, null);
  assertEquals(result.valid, false);
  assertEquals(result.reason, "obligation_without_evidence");
});

Deno.test("verifyExpenseObligationEvidence: a quote that cannot be verified against the document is invalid", () => {
  // Multi-page doclingRaw -- resolveVerifiedSourcePage's single-page
  // fallback (page auto-verifies when the document has exactly one page)
  // must not mask a genuinely unverifiable quote here.
  const o = camObligation({ sourceQuote: "This exact sentence does not appear anywhere in the document.", sourcePage: 1 });
  const doclingRaw = { text_blocks: [{ text: "Something completely different.", page: 1 }, { text: "Yet another unrelated sentence.", page: 2 }] };
  const result = verifyExpenseObligationEvidence(o, doclingRaw);
  assertEquals(result.valid, false);
  assertEquals(result.reason, "evidence_quote_not_found");
});

Deno.test("verifyExpenseObligationEvidence: a quote that verifies against the document on the claimed page is valid", () => {
  const quote = "CAM shall be $1,200 annually.";
  const o = camObligation({ sourceQuote: quote, sourcePage: 1 });
  const doclingRaw = { text_blocks: [{ text: quote, page: 1 }] };
  const result = verifyExpenseObligationEvidence(o, doclingRaw);
  assertEquals(result.valid, true);
});

Deno.test("applyExpenseObligationEvidenceVerification: valid evidence promotes unverified -> verified", () => {
  const quote = "CAM shall be $1,200 annually.";
  const o = camObligation({ sourceQuote: quote, sourcePage: 1 });
  const doclingRaw = { text_blocks: [{ text: quote, page: 1 }] };
  const result = applyExpenseObligationEvidenceVerification(o, doclingRaw);
  assertEquals(result.verificationStatus, "verified");
});

Deno.test("applyExpenseObligationEvidenceVerification: invalid evidence sets needs_review + requiresReview, never rejects an already-rejected obligation back to needs_review incorrectly", () => {
  const o = { ...camObligation({ sourceQuote: "unverifiable text" }), verificationStatus: "rejected" };
  const result = applyExpenseObligationEvidenceVerification(o, { text_blocks: [] });
  assertEquals(result.verificationStatus, "rejected", "an already-rejected obligation must not be silently changed");
  assertEquals(result.requiresReview, true);
});

Deno.test("applyExpenseObligationEvidenceVerification: never mutates the input object", () => {
  const quote = "CAM shall be $1,200 annually.";
  const o = camObligation({ sourceQuote: quote, sourcePage: 1 });
  const originalStatus = o.verificationStatus;
  applyExpenseObligationEvidenceVerification(o, { text_blocks: [{ text: quote, page: 1 }] });
  assertEquals(o.verificationStatus, originalStatus);
});

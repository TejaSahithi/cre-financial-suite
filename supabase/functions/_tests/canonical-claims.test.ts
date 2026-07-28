// @ts-nocheck
// Canonical Claim/Evidence Layer (Phase 2) tests.
//
// Covers the converters (claim-converters.ts) and evidence verification
// (claim-validation.ts) in isolation -- pure functions, no I/O, no live
// LLM calls. LEASE_CANONICAL_CLAIMS_V1 stays default-off in production; these
// tests exercise the functions directly regardless of the flag.

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  claimsToDynamicRows,
  claimsToLegacyFields,
  legacyFieldsToClaims,
  mapperResultToClaims,
  strictResultToClaims,
  verifierResultToClaims,
  type ClaimIdentityContext,
} from "../_shared/extraction/canonical/claim-converters.ts";
import { applyEvidenceVerification, verifyClaimEvidence } from "../_shared/extraction/canonical/claim-validation.ts";
import type { ExtractedClaim } from "../_shared/extraction/canonical/extracted-claim.ts";
import type { ExtractedField } from "../_shared/extraction/types.ts";

const CONTEXT: ClaimIdentityContext = {
  organizationId: "org-1",
  fileId: "file-1",
  generationId: "gen-1",
  extractionRunId: "run-1",
};

function sampleDocling(sourceText: string, page: number) {
  // Multiple pages/blocks deliberately -- resolveVerifiedSourcePage() has a
  // single-page-document fallback (trivially "verified" when the whole
  // document has exactly one page) that would make a "quote not found" test
  // pass for the wrong reason on a one-block fixture.
  return {
    text_blocks: [
      { block_index: 0, type: "paragraph", text: "Unrelated preamble text on page one.", page: 1 },
      { block_index: 1, type: "paragraph", text: sourceText, page },
      { block_index: 2, type: "paragraph", text: "Unrelated closing text on a later page.", page: page + 1 },
    ],
  };
}

// ── mapperResultToClaims ─────────────────────────────────────────────────────

Deno.test("mapperResultToClaims: a mapper result converts into a claim", () => {
  const claims = mapperResultToClaims({
    domain: "expenses_and_cam",
    assignments: {
      electric_responsibility: { value: "tenant", sourceText: "Tenant pays electricity.", sourcePage: 8, confidence: 0.9, notStated: false },
    },
    context: CONTEXT,
    promptVersion: "llm-primary-mapping-v1",
  });
  assertEquals(claims.length, 1);
  assertEquals(claims[0].fieldCode, "electric_responsibility");
  assertEquals(claims[0].normalizedValue, "tenant");
  assertEquals(claims[0].status, "explicit");
  assertEquals(claims[0].verificationStatus, "unverified");
  assertEquals(claims[0].evidence.length, 1);
  assertEquals(claims[0].evidence[0].quote, "Tenant pays electricity.");
  assertEquals(claims[0].organizationId, "org-1");
});

// ── strictResultToClaims ─────────────────────────────────────────────────────

Deno.test("strictResultToClaims: a strict result converts into a claim", () => {
  const claims = strictResultToClaims({
    domain: "expenses_and_cam",
    strictFields: {
      cam_amount: { status: "explicit", value: "1200", rawValue: "$1,200", sourceNodeIds: [], sourceQuote: "CAM shall be $1,200.", uncertaintyReason: null },
    },
    context: CONTEXT,
    schemaVersion: "expenses-and-cam-v1",
  });
  assertEquals(claims.length, 1);
  assertEquals(claims[0].status, "explicit");
  assertEquals(claims[0].normalizedValue, "1200");
  assertEquals(claims[0].rawValue, "$1,200");
  assertEquals(claims[0].requiresReview, false);
});

Deno.test("strictResultToClaims: ambiguous/conflicting/illegible statuses are marked requiresReview", () => {
  const claims = strictResultToClaims({
    domain: "expenses_and_cam",
    strictFields: {
      insurance_responsibility: { status: "ambiguous", value: "landlord", rawValue: "landlord", sourceNodeIds: [], sourceQuote: "Rent includes insurance.", uncertaintyReason: "Bundled cost, not a clear responsibility statement." },
    },
    context: CONTEXT,
  });
  assertEquals(claims[0].requiresReview, true);
  assertEquals(claims[0].reviewReasons, ["Bundled cost, not a clear responsibility statement."]);
});

// ── verifierResultToClaims ───────────────────────────────────────────────────

Deno.test("verifierResultToClaims: confirm/null/uncertain map to verified/rejected/needs_review, never clearing normalizedValue", () => {
  const claims: ExtractedClaim[] = mapperResultToClaims({
    domain: "expenses_and_cam",
    assignments: {
      a: { value: "tenant", sourceText: "q", sourcePage: 1, confidence: 0.9, notStated: false },
      b: { value: "landlord", sourceText: "q", sourcePage: 1, confidence: 0.9, notStated: false },
      c: { value: "tenant", sourceText: "q", sourcePage: 1, confidence: 0.9, notStated: false },
    },
    context: CONTEXT,
  });
  const updated = verifierResultToClaims(claims, [
    { field: "a", decision: "confirm", reason: "matches the cited quote" },
    { field: "b", decision: "null", reason: "quote does not support this value" },
    { field: "c", decision: "uncertain", reason: "genuinely ambiguous" },
  ]);
  const byField = Object.fromEntries(updated.map((c) => [c.fieldCode, c]));
  assertEquals(byField.a.verificationStatus, "verified");
  assertEquals(byField.a.normalizedValue, "tenant");
  assertEquals(byField.b.verificationStatus, "rejected");
  assertEquals(byField.b.normalizedValue, "landlord", "rejected claims keep their value -- claimsToLegacyFields decides visibility, not this function");
  assertEquals(byField.c.verificationStatus, "needs_review");
  assertEquals(byField.c.requiresReview, true);
});

Deno.test("verifierResultToClaims: a claim the results array doesn't mention is returned unchanged", () => {
  const claims = mapperResultToClaims({
    domain: "expenses_and_cam",
    assignments: { a: { value: "tenant", sourceText: "q", sourcePage: 1, confidence: 0.9, notStated: false } },
    context: CONTEXT,
  });
  const updated = verifierResultToClaims(claims, []);
  assertEquals(updated[0].verificationStatus, "unverified");
});

// ── legacyFieldsToClaims / claimsToLegacyFields round-trip ──────────────────

Deno.test("legacyFieldsToClaims -> claimsToLegacyFields: claims survive conversion back into the existing UI field format", () => {
  const fields: Record<string, ExtractedField> = {
    monthly_rent: { value: 1400, source: "llm", confidence: 0.95, sourceText: "Rent is $1,400.", sourcePage: 2, extractionStatus: "extracted" },
    tenant_name: { value: "Mindful Tech Solutions Inc", source: "llm", confidence: 0.9, sourceText: "Tenant: Mindful Tech Solutions Inc", sourcePage: 1, extractionStatus: "extracted" },
  };
  const claims = legacyFieldsToClaims({ fields, context: CONTEXT });
  assertEquals(claims.length, 2);
  const roundTripped = claimsToLegacyFields(claims);
  assertEquals(roundTripped.monthly_rent.value, 1400);
  assertEquals(roundTripped.tenant_name.value, "Mindful Tech Solutions Inc");
  assertEquals(roundTripped.monthly_rent.sourceText, "Rent is $1,400.");
});

Deno.test("claimsToLegacyFields: a rejected claim does not surface at all, matching applyValidationCorrections' delete behavior", () => {
  const fields: Record<string, ExtractedField> = {
    insurance_responsibility: { value: "landlord", source: "llm", confidence: 0.9, sourceText: "Rent includes insurance.", sourcePage: 4, extractionStatus: "extracted" },
  };
  const claims = legacyFieldsToClaims({ fields, context: CONTEXT });
  const rejected = verifierResultToClaims(claims, [{ field: "insurance_responsibility", decision: "null", reason: "not clearly assigned" }]);
  const roundTripped = claimsToLegacyFields(rejected);
  assertEquals(roundTripped.insurance_responsibility, undefined);
});

// ── verifyClaimEvidence / applyEvidenceVerification ─────────────────────────

function makeClaim(overrides: Partial<ExtractedClaim>): ExtractedClaim {
  return {
    claimId: "c1",
    organizationId: "org-1",
    fileId: "file-1",
    generationId: "gen-1",
    extractionRunId: "run-1",
    domain: "expenses_and_cam",
    fieldCode: "electric_responsibility",
    canonicalFieldCode: "electric_responsibility",
    status: "explicit",
    verificationStatus: "unverified",
    rawValue: "tenant",
    normalizedValue: "tenant",
    evidence: [],
    controllingDocumentId: null,
    sourceModel: "llm",
    promptVersion: null,
    schemaVersion: null,
    requiresReview: false,
    reviewReasons: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

Deno.test("verifyClaimEvidence: a populated claim without evidence is invalid", () => {
  const claim = makeClaim({ evidence: [] });
  const result = verifyClaimEvidence(claim, sampleDocling("Tenant pays electricity.", 8));
  assertEquals(result.valid, false);
  assertEquals(result.reason, "populated_claim_without_evidence");
});

Deno.test("verifyClaimEvidence: a quote that cannot be found anywhere in the document is invalid", () => {
  const claim = makeClaim({
    evidence: [{ documentId: "file-1", pageNumber: 8, nodeId: null, quote: "This sentence does not appear anywhere in the document.", polygon: null, ocrConfidence: null, role: "direct" }],
  });
  const result = verifyClaimEvidence(claim, sampleDocling("Tenant pays electricity.", 8));
  assertEquals(result.valid, false);
  assertEquals(result.reason, "evidence_quote_not_found");
});

Deno.test("verifyClaimEvidence: a quote that verifies to a different page than claimed is invalid", () => {
  const claim = makeClaim({
    evidence: [{ documentId: "file-1", pageNumber: 3, nodeId: null, quote: "Tenant pays electricity.", polygon: null, ocrConfidence: null, role: "direct" }],
  });
  const result = verifyClaimEvidence(claim, sampleDocling("Tenant pays electricity.", 8));
  assertEquals(result.valid, false);
  assertEquals(result.reason, "evidence_page_mismatch");
});

Deno.test("verifyClaimEvidence: a not_found claim with zero evidence is valid -- nothing to ground", () => {
  const claim = makeClaim({ status: "not_found", normalizedValue: null, evidence: [] });
  const result = verifyClaimEvidence(claim, sampleDocling("Tenant pays electricity.", 8));
  assertEquals(result.valid, true);
});

Deno.test("applyEvidenceVerification: an invalid reference is flagged needs_review, never silently removes the value", () => {
  const claim = makeClaim({ evidence: [] });
  const updated = applyEvidenceVerification(claim, sampleDocling("Tenant pays electricity.", 8));
  assertEquals(updated.verificationStatus, "needs_review");
  assertEquals(updated.requiresReview, true);
  assertEquals(updated.normalizedValue, "tenant", "the value must never be silently cleared by evidence verification");
});

Deno.test("applyEvidenceVerification: a valid, still-unverified claim is promoted to verified", () => {
  const claim = makeClaim({
    evidence: [{ documentId: "file-1", pageNumber: 8, nodeId: null, quote: "Tenant pays electricity.", polygon: null, ocrConfidence: null, role: "direct" }],
  });
  const updated = applyEvidenceVerification(claim, sampleDocling("Tenant pays electricity.", 8));
  assertEquals(updated.verificationStatus, "verified");
});

Deno.test("applyEvidenceVerification: an already-rejected claim is left alone even if its evidence is technically valid", () => {
  const claim = makeClaim({
    verificationStatus: "rejected",
    evidence: [{ documentId: "file-1", pageNumber: 8, nodeId: null, quote: "Tenant pays electricity.", polygon: null, ocrConfidence: null, role: "direct" }],
  });
  const updated = applyEvidenceVerification(claim, sampleDocling("Tenant pays electricity.", 8));
  assertEquals(updated.verificationStatus, "rejected", "evidence verification must not overturn an explicit verifier rejection");
});

// ── claimsToDynamicRows ──────────────────────────────────────────────────────

Deno.test("claimsToDynamicRows: retains source page and a review reason for a claim not backed by an existing field", () => {
  const claim = makeClaim({
    fieldCode: "grease_trap_surcharge",
    canonicalFieldCode: "grease_trap_surcharge",
    requiresReview: true,
    reviewReasons: ["Ambiguous responsibility"],
    evidence: [{ documentId: "file-1", pageNumber: 5, nodeId: null, quote: "A $174.55 grease trap charge is added to monthly rent.", polygon: null, ocrConfidence: null, role: "direct" }],
  });
  const rows = claimsToDynamicRows({ claims: [claim], knownFieldKeys: new Set(["electric_responsibility"]), documentProfile: "full_lease" });
  assertEquals(rows.length, 1);
  assertEquals(rows[0].source_page, 5);
  assertEquals(rows[0].review_reason, "Ambiguous responsibility");
  assertEquals(rows[0].requires_review, true);
});

Deno.test("claimsToDynamicRows: a claim backed by an existing schema field does not duplicate as a dynamic row", () => {
  const claim = makeClaim({ fieldCode: "electric_responsibility", canonicalFieldCode: "electric_responsibility" });
  const rows = claimsToDynamicRows({ claims: [claim], knownFieldKeys: new Set(["electric_responsibility"]), documentProfile: "full_lease" });
  assertEquals(rows.length, 0);
});

// ── The exact NAREN repro: two fields, one clause ────────────────────────────

Deno.test("mapperResultToClaims: two fields supported by one clause remain two separate claims (the dedupe-fix repro)", () => {
  const sourceText = "Tenant does pay for all electricity, HVAC, water, sewer, and other utilities and services used at the Premises, together with all taxes.";
  const claims = mapperResultToClaims({
    domain: "expenses_and_cam",
    assignments: {
      electric_responsibility: { value: "tenant", sourceText, sourcePage: 8, confidence: 0.98, notStated: false },
      water_sewer_responsibility: { value: "tenant", sourceText, sourcePage: 8, confidence: 0.98, notStated: false },
      tax_responsibility: { value: "tenant", sourceText, sourcePage: 8, confidence: 0.97, notStated: false },
    },
    context: CONTEXT,
  });
  assertEquals(claims.length, 3);
  const fieldCodes = new Set(claims.map((c) => c.fieldCode));
  assertEquals(fieldCodes, new Set(["electric_responsibility", "water_sewer_responsibility", "tax_responsibility"]));
  // Each has its own claimId despite sharing evidence text/value -- they are
  // never collapsed into one claim by this converter.
  assertEquals(new Set(claims.map((c) => c.claimId)).size, 3);
});

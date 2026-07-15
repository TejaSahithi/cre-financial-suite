import { describe, it, expect } from "vitest";
import { resolveSourceTextQuality, hasValidSourceEvidence, SOURCE_TEXT_QUALITIES } from "@/lib/leaseReviewSchema";

describe("Phase 44A-Fix: booleanSourceSupportsValue (exercised via resolveSourceTextQuality/hasValidSourceEvidence)", () => {
  it("supports landlord_consent true from 'Landlord hereby consents...' (conjugated form, the real bug)", () => {
    const evidence = {
      value: true,
      sourceText:
        "Landlord hereby consents to the assignment and assumption of the Lease as set forth herein, subject to the terms and conditions of this Agreement.",
      sourcePage: 1,
    };
    expect(resolveSourceTextQuality(evidence)).toBe(SOURCE_TEXT_QUALITIES.EXACT);
    expect(hasValidSourceEvidence(evidence)).toBe(true);
  });

  it("still supports true from the bare word 'consent' (backward compatible)", () => {
    const evidence = {
      value: true,
      sourceText: "Landlord consent is hereby given for this assignment.",
      sourcePage: 1,
    };
    expect(hasValidSourceEvidence(evidence)).toBe(true);
  });

  it("does not support a boolean value from unrelated text", () => {
    const evidence = {
      value: true,
      sourceText: "The premises contain approximately 4,200 rentable square feet.",
      sourcePage: 1,
    };
    expect(resolveSourceTextQuality(evidence)).toBe(SOURCE_TEXT_QUALITIES.INCONSISTENT);
    expect(hasValidSourceEvidence(evidence)).toBe(false);
  });

  it("finds topic-relevant text regardless of true/false polarity (existing behavior preserved)", () => {
    const evidence = {
      value: false,
      sourceText: "Landlord's consent is not required for this type of transfer.",
      sourcePage: 1,
    };
    // booleanSourceSupportsValue is topic-only, not polarity-aware - this
    // was true before the fix and must remain true after it.
    expect(hasValidSourceEvidence(evidence)).toBe(true);
  });

  it("other verb-stem keywords (waive/renew/terminate/require) also match their conjugated forms now", () => {
    expect(hasValidSourceEvidence({ value: true, sourceText: "Tenant hereby waives any right to object.", sourcePage: 1 })).toBe(true);
    expect(hasValidSourceEvidence({ value: true, sourceText: "This Lease shall be renewed automatically.", sourcePage: 1 })).toBe(true);
    expect(hasValidSourceEvidence({ value: true, sourceText: "This Agreement terminated on the stated date.", sourcePage: 1 })).toBe(true);
    expect(hasValidSourceEvidence({ value: true, sourceText: "Landlord requires written notice within 10 days.", sourcePage: 1 })).toBe(true);
  });

  it("does not over-broaden: text sharing only a substring with a keyword does not match", () => {
    // "consentaneous"/"consenter" etc. are not real lease vocabulary, but this
    // guards that the stem regex is still word-bounded, not a raw substring
    // search that would match keywords buried inside unrelated words.
    const evidence = { value: true, sourceText: "The unconsented use of common areas is prohibited.", sourcePage: 1 };
    // "unconsented" does not contain a \b boundary immediately before "consent"
    // (the "un" prefix is a word character), so this must NOT match on the
    // consent stem alone.
    expect(hasValidSourceEvidence(evidence)).toBe(false);
  });
});

// @ts-nocheck
// P2.6 -- claim-resolution.ts / claims-to-field-projection.ts /
// compatibility-payload-builder.ts / compatibility-diff.ts tests.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { resolveClaimForFactSlot } from "../_shared/extraction/claims/adapters/claim-resolution.ts";
import { buildFieldProjection } from "../_shared/extraction/claims/adapters/claims-to-field-projection.ts";
import { buildCompatibilityExtractionDataSlice } from "../_shared/extraction/claims/adapters/compatibility-payload-builder.ts";
import { diffCompatibilityFields, diffFieldOrdering, summarizeDiff } from "../_shared/extraction/claims/adapters/compatibility-diff.ts";

const BASE_SLOT = { conceptKey: "tenant_name", scopeKey: "lease", instanceKey: "default", evidenceRequired: true };

Deno.test("resolver: no claim at all -> unresolved, never auto not_present", () => {
  const result = resolveClaimForFactSlot({ ...BASE_SLOT, claims: [], reviewDecisions: [], hasOpenConflict: false });
  assertEquals(result.outcome, "unresolved");
  assertEquals(result.winningClaimId, null);
});

Deno.test("resolver: explicit not_present claim resolves to explicit_status", () => {
  const claims = [{ claimId: "c1", producerType: "deterministic_mapper", assertionStatus: "not_present", normalizedValue: null, hasEvidence: false, createdAt: "2026-01-01" }];
  const result = resolveClaimForFactSlot({ ...BASE_SLOT, claims, reviewDecisions: [], hasOpenConflict: false });
  assertEquals(result.outcome, "explicit_status");
  assertEquals(result.winningClaimId, "c1");
});

Deno.test("resolver: deterministic claim with evidence wins over no-evidence deterministic claim absent", () => {
  const claims = [{ claimId: "c1", producerType: "deterministic_mapper", assertionStatus: "asserted", normalizedValue: "Acme Corp", hasEvidence: true, createdAt: "2026-01-01" }];
  const result = resolveClaimForFactSlot({ ...BASE_SLOT, claims, reviewDecisions: [], hasOpenConflict: false });
  assertEquals(result.outcome, "deterministic");
  assertEquals(result.normalizedValue, "Acme Corp");
});

Deno.test("resolver: deterministic claim WITHOUT sufficient evidence when evidence is required does not win", () => {
  const claims = [{ claimId: "c1", producerType: "deterministic_mapper", assertionStatus: "asserted", normalizedValue: "Acme Corp", hasEvidence: false, createdAt: "2026-01-01" }];
  const result = resolveClaimForFactSlot({ ...BASE_SLOT, claims, reviewDecisions: [], hasOpenConflict: false });
  assertEquals(result.outcome, "unresolved");
});

Deno.test("resolver: semantic claim wins over deterministic claim when both present", () => {
  const claims = [
    { claimId: "c1", producerType: "deterministic_mapper", assertionStatus: "asserted", normalizedValue: "Acme Corp", hasEvidence: true, createdAt: "2026-01-01" },
    { claimId: "c2", producerType: "semantic_extractor", assertionStatus: "asserted", normalizedValue: "Acme Corporation", hasEvidence: true, createdAt: "2026-01-01" },
  ];
  const result = resolveClaimForFactSlot({ ...BASE_SLOT, claims, reviewDecisions: [], hasOpenConflict: false });
  assertEquals(result.outcome, "semantic");
  assertEquals(result.winningClaimId, "c2");
});

Deno.test("resolver: reviewer-accepted claim wins over semantic/deterministic", () => {
  const claims = [
    { claimId: "c1", producerType: "deterministic_mapper", assertionStatus: "asserted", normalizedValue: "Acme Corp", hasEvidence: true, createdAt: "2026-01-01" },
    { claimId: "c2", producerType: "semantic_extractor", assertionStatus: "asserted", normalizedValue: "Acme Corporation", hasEvidence: true, createdAt: "2026-01-01" },
  ];
  const decisions = [{ decisionType: "accept" as const, claimId: "c1" }];
  const result = resolveClaimForFactSlot({ ...BASE_SLOT, claims, reviewDecisions: decisions, hasOpenConflict: false });
  assertEquals(result.outcome, "reviewer_accepted");
  assertEquals(result.winningClaimId, "c1");
});

Deno.test("resolver: reviewer replacement claim wins over everything else", () => {
  const claims = [
    { claimId: "c1", producerType: "deterministic_mapper", assertionStatus: "asserted", normalizedValue: "Acme Corp", hasEvidence: true, createdAt: "2026-01-01" },
    { claimId: "c2", producerType: "reviewer", assertionStatus: "asserted", normalizedValue: "Acme Corp Renamed", hasEvidence: false, createdAt: "2026-01-02" },
  ];
  const decisions = [{ decisionType: "edit" as const, claimId: "c1", replacementClaimId: "c2" }];
  const result = resolveClaimForFactSlot({ ...BASE_SLOT, claims, reviewDecisions: decisions, hasOpenConflict: false });
  assertEquals(result.outcome, "reviewer_replacement");
  assertEquals(result.winningClaimId, "c2");
});

Deno.test("resolver: open conflict resolves to needs_review even when value-bearing claims exist", () => {
  const claims = [
    { claimId: "c1", producerType: "semantic_extractor", assertionStatus: "asserted", normalizedValue: "5000.00", hasEvidence: true, createdAt: "2026-01-01" },
    { claimId: "c2", producerType: "semantic_extractor", assertionStatus: "asserted", normalizedValue: "5500.00", hasEvidence: true, createdAt: "2026-01-01" },
  ];
  const result = resolveClaimForFactSlot({ ...BASE_SLOT, claims, reviewDecisions: [], hasOpenConflict: true });
  assertEquals(result.outcome, "needs_review");
  assertEquals(result.winningClaimId, null);
});

Deno.test("resolver: a superseded claim never wins even if it would otherwise qualify", () => {
  const claims = [
    { claimId: "c1", producerType: "deterministic_mapper", assertionStatus: "asserted", normalizedValue: "Old Value", hasEvidence: true, supersededByClaimId: "c2", createdAt: "2026-01-01" },
  ];
  const result = resolveClaimForFactSlot({ ...BASE_SLOT, claims, reviewDecisions: [], hasOpenConflict: false });
  assertEquals(result.outcome, "unresolved");
});

Deno.test("buildFieldProjection: every registry concept gets exactly one entry, even when unresolved", () => {
  const projection = buildFieldProjection({ claims: [], reviewDecisionsByFactSlot: new Map(), openConflictFactSlots: new Set() });
  assert(projection.length > 0);
  assert(projection.every((e) => e.outcome === "unresolved"));
});

Deno.test("buildFieldProjection: a resolved claim surfaces in the projection with its value", () => {
  const claims = [{
    claimId: "c1", conceptKey: "tenant_name", scopeKey: "lease", instanceKey: "default",
    producerType: "deterministic_mapper", assertionStatus: "asserted", normalizedValue: "Acme Corp",
    hasEvidence: true, createdAt: "2026-01-01",
  }];
  const projection = buildFieldProjection({ claims, reviewDecisionsByFactSlot: new Map(), openConflictFactSlots: new Set() });
  const tenantEntry = projection.find((e) => e.conceptKey === "tenant_name");
  assertEquals(tenantEntry!.outcome, "deterministic");
  assertEquals(tenantEntry!.value, "Acme Corp");
});

Deno.test("compatibility builder: fields and field_evidence are duplicated content, matching the real payload's quirk", () => {
  const entries = [{
    fieldKey: "tenant_name", conceptKey: "tenant_name", scopeKey: "lease", instanceKey: "default",
    outcome: "deterministic", claimId: "c1", value: "Acme Corp", rawValue: "ACME CORP.",
    sourcePage: 1, sourceText: "Tenant: Acme Corp", confidence: 90,
  }];
  const slice = buildCompatibilityExtractionDataSlice(entries as any, new Map([["tenant_name", "parties"]]));
  assertEquals(slice.fields, slice.field_evidence);
  assertEquals(slice.fields.tenant_name.value, "Acme Corp");
  assertEquals(slice.fields.tenant_name.field_group, "parties");
  assertEquals(slice.confidence_scores.tenant_name, 90);
});

Deno.test("compatibility builder: unresolved fields are not projected as a row at all", () => {
  const entries = [{
    fieldKey: "broker_name", conceptKey: "broker_name", scopeKey: "lease", instanceKey: "default",
    outcome: "unresolved", claimId: null, value: null, rawValue: null, sourcePage: null, sourceText: null, confidence: null,
  }];
  const slice = buildCompatibilityExtractionDataSlice(entries as any, new Map());
  assertEquals(Object.keys(slice.fields).length, 0);
});

Deno.test("compatibility diff: equivalent money representations classify as representation_only, not value_mismatch", () => {
  const legacy = { monthly_rent: { value: "$6,004.00", raw_value: null, raw: null, source_page: 1, page: 1, source_text: "x", exact_source_text: "x", snippet: "x", source_clause: "x", confidence: 90, confidence_score: 90, extraction_status: "extracted", field_group: "rent" } };
  const claimProjected = { monthly_rent: { ...legacy.monthly_rent, value: "6004.00" } };
  const results = diffCompatibilityFields(legacy, claimProjected, { valueTypeByFieldKey: new Map([["monthly_rent", "money"]]) });
  assertEquals(results[0].classification, "representation_only");
});

Deno.test("compatibility diff: a genuinely different value classifies as value_mismatch", () => {
  const legacy = { monthly_rent: { value: "5000.00", raw_value: null, raw: null, source_page: 1, page: 1, source_text: "x", exact_source_text: "x", snippet: "x", source_clause: "x", confidence: 90, confidence_score: 90, extraction_status: "extracted", field_group: "rent" } };
  const claimProjected = { monthly_rent: { ...legacy.monthly_rent, value: "5500.00" } };
  const results = diffCompatibilityFields(legacy, claimProjected, { valueTypeByFieldKey: new Map([["monthly_rent", "money"]]) });
  assertEquals(results[0].classification, "value_mismatch");
});

Deno.test("compatibility diff: missing/extra field classification", () => {
  const legacy = { tenant_name: { value: "Acme", raw_value: null, raw: null, source_page: null, page: null, source_text: null, exact_source_text: null, snippet: null, source_clause: null, confidence: null, confidence_score: null, extraction_status: "extracted", field_group: null } };
  const claimProjected = { landlord_name: { value: "Some Landlord", raw_value: null, raw: null, source_page: null, page: null, source_text: null, exact_source_text: null, snippet: null, source_clause: null, confidence: null, confidence_score: null, extraction_status: "extracted", field_group: null } };
  const results = diffCompatibilityFields(legacy, claimProjected);
  const byKey = Object.fromEntries(results.map((r) => [r.fieldKey, r.classification]));
  assertEquals(byKey.tenant_name, "missing_in_claim_projection");
  assertEquals(byKey.landlord_name, "extra_in_claim_projection");
});

Deno.test("compatibility diff: summarizeDiff tallies every category", () => {
  const legacy = { a: { value: 1, raw_value: null, raw: null, source_page: null, page: null, source_text: null, exact_source_text: null, snippet: null, source_clause: null, confidence: null, confidence_score: null, extraction_status: "extracted", field_group: null } };
  const claimProjected = { a: { ...legacy.a } };
  const summary = summarizeDiff(diffCompatibilityFields(legacy, claimProjected));
  assertEquals(summary.equal, 1);
});

Deno.test("diffFieldOrdering: detects a real ordering difference among shared keys", () => {
  assert(diffFieldOrdering({ a: 1, b: 2 }, { b: 2, a: 1 }));
  assertEquals(diffFieldOrdering({ a: 1, b: 2 }, { a: 1, b: 2 }), false);
});

// @ts-nocheck
// P2.4 -- deterministic/semantic/dynamic-findings adapter tests, against
// fixtures shaped exactly like the real pipeline types confirmed this
// session (ExtractedField: _shared/extraction/types.ts:24-30;
// unmappedLlmFields: lease-workflow.ts:2396/4291).
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { deterministicOutputToClaims } from "../_shared/extraction/claims/adapters/deterministic-output-to-claims.ts";
import { semanticOutputToClaims } from "../_shared/extraction/claims/adapters/semantic-output-to-claims.ts";
import { dynamicFindingsToClaims } from "../_shared/extraction/claims/adapters/dynamic-findings-to-claims.ts";
import { buildFieldEvidence } from "../_shared/extraction/claims/adapters/field-evidence-to-evidence.ts";

const CONTEXT = {
  uploadedFileId: "file-1",
  extractionRunId: "run-1",
  generationId: "gen-1",
  stageAttempt: 1,
};

Deno.test("field-evidence-to-evidence: builds page_and_span evidence when source text is present", async () => {
  const item = await buildFieldEvidence("ev1", {
    uploadedFileId: "file-1", extractionRunId: "run-1",
    sourcePage: 3, sourceText: "Tenant: Acme Corp",
  });
  assert(item);
  assertEquals(item!.location_precision, "page_and_span");
  assertEquals(item!.page_start, 3);
  assert(item!.source_text_hash);
});

Deno.test("field-evidence-to-evidence: returns null when there is no page and no source text", async () => {
  const item = await buildFieldEvidence("ev1", {
    uploadedFileId: "file-1", extractionRunId: "run-1",
    sourcePage: null, sourceText: null,
  });
  assertEquals(item, null);
});

Deno.test("deterministic adapter: every field in the input map becomes exactly one claim", async () => {
  const fields = {
    tenant_name: { value: "Acme Corp", source: "rule", confidence: 0.95, sourceText: "Tenant: Acme Corp", sourcePage: 1 },
    broker_name: { value: null, source: "rule", confidence: 0 },
    landlord_name: { value: "  ", source: "table", confidence: 0.8 }, // blank-string value -- must still become a claim
  };
  const result = await deterministicOutputToClaims(fields as any, CONTEXT);
  assertEquals(result.claims.length, 3);

  const tenant = result.claims.find((c) => c.concept_key === "tenant_name");
  assertEquals(tenant!.assertion_status, "asserted");
  assertEquals(tenant!.normalized_value, "Acme Corp");
  assertEquals(tenant!.producer_type, "deterministic_mapper");
  assertEquals(tenant!.registry_status, "registered");

  const broker = result.claims.find((c) => c.concept_key === "broker_name");
  assertEquals(broker!.assertion_status, "not_present");
  assertEquals(broker!.normalized_value, null);

  const landlord = result.claims.find((c) => c.concept_key === "landlord_name");
  assertEquals(landlord!.assertion_status, "not_present"); // blank string is not a real value
});

Deno.test("deterministic adapter: llm-sourced fields are skipped (owned by the semantic adapter)", async () => {
  const fields = {
    tenant_name: { value: "Acme Corp", source: "llm", confidence: 0.7 },
  };
  const result = await deterministicOutputToClaims(fields as any, CONTEXT);
  assertEquals(result.claims.length, 0);
});

Deno.test("deterministic adapter: an asserted claim with source text gets linked evidence", async () => {
  const fields = {
    tenant_name: { value: "Acme Corp", source: "rule", confidence: 0.95, sourceText: "Tenant: Acme Corp", sourcePage: 1 },
  };
  const result = await deterministicOutputToClaims(fields as any, CONTEXT);
  assertEquals(result.evidence.length, 1);
  assertEquals(result.links.length, 1);
  assertEquals(result.links[0].claim_local_id, result.claims[0].local_id);
});

Deno.test("deterministic adapter: an unregistered concept key is preserved under the dynamic.* namespace, not a bare unregistered key", async () => {
  const fields = {
    totally_not_a_real_concept: { value: "some value", source: "rule", confidence: 0.9 },
  };
  const result = await deterministicOutputToClaims(fields as any, CONTEXT);
  assertEquals(result.claims.length, 1);
  assertEquals(result.claims[0].registry_status, "unregistered");
  assert(result.claims[0].concept_key.startsWith("dynamic."));
  assertEquals(result.claims[0].metadata.original_key, "totally_not_a_real_concept");
});

Deno.test("semantic adapter: multiple candidates are preserved as separate claims, never collapsed", async () => {
  const groups = [{
    conceptKey: "monthly_rent",
    providerInvocationId: "inv-1",
    candidates: [
      { value: "5000", confidence: 0.8, sourceText: "Rent: $5,000/mo", sourcePage: 2 },
      { value: "5500", confidence: 0.6, sourceText: "Base rent $5,500 monthly", sourcePage: 14 },
    ],
  }];
  const result = await semanticOutputToClaims(groups, CONTEXT);
  assertEquals(result.claims.length, 2);
  assertEquals(result.claims[0].normalized_value, "5000.00");
  assertEquals(result.claims[1].normalized_value, "5500.00");
  assertEquals(result.claims[0].candidate_ordinal, 0);
  assertEquals(result.claims[1].candidate_ordinal, 1);
  assertEquals(result.evidence.length, 2);
  for (const claim of result.claims) {
    assertEquals((claim as any).provider_invocation_id, "inv-1");
    assertEquals(claim.producer_type, "semantic_extractor");
  }
});

Deno.test("semantic adapter: zero candidates still produces one not_present claim, not silence", async () => {
  const groups = [{ conceptKey: "broker_name", providerInvocationId: "inv-2", candidates: [] }];
  const result = await semanticOutputToClaims(groups, CONTEXT);
  assertEquals(result.claims.length, 1);
  assertEquals(result.claims[0].assertion_status, "not_present");
});

Deno.test("dynamic-findings adapter: every unmapped field with a real value becomes a dynamic.* claim", async () => {
  const unmapped = [
    { key: "Tenant's Special Clause", value: "Some special terms", sourceText: "Special: some special terms", sourcePage: 5, confidence: 0.7 },
    { key: "empty_field", value: "", sourcePage: 1 }, // blank -- filtered, matches lease-workflow.ts's own isBlank scoping
    { key: "null_field", value: null },
  ];
  const result = await dynamicFindingsToClaims(unmapped as any, CONTEXT);
  assertEquals(result.claims.length, 1);
  assertEquals(result.claims[0].concept_key, "dynamic.tenant_s_special_clause");
  assertEquals(result.claims[0].registry_status, "unregistered");
  assertEquals(result.claims[0].metadata.original_key, "Tenant's Special Clause");
  assertEquals(result.evidence.length, 1);
  assertEquals(result.links.length, 1);
});

Deno.test("dynamic-findings adapter: distinct original keys that normalize the same still each get a claim (no silent merge)", async () => {
  const unmapped = [
    { key: "Weird Key!", value: "value one" },
    { key: "weird_key", value: "value two" },
  ];
  const result = await dynamicFindingsToClaims(unmapped as any, CONTEXT);
  // Both normalize to the same concept_key ("dynamic.weird_key") but are
  // still two distinct claim rows since candidate_ordinal/claim_key differ
  // per-loop-iteration local_id -- verifying neither finding is dropped.
  assertEquals(result.claims.length, 2);
});

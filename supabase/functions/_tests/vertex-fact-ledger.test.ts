// @ts-nocheck
// Phase 5A unit tests for the BUSINESS_EXTRACTION_PROVIDER=vertex_fact_ledger
// modules (supabase/functions/_shared/extraction/vertex-fact-ledger/).
// Run: deno test --allow-env --allow-read --allow-net --no-lock vertex-fact-ledger.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { mapFactsToStandardFields } from "../_shared/extraction/vertex-fact-ledger/fact-field-mapper.ts";
import { computeProfileApprovalBlockers } from "../_shared/extraction/vertex-fact-ledger/approval-blockers.ts";
import { runVertexFactLedgerPipeline } from "../_shared/extraction/vertex-fact-ledger/orchestrator.ts";
import type { Fact } from "../_shared/extraction/vertex-fact-ledger/types.ts";

function makeFact(overrides: Partial<Fact>): Fact {
  return {
    category: "clause:default",
    value: "test value",
    sourceText: "Some source text",
    sourcePage: 1,
    confidence: 0.8,
    ...overrides,
  };
}

// ── fact-field-mapper.ts ──────────────────────────────────────────────────────

Deno.test("mapFactsToStandardFields: a fact with a strong LEASE_SCHEMA label match maps to the right field", () => {
  const facts: Fact[] = [
    makeFact({
      category: "clause:rent_escalation",
      value: 5000,
      sourceText: "The Base Rent shall be $5,000.00 payable monthly.",
      sourcePage: 3,
      confidence: 0.9,
    }),
  ];
  const result = mapFactsToStandardFields({ facts, moduleType: "lease" });
  assertEquals(result.unmappedFacts.length, 0);
  assertEquals(result.records.length, 1);
  const monthlyRent = result.records[0].fields.monthly_rent;
  assert(monthlyRent, "monthly_rent should be mapped");
  assertEquals(monthlyRent.value, 5000);
  assertEquals(monthlyRent.source, "llm");
  assertEquals(monthlyRent.sourcePage, 3);
});

Deno.test("mapFactsToStandardFields: a fact with no real label match is returned in unmappedFacts", () => {
  const facts: Fact[] = [
    makeFact({
      category: "clause:governing_law",
      value: "State of Delaware",
      sourceText: "This Lease shall be governed by the laws of the State of Delaware.",
      confidence: 0.7,
    }),
  ];
  const result = mapFactsToStandardFields({ facts, moduleType: "lease" });
  assertEquals(result.unmappedFacts.length, 1);
  assertEquals(result.unmappedFacts[0].value, "State of Delaware");
  const mappedFieldCount = Object.keys(result.records[0].fields).length;
  assertEquals(mappedFieldCount, 0);
});

Deno.test("mapFactsToStandardFields: two facts competing for the same field resolve to the stronger label match", () => {
  const facts: Fact[] = [
    makeFact({
      category: "clause:rent_escalation",
      value: 4000,
      sourceText: "Base Rent: $4,000",
      confidence: 0.6,
    }),
    makeFact({
      category: "clause:rent_escalation",
      value: 4500,
      // "monthly rent" is a longer/more specific label match than "base rent",
      // so this fact should win even though its confidence is lower.
      sourceText: "Monthly Rent: $4,500",
      confidence: 0.5,
    }),
  ];
  const result = mapFactsToStandardFields({ facts, moduleType: "lease" });
  assertEquals(result.records[0].fields.monthly_rent.value, 4500);
});

Deno.test("mapFactsToStandardFields: an invalid value is rejected by the reused validateRecords()", () => {
  const facts: Fact[] = [
    makeFact({
      category: "clause:rent_escalation",
      value: "not-a-date",
      sourceText: "Start Date: not-a-date",
      confidence: 0.8,
    }),
  ];
  const result = mapFactsToStandardFields({ facts, moduleType: "lease" });
  assertEquals(result.records[0].fields.start_date.value, null);
  assert(result.validationErrors.length > 0, "an invalid date must produce a validation error, exactly like legacy_hybrid would reject it");
});

// ── approval-blockers.ts ──────────────────────────────────────────────────────

function fieldsOf(values: Record<string, unknown>) {
  const fields: Record<string, { value: unknown }> = {};
  for (const [key, value] of Object.entries(values)) fields[key] = { value };
  return { fields };
}

Deno.test("computeProfileApprovalBlockers: full_lease with all required fields present has zero blockers", () => {
  const standardFields = fieldsOf({
    tenant_name: "Acme Inc",
    landlord_name: "Landlord LLC",
    property_address: "123 Main St",
    start_date: "2025-01-01",
    end_date: "2030-01-01",
    monthly_rent: 5000,
  });
  const result = computeProfileApprovalBlockers({ profile: "full_lease", standardFields });
  assertEquals(result.blockers.length, 0);
});

Deno.test("computeProfileApprovalBlockers: full_lease missing tenant_name produces a blocker for it", () => {
  const standardFields = fieldsOf({
    tenant_name: null,
    landlord_name: "Landlord LLC",
    property_address: "123 Main St",
    start_date: "2025-01-01",
    end_date: "2030-01-01",
    monthly_rent: 5000,
  });
  const result = computeProfileApprovalBlockers({ profile: "full_lease", standardFields });
  assert(result.blockers.some((b) => b.fieldKey === "tenant_name"), "must flag missing tenant_name");
});

Deno.test("computeProfileApprovalBlockers: assignment uses the assignment rule set, not the full-lease one", () => {
  const standardFields = fieldsOf({
    assignor_name: "Old Tenant LLC",
    assignee_name: "New Tenant LLC",
    assignment_effective_date: "2025-06-01",
    landlord_consent: true,
    // Deliberately no tenant_name/property_address/dates — full_lease rules
    // would blocker on these, assignment rules should not.
  });
  const result = computeProfileApprovalBlockers({ profile: "assignment", standardFields });
  assertEquals(result.blockers.length, 0, "assignment rules are satisfied; full_lease-only fields must not leak in");
});

Deno.test("computeProfileApprovalBlockers: assignment_amendment gets the union of both rule sets", () => {
  const result = computeProfileApprovalBlockers({ profile: "assignment_amendment", standardFields: fieldsOf({}) });
  const fieldKeys = new Set(result.blockers.map((b) => b.fieldKey));
  // From the assignment rule set:
  assert(fieldKeys.has("assignor_name"));
  assert(fieldKeys.has("assignee_name"));
  // From the amendment rule set:
  assert(fieldKeys.has("all_other_terms_remain_same"));
});

Deno.test("computeProfileApprovalBlockers: abstract/addendum/exhibit fall back to the minimal 3-field floor", () => {
  for (const profile of ["abstract", "addendum", "exhibit"] as const) {
    const result = computeProfileApprovalBlockers({ profile, standardFields: fieldsOf({}) });
    assertEquals(result.blockers.length, 3, `${profile} should use the minimal 3-field floor`);
  }
});

// ── orchestrator.ts: return-shape contract ────────────────────────────────────

const SAMPLE_LEASE_TEXT = `
LEASE AGREEMENT

This Lease is entered into by and between 224 Partners, LLC ("Landlord") and
Mindful Tech Solutions, Inc. ("Tenant").

1. Premises: 2,500 rentable square feet located at 123 Main St, Suite 100.
2. Commencement Date: January 1, 2025.
3. Base Rent: $5,000 per month.
`.repeat(3);

function sampleDocling() {
  return {
    full_text: SAMPLE_LEASE_TEXT,
    text_blocks: SAMPLE_LEASE_TEXT.split("\n\n").filter(Boolean).map((t, i) => ({
      block_index: i,
      type: "paragraph",
      text: t,
      page: 1,
    })),
    tables: [],
    fields: [],
    page_count: 1,
    extraction_method: "test_fixture",
  };
}

function assertIsExtractionPipelineResultShape(result: any) {
  assert(result && typeof result === "object");
  assert(Array.isArray(result.rows), "rows must be an array");
  assert(typeof result.method === "string", "method must be a string");
  assert(Array.isArray(result.warnings), "warnings must be an array");
  assert(Array.isArray(result.validationErrors), "validationErrors must be an array");
  assert(result.metadata && typeof result.metadata === "object", "metadata must be an object");
  assert(typeof result.metadata.ruleFieldsExtracted === "number");
  assert(typeof result.metadata.tableFieldsExtracted === "number");
  assert(typeof result.metadata.llmFieldsExtracted === "number");
  assert(typeof result.metadata.totalRecords === "number");
  assert(typeof result.metadata.avgConfidence === "number");
  assert(typeof result.metadata.chunksProcessed === "number");
  assert(typeof result.metadata.processingTimeMs === "number");
}

Deno.test("runVertexFactLedgerPipeline: no Vertex credentials configured — degrades cleanly, never throws/hangs", async () => {
  Deno.env.delete("VERTEX_PROJECT_ID");
  Deno.env.delete("GOOGLE_PROJECT_ID");
  Deno.env.delete("GOOGLE_SERVICE_ACCOUNT_KEY");
  Deno.env.delete("GOOGLE_CLIENT_EMAIL");
  Deno.env.delete("GOOGLE_PRIVATE_KEY");

  const result = await runVertexFactLedgerPipeline({
    moduleType: "lease",
    fileName: "no-credentials.txt",
    docling: sampleDocling(),
    documentSubtype: null,
  });

  assertIsExtractionPipelineResultShape(result);
  assertEquals(result.method, "fallback", "a run that extracted zero facts must not misreport itself as a successful llm_only run");
  assert(result.warnings.length > 0, "should carry a warning explaining why nothing was extracted");
});

Deno.test("runVertexFactLedgerPipeline: mocked successful Vertex call — return-shape contract and field mapping", async () => {
  // Generate a throwaway RSA keypair so the real signJWT() code path in
  // vertex-ai.ts runs against a fake-but-structurally-valid service account,
  // instead of skipping JWT signing entirely.
  const keyPair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8)));
  const pem = `-----BEGIN PRIVATE KEY-----\n${(b64.match(/.{1,64}/g) ?? [b64]).join("\n")}\n-----END PRIVATE KEY-----`;

  Deno.env.set("VERTEX_PROJECT_ID", "test-project");
  Deno.env.set("GOOGLE_CLIENT_EMAIL", "test@test-project.iam.gserviceaccount.com");
  Deno.env.set("GOOGLE_PRIVATE_KEY", pem);

  const realFetch = globalThis.fetch;
  let generateContentCallCount = 0;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = input.toString();
    if (url.includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "fake-access-token", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("aiplatform.googleapis.com") && url.includes("generateContent")) {
      generateContentCallCount++;
      // Call #1 is the profile classifier; every call after that is fact
      // extraction (this short sample text is a single chunk).
      const isProfileCall = generateContentCallCount === 1;
      const responseText = isProfileCall
        ? JSON.stringify({ document_profile: "full_lease", confidence: 0.9, reasoning: "test fixture" })
        : JSON.stringify([
          { category: "clause:rent_escalation", value: 5000, source_text: "Base Rent: $5,000 per month.", source_page: 2, confidence: 0.9 },
          { category: "clause:governing_law", value: "Delaware", source_text: "Governed by the laws of the State of Delaware.", source_page: 5, confidence: 0.8 },
        ]);
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: responseText }] } }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return realFetch(input, init);
  }) as typeof fetch;

  try {
    const result = await runVertexFactLedgerPipeline({
      moduleType: "lease",
      fileName: "mocked-success.txt",
      docling: sampleDocling(),
      documentSubtype: null,
    });

    assertIsExtractionPipelineResultShape(result);
    assertEquals(result.method, "llm_only");

    const debug = (result.metadata as any).extractionDebug;
    assert(debug, "extractionDebug must be present");

    // merged_field_sources must be in the same {value, source, confidence,
    // source_text, source_page} shape pipeline.ts's snapshotFieldMap() produces.
    const monthlyRent = debug.merged_field_sources?.monthly_rent;
    assert(monthlyRent, "monthly_rent must appear in merged_field_sources");
    assertEquals(monthlyRent.value, 5000);
    assertEquals(monthlyRent.source, "llm");
    assertEquals(monthlyRent.source_page, 2);
    assert(typeof monthlyRent.confidence === "number");
    assert(typeof monthlyRent.source_text === "string" && monthlyRent.source_text.length > 0);

    // validated_field_values present in the same shape.
    assert(debug.validated_field_values?.monthly_rent, "validated_field_values must also be populated");

    // Provider-specific diagnostics.
    const vfl = debug.vertex_fact_ledger;
    assert(vfl, "metadata.extractionDebug.vertex_fact_ledger must be present");
    assertEquals(vfl.document_profile, "full_lease");
    assertEquals(vfl.document_profile_method, "vertex");
    assert(Array.isArray(vfl.dynamic_items));
    assert(
      vfl.dynamic_items.some((item: any) => String(item.source_text || "").includes("Delaware")),
      "the unmapped Delaware fact must be preserved as a dynamic item, not discarded",
    );
    assert(Array.isArray(vfl.approval_blockers));
  } finally {
    globalThis.fetch = realFetch;
    Deno.env.delete("VERTEX_PROJECT_ID");
    Deno.env.delete("GOOGLE_CLIENT_EMAIL");
    Deno.env.delete("GOOGLE_PRIVATE_KEY");
  }
});

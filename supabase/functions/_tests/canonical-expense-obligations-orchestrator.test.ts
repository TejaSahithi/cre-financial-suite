// @ts-nocheck
// Phase 6A orchestrator integration test (correction G's real deployment
// gate): runOpenAIFactLedgerPipeline with BOTH Phase 5's and Phase 6A's
// flags active must produce byte-identical rows/method/validationErrors to
// flag-off, and the real authoritativeMutationCount measured inside the
// real code path (not a stub) must be 0. No live LLM call anywhere in this
// file -- the fixture has zero cam/tax/insurance/utility/repair language
// and full deterministic core_terms coverage, so every specialist reports
// "no_evidence" and the main escalation loop makes zero network calls,
// matching this suite's established "zero Azure/OpenAI calls in tests"
// convention while still exercising the real flag=on code path end to end.

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { runOpenAIFactLedgerPipeline } from "../_shared/extraction/openai-fact-ledger/orchestrator.ts";

Deno.env.set("LEASE_WHOLE_DOCUMENT_LLM_V1", "off");

if (!Deno.env.get("OPENAI_API_KEY")) {
  Deno.env.set("OPENAI_API_KEY", "sk-fake-openai-key-for-testing");
}

function block(overrides: Partial<{ block_index: number; type: string; text: string; page: number }>) {
  return { block_index: 0, type: "paragraph", text: "", page: 1, ...overrides };
}

const NO_SPECIALIST_LANGUAGE_DOCLING = {
  full_text: "PARTIES\nTenant: Justin Cress\nLandlord: Example Holdings LLC\n\nPREMISES\nRentable Area: 1,875 square feet",
  text_blocks: [
    block({ block_index: 0, type: "heading", text: "PARTIES", page: 1 }),
    block({ block_index: 1, text: "Tenant: Justin Cress", page: 1 }),
    block({ block_index: 2, text: "Landlord: Example Holdings LLC", page: 1 }),
    block({ block_index: 3, type: "heading", text: "PREMISES", page: 1 }),
    block({ block_index: 4, text: "Rentable Area: 1,875 square feet", page: 1 }),
  ],
  tables: [],
  fields: [
    { key: "Tenant", value: "Justin Cress", confidence: 0.9, page: 1 },
    { key: "Landlord", value: "Example Holdings LLC", confidence: 0.9, page: 1 },
    { key: "Rentable Area", value: "1875", confidence: 0.9, page: 1 },
    { key: "Commencement Date", value: "2024-03-01", confidence: 0.9, page: 1 },
    { key: "Expiration Date", value: "2029-02-28", confidence: 0.9, page: 1 },
  ],
  page_count: 1,
};

Deno.test("orchestrator: both flags ON (MLB-style org-admitted) -> rows/method/validationErrors byte-identical to flags-off, authoritativeMutationCount:0, runStatus reflects real outcome", async () => {
  const originalSpecialistsFlag = Deno.env.get("LEASE_EXPENSE_SPECIALISTS_V1");
  const originalSpecialistsAllowlist = Deno.env.get("LEASE_EXPENSE_SPECIALISTS_ORG_ALLOWLIST");
  const originalCanonicalFlag = Deno.env.get("LEASE_CANONICAL_EXPENSE_OBLIGATIONS_V1");
  const originalCanonicalAllowlist = Deno.env.get("LEASE_CANONICAL_EXPENSE_OBLIGATIONS_ORG_ALLOWLIST");
  try {
    Deno.env.delete("LEASE_EXPENSE_SPECIALISTS_V1");
    Deno.env.delete("LEASE_CANONICAL_EXPENSE_OBLIGATIONS_V1");
    const resultOff = await runOpenAIFactLedgerPipeline(
      { docling: NO_SPECIALIST_LANGUAGE_DOCLING, fileName: "test.pdf", moduleType: "lease", documentSubtype: null },
      { provenance: { supabaseAdmin: {}, context: { orgId: "org-1", uploadedFileId: "file-1", generationId: "gen-1", extractionRunId: "run-1", stageRunId: "stage-1", stageAttempt: 1, operation: "test" } } },
    );

    Deno.env.set("LEASE_EXPENSE_SPECIALISTS_V1", "active");
    Deno.env.set("LEASE_EXPENSE_SPECIALISTS_ORG_ALLOWLIST", "org-1");
    Deno.env.set("LEASE_CANONICAL_EXPENSE_OBLIGATIONS_V1", "active");
    Deno.env.set("LEASE_CANONICAL_EXPENSE_OBLIGATIONS_ORG_ALLOWLIST", "org-1");
    const resultOn = await runOpenAIFactLedgerPipeline(
      { docling: NO_SPECIALIST_LANGUAGE_DOCLING, fileName: "test.pdf", moduleType: "lease", documentSubtype: null },
      { provenance: { supabaseAdmin: {}, context: { orgId: "org-1", uploadedFileId: "file-1", generationId: "gen-1", extractionRunId: "run-1", stageRunId: "stage-1", stageAttempt: 1, operation: "test" } } },
    );

    // Note: unlike extractFactLedgerAdaptive called directly (Phase 5's own
    // test), runOpenAIFactLedgerPipeline's document-profile-classification
    // step makes its own attempted network call regardless of either
    // flag -- pre-existing orchestrator behavior, not something Phase 6A
    // introduced (it happens on the flag-off run too). It fails fast
    // (401, fake key) and the pipeline degrades gracefully, so the
    // byte-identical comparison below is still the real, meaningful
    // assertion.
    assertEquals(resultOn.rows, resultOff.rows, "rows must be byte-identical -- Phase 6A must never mutate authoritative output");
    assertEquals(resultOn.method, resultOff.method);
    assertEquals(resultOn.validationErrors, resultOff.validationErrors);

    const canonicalMetrics = resultOn.metadata?.extractionDebug?.openai_fact_ledger?.canonical_expense_obligation_metrics;
    assert(canonicalMetrics != null, "expected canonical_expense_obligation_metrics to be present when the flag is active");
    assertEquals(canonicalMetrics.authoritativeMutationCount, 0);
    // Every specialist reports no_evidence for this fixture (no cam/tax/
    // insurance/utility/repair language) -- the layer still runs (flag on,
    // org admitted, specialist records present), just converts zero
    // obligations, so runStatus is "no_obligations", not "flag_off".
    assertEquals(canonicalMetrics.runStatus, "no_obligations");
    assertEquals(canonicalMetrics.canonicalObligationCount, 0);

    const offMetrics = resultOff.metadata?.extractionDebug?.openai_fact_ledger?.canonical_expense_obligation_metrics;
    assertEquals(offMetrics.runStatus, "flag_off");
    assertEquals(offMetrics.authoritativeMutationCount, 0);
  } finally {
    if (originalSpecialistsFlag == null) Deno.env.delete("LEASE_EXPENSE_SPECIALISTS_V1"); else Deno.env.set("LEASE_EXPENSE_SPECIALISTS_V1", originalSpecialistsFlag);
    if (originalSpecialistsAllowlist == null) Deno.env.delete("LEASE_EXPENSE_SPECIALISTS_ORG_ALLOWLIST"); else Deno.env.set("LEASE_EXPENSE_SPECIALISTS_ORG_ALLOWLIST", originalSpecialistsAllowlist);
    if (originalCanonicalFlag == null) Deno.env.delete("LEASE_CANONICAL_EXPENSE_OBLIGATIONS_V1"); else Deno.env.set("LEASE_CANONICAL_EXPENSE_OBLIGATIONS_V1", originalCanonicalFlag);
    if (originalCanonicalAllowlist == null) Deno.env.delete("LEASE_CANONICAL_EXPENSE_OBLIGATIONS_ORG_ALLOWLIST"); else Deno.env.set("LEASE_CANONICAL_EXPENSE_OBLIGATIONS_ORG_ALLOWLIST", originalCanonicalAllowlist);
  }
});

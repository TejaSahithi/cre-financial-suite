// @ts-nocheck
// Phase 5 expense-specialist shadow orchestration tests
// (expense-specialist-shadow.ts, expense-specialists-mode.ts, and the
// adaptive-extractor.ts hook). No live LLM calls anywhere in this file --
// every scenario is crafted to short-circuit at "no evidence" or an
// exception BEFORE reaching callLLMStructuredWithProvenance, matching this
// suite's established "zero Azure/OpenAI calls in tests" convention.

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  runExpenseSpecialistShadowOutput,
  runAllExpenseSpecialistShadowOutputs,
  buildSpecialistEvidenceText,
} from "../_shared/extraction/openai-fact-ledger/expense-specialist-shadow.ts";
import {
  getLeaseExpenseSpecialistsMode,
  isLeaseExpenseSpecialistsActive,
  shouldRunLeaseExpenseSpecialists,
} from "../_shared/extraction/openai-fact-ledger/expense-specialists-mode.ts";
import { getExpenseSpecialistDefinitionsInOrder, getDomainDefinition } from "../_shared/extraction/domains/domain-registry.ts";
import { routeSectionsWithSpecialists } from "../_shared/extraction/section-router.ts";
import { extractFactLedgerAdaptive } from "../_shared/extraction/openai-fact-ledger/adaptive-extractor.ts";
import { resolveDocumentIndex } from "../_shared/extraction/openai-fact-ledger/document-index-v3.ts";

if (!Deno.env.get("OPENAI_API_KEY")) {
  Deno.env.set("OPENAI_API_KEY", "sk-fake-openai-key-for-testing");
}

function block(overrides: Partial<{ block_index: number; type: string; text: string; page: number }>) {
  return { block_index: 0, type: "paragraph", text: "", page: 1, ...overrides };
}

const EMPTY_SPECIALIST_ROUTING = { blocks: [], bySpecialistDomain: {} };

// ── expense-specialists-mode.ts ──────────────────────────────────────────────

Deno.test("expense-specialists-mode: defaults to off, invalid values resolve to off, never throws", () => {
  const originalValue = Deno.env.get("LEASE_EXPENSE_SPECIALISTS_V1");
  try {
    Deno.env.delete("LEASE_EXPENSE_SPECIALISTS_V1");
    assertEquals(getLeaseExpenseSpecialistsMode(), "off");
    assertEquals(isLeaseExpenseSpecialistsActive(), false);
    Deno.env.set("LEASE_EXPENSE_SPECIALISTS_V1", "bogus-value");
    assertEquals(getLeaseExpenseSpecialistsMode(), "off");
    Deno.env.set("LEASE_EXPENSE_SPECIALISTS_V1", "active");
    assertEquals(getLeaseExpenseSpecialistsMode(), "active");
    assertEquals(isLeaseExpenseSpecialistsActive(), true);
  } finally {
    if (originalValue == null) Deno.env.delete("LEASE_EXPENSE_SPECIALISTS_V1");
    else Deno.env.set("LEASE_EXPENSE_SPECIALISTS_V1", originalValue);
  }
});

Deno.test("shouldRunLeaseExpenseSpecialists: false when flag active but org not in allowlist/sample rate", () => {
  const originalFlag = Deno.env.get("LEASE_EXPENSE_SPECIALISTS_V1");
  const originalAllowlist = Deno.env.get("LEASE_EXPENSE_SPECIALISTS_ORG_ALLOWLIST");
  try {
    Deno.env.set("LEASE_EXPENSE_SPECIALISTS_V1", "active");
    Deno.env.delete("LEASE_EXPENSE_SPECIALISTS_ORG_ALLOWLIST");
    assertEquals(shouldRunLeaseExpenseSpecialists({ orgId: "some-org", generationId: "gen-1" }), false);
    Deno.env.set("LEASE_EXPENSE_SPECIALISTS_ORG_ALLOWLIST", "some-org");
    assertEquals(shouldRunLeaseExpenseSpecialists({ orgId: "some-org", generationId: "gen-1" }), true);
  } finally {
    if (originalFlag == null) Deno.env.delete("LEASE_EXPENSE_SPECIALISTS_V1"); else Deno.env.set("LEASE_EXPENSE_SPECIALISTS_V1", originalFlag);
    if (originalAllowlist == null) Deno.env.delete("LEASE_EXPENSE_SPECIALISTS_ORG_ALLOWLIST"); else Deno.env.set("LEASE_EXPENSE_SPECIALISTS_ORG_ALLOWLIST", originalAllowlist);
  }
});

// ── buildSpecialistEvidenceText ──────────────────────────────────────────────

Deno.test("buildSpecialistEvidenceText: empty string when the domain has no routed blocks", () => {
  const text = buildSpecialistEvidenceText("insurance", EMPTY_SPECIALIST_ROUTING as any, 24_000);
  assertEquals(text, "");
});

Deno.test("buildSpecialistEvidenceText: truncates to maxChars", () => {
  const longText = "insurance ".repeat(500);
  const docling = { text_blocks: [block({ text: longText })] };
  const routing = routeSectionsWithSpecialists(docling as any);
  const text = buildSpecialistEvidenceText("insurance", routing, 50);
  assert(text.length <= 50, `expected <= 50 chars, got ${text.length}`);
});

// ── runExpenseSpecialistShadowOutput: correction C -- never throws, never null ─

Deno.test("runExpenseSpecialistShadowOutput: no evidence -> a real record with technicalStatus 'no_evidence', not null", async () => {
  const definition = getDomainDefinition("insurance" as any);
  const record = await runExpenseSpecialistShadowOutput({
    definition, specialistRouting: EMPTY_SPECIALIST_ROUTING as any, moduleType: "lease",
    provenance: { supabaseAdmin: {}, context: { orgId: "org-1", uploadedFileId: "f1", generationId: "gen-1", extractionRunId: "r1", stageRunId: "s1", stageAttempt: 1, operation: "test" } },
  });
  assert(record != null, "must never return null");
  assertEquals(record.domain, "insurance");
  assertEquals(record.technicalStatus, "no_evidence");
  assertEquals(record.obligations, []);
});

Deno.test("runExpenseSpecialistShadowOutput: an unrecognized specialist id (schema lookup throws) is caught -> technicalStatus 'exception', never propagates", async () => {
  // A definition with routed evidence (so we reach the schema lookup) but an
  // id the schema dispatcher doesn't recognize -- forces the exact
  // "outer try/catch" path correction C requires.
  const brokenDefinition = { ...getDomainDefinition("insurance" as any), id: "not_a_real_specialist" };
  const docling = { text_blocks: [block({ text: "Tenant shall maintain a Commercial General Liability insurance policy." })] };
  const routing = routeSectionsWithSpecialists(docling as any);
  // Manually route a block under the broken id so buildSpecialistEvidenceText finds evidence.
  const brokenRouting = { blocks: routing.blocks, bySpecialistDomain: { not_a_real_specialist: routing.blocks } };
  const record = await runExpenseSpecialistShadowOutput({
    definition: brokenDefinition, specialistRouting: brokenRouting as any, moduleType: "lease",
    provenance: { supabaseAdmin: {}, context: { orgId: "org-1", uploadedFileId: "f1", generationId: "gen-1", extractionRunId: "r1", stageRunId: "s1", stageAttempt: 1, operation: "test" } },
  });
  assert(record != null, "must never return null, even on an internal exception");
  assertEquals(record.technicalStatus, "exception");
  assertEquals(record.obligations, []);
  assert(record.errorMessage, "an exception record should carry a real error message");
});

Deno.test("runExpenseSpecialistShadowOutput: two independent calls (one no_evidence, one exception) don't affect each other's result", async () => {
  const goodDefinition = getDomainDefinition("taxes" as any);
  const brokenDefinition = { ...getDomainDefinition("insurance" as any), id: "not_a_real_specialist" };
  const docling = { text_blocks: [block({ text: "Tenant shall maintain a Commercial General Liability insurance policy." })] };
  const routing = routeSectionsWithSpecialists(docling as any);
  const brokenRouting = { blocks: routing.blocks, bySpecialistDomain: { not_a_real_specialist: routing.blocks } };
  const provenance = { supabaseAdmin: {}, context: { orgId: "org-1", uploadedFileId: "f1", generationId: "gen-1", extractionRunId: "r1", stageRunId: "s1", stageAttempt: 1, operation: "test" } };

  const [good, broken] = await Promise.all([
    runExpenseSpecialistShadowOutput({ definition: goodDefinition, specialistRouting: EMPTY_SPECIALIST_ROUTING as any, moduleType: "lease", provenance }),
    runExpenseSpecialistShadowOutput({ definition: brokenDefinition, specialistRouting: brokenRouting as any, moduleType: "lease", provenance }),
  ]);
  assertEquals(good.technicalStatus, "no_evidence");
  assertEquals(broken.technicalStatus, "exception");
});

// ── runAllExpenseSpecialistShadowOutputs: correction C -- always exactly N records ─

Deno.test("runAllExpenseSpecialistShadowOutputs: always returns exactly 5 records, one per specialist, in registry order", async () => {
  const definitions = getExpenseSpecialistDefinitionsInOrder();
  const records = await runAllExpenseSpecialistShadowOutputs({
    specialistRouting: EMPTY_SPECIALIST_ROUTING as any, moduleType: "lease",
    provenance: { supabaseAdmin: {}, context: { orgId: "org-1", uploadedFileId: "f1", generationId: "gen-1", extractionRunId: "r1", stageRunId: "s1", stageAttempt: 1, operation: "test" } },
  });
  assertEquals(records.length, definitions.length);
  assertEquals(records.map((r) => r.domain), definitions.map((d) => d.id));
  assert(records.every((r) => r.technicalStatus === "no_evidence"), "no routed evidence anywhere -> every specialist should report no_evidence");
});

// ── adaptive-extractor.ts hook: no-authoritative-mutation gate ──────────────
//
// A minimal fixture with zero cam/tax/insurance/utility/repair language (so
// every specialist short-circuits to "no_evidence", no network call
// attempted) and fully deterministic core_terms coverage (so the MAIN loop
// also makes zero LLM calls) -- this keeps the whole test network-free
// while still exercising the real flag=on code path end to end.
async function buildDocIndex(docling: Record<string, unknown>) {
  const resolution = await resolveDocumentIndex(docling as any, { canonicalLayout: null });
  return resolution.index;
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

function countFetchCallsTo(pattern: RegExp) {
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = input.toString();
    if (pattern.test(url)) calls++;
    return realFetch(input, init);
  }) as typeof fetch;
  return { count: () => calls, restore: () => { globalThis.fetch = realFetch; } };
}

Deno.test("adaptive-extractor hook: flag OFF -> expenseSpecialistShadow is empty, zero extra calls", async () => {
  const originalFlag = Deno.env.get("LEASE_EXPENSE_SPECIALISTS_V1");
  try {
    Deno.env.delete("LEASE_EXPENSE_SPECIALISTS_V1");
    const docIndex = await buildDocIndex(NO_SPECIALIST_LANGUAGE_DOCLING);
    const result = await extractFactLedgerAdaptive({
      docIndex, profile: { documentProfile: "full_lease", confidence: 0.9, method: "regex_fallback" }, moduleType: "lease",
    });
    assertEquals(result.adaptiveInstrumentation.expenseSpecialistShadow, []);
  } finally {
    if (originalFlag == null) Deno.env.delete("LEASE_EXPENSE_SPECIALISTS_V1"); else Deno.env.set("LEASE_EXPENSE_SPECIALISTS_V1", originalFlag);
  }
});

Deno.test("adaptive-extractor hook: flag ON (org-admitted) -> facts/allFacts/domainsEscalated are BYTE-IDENTICAL to flag-off, expenseSpecialistShadow has 5 no_evidence records", async () => {
  const originalFlag = Deno.env.get("LEASE_EXPENSE_SPECIALISTS_V1");
  const originalAllowlist = Deno.env.get("LEASE_EXPENSE_SPECIALISTS_ORG_ALLOWLIST");
  const spy = countFetchCallsTo(/api\.openai\.com|azure/i);
  try {
    Deno.env.delete("LEASE_EXPENSE_SPECIALISTS_V1");
    const docIndexOff = await buildDocIndex(NO_SPECIALIST_LANGUAGE_DOCLING);
    const resultOff = await extractFactLedgerAdaptive({
      docIndex: docIndexOff, profile: { documentProfile: "full_lease", confidence: 0.9, method: "regex_fallback" }, moduleType: "lease",
    });

    Deno.env.set("LEASE_EXPENSE_SPECIALISTS_V1", "active");
    Deno.env.set("LEASE_EXPENSE_SPECIALISTS_ORG_ALLOWLIST", "org-1");
    const docIndexOn = await buildDocIndex(NO_SPECIALIST_LANGUAGE_DOCLING);
    const resultOn = await extractFactLedgerAdaptive({
      docIndex: docIndexOn, profile: { documentProfile: "full_lease", confidence: 0.9, method: "regex_fallback" }, moduleType: "lease",
      provenance: { supabaseAdmin: {}, context: { orgId: "org-1", uploadedFileId: "f1", generationId: "gen-1", extractionRunId: "r1", stageRunId: "s1", stageAttempt: 1, operation: "test" } },
    });

    assertEquals(spy.count(), 0, "this fixture must make zero real Azure/OpenAI calls in either mode");
    assertEquals(resultOn.facts, resultOff.facts, "facts must be byte-identical -- specialists must never mutate authoritative facts");
    assertEquals(resultOn.adaptiveInstrumentation.domainsEscalated, resultOff.adaptiveInstrumentation.domainsEscalated);
    assertEquals(resultOn.adaptiveInstrumentation.llmCalls, resultOff.adaptiveInstrumentation.llmCalls);
    assertEquals(resultOn.adaptiveInstrumentation.expenseSpecialistShadow.length, 5);
    assert(resultOn.adaptiveInstrumentation.expenseSpecialistShadow.every((r) => r.technicalStatus === "no_evidence"));
  } finally {
    spy.restore();
    if (originalFlag == null) Deno.env.delete("LEASE_EXPENSE_SPECIALISTS_V1"); else Deno.env.set("LEASE_EXPENSE_SPECIALISTS_V1", originalFlag);
    if (originalAllowlist == null) Deno.env.delete("LEASE_EXPENSE_SPECIALISTS_ORG_ALLOWLIST"); else Deno.env.set("LEASE_EXPENSE_SPECIALISTS_ORG_ALLOWLIST", originalAllowlist);
  }
});

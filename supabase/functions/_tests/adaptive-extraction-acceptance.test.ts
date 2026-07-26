// @ts-nocheck
/**
 * Acceptance-criteria tests for the Section-Aware Candidate Router
 * (section-router.ts, deterministic-candidates.ts, domain-readiness.ts,
 * openai-fact-ledger/adaptive-extractor.ts).
 *
 * Synthetic fixtures spanning the three lease archetypes this task and the
 * prior Lease Truth Assembly pass both reference (typed lease with a
 * summary page; scanned lease with handwritten addenda/tables/formulas;
 * scanned form lease with handwritten party/premises/rent/term values) --
 * no real document text or values are copied here.
 */
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { extractFactLedgerAdaptive } from "../_shared/extraction/openai-fact-ledger/adaptive-extractor.ts";
import { mapFactsToStandardFields } from "../_shared/extraction/openai-fact-ledger/fact-field-mapper.ts";
import { assembleCanonicalFields } from "../_shared/extraction/lease-truth-assembly.ts";
import { resolveDocumentIndex } from "../_shared/extraction/openai-fact-ledger/document-index-v3.ts";

// Set once for this file's process lifetime (Deno.test has no module-level
// before/after hook to scope this more tightly) -- a fake key is harmless to
// leave in place; no other test file in this suite relies on
// OPENAI_API_KEY being unset, and files that need a specific value already
// save/restore their own via try/finally.
if (!Deno.env.get("OPENAI_API_KEY")) {
  Deno.env.set("OPENAI_API_KEY", "sk-fake-openai-key-for-testing");
}

async function buildDocIndex(docling: Record<string, unknown>) {
  const resolution = await resolveDocumentIndex(docling as any, { canonicalLayout: null });
  return resolution.index;
}

function block(overrides: Partial<{ block_index: number; type: string; text: string; page: number }>) {
  return { block_index: 0, type: "paragraph", text: "", page: 1, ...overrides };
}

function countFetchCallsTo(pattern: RegExp) {
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = input.toString();
    if (pattern.test(url)) calls++;
    return realFetch(input, init);
  }) as typeof fetch;
  return {
    count: () => calls,
    restore: () => { globalThis.fetch = realFetch; },
  };
}

// ── Archetype: typed lease with a lease-summary page (labelled, form-shaped) ─

Deno.test("acceptance: labelled parties and premises area are extracted with ZERO Azure OpenAI calls", async () => {
  const docling = {
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

  const spy = countFetchCallsTo(/api\.openai\.com/);
  try {
    const docIndex = await buildDocIndex(docling);
    const result = await extractFactLedgerAdaptive({
      docIndex,
      profile: { documentProfile: "full_lease", confidence: 0.9, method: "regex_fallback" },
      moduleType: "lease",
    });
    assertEquals(spy.count(), 0, "expected zero Azure OpenAI calls for a fully labelled core_terms domain");
    assertEquals(result.adaptiveInstrumentation.mode, "adaptive");
    assertEquals(result.adaptiveInstrumentation.llmCalls, 0);
    assert(result.adaptiveInstrumentation.domainsResolvedDeterministically.includes("core_terms"));

    const mapped = mapFactsToStandardFields({ facts: result.facts, moduleType: "lease" });
    assertEquals(mapped.records[0]?.fields?.tenant_name?.value, "Justin Cress");
    assertEquals(mapped.records[0]?.fields?.landlord_name?.value, "Example Holdings LLC");
    assertEquals(mapped.records[0]?.fields?.square_footage?.value, 1875);
  } finally {
    spy.restore();
  }
});

Deno.test("acceptance: an explicit monthly/annual rent pair validates with ZERO Azure OpenAI calls", async () => {
  const docling = {
    full_text: "RENT\nMonthly Rent: $1,400.00\nAnnual Rent: $16,800.00",
    text_blocks: [
      block({ block_index: 0, type: "heading", text: "BASE RENT", page: 2 }),
      block({ block_index: 1, text: "Monthly Rent: $1,400.00", page: 2 }),
      block({ block_index: 2, text: "Annual Rent: $16,800.00", page: 2 }),
    ],
    tables: [],
    fields: [
      { key: "Monthly Rent", value: "1400", confidence: 0.9, page: 2 },
      { key: "Annual Rent", value: "16800", confidence: 0.9, page: 2 },
    ],
    page_count: 2,
  };

  const spy = countFetchCallsTo(/api\.openai\.com/);
  try {
    const docIndex = await buildDocIndex(docling);
    const result = await extractFactLedgerAdaptive({
      docIndex,
      profile: { documentProfile: "full_lease", confidence: 0.9, method: "regex_fallback" },
      moduleType: "lease",
    });
    assertEquals(spy.count(), 0, "expected zero Azure OpenAI calls for a fully labelled rent_and_charges domain");
    assert(result.adaptiveInstrumentation.domainsResolvedDeterministically.includes("rent_and_charges"));

    const mapped = mapFactsToStandardFields({ facts: result.facts, moduleType: "lease" });
    const rows = [{ ...Object.fromEntries(Object.entries(mapped.records[0]?.fields ?? {}).map(([k, v]) => [k, (v as any).value])) }];
    const canonical = assembleCanonicalFields({
      rows,
      extractionDebug: { merged_field_sources: Object.fromEntries(Object.entries(mapped.records[0]?.fields ?? {}).map(([k, v]: any) => [k, { value: v.value, source: v.source, confidence: v.confidence, source_text: v.sourceText, source_page: v.sourcePage }])) },
      moduleType: "lease",
    });
    assertEquals(canonical.canonicalFields.monthly_rent?.status, "verified");
    assertEquals(canonical.canonicalFields.annual_rent?.status, "verified");
  } finally {
    spy.restore();
  }
});

// ── Archetype: scanned lease with handwritten addenda/tables/formulas ───────

Deno.test("acceptance: utilities evidence comes from the utilities section, not a repair clause", async () => {
  const docling = {
    full_text:
      "REPAIRS AND MAINTENANCE\nLandlord shall repair the HVAC system in the event of mechanical failure.\n\n" +
      "UTILITIES\nTenant shall pay directly for all electric service furnished to the Premises.",
    text_blocks: [
      block({ block_index: 0, type: "heading", text: "REPAIRS AND MAINTENANCE", page: 6 }),
      block({ block_index: 1, text: "Landlord shall repair the HVAC system in the event of mechanical failure.", page: 6 }),
      block({ block_index: 2, type: "heading", text: "UTILITIES", page: 7 }),
      block({ block_index: 3, text: "Tenant shall pay directly for all electric service furnished to the Premises.", page: 7 }),
    ],
    tables: [],
    fields: [],
    page_count: 7,
  };
  const docIndex = await buildDocIndex(docling);
  const routing = (await import("../_shared/extraction/section-router.ts")).routeSections(docling as any);
  const repairBlock = routing.blocks.find((b) => b.text.includes("HVAC"));
  const utilityBlock = routing.blocks.find((b) => b.text.includes("electric service"));
  assertEquals(repairBlock?.primaryDomain, "repairs");
  assertEquals(utilityBlock?.primaryDomain, "utilities");
});

Deno.test("acceptance: insurance requirements come from the insurance section, not an unrelated clause", async () => {
  const docling = {
    full_text: "INSURANCE\nTenant shall maintain commercial general liability insurance with limits of not less than $1,000,000.",
    text_blocks: [
      block({ block_index: 0, type: "heading", text: "INSURANCE", page: 9 }),
      block({ block_index: 1, text: "Tenant shall maintain commercial general liability insurance with limits of not less than $1,000,000.", page: 9 }),
    ],
    tables: [],
    fields: [],
    page_count: 9,
  };
  const { routeSections } = await import("../_shared/extraction/section-router.ts");
  const routing = routeSections(docling as any);
  assertEquals(routing.blocks[1].primaryDomain, "insurance");
  assertEquals(routing.byLlmCallDomain.expenses_and_cam?.some((b) => b.text.includes("commercial general liability")), true);
});

Deno.test("acceptance: relevant CAM clauses are routed to the expenses_and_cam domain", async () => {
  const docling = {
    full_text: "COMMON AREA MAINTENANCE\nTenant shall pay its proportionate share of Common Area Maintenance costs, subject to a cap of 5% per year.",
    text_blocks: [
      block({ block_index: 0, type: "heading", text: "COMMON AREA MAINTENANCE", page: 4 }),
      block({ block_index: 1, text: "Tenant shall pay its proportionate share of Common Area Maintenance costs, subject to a cap of 5% per year.", page: 4 }),
    ],
    tables: [],
    fields: [],
    page_count: 4,
  };
  const { routeSections } = await import("../_shared/extraction/section-router.ts");
  const routing = routeSections(docling as any);
  assertEquals(routing.blocks[1].primaryDomain, "cam");
  assert((routing.byLlmCallDomain.expenses_and_cam ?? []).length > 0);
});

Deno.test("acceptance: additional charges cannot become base rent under adaptive extraction either", async () => {
  const docling = {
    full_text: "Tenant's estimated monthly Common Area Maintenance charge is $480.00.",
    text_blocks: [block({ block_index: 0, text: "Tenant's estimated monthly Common Area Maintenance charge is $480.00.", page: 3 })],
    tables: [],
    fields: [{ key: "CAM Charge", value: "480", confidence: 0.9, page: 3 }],
    page_count: 3,
  };
  const { extractDeterministicCandidates } = await import("../_shared/extraction/deterministic-candidates.ts");
  const det = extractDeterministicCandidates(docling as any, "lease");
  const mapped = mapFactsToStandardFields({ facts: det.facts, moduleType: "lease" });
  assertEquals(mapped.records[0]?.fields?.monthly_rent, undefined, "CAM charge must not populate monthly_rent");
});

// ── Instrumentation: skipped/called domains record why ──────────────────────

Deno.test("acceptance: a skipped (deterministically-resolved) domain records why it was skipped", async () => {
  const docling = {
    full_text: "PARTIES\nTenant: Justin Cress\nLandlord: Example Holdings LLC\nPREMISES\nRentable Area: 1,875 square feet\nCommencement Date: 2024-03-01\nExpiration Date: 2029-02-28",
    text_blocks: [
      block({ block_index: 0, type: "heading", text: "PARTIES", page: 1 }),
      block({ block_index: 1, text: "Tenant: Justin Cress", page: 1 }),
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
  const docIndex = await buildDocIndex(docling);
  const result = await extractFactLedgerAdaptive({
    docIndex,
    profile: { documentProfile: "full_lease", confidence: 0.9, method: "regex_fallback" },
    moduleType: "lease",
  });
  const coreTermsEntry = result.adaptiveInstrumentation.perDomain.find((d) => d.domain === "core_terms");
  assertEquals(coreTermsEntry?.called, false);
  assert(coreTermsEntry?.reason?.length > 0, "expected a non-empty skip reason");
});

Deno.test("acceptance: an escalated domain records why it was necessary", async () => {
  const docling = {
    // Routes to the "options" SectionDomain (legal_rights_and_dates) via the
    // heading, but the body text is deliberately too vague for
    // rule-extractor.ts's deterministic renewal_options patterns (which
    // require an explicit "N option(s) to renew for Y years" shape) to
    // resolve -- so this domain has routed content but no deterministic
    // candidate, the genuine "needs an LLM call" case.
    full_text: "RENEWAL OPTIONS\nThe specific terms of any renewal option shall be negotiated by the parties in good faith at a later date.",
    text_blocks: [
      block({ block_index: 0, type: "heading", text: "RENEWAL OPTIONS", page: 11 }),
      block({ block_index: 1, text: "The specific terms of any renewal option shall be negotiated by the parties in good faith at a later date.", page: 11 }),
    ],
    tables: [],
    fields: [],
    page_count: 11,
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = input.toString();
    if (url.includes("api.openai.com")) {
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ facts: [] }) }, finish_reason: "stop" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    const docIndex = await buildDocIndex(docling);
    const result = await extractFactLedgerAdaptive({
      docIndex,
      profile: { documentProfile: "full_lease", confidence: 0.9, method: "regex_fallback" },
      moduleType: "lease",
    });
    const legalEntry = result.adaptiveInstrumentation.perDomain.find((d) => d.domain === "legal_rights_and_dates");
    assertEquals(legalEntry?.called, true);
    assert(legalEntry?.reason?.length > 0, "expected a non-empty escalation reason");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── Truth Assembly remains the sole final publisher ──────────────────────────

Deno.test("acceptance: adaptive facts flow through the SAME mapFactsToStandardFields + Lease Truth Assembly pipeline (no new publisher)", async () => {
  const docling = {
    full_text: "Tenant: Justin Cress\nLandlord: Example Holdings LLC",
    text_blocks: [block({ block_index: 0, text: "Tenant: Justin Cress" })],
    tables: [],
    fields: [
      { key: "Tenant", value: "Justin Cress", confidence: 0.9, page: 1 },
      { key: "Landlord", value: "Example Holdings LLC", confidence: 0.9, page: 1 },
    ],
    page_count: 1,
  };
  const docIndex = await buildDocIndex(docling);
  const result = await extractFactLedgerAdaptive({
    docIndex,
    profile: { documentProfile: "full_lease", confidence: 0.9, method: "regex_fallback" },
    moduleType: "lease",
  });
  // The exact same mapper + assembly functions Lease Truth Assembly's own
  // tests exercise -- no parallel merge/publish path exists for adaptive facts.
  const mapped = mapFactsToStandardFields({ facts: result.facts, moduleType: "lease" });
  assert(mapped.records[0]?.fields?.tenant_name?.value === "Justin Cress");
  const canonical = assembleCanonicalFields({
    rows: [{ tenant_name: "Justin Cress" }],
    extractionDebug: { merged_field_sources: { tenant_name: { value: "Justin Cress", source: "rule", confidence: 0.9, source_text: "Tenant: Justin Cress", source_page: 1 } } },
    moduleType: "lease",
  });
  assertEquals(canonical.canonicalFields.tenant_name?.value, "Justin Cress");
});

// ── Canonical-only rebuild makes ZERO Azure/OpenAI calls ─────────────────────

Deno.test("acceptance: a canonical-only rebuild (re-deriving the canonical payload from already-extracted facts) uses 0 Azure calls and 0 OpenAI calls", () => {
  const spy = countFetchCallsTo(/api\.openai\.com|documentintelligence\.azure\.com/);
  try {
    // Simulates a rebuild: facts already exist (e.g. from a prior extraction
    // run), only mapFactsToStandardFields + assembleCanonicalFields re-run.
    // Neither function makes a network call -- both are pure/offline.
    const facts = [
      { category: "clause:party_identification", value: "Justin Cress", sourceText: "Tenant: Justin Cress", sourcePage: 1, confidence: 0.9 },
    ];
    const mapped = mapFactsToStandardFields({ facts, moduleType: "lease" });
    assembleCanonicalFields({
      rows: [{ tenant_name: mapped.records[0]?.fields?.tenant_name?.value }],
      extractionDebug: { merged_field_sources: {} },
      moduleType: "lease",
    });
    assertEquals(spy.count(), 0, "a canonical-only rebuild must never call Azure or OpenAI");
  } finally {
    spy.restore();
  }
});


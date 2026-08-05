// @ts-nocheck
//
// Regression tests for the sectioned/large-document whole-document LLM path.
//
// This closes the same silent-data-loss gap that
// whole-document-llm-incomplete-response.test.ts pins for the single-call
// path, one layer up: `runWholeDocumentLlmOnCompact` already rejects a
// truncated or mass-omitting response for a SINGLE call, but a large lease is
// split into multiple section calls (buildCompactSections +
// runSectionedWholeDocumentLlmPipeline), and mergeSectionedWholeDocumentResults
// only counted a failed section in `section_failure_count` diagnostics --
// it never failed the overall run. A lease split into, say, 8 sections where
// one section is truncated would still merge to `method: "llm_only"`
// (success), silently reporting every field that only appeared in that
// section's slice of the document as "not_stated_or_not_found_in_sections".
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { __test__ } from "../_shared/extraction/whole-document-llm/extractor.ts";
import { getSchema } from "../_shared/extraction/schemas.ts";

const { maxSectionFailureRatio, mergeSectionedWholeDocumentResults } = __test__;

const FIELDS = Object.entries(getSchema("lease"))
  .filter(([, def]) => !(def as any).derived)
  .slice(0, 2) as Array<[string, any]>;
const [FIELD_A, FIELD_B] = FIELDS.map(([key]) => key);

const PARENT_COMPACT = {
  version: "lease-compact-document-v1",
  source: "azure_full_layout",
  pageCount: 2,
  nodes: [],
  tables: [],
  keyValues: [],
  diagnostics: {
    characterCount: 100,
    nodeCount: 1,
    tableCount: 0,
    tableRowCount: 0,
    keyValueCount: 0,
    inputWasTruncated: false,
  },
};

function successSection(value: string): Record<string, unknown> {
  return {
    rows: [{ [FIELD_A]: value }],
    method: "llm_only",
    warnings: [],
    validationErrors: [],
    metadata: {
      extractionDebug: {
        openai_fact_ledger: {
          llm_call_count: 1,
          input_tokens: 100,
          output_tokens: 50,
          merged_field_sources: {
            [FIELD_A]: {
              confidence: 0.9,
              source_text: value,
              source_page: 1,
              extraction_status: "extracted",
              canonical_status: "extracted",
              resolution_state: "authoritative",
              requires_review: false,
            },
          },
          evidence_anchors: [{
            field_key: FIELD_A,
            source_text: value,
            source_page: 1,
            source_node_ids: ["n1"],
          }],
        },
      },
    },
  };
}

function failedSection(classification: string, finishReason: string | null = null): Record<string, unknown> {
  return {
    rows: [],
    method: "fallback",
    warnings: [`section call failed: ${classification}`],
    validationErrors: [],
    metadata: {
      extractionDebug: {
        openai_fact_ledger: {
          llm_call_count: 1,
          input_tokens: 100,
          output_tokens: 50,
          failure_classification: classification,
          finish_reason: finishReason,
        },
      },
    },
  };
}

Deno.test("section failure ratio: default is strict (any section failure fails)", () => {
  assertEquals(maxSectionFailureRatio(), 0);
});

Deno.test("section failure ratio: configurable and rejects out-of-range values", () => {
  const original = Deno.env.get("LEASE_WHOLE_DOCUMENT_LLM_MAX_SECTION_FAILURE_RATIO");
  const restore = () => {
    if (original === undefined) Deno.env.delete("LEASE_WHOLE_DOCUMENT_LLM_MAX_SECTION_FAILURE_RATIO");
    else Deno.env.set("LEASE_WHOLE_DOCUMENT_LLM_MAX_SECTION_FAILURE_RATIO", original);
  };
  try {
    Deno.env.set("LEASE_WHOLE_DOCUMENT_LLM_MAX_SECTION_FAILURE_RATIO", "0.25");
    assertEquals(maxSectionFailureRatio(), 0.25);
    for (const bad of ["-0.5", "1.5", "abc"]) {
      Deno.env.set("LEASE_WHOLE_DOCUMENT_LLM_MAX_SECTION_FAILURE_RATIO", bad);
      assertEquals(maxSectionFailureRatio(), 0, `expected fallback for ${JSON.stringify(bad)}`);
    }
  } finally {
    restore();
  }
});

Deno.test("sectioned merge: all sections succeeding merges normally", async () => {
  const result = await mergeSectionedWholeDocumentResults({
    startedAt: Date.now(),
    parentCompact: PARENT_COMPACT,
    sectionResults: [successSection("Acme Corp"), successSection("Acme Corp")],
    sectionCount: 2,
    sectionDocumentBudget: 100_000,
    sectionWarnings: [],
    fields: FIELDS,
    originalPromptChars: 1_000,
    maxInputChars: 400_000,
    deadlineExhausted: false,
  });

  assertEquals(result.method, "llm_only");
  assertEquals(result.rows.length, 1);
  const debug = (result.metadata as any).extractionDebug.openai_fact_ledger;
  assertEquals(debug.section_failure_count, 0);
  assertEquals(debug.failure_classification, undefined);
});

Deno.test("sectioned merge: a single truncated section fails the whole run under the default ratio", async () => {
  const result = await mergeSectionedWholeDocumentResults({
    startedAt: Date.now(),
    parentCompact: PARENT_COMPACT,
    sectionResults: [successSection("Acme Corp"), failedSection("RESPONSE_TRUNCATED", "length")],
    sectionCount: 2,
    sectionDocumentBudget: 100_000,
    sectionWarnings: [],
    fields: FIELDS,
    originalPromptChars: 1_000,
    maxInputChars: 400_000,
    deadlineExhausted: false,
  });

  assertEquals(result.method, "fallback");
  assertEquals(result.rows, []);
  const debug = (result.metadata as any).extractionDebug.openai_fact_ledger;
  assertEquals(debug.failure_classification, "SECTIONED_RESPONSE_SECTION_FAILURES");
  assertEquals(debug.section_failure_count, 1);
  assertEquals(debug.section_count, 2);
  assertEquals(debug.failed_sections.length, 1);
  assertEquals(debug.failed_sections[0].failure_classification, "RESPONSE_TRUNCATED");
  assertEquals(debug.failed_sections[0].finish_reason, "length");
});

Deno.test("sectioned merge: mass-omission in one section also trips the guard", async () => {
  const result = await mergeSectionedWholeDocumentResults({
    startedAt: Date.now(),
    parentCompact: PARENT_COMPACT,
    sectionResults: [successSection("Acme Corp"), failedSection("STRICT_RESPONSE_MASS_OMISSION")],
    sectionCount: 2,
    sectionDocumentBudget: 100_000,
    sectionWarnings: [],
    fields: FIELDS,
    originalPromptChars: 1_000,
    maxInputChars: 400_000,
    deadlineExhausted: false,
  });

  assertEquals(result.method, "fallback");
  const debug = (result.metadata as any).extractionDebug.openai_fact_ledger;
  assertEquals(debug.failure_classification, "SECTIONED_RESPONSE_SECTION_FAILURES");
});

Deno.test("sectioned merge: raising LEASE_WHOLE_DOCUMENT_LLM_MAX_SECTION_FAILURE_RATIO tolerates a failed section", async () => {
  const original = Deno.env.get("LEASE_WHOLE_DOCUMENT_LLM_MAX_SECTION_FAILURE_RATIO");
  Deno.env.set("LEASE_WHOLE_DOCUMENT_LLM_MAX_SECTION_FAILURE_RATIO", "0.5");
  try {
    const result = await mergeSectionedWholeDocumentResults({
      startedAt: Date.now(),
      parentCompact: PARENT_COMPACT,
      sectionResults: [successSection("Acme Corp"), failedSection("RESPONSE_TRUNCATED", "length")],
      sectionCount: 2,
      sectionDocumentBudget: 100_000,
      sectionWarnings: [],
      fields: FIELDS,
      originalPromptChars: 1_000,
      maxInputChars: 400_000,
      deadlineExhausted: false,
    });

    assertEquals(result.method, "llm_only");
    const debug = (result.metadata as any).extractionDebug.openai_fact_ledger;
    assertEquals(debug.section_failure_count, 1);
    assertEquals(debug.section_failure_ratio, 0.5);
    assertEquals(debug.failed_sections.length, 1);
  } finally {
    if (original === undefined) Deno.env.delete("LEASE_WHOLE_DOCUMENT_LLM_MAX_SECTION_FAILURE_RATIO");
    else Deno.env.set("LEASE_WHOLE_DOCUMENT_LLM_MAX_SECTION_FAILURE_RATIO", original);
  }
});

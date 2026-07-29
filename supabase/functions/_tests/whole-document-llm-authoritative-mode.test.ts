// @ts-nocheck

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  getWholeDocumentLlmMode,
  isWholeDocumentLlmActive,
} from "../_shared/extraction/whole-document-llm/feature-mode.ts";
import { __test__ as wholeDocumentExtractorTestHooks } from "../_shared/extraction/whole-document-llm/extractor.ts";

function env(value: string | undefined) {
  return { get: () => value };
}

Deno.test("whole-document lease extraction defaults active when the flag is unset", () => {
  assertEquals(getWholeDocumentLlmMode(env(undefined)), "active");
  assertEquals(isWholeDocumentLlmActive(env(undefined)), true);
});

Deno.test("whole-document lease extraction stays active for blank, active, and invalid values", () => {
  for (const value of ["", "active", "ACTIVE", "typo"]) {
    assertEquals(getWholeDocumentLlmMode(env(value)), "active");
  }
});

Deno.test("legacy lease mapping requires the explicit off rollback value", () => {
  assertEquals(getWholeDocumentLlmMode(env("off")), "off");
  assertEquals(getWholeDocumentLlmMode(env(" OFF ")), "off");
  assertEquals(isWholeDocumentLlmActive(env("off")), false);
});

Deno.test("whole-document LLM splits oversize compact documents into bounded sections", () => {
  const text = "Lease section text. ".repeat(8000);
  const compact = {
    version: "lease-compact-document-v1",
    source: "azure_full_layout",
    pageCount: 4,
    nodes: [1, 2, 3, 4].map((page) => ({
      id: `page:${page}`,
      kind: "page",
      page,
      text,
    })),
    tables: [],
    keyValues: [],
    diagnostics: {
      characterCount: text.length * 4,
      nodeCount: 4,
      tableCount: 0,
      tableRowCount: 0,
      keyValueCount: 0,
      inputWasTruncated: false,
    },
  };

  const { sections, warnings } = wholeDocumentExtractorTestHooks.buildCompactSections(
    compact,
    "small prompt",
    90_000,
  );

  assertEquals(warnings.length, 0);
  assert(sections.length > 1, "oversize compact document should be split before the LLM call");
  for (const section of sections) {
    const promptChars = "small prompt".length + JSON.stringify({ compactDocument: section }).length;
    assert(promptChars <= 90_000, `section prompt exceeded budget: ${promptChars}`);
  }
});

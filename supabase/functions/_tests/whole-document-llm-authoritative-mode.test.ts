// @ts-nocheck

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
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

Deno.test("whole-document lease extraction ignores the old off rollback value", () => {
  assertEquals(getWholeDocumentLlmMode(env("off")), "active");
  assertEquals(getWholeDocumentLlmMode(env(" OFF ")), "active");
  assertEquals(isWholeDocumentLlmActive(env("off")), true);
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

Deno.test("whole-document LLM typed validator accepts common lease value formats", () => {
  const validate = wholeDocumentExtractorTestHooks.validateTypedValue;

  assertEquals(validate("$5.25 per leasable square foot", { type: "number", labels: [], description: "CAM amount" }), {
    valid: true,
    value: 5.25,
  });
  assertEquals(validate("five percent", { type: "number", min: 0, max: 100, labels: [], description: "Admin fee" }), {
    valid: true,
    value: 5,
  });
  assertEquals(validate("Yes", { type: "boolean", labels: [], description: "Insurance required" }), {
    valid: true,
    value: true,
  });
  assertEquals(validate("not applicable", { type: "boolean", labels: [], description: "Option present" }), {
    valid: true,
    value: false,
  });
  assertEquals(validate("1/31/2029", { type: "date", labels: [], description: "Expiration" }), {
    valid: true,
    value: "2029-01-31",
  });
  assertEquals(validate("Triple Net", { type: "enum", enumValues: ["gross", "modified_gross", "triple_net"], labels: [], description: "Lease type" }), {
    valid: true,
    value: "triple_net",
  });
});
Deno.test("whole-document LLM expense candidates recover evidence by quote when node ids are stale", () => {
  const quote = "Tenant shall reimburse Landlord for Tenant's proportionate share of common area maintenance expenses.";
  const compact = {
    version: "lease-compact-document-v1",
    source: "azure_full_layout",
    pageCount: 9,
    nodes: [{ id: "page:7", kind: "page", page: 7, text: `Section 5. ${quote}` }],
    tables: [],
    keyValues: [],
    diagnostics: {
      characterCount: quote.length,
      nodeCount: 1,
      tableCount: 0,
      tableRowCount: 0,
      keyValueCount: 0,
      inputWasTruncated: false,
    },
  };

  const result = wholeDocumentExtractorTestHooks.buildExpenseRuleCandidates({
    compact,
    candidates: [{
      category: "common area maintenance",
      subcategory: null,
      obligationKind: "cam",
      responsibleParty: "tenant",
      paymentTreatment: "reimbursable",
      recoverableFromTenant: "yes",
      camEligible: "yes",
      recoveryMethod: "pro_rata_share",
      allocationBasis: "proportionate share",
      includedInBaseRent: "no",
      amount: null,
      amountFrequency: "not_stated",
      tenantSharePercent: null,
      baseYear: null,
      baseYearAmount: null,
      expenseStopAmount: null,
      capType: null,
      capAmount: null,
      capPercent: null,
      grossUpPercent: null,
      adminFeePercent: null,
      reconciliationRequired: "conditional",
      reconciliationFrequency: null,
      status: "found",
      sourceNodeIds: ["stale-node-id"],
      sourceQuote: quote,
      confidence: 0.91,
      uncertaintyReason: null,
    }],
  });

  assertEquals(result.rejected, []);
  assertEquals(result.rules.length, 1);
  assertEquals(result.rules[0].expense_category, "common_area_maintenance");
  assertEquals(result.rules[0].source_page, 7);
  assertEquals(result.rules[0].source_node_ids, ["page:7"]);
  assertEquals(result.rules[0].source_evidence_recovered, true);
});

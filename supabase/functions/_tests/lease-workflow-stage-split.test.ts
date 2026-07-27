// @ts-nocheck
// Bounded Per-Domain Enrich Refactor -- correctness gate for the
// lease-workflow.ts split (see FAILED_EXTRACTION_ROOT_CAUSE.md and the
// "Bounded Per-Domain Enrich Refactor" plan).
//
// buildLeaseWorkflowAbstraction() used to be one 430-line function. It is
// now a thin composition of 4 stage functions
// (runLeaseWorkflowStage1Clauses -> ...Stage2Fields -> ...Stage3Items ->
// ...Stage4Derivation), so each stage can run in its own bounded Edge
// Function invocation instead of all four running back-to-back in one.
// This file proves the refactor is behavior-preserving: manually composing
// the 4 stages (the way the new bounded enrich_clauses/enrich_fields/
// enrich_items/enrich_derivation pipeline stages actually will, serializing
// each stage's output in between) must produce EXACTLY the same result as
// calling buildLeaseWorkflowAbstraction() directly, for every fixture.

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  buildLeaseWorkflowAbstraction,
  __test__,
} from "../_shared/extraction/lease-workflow.ts";

const {
  runLeaseWorkflowStage1Clauses,
  runLeaseWorkflowStage2Fields,
  runLeaseWorkflowStage3Items,
  runLeaseWorkflowStage4Derivation,
} = __test__;

function runComposedStages(args: {
  row: Record<string, unknown>;
  doclingRaw?: Record<string, unknown> | null;
  documentSubtype?: string | null;
  documentProfileOverride?: string | null;
  unmappedLlmFields?: any[];
  factLedgerDynamicItems?: any[];
}) {
  const stage1 = runLeaseWorkflowStage1Clauses({ doclingRaw: args.doclingRaw });
  const stage2 = runLeaseWorkflowStage2Fields({
    row: args.row,
    doclingRaw: args.doclingRaw,
    documentSubtype: args.documentSubtype,
    documentProfileOverride: args.documentProfileOverride,
    unmappedLlmFields: args.unmappedLlmFields,
    stage1,
  });
  const stage3 = runLeaseWorkflowStage3Items({
    row: args.row,
    doclingRaw: args.doclingRaw,
    documentSubtype: args.documentSubtype,
    documentProfileOverride: args.documentProfileOverride,
    factLedgerDynamicItems: args.factLedgerDynamicItems,
    stage1,
    stage2,
  });
  const stage4 = runLeaseWorkflowStage4Derivation({
    row: args.row,
    doclingRaw: args.doclingRaw,
    documentSubtype: args.documentSubtype,
    documentProfileOverride: args.documentProfileOverride,
    stage1,
    stage2,
    stage3,
  });
  return stage4;
}

const assignmentText = [
  "ASSIGNMENT, ASSUMPTION AND AMENDMENT OF LEASE",
  "This Agreement is entered into as of the 5th day of April, 2024 (the Effective Date), by and among Assignor LLC, Assignee LLC and Landlord LLC.",
  "Landlord and Assignor entered into that certain Lease dated January 2, 2020 for the lease of approximately 2,000 rentable square feet.",
  "Landlord agrees to extend the initial Term of the Lease by one year and said initial Term shall now expire June 30, 2028.",
  "Base Rent for the additional one year shall be $120,000.00. All other terms of the Lease shall remain the same.",
].join("\n");

const baseLeaseText = [
  "COMMERCIAL LEASE AGREEMENT",
  "This Lease is entered into between Markets at Choto, LLC (\"Landlord\") and Cress Family Restaurants, LLC (\"Tenant\").",
  "1. Premises. The Premises are located at 12350 South Northshore, Knoxville, TN 37922.",
  "2. Term. The Term of this Lease shall commence on February 1, 2024 and expire on January 31, 2029.",
  "3. Rent. Tenant shall pay Landlord Base Rent of $4,500.00 per month.",
  "4. Taxes. Tenant shall be responsible for paying all Real Estate Taxes, Insurance Premiums and Common Area Maintenance Expenses.",
  "5. Use. Tenant shall use the Premises solely for a full-service restaurant.",
].join("\n");

const FIXTURES: Array<{ name: string; row: Record<string, unknown>; doclingRaw: any; documentProfileOverride?: string }> = [
  {
    name: "assignment/amendment document",
    row: {},
    doclingRaw: { full_text: assignmentText, text_blocks: [{ text: assignmentText, page: 1 }], tables: [], fields: [] },
    documentProfileOverride: "assignment_amendment",
  },
  {
    name: "base lease document",
    row: {},
    doclingRaw: { full_text: baseLeaseText, text_blocks: [{ text: baseLeaseText, page: 1 }], tables: [], fields: [] },
  },
  {
    name: "empty/blank document (edge case)",
    row: {},
    doclingRaw: { full_text: "", text_blocks: [], tables: [], fields: [] },
  },
];

for (const fixture of FIXTURES) {
  Deno.test(`lease-workflow stage split: ${fixture.name} -- composed stages match buildLeaseWorkflowAbstraction() exactly`, () => {
    const direct = buildLeaseWorkflowAbstraction({
      row: fixture.row,
      doclingRaw: fixture.doclingRaw,
      documentProfileOverride: fixture.documentProfileOverride,
    });
    const composed = runComposedStages({
      row: fixture.row,
      doclingRaw: fixture.doclingRaw,
      documentProfileOverride: fixture.documentProfileOverride,
    });
    // Deep-equal the whole return shape -- lease_fields, lease_clauses,
    // extracted_document_items, expense_rules, cam_profile, budget_preview,
    // budget_handoff_readiness, validations, summary, everything.
    assertEquals(composed, direct);
  });
}

Deno.test("lease-workflow stage split: each stage's own output shape is stable (regression anchor, not just equality-to-monolith)", () => {
  const stage1 = runLeaseWorkflowStage1Clauses({
    doclingRaw: { full_text: baseLeaseText, text_blocks: [{ text: baseLeaseText, page: 1 }], tables: [], fields: [] },
  });
  assertEquals(Array.isArray(stage1.clauses), true);

  const stage2 = runLeaseWorkflowStage2Fields({
    row: {},
    doclingRaw: { full_text: baseLeaseText, text_blocks: [{ text: baseLeaseText, page: 1 }], tables: [], fields: [] },
    stage1,
  });
  assertEquals(typeof stage2.leaseFields, "object");
  assertEquals(typeof stage2.documentProfile, "string");

  const stage3 = runLeaseWorkflowStage3Items({
    row: {},
    doclingRaw: { full_text: baseLeaseText, text_blocks: [{ text: baseLeaseText, page: 1 }], tables: [], fields: [] },
    stage1,
    stage2,
  });
  assertEquals(Array.isArray(stage3.extractedDocumentItems), true);
  assertEquals(typeof stage3.genericSourceTextRejected, "number");

  const stage4 = runLeaseWorkflowStage4Derivation({
    row: {},
    doclingRaw: { full_text: baseLeaseText, text_blocks: [{ text: baseLeaseText, page: 1 }], tables: [], fields: [] },
    stage1,
    stage2,
    stage3,
  });
  assertEquals(Array.isArray(stage4.expense_rules), true);
  assertEquals(typeof stage4.summary, "object");
});

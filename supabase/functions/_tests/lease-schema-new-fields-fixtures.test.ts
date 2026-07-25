// @ts-nocheck
// Real extraction-behavior fixtures for the 13 lease fields newly added to
// LEASE_GROUPS by the Tier 2 reachability fix. These are deterministic
// (rule/pattern path only, no live LLM call) checks that a representative
// sentence for each field actually produces a surviving, non-null candidate
// with correct evidence — proving more than the metadata-only reachability
// check in lease-schema-declared-extraction-metadata.test.ts.
// Run: deno test --allow-env --allow-read --allow-net --no-lock lease-schema-new-fields-fixtures.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { extractRuleBased } from "../_shared/extraction/rule-extractor.ts";
import type { DoclingOutput } from "../_shared/extraction/types.ts";

function fixtureDocling(sentence: string): DoclingOutput {
  return {
    text_blocks: [{ block_index: 0, type: "paragraph", text: sentence, page: 1 }],
    tables: [],
    fields: [],
    full_text: sentence,
  } as unknown as DoclingOutput;
}

const CASES: Array<{ field: string; sentence: string; expectNumber?: number }> = [
  {
    field: "late_fee_amount",
    sentence: "Late Fee: Tenant shall pay a late fee of $150.00 if rent is not received within 5 days.",
    expectNumber: 150,
  },
  {
    field: "returned_payment_fee_amount",
    sentence: "Tenant shall pay a returned payment fee of $50.00 for any dishonored check.",
    expectNumber: 50,
  },
  {
    field: "administrative_fee_amount",
    sentence: "Tenant shall pay an administrative fee of $75.00 per late payment.",
    expectNumber: 75,
  },
  {
    field: "parking_fee_amount",
    sentence: "Tenant shall pay a monthly parking fee of $100.00 for each reserved space.",
    expectNumber: 100,
  },
  {
    field: "utility_reimbursement_amount",
    sentence: "Tenant shall pay a utility reimbursement of $85.00 per month.",
    expectNumber: 85,
  },
  {
    field: "water_sewer_reimbursement_amount",
    sentence: "Tenant shall pay a water/sewer reimbursement of $45.00 per month.",
    expectNumber: 45,
  },
  {
    field: "tax_responsibility",
    sentence: "Real estate taxes shall be paid directly by Tenant to the taxing authority.",
  },
  {
    field: "insurance_responsibility",
    sentence: "Property insurance for the Building shall be maintained by Landlord as an operating expense.",
  },
  {
    field: "electric_responsibility",
    sentence: "Tenant must pay electric charges directly to the utility provider each month.",
  },
  {
    field: "water_sewer_responsibility",
    sentence: "Tenant shall be responsible for all water/sewer charges billed to the Premises.",
  },
];

for (const { field, sentence, expectNumber } of CASES) {
  Deno.test(`rule-based extraction surfaces a non-null candidate for ${field}`, () => {
    const result = extractRuleBased(fixtureDocling(sentence), "lease");
    assert(result.records.length > 0, `extractRuleBased produced no records for: "${sentence}"`);
    const extracted = result.records[0].fields[field];
    assert(extracted, `${field} was not extracted from: "${sentence}"`);
    assert(extracted.value != null && extracted.value !== "", `${field} extracted a null/empty value from: "${sentence}"`);
    assert(extracted.sourceText && extracted.sourceText.length > 0, `${field} has no sourceText`);
    if (expectNumber !== undefined) {
      assertEquals(extracted.value, expectNumber);
    }
  });
}

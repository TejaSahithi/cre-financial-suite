// @ts-nocheck
// Metadata-coverage check for LEASE_SCHEMA: every non-derived field must have
// AT LEAST ONE declared extraction mechanism (LEASE_GROUPS membership, a rule
// pattern, a table header, or label/alias coverage), OR be explicitly declared
// extractionMode: "human_only" in the schema itself. This proves declared
// metadata exists — it does NOT prove extraction actually succeeds end-to-end;
// see lease-schema-new-fields-fixtures.test.ts for real extraction-behavior
// coverage of the 13 fields newly added to LEASE_GROUPS by this change.
// Run: deno test --allow-env --allow-read --allow-net --no-lock lease-schema-declared-extraction-metadata.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { LEASE_SCHEMA, getFieldGroups } from "../_shared/extraction/schemas.ts";
import { getFieldContract } from "../_shared/extraction/field-contract.ts";

function hasDeclaredMetadata(fieldKey: string, groupedFieldNames: Set<string>): { has: boolean; via: string[] } {
  const def = LEASE_SCHEMA[fieldKey];
  const via: string[] = [];
  if (groupedFieldNames.has(fieldKey)) via.push("LEASE_GROUPS");
  if ((def.patterns?.length ?? 0) > 0) via.push("rule_pattern");
  if ((def.tableHeaders?.length ?? 0) > 0) via.push("table_header");
  const contract = getFieldContract(fieldKey);
  if ((def.labels?.length ?? 0) > 0 || (contract?.aliases?.length ?? 0) > 0) via.push("labels_or_contract_aliases");
  return { has: via.length > 0, via };
}

Deno.test("every non-derived LEASE_SCHEMA field has declared extraction metadata, or is explicitly extractionMode: human_only", () => {
  const groupedFieldNames = new Set(getFieldGroups("lease").flatMap((g) => g.fields));
  const gaps = Object.entries(LEASE_SCHEMA)
    .filter(([key, def]) => !def.derived && def.extractionMode !== "human_only" && !hasDeclaredMetadata(key, groupedFieldNames).has)
    .map(([key]) => key);
  assertEquals(gaps, [], `Fields with no declared extraction metadata and no human_only declaration: ${gaps.join(", ")}`);
});

Deno.test("human_only fields are genuinely metadata-free (declaration is not stale)", () => {
  const groupedFieldNames = new Set(getFieldGroups("lease").flatMap((g) => g.fields));
  for (const [key, def] of Object.entries(LEASE_SCHEMA)) {
    if (def.extractionMode !== "human_only") continue;
    const { has, via } = hasDeclaredMetadata(key, groupedFieldNames);
    assert(!has, `${key} is declared human_only but now has real metadata (${via.join(", ")}) — remove the declaration or add real coverage.`);
  }
});

Deno.test("the 13 fields moved into new LLM groups are present in their expected groups", () => {
  const groups = getFieldGroups("lease");
  const byName = (name: string) => groups.find((g) => g.name === name)?.fields ?? [];
  assertEquals(
    byName("fees_and_charges").sort(),
    ["administrative_fee_amount", "application_fee_amount", "late_fee_amount", "parking_fee_amount", "pet_fee_amount", "pet_rent_amount", "returned_payment_fee_amount"].sort(),
  );
  assertEquals(
    byName("utilities_and_responsibility").sort(),
    ["electric_responsibility", "insurance_responsibility", "tax_responsibility", "utility_reimbursement_amount", "water_sewer_reimbursement_amount", "water_sewer_responsibility"].sort(),
  );
});

Deno.test("LEASE_GROUPS has 17 groups after the Tier 2 split (9 - 4 split-away + 10 replacement + 2 new)", () => {
  assertEquals(getFieldGroups("lease").length, 17);
});

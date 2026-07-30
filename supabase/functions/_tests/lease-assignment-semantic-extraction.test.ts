// @ts-nocheck

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildLeaseWorkflowAbstraction } from "../_shared/extraction/lease-workflow.ts";
import { computeDerivedFields } from "../_shared/extraction/calculator.ts";

const assignmentText = [
  "ASSIGNMENT, ASSUMPTION AND AMENDMENT OF LEASE",
  "This Agreement is entered into as of the 5th day of April, 2024 (the Effective Date), by and among Assignor LLC, Assignee LLC and Landlord LLC.",
  "Landlord and Assignor entered into that certain Lease dated January 2, 2020 for the lease of approximately 2,000 rentable square feet.",
  "Landlord agrees to extend the initial Term of the Lease by one year and said initial Term shall now expire June 30, 2028.",
  "Base Rent for the additional one year shall be $120,000.00. All other terms of the Lease shall remain the same.",
].join("\n");

const doclingRaw = {
  full_text: assignmentText,
  text_blocks: [{ text: assignmentText, page: 1 }],
  tables: [],
  fields: [],
};

Deno.test("lease workflow: assignment effective date is separate from referenced original lease date", () => {
  const workflow = buildLeaseWorkflowAbstraction({
    row: {},
    doclingRaw,
    documentProfileOverride: "assignment_amendment",
  });

  assertEquals(workflow.lease_fields.assignment_effective_date?.value, "2024-04-05");
  assertEquals(workflow.lease_fields.lease_date?.value, null);

  const originalLeaseDate = workflow.extracted_document_items.find((item) => item.item_type === "original_lease_date");
  assert(originalLeaseDate, "referenced original lease date should remain reviewable");
  assertEquals(originalLeaseDate.display_tab, "dates_term");
  assertEquals(originalLeaseDate.maps_to_fixed_field, false);
  assertEquals(originalLeaseDate.creates_dynamic_row, true);
});

Deno.test("lease workflow: additional-year base rent maps to its own rent field", () => {
  const workflow = buildLeaseWorkflowAbstraction({
    row: {},
    doclingRaw,
    documentProfileOverride: "assignment_amendment",
  });

  assertEquals(workflow.lease_fields.amended_base_rent_for_additional_year?.value, 120000);
  assertEquals(workflow.lease_fields.base_rent_monthly?.value, null);

  const rentItem = workflow.extracted_document_items.find((item) => item.item_type === "amended_base_rent_for_additional_year");
  assert(rentItem, "additional-year rent should be reviewable in Rent & Charges");
  assertEquals(rentItem.field_key, "amended_base_rent_for_additional_year");
  assertEquals(rentItem.display_tab, "rent_charges");
});

Deno.test("computeDerivedFields: additional-year base rent conflict preserves source amounts for review", () => {
  const rows = [{ monthly_rent: 120000, annual_rent: 1440000, amended_base_rent_for_additional_year: 120000 }];
  computeDerivedFields(rows, "lease");

  assertEquals(rows[0].annual_rent, 1440000);
  assertEquals(rows[0].monthly_rent, 120000);
  assertEquals(rows[0]._derivation_needs_review.monthly_rent, true);
  assertEquals(Boolean(rows[0]._derivation_conflicts.monthly_rent), true);
});

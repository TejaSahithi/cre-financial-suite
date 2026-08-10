// @ts-nocheck
//
// Regression tests for the field-partitioned retry path
// (partitionFieldsIntoGroups / mergeFieldPartitionedResults in
// whole-document-llm/extractor.ts).
//
// Context: a truncated direct whole-document call (finish_reason=length) was
// being retried by re-splitting the *document* into sections, but every
// section call still requested the full ~50-field schema -- so a document
// small enough that input size was never the problem (e.g. 6 pages) would
// truncate on every retry too, since the OUTPUT (one claim per field) was
// the actual constraint, not the input. Field-partitioning splits the
// SCHEMA into small domain groups (reusing getFieldGroups(), the same
// grouping already used for prompting) so each retry call's response can't
// approach the output-token ceiling regardless of document size.
import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { __test__ } from "../_shared/extraction/whole-document-llm/extractor.ts";
import { getSchema } from "../_shared/extraction/schemas.ts";

const { partitionFieldsIntoGroups, mergeFieldPartitionedResults } = __test__;

const LEASE_FIELDS = Object.entries(getSchema("lease")).filter(
  ([, def]) => !(def as any).derived,
) as Array<[string, any]>;

function groupResult(fields: Record<string, unknown>, confidences: Record<string, number>): Record<string, unknown> {
  const row: Record<string, unknown> = { _row: 1 };
  const sources: Record<string, string> = {};
  const evidence: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    row[key] = value;
    sources[key] = "llm";
    evidence[key] = { source_text: `evidence for ${key}`, source_page: 1 };
  }
  row._field_confidences = confidences;
  row._field_sources = sources;
  row._field_evidence = evidence;
  return {
    rows: [row],
    method: "llm_only",
    warnings: [],
    validationErrors: [],
    customFieldSuggestions: [],
    metadata: {
      extractionDebug: {
        openai_fact_ledger: {
          llm_call_count: 1,
          input_tokens: 500,
          output_tokens: 200,
          model: "gpt-test",
          facts_extracted_count: Object.keys(fields).length,
          facts_mapped_count: Object.keys(fields).length,
          field_statuses: Object.fromEntries(Object.keys(fields).map((key) => [key, "found"])),
        },
      },
    },
  };
}

function failedGroupResult(): Record<string, unknown> {
  return {
    rows: [],
    method: "fallback",
    warnings: ["truncated"],
    validationErrors: [],
    metadata: {
      extractionDebug: {
        openai_fact_ledger: { failure_classification: "RESPONSE_TRUNCATED" },
      },
    },
  };
}

Deno.test("partitionFieldsIntoGroups: every requested field appears in exactly one group", () => {
  const groups = partitionFieldsIntoGroups(LEASE_FIELDS, "lease");
  const seen = new Set<string>();
  for (const group of groups) {
    assertExists(group.name);
    for (const [key] of group.fields) {
      assertEquals(seen.has(key), false, `field ${key} appeared in more than one group`);
      seen.add(key);
    }
  }
  assertEquals(seen.size, LEASE_FIELDS.length);
});

Deno.test("partitionFieldsIntoGroups: unrecognized fields land in a trailing 'ungrouped' bucket", () => {
  const fields: Array<[string, any]> = [...LEASE_FIELDS.slice(0, 2), ["totally_made_up_field", { type: "string" }]];
  const groups = partitionFieldsIntoGroups(fields, "lease");
  const ungrouped = groups.find((g) => g.name === "ungrouped");
  assertExists(ungrouped);
  assertEquals(ungrouped!.fields.some(([key]) => key === "totally_made_up_field"), true);
});

Deno.test("mergeFieldPartitionedResults: fields from different groups merge, and a cross-group derived field is computed", () => {
  // monthly_rent/annual_rent live in the "financial" group; square_footage
  // lives in a different (space/physical) group. rent_per_sf = annual_rent /
  // square_footage (calculator.ts) can only be derived once both groups'
  // results are combined -- neither group's own partial computeDerivedFields
  // pass can see the other group's field.
  const financialResult = groupResult(
    { monthly_rent: 5000, annual_rent: 60000 },
    { monthly_rent: 0.9, annual_rent: 0.9 },
  );
  const spaceResult = groupResult(
    { square_footage: 1000 },
    { square_footage: 0.85 },
  );

  const merged = mergeFieldPartitionedResults({
    startedAt: Date.now(),
    moduleType: "lease",
    groupNames: ["financial", "space"],
    groupResults: [financialResult, spaceResult],
  });

  assertEquals(merged.method, "llm_only");
  const row = merged.rows[0] as Record<string, unknown>;
  assertEquals(row.monthly_rent, 5000);
  assertEquals(row.annual_rent, 60000);
  assertEquals(row.square_footage, 1000);
  assertEquals(row.rent_per_sf, 60);
});

Deno.test("mergeFieldPartitionedResults: all groups failing returns a failure result, not a fake success", () => {
  const merged = mergeFieldPartitionedResults({
    startedAt: Date.now(),
    moduleType: "lease",
    groupNames: ["financial", "space"],
    groupResults: [failedGroupResult(), failedGroupResult()],
  });

  assertEquals(merged.method, "fallback");
  assertEquals(merged.rows.length, 0);
  const debug = (merged.metadata as any)?.extractionDebug?.openai_fact_ledger;
  assertEquals(debug?.failure_classification, "FIELD_PARTITION_ALL_GROUPS_FAILED");
});

Deno.test("mergeFieldPartitionedResults: one failed group among several still returns the successful fields, with a warning", () => {
  const financialResult = groupResult({ monthly_rent: 5000 }, { monthly_rent: 0.9 });

  const merged = mergeFieldPartitionedResults({
    startedAt: Date.now(),
    moduleType: "lease",
    groupNames: ["financial", "space"],
    groupResults: [financialResult, failedGroupResult()],
  });

  assertEquals(merged.method, "llm_only");
  const row = merged.rows[0] as Record<string, unknown>;
  assertEquals(row.monthly_rent, 5000);
  assertEquals(merged.warnings.length > 0, true);
  assertEquals(merged.warnings[0].includes("space"), true);
});

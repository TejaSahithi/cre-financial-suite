// @ts-nocheck
/**
 * Unit tests for review-approve/index.ts's Lease Truth Assembly
 * approval-safety gate (findConflictingTruthAssemblyFields). Pure function,
 * no DB/HTTP dependency -- deliberately kept independent of the RPC-gated
 * review_readiness check this gate is additive to.
 */
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const realServe = Deno.serve;
(Deno as any).serve = (..._args: unknown[]) => ({ finished: Promise.resolve(), shutdown: () => {} });
const { __test__: reviewApproveTest } = await import("../review-approve/index.ts");
(Deno as any).serve = realServe;

function fileRecordWithFields(standardFields: Array<Record<string, unknown>>) {
  return { ui_review_payload: { records: [{ standard_fields: standardFields }] } };
}

Deno.test("findConflictingTruthAssemblyFields: returns [] when no field is conflicting", () => {
  const fileRecord = fileRecordWithFields([
    { field_key: "monthly_rent", truth_assembly_status: "verified", truth_assembly_field_id: "monthly_rent" },
    { field_key: "tenant_name", truth_assembly_status: null, truth_assembly_field_id: "tenant_name" },
  ]);
  assertEquals(reviewApproveTest.findConflictingTruthAssemblyFields(fileRecord), []);
});

Deno.test("findConflictingTruthAssemblyFields: returns the canonical field id for a conflicting field", () => {
  const fileRecord = fileRecordWithFields([
    { field_key: "start_date", truth_assembly_status: "conflicting", truth_assembly_field_id: "commencement_date" },
    { field_key: "commencement_date", truth_assembly_status: "conflicting", truth_assembly_field_id: "commencement_date" },
  ]);
  assertEquals(reviewApproveTest.findConflictingTruthAssemblyFields(fileRecord), ["commencement_date"]);
});

Deno.test("findConflictingTruthAssemblyFields: handles a missing/malformed ui_review_payload without throwing", () => {
  assertEquals(reviewApproveTest.findConflictingTruthAssemblyFields({}), []);
  assertEquals(reviewApproveTest.findConflictingTruthAssemblyFields({ ui_review_payload: null }), []);
  assertEquals(reviewApproveTest.findConflictingTruthAssemblyFields({ ui_review_payload: { records: "not-an-array" } }), []);
});

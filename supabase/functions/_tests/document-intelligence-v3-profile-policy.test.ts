// @ts-nocheck
// Phase 9 unit tests for the Document Intelligence v3 profile-policy registry.
// Pure-function tests only -- no DB, no network.

import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { getProfilePolicy, resolvePolicyKey, listProfilePolicyKeys } from "../_shared/extraction/document-intelligence-v3/profile-policy.ts";

Deno.test("listProfilePolicyKeys: Phase 9 policy registry contains required CRE profiles", () => {
  const keys = listProfilePolicyKeys();
  for (const expected of [
    "base_lease",
    "lease_amendment",
    "lease_assignment",
    "assignment_assumption",
    "assignment_assumption_amendment",
    "renewal_amendment",
    "termination_agreement",
    "guaranty",
    "snda",
    "estoppel",
    "commencement_letter",
    "side_letter",
    "notice",
    "exhibit",
    "work_letter",
    "rules_regulations",
    "unknown_cre_document",
    "non_cre_document",
  ]) {
    assert(keys.includes(expected), `expected registry to include ${expected}`);
  }
});

Deno.test("resolvePolicyKey: null/undefined/empty resolves to unknown_cre_document", () => {
  assertEquals(resolvePolicyKey(null), "unknown_cre_document");
  assertEquals(resolvePolicyKey(undefined), "unknown_cre_document");
  assertEquals(resolvePolicyKey(""), "unknown_cre_document");
});

Deno.test("resolvePolicyKey: vertex_fact_ledger vocabulary maps into Phase 9 policies", () => {
  assertEquals(resolvePolicyKey("full_lease"), "base_lease");
  assertEquals(resolvePolicyKey("assignment"), "assignment_assumption");
  assertEquals(resolvePolicyKey("assignment_amendment"), "assignment_assumption_amendment");
  assertEquals(resolvePolicyKey("amendment"), "lease_amendment");
});

Deno.test("resolvePolicyKey: exact registry keys pass through unchanged", () => {
  assertEquals(resolvePolicyKey("lease_assignment"), "lease_assignment");
  assertEquals(resolvePolicyKey("assignment_assumption"), "assignment_assumption");
  assertEquals(resolvePolicyKey("non_cre_document"), "non_cre_document");
});

Deno.test("resolvePolicyKey: unrecognized profile never defaults to base_lease", () => {
  assertEquals(resolvePolicyKey("something_the_registry_has_never_seen"), "unknown_cre_document");
});

Deno.test("getProfilePolicy(base_lease): required fields remain the base lease set", () => {
  const policy = getProfilePolicy("full_lease");
  assertEquals(policy.policy_key, "base_lease");
  assertEquals(policy.profile_status, "recognized");
  assertEquals(
    [...policy.required_fields].sort(),
    [
      "commencement_date",
      "expense_structure",
      "expiration_date",
      "landlord_name",
      "lease_type",
      "monthly_rent",
      "property_address",
      "square_footage",
      "tenant_name",
    ].sort(),
  );
  assertEquals(policy.advisory_message, null);
});

Deno.test("getProfilePolicy(assignment_assumption): excludes amendment-only all_other_terms_remain_same", () => {
  const policy = getProfilePolicy("assignment_assumption");
  assertEquals(policy.policy_key, "assignment_assumption");
  assert(policy.required_fields.includes("assumption_scope"));
  assertFalse(policy.required_fields.includes("all_other_terms_remain_same"));
  for (const mustNotBeRequired of ["monthly_rent", "lease_type", "cam_amount", "expense_structure", "building_rsf"]) {
    assertFalse(policy.required_fields.includes(mustNotBeRequired), `${mustNotBeRequired} must not be hard-required`);
  }
});

Deno.test("getProfilePolicy(assignment_assumption_amendment): includes amendment-specific required field", () => {
  const policy = getProfilePolicy("assignment_amendment");
  assertEquals(policy.policy_key, "assignment_assumption_amendment");
  assert(policy.required_fields.includes("all_other_terms_remain_same"));
  assert(policy.required_fields.includes("assumption_scope"));
  assertEquals(policy.advisory_message, "Original lease required for CAM, expense recovery, and full budget setup.");
});

Deno.test("getProfilePolicy(lease_assignment): is not treated as base lease", () => {
  const policy = getProfilePolicy("lease_assignment");
  assertEquals(policy.policy_key, "lease_assignment");
  assert(policy.required_fields.includes("assignor_name"));
  assertFalse(policy.required_fields.includes("monthly_rent"));
  assertFalse(policy.required_fields.includes("expense_structure"));
});

Deno.test("getProfilePolicy(unknown_cre_document): zero required fields and needs_review", () => {
  const policy = getProfilePolicy("something_never_seen_before");
  assertEquals(policy.policy_key, "unknown_cre_document");
  assertEquals(policy.profile_status, "needs_review");
  assertEquals(policy.required_fields, []);
});

Deno.test("getProfilePolicy(non_cre_document): not applicable and zero blockers", () => {
  const policy = getProfilePolicy("non_cre_document");
  assertEquals(policy.policy_status ?? policy.profile_status, "not_applicable");
  assertEquals(policy.required_fields, []);
});

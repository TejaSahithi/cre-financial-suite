// @ts-nocheck
// Azure + Vertex Phase 4E (local implementation): reviewer-state
// preservation tests for buildLeaseReviewDraftPayload()'s field_reviews
// merge fix. Importing index.ts pulls in its top-level Deno.serve(...) —
// this file has no separate library module (the fix is deliberately scoped
// to review-approve/index.ts only), so each test disables resource/op
// sanitization for that reason, matching the established pattern from the
// Azure P0 patch's lease-extraction-worker-reconciliation.test.ts. Nothing
// here makes a network call of its own.
// Run: deno test --allow-env --allow-read --allow-net --no-lock review-approve-reviewer-state-preservation.test.ts

import { assertEquals, assertNotEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { __test__ } from "../review-approve/index.ts";

const { buildLeaseReviewDraftPayload } = __test__;

function baseFileRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "file-1",
    org_id: "org-1",
    file_name: "lease.pdf",
    document_subtype: "base_lease",
    normalized_output: { metadata: { extractionDebug: {} } },
    ui_review_payload: {},
    ...overrides,
  };
}

const USER = { id: "user-1", email: "reviewer@example.com" };
const NOW = "2026-07-16T00:00:00.000Z";

Deno.test({
  name: "buildLeaseReviewDraftPayload: existing field_reviews is preserved exactly when present",
  sanitizeResources: false,
  sanitizeOps: false,
  fn() {
    const existingFieldReviews = {
      tenant_name: { status: "accepted", reviewed_by: "reviewer@example.com", reviewed_at: "2026-07-01T00:00:00.000Z", notes: "Confirmed against page 1" },
      monthly_rent: { status: "rejected", reviewed_by: "reviewer@example.com", reviewed_at: "2026-07-01T00:00:05.000Z", notes: "Value looks wrong, needs manual check" },
    };
    const payload = buildLeaseReviewDraftPayload(
      baseFileRecord(),
      { tenant_name: "Fresh Extracted Name", monthly_rent: 9999 },
      null,
      USER,
      NOW,
      0,
      existingFieldReviews,
    );
    assertEquals(payload.extraction_data.field_reviews, existingFieldReviews, "field_reviews must survive byte-exact");
  },
});

Deno.test({
  name: "buildLeaseReviewDraftPayload: unreviewed automated fields still refresh from the fresh extraction even when field_reviews is preserved",
  sanitizeResources: false,
  sanitizeOps: false,
  fn() {
    const existingFieldReviews = { tenant_name: { status: "accepted" } };
    const payload = buildLeaseReviewDraftPayload(
      baseFileRecord(),
      { tenant_name: "Old Name Reviewer Saw", monthly_rent: 5000 },
      null,
      USER,
      NOW,
      0,
      existingFieldReviews,
    );
    // The top-level tenant_name column (not inside field_reviews) reflects
    // whatever this rebuild's row says — it is NOT frozen by field_reviews
    // existing for that key. field_reviews only preserves the reviewer's
    // own decision record, never blocks the underlying value from refreshing.
    assertEquals(payload.tenant_name, "Old Name Reviewer Saw");
    assertEquals(payload.monthly_rent, 5000);
    assertEquals(payload.extraction_data.field_reviews, existingFieldReviews);
  },
});

Deno.test({
  name: "buildLeaseReviewDraftPayload: a first-time draft build (no existing field_reviews) does not add the key at all — matches pre-Phase-4E payload shape",
  sanitizeResources: false,
  sanitizeOps: false,
  fn() {
    const payload = buildLeaseReviewDraftPayload(
      baseFileRecord(),
      { tenant_name: "Acme Corp" },
      null,
      USER,
      NOW,
      0,
      undefined,
    );
    assertEquals(Object.prototype.hasOwnProperty.call(payload.extraction_data, "field_reviews"), false);
  },
});

Deno.test({
  name: "buildLeaseReviewDraftPayload: an empty-object existing field_reviews is treated the same as none present (no key added)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn() {
    const payload = buildLeaseReviewDraftPayload(
      baseFileRecord(),
      { tenant_name: "Acme Corp" },
      null,
      USER,
      NOW,
      0,
      {},
    );
    assertEquals(Object.prototype.hasOwnProperty.call(payload.extraction_data, "field_reviews"), false);
  },
});

Deno.test({
  name: "buildLeaseReviewDraftPayload: two different rebuilds with the same existingFieldReviews produce identical field_reviews (deterministic preservation, not accidental)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn() {
    const existingFieldReviews = { square_footage: { status: "accepted", notes: "Verified via floor plan" } };
    const payloadA = buildLeaseReviewDraftPayload(baseFileRecord(), { tenant_name: "A" }, null, USER, NOW, 0, existingFieldReviews);
    const payloadB = buildLeaseReviewDraftPayload(baseFileRecord(), { tenant_name: "B" }, null, USER, NOW, 0, existingFieldReviews);
    assertEquals(payloadA.extraction_data.field_reviews, payloadB.extraction_data.field_reviews);
    assertNotEquals(payloadA.tenant_name, payloadB.tenant_name, "sanity check: the two rebuilds are genuinely different otherwise");
  },
});

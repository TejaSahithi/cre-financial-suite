// @ts-nocheck
// Regression test for a real production bug found while investigating the
// strict-outputs pilot: a value the mapper already flagged "needs_review"
// (semanticVetoReason) and a later self-consistency verifier pass had
// independently CONFIRMED was still vanishing from the final ui_review_payload.
//
// Root cause: assembleCanonicalFields() (lease-truth-assembly.ts) re-runs the
// exact same checkFieldSemanticCompatibility check the mapper already ran,
// and when it fails with no other candidate, it nulled the value outright --
// more destructively than the mapper's own upstream choice to keep the value
// visible with a review flag. Confirmed live against the real NAREN lease
// trace: electric_responsibility="tenant", grounded in "8.1 Utilities...
// Tenant does pay for all electricity...", gets classified monetaryRole="cam"
// (the same sentence also lists CAM among several bundled costs) and fails
// electric_responsibility's monetaryRole=utility_charge requirement.
//
// Fix: when every candidate fails the redundant re-check, prefer a candidate
// that already carries the upstream review flag (requires_review /
// extraction_status="needs_review") with real grounded evidence, rather than
// deleting it. A candidate with no upstream review history still gets the
// original value:null/needs_review treatment -- this module may be the ONLY
// check it has ever seen (e.g. the legacy keyword-mapping path).

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { assembleCanonicalFields } from "../_shared/extraction/lease-truth-assembly.ts";

const ELECTRIC_SOURCE_TEXT =
  "8.1 Utilities. This is a Gross Lease. The Tenant is aware that in the Monthly Rent amount and payment " +
  "that all CAM, property taxes, insurance, maintenance and utility and janitorial costs are included as " +
  "shown on Summary page; therefore Tenant does pay for all electricity, HVAC, water, sewer, and other " +
  "utilities and services used at the Premises (\"Utilities\"), together with all taxes, penalties, " +
  "surcharges, and maintenance charges pertaining thereto.";

Deno.test("assembleCanonicalFields: a value already flagged needs_review upstream and confirmed by the verifier survives a failing redundant semantic re-check", () => {
  const result = assembleCanonicalFields({
    rows: [{ electric_responsibility: "tenant" }],
    extractionDebug: {
      merged_field_sources: {
        electric_responsibility: {
          value: "tenant",
          source: "llm",
          confidence: 0.98,
          source_text: ELECTRIC_SOURCE_TEXT,
          source_page: 8,
          extraction_status: "needs_review",
          requires_review: true,
        },
      },
    },
    moduleType: "lease",
  });

  const field = result.canonicalFields.electric_responsibility;
  assertEquals(field.value, "tenant", "a value already reviewed and kept upstream must not be silently deleted");
  assertEquals(field.status, "needs_review", "must stay flagged for human review, not silently confirmed");
  assertEquals(field.sourceText, ELECTRIC_SOURCE_TEXT);
  assertEquals(field.sourcePage, 8);
  assert(
    field.validationResults.some((r) => r.rule === "semantic_compatibility" && !r.passed),
    "the failing check must still be recorded, not hidden",
  );
  assertEquals(field.confidenceComponents.final, 0, "confidence must still be capped by the failed semantic check");
});

Deno.test("assembleCanonicalFields: a candidate with NO upstream review history still gets nulled on the same failing check (no regression)", () => {
  const result = assembleCanonicalFields({
    rows: [{ electric_responsibility: "tenant" }],
    extractionDebug: {
      merged_field_sources: {
        electric_responsibility: {
          value: "tenant",
          source: "rule",
          confidence: 0.9,
          source_text: ELECTRIC_SOURCE_TEXT,
          source_page: 8,
          // No extraction_status / requires_review -- this module is the
          // only check this candidate has ever been through.
        },
      },
    },
    moduleType: "lease",
  });

  const field = result.canonicalFields.electric_responsibility;
  assertEquals(field.value, null, "a never-reviewed candidate failing the check has no upstream judgment call to defer to");
  assertEquals(field.status, "needs_review");
});

Deno.test("assembleCanonicalFields: a field with zero candidates at all is still not_stated (unrelated code path, sanity check)", () => {
  const result = assembleCanonicalFields({
    rows: [{}],
    extractionDebug: { merged_field_sources: {} },
    moduleType: "lease",
  });
  assertEquals(result.canonicalFields.electric_responsibility, undefined);
});

Deno.test("assembleCanonicalFields: a value that already passes the semantic check is completely unaffected by the fallback path", () => {
  const result = assembleCanonicalFields({
    rows: [{ monthly_rent: 1400 }],
    extractionDebug: {
      merged_field_sources: {
        monthly_rent: {
          value: 1400,
          source: "llm",
          confidence: 0.95,
          source_text: "Base Rent shall be $1,400.00 per month.",
          source_page: 2,
        },
      },
    },
    moduleType: "lease",
  });
  const field = result.canonicalFields.monthly_rent;
  assertEquals(field.value, 1400);
  assert(field.status === "verified" || field.status === "derived_verified", `expected a normal verified status, got ${field.status}`);
});

Deno.test("assembleCanonicalFields: obligation-direction branch also preserves an upstream-reviewed value instead of deleting it", () => {
  // A responsibility-family field whose sourceText fails validateObligationDirection
  // (actor/action/object mismatch) but was already flagged+kept upstream.
  const result = assembleCanonicalFields({
    rows: [{ hvac_responsibility: "tenant" }],
    extractionDebug: {
      merged_field_sources: {
        hvac_responsibility: {
          value: "tenant",
          source: "llm",
          confidence: 0.9,
          // Landlord is the grammatical actor here, not tenant -- this is
          // deliberately the kind of sentence validateObligationDirection
          // flags as a direction mismatch for a "tenant" value.
          source_text: "Landlord shall maintain and repair the HVAC system at Landlord's sole cost.",
          source_page: 6,
          extraction_status: "needs_review",
          requires_review: true,
        },
      },
    },
    moduleType: "lease",
  });
  const field = result.canonicalFields.hvac_responsibility;
  // Whichever gate actually rejected it (semantic or obligation-direction),
  // the upstream-reviewed value must survive with needs_review, not be nulled.
  if (field.value !== "tenant") {
    throw new Error(`expected the upstream-reviewed value to survive a failing redundant check, got value=${JSON.stringify(field.value)} status=${field.status}`);
  }
  assertEquals(field.status, "needs_review");
});

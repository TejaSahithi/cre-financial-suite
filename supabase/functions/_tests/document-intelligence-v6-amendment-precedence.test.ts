// @ts-nocheck

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { selectEffectiveProjection } from "../_shared/extraction/document-semantics/amendment-precedence.ts";

Deno.test("Release 6 amendment precedence selects reviewer override first", () => {
  const selected = selectEffectiveProjection({ fieldKey: "expiration_date", baseProjection: { normalizedValue: "2026-12-31" }, reviewerOverride: { overrideValue: "2027-12-31", is_active: true } });
  assertEquals(selected.selectedLayer, "reviewer_override");
  assertEquals(selected.value, "2027-12-31");
});

Deno.test("Release 6 amendment precedence selects latest resolved amendment effect", () => {
  const selected = selectEffectiveProjection({
    fieldKey: "expiration_date",
    baseProjection: { normalizedValue: "2026-12-31", uploadedFileId: "base" },
    amendmentEffects: [
      { id: "e1", sourceUploadedFileId: "a1", targetCanonicalFieldKey: "expiration_date", effectType: "extend", effectiveDate: "2025-01-01", replacementValue: "2027-12-31", resolutionStatus: "resolved" },
      { id: "e2", sourceUploadedFileId: "a2", targetCanonicalFieldKey: "expiration_date", effectType: "extend", effectiveDate: "2026-01-01", replacementValue: "2028-12-31", resolutionStatus: "resolved" },
    ],
  });
  assertEquals(selected.selectedLayer, "family_effective");
  assertEquals(selected.value, "2028-12-31");
  assertEquals(selected.trace.reasonCodes, ["explicit_later_amendment_effect"]);
});

Deno.test("Release 6 amendment precedence falls back to local projection when effects are unresolved", () => {
  const selected = selectEffectiveProjection({ fieldKey: "monthly_rent", baseProjection: { normalizedValue: 1000 }, amendmentEffects: [{ id: "e1", targetCanonicalFieldKey: "monthly_rent", effectType: "replace", replacementValue: 1200, resolutionStatus: "unresolved" }] });
  assertEquals(selected.selectedLayer, "document_local");
  assertEquals(selected.trace.resolutionStatus, "incomplete");
});
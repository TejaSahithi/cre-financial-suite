// @ts-nocheck
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { isAllowedTransition } from "../_shared/pipeline-status.ts";

Deno.test("pipeline-status allows the documented happy-path transitions", () => {
  const allowedPairs = [
    ["uploaded", "parsing"],
    ["uploaded", "review_required"],
    ["parsing", "parsed"],
    ["parsing", "pdf_parsed"],
    ["parsing", "review_required"],
    ["pdf_parsed", "validating"],
    ["pdf_parsed", "review_required"],
    ["validated", "review_required"],
    ["validated", "storing"],
    ["review_required", "approved"],
    ["review_required", "parsing"],
    ["approved", "validating"],
    ["approved", "storing"],
    ["storing", "stored"],
    ["stored", "computing"],
    ["computing", "completed"],
    ["failed", "parsing"],
    ["failed", "review_required"],
  ];

  for (const [fromStatus, toStatus] of allowedPairs) {
    assertEquals(
      isAllowedTransition(fromStatus as any, toStatus as any),
      true,
      `Expected transition ${fromStatus} -> ${toStatus} to be allowed`,
    );
  }
});

Deno.test("pipeline-status rejects invalid regressions and review bypasses", () => {
  const rejectedPairs = [
    ["uploaded", "stored"],
    ["parsed", "stored"],
    ["pdf_parsed", "stored"],
    ["review_required", "stored"],
    ["review_required", "validated"],
    ["approved", "completed"],
    ["stored", "validated"],
    ["completed", "parsing"],
  ];

  for (const [fromStatus, toStatus] of rejectedPairs) {
    assertEquals(
      isAllowedTransition(fromStatus as any, toStatus as any),
      false,
      `Expected transition ${fromStatus} -> ${toStatus} to be rejected`,
    );
  }
});


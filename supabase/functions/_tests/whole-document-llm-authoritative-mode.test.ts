// @ts-nocheck

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  getWholeDocumentLlmMode,
  isWholeDocumentLlmActive,
} from "../_shared/extraction/whole-document-llm/feature-mode.ts";

function env(value: string | undefined) {
  return { get: () => value };
}

Deno.test("whole-document lease extraction defaults active when the flag is unset", () => {
  assertEquals(getWholeDocumentLlmMode(env(undefined)), "active");
  assertEquals(isWholeDocumentLlmActive(env(undefined)), true);
});

Deno.test("whole-document lease extraction stays active for blank, active, and invalid values", () => {
  for (const value of ["", "active", "ACTIVE", "typo"]) {
    assertEquals(getWholeDocumentLlmMode(env(value)), "active");
  }
});

Deno.test("legacy lease mapping requires the explicit off rollback value", () => {
  assertEquals(getWholeDocumentLlmMode(env("off")), "off");
  assertEquals(getWholeDocumentLlmMode(env(" OFF ")), "off");
  assertEquals(isWholeDocumentLlmActive(env("off")), false);
});

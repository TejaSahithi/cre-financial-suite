// @ts-nocheck
// P4.1 -- canonical date-expression registry and snapshot contract tests.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  CANONICAL_DATE_EXPRESSION_TYPES,
  computeDateExpressionRegistryHash,
  DATE_EXPRESSION_TYPES,
  getDateExpressionType,
  validateDateExpressionRegistry,
} from "../_shared/extraction/lease-financial-schedule/date-expressions/date-expression-registry.ts";
import { DATE_EXPRESSION_REGISTRY_VERSION } from "../_shared/extraction/lease-financial-schedule/date-expressions/date-expression-registry-version.ts";
import { normalizeDateExpressionType, requireDateExpressionType } from "../_shared/extraction/lease-financial-schedule/date-expressions/date-expression-normalization.ts";

const EXPECTED_HASH = "4fb01e689af22475cd4df1207847c37589cbfa90e56b31fbe0d30668a4c501a8";
const SQL_PATH = "supabase/migrations/20260848000000_lease_date_expression_foundation_p4_1.sql";

Deno.test("P4.1 registry: canonical vocabulary is unique, complete and reconciled", () => {
  assertEquals(DATE_EXPRESSION_REGISTRY_VERSION, "lease-date-expressions-v1");
  assertEquals(CANONICAL_DATE_EXPRESSION_TYPES, [
    "fixed_date",
    "event_date",
    "relative_to_date",
    "relative_to_event",
    "earlier_of",
    "later_of",
    "minimum_of",
    "maximum_of",
    "dependent_date",
    "recurring_deadline",
    "notice_window",
    "unresolved_expression",
  ]);
  assertEquals(new Set(CANONICAL_DATE_EXPRESSION_TYPES).size, 12);
  assertEquals(validateDateExpressionRegistry(), { valid: true, errors: [] });
});

Deno.test("P4.1 registry: aliases normalize into canonical types without becoming registry rows", () => {
  assertEquals(normalizeDateExpressionType("fixed"), "fixed_date");
  assertEquals(normalizeDateExpressionType("specific-date"), "fixed_date");
  assertEquals(normalizeDateExpressionType("event"), "event_date");
  assertEquals(normalizeDateExpressionType("relative event"), "relative_to_event");
  assertEquals(normalizeDateExpressionType("sooner_of"), "earlier_of");
  assertEquals(normalizeDateExpressionType("unknown_expression"), "unresolved_expression");
  assertEquals(normalizeDateExpressionType("commencement_date"), null);
  assertEquals(getDateExpressionType("fixed"), undefined);
  assertThrows(() => requireDateExpressionType("commencement_date"), Error, "DATE_EXPRESSION_TYPE_INVALID");
});

Deno.test("P4.1 registry: dependency-processing types cannot claim fixed resolution", () => {
  for (const entry of DATE_EXPRESSION_TYPES) {
    if (entry.expressionType !== "fixed_date" && entry.expressionType !== "event_date") {
      assertEquals(entry.fixedResolvedDatePermitted, false, entry.expressionType);
      assert(entry.validationRules.some((rule) => rule.includes("no_") || rule.includes("preserve")), entry.expressionType);
    }
  }
  assertEquals(getDateExpressionType("relative_to_date")?.requiresDependencyProcessing, true);
  assertEquals(getDateExpressionType("notice_window")?.offsetsPermitted, true);
  assertEquals(getDateExpressionType("recurring_deadline")?.recurrencePermitted, true);
});

Deno.test("P4.1 registry: generated SQL snapshot hash matches code hash", async () => {
  const sql = await Deno.readTextFile(SQL_PATH);
  const hash = await computeDateExpressionRegistryHash();
  assertEquals(hash, EXPECTED_HASH);
  assertStringIncludes(sql, `('${DATE_EXPRESSION_REGISTRY_VERSION}', '${EXPECTED_HASH}')`);
  for (const type of CANONICAL_DATE_EXPRESSION_TYPES) {
    assertStringIncludes(sql, `('${DATE_EXPRESSION_REGISTRY_VERSION}', '${type}'`);
  }
  assertEquals([...sql.matchAll(/\('lease-date-expressions-v1', '[a-z_]+',/g)].length, 12);
  assertStringIncludes(await Deno.readTextFile("scripts/generate-date-expression-registry.ts"), "computeDateExpressionRegistryHash");
});
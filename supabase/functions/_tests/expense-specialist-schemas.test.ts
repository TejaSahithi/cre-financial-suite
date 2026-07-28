// @ts-nocheck
// Phase 5 obligation strict-schema structural validation (correction E:
// maxItems hardening). One generic structural test run once per schema
// (not hand-duplicated 5 times), plus the schema dispatcher.

import { assert, assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { getCamObligationStrictSchema } from "../_shared/extraction/schemas/domains/expense-specialists/cam-obligation.schema.ts";
import { getTaxObligationStrictSchema } from "../_shared/extraction/schemas/domains/expense-specialists/tax-obligation.schema.ts";
import { getInsuranceObligationStrictSchema } from "../_shared/extraction/schemas/domains/expense-specialists/insurance-obligation.schema.ts";
import { getUtilityObligationStrictSchema } from "../_shared/extraction/schemas/domains/expense-specialists/utility-obligation.schema.ts";
import { getRepairObligationStrictSchema } from "../_shared/extraction/schemas/domains/expense-specialists/repair-obligation.schema.ts";
import { getObligationStrictSchema } from "../_shared/extraction/schemas/domains/expense-specialists/obligation-schema-registry.ts";
import { OBLIGATION_ARRAY_MAX_ITEMS, STRING_ARRAY_MAX_ITEMS } from "../_shared/extraction/schemas/domains/expense-specialists/obligation-schema-helpers.ts";

const ALL_SCHEMA_GETTERS = [
  ["cam_obligation_v1", getCamObligationStrictSchema],
  ["tax_obligation_v1", getTaxObligationStrictSchema],
  ["insurance_obligation_v1", getInsuranceObligationStrictSchema],
  ["utility_obligation_v1", getUtilityObligationStrictSchema],
  ["repair_obligation_v1", getRepairObligationStrictSchema],
] as const;

function walkObjectSchemas(schema: any, visit: (node: any) => void) {
  if (!schema || typeof schema !== "object") return;
  if (schema.type === "object") {
    visit(schema);
    for (const propSchema of Object.values(schema.properties ?? {})) walkObjectSchemas(propSchema, visit);
  }
  if (schema.type === "array" && schema.items) walkObjectSchemas(schema.items, visit);
  if (Array.isArray(schema.anyOf)) for (const sub of schema.anyOf) walkObjectSchemas(sub, visit);
}

for (const [expectedName, getSchema] of ALL_SCHEMA_GETTERS) {
  Deno.test(`${expectedName}: schemaName matches, top-level shape is { obligations: [...] } with maxItems`, () => {
    const def = getSchema();
    assertEquals(def.schemaName, expectedName);
    assert(def.schemaVersion.length > 0);
    assertEquals(def.jsonSchema.type, "object");
    assertEquals(def.jsonSchema.additionalProperties, false);
    assertEquals(def.jsonSchema.required, ["obligations"]);
    const obligationsSchema = (def.jsonSchema as any).properties.obligations;
    assertEquals(obligationsSchema.type, "array");
    assertEquals(obligationsSchema.maxItems, OBLIGATION_ARRAY_MAX_ITEMS);
  });

  Deno.test(`${expectedName}: every object-shaped node has additionalProperties:false and required === all its property keys`, () => {
    const def = getSchema();
    walkObjectSchemas(def.jsonSchema, (node) => {
      assertEquals(node.additionalProperties, false, `a nested object node in ${expectedName} is missing additionalProperties:false`);
      const propertyKeys = Object.keys(node.properties ?? {});
      assertEquals(new Set(node.required ?? []), new Set(propertyKeys), `every property in ${expectedName} must be required (strict mode) -- optionality is expressed via a null value, not key omission`);
    });
  });

  Deno.test(`${expectedName}: every array-of-strings property has an explicit maxItems`, () => {
    const def = getSchema();
    walkObjectSchemas(def.jsonSchema, (node) => {
      for (const propSchema of Object.values(node.properties ?? {}) as any[]) {
        if (propSchema.type === "array" && propSchema.items?.type === "string") {
          assert(typeof propSchema.maxItems === "number", `a string-array property in ${expectedName} is missing maxItems`);
          assertEquals(propSchema.maxItems, STRING_ARRAY_MAX_ITEMS);
        }
      }
    });
  });
}

Deno.test("getObligationStrictSchema: dispatches all 5 real specialist ids correctly", () => {
  assertEquals(getObligationStrictSchema("cam_and_operating_expenses" as any).schemaName, "cam_obligation_v1");
  assertEquals(getObligationStrictSchema("taxes" as any).schemaName, "tax_obligation_v1");
  assertEquals(getObligationStrictSchema("insurance" as any).schemaName, "insurance_obligation_v1");
  assertEquals(getObligationStrictSchema("utilities" as any).schemaName, "utility_obligation_v1");
  assertEquals(getObligationStrictSchema("repairs_and_maintenance" as any).schemaName, "repair_obligation_v1");
});

Deno.test("getObligationStrictSchema: throws (never returns undefined) for an unrecognized domain", () => {
  assertThrows(() => getObligationStrictSchema("not_a_real_specialist" as any), Error, "No obligation schema registered for domain");
});

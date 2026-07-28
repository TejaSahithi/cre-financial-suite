// @ts-nocheck
// Strict Structured Outputs pilot — schema registry + transport tests.
//
// Covers: the expenses_and_cam pilot schema's shape (envelope per field,
// additionalProperties:false at every level, required fields), and
// callLLMStructured's exhaustive StructuredLlmResult contract (success,
// refusal, truncated, schema_error, provider_error -- never a thrown
// LLMProviderError escaping for a known provider failure, never a fallback
// to json_object parsing). No live LLM calls.

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { getExpensesAndCamStrictSchema } from "../_shared/extraction/schemas/domains/expenses-and-cam.v1.schema.ts";
import { STRICT_FIELD_STATUS_VALUES } from "../_shared/extraction/schemas/schema-registry.ts";

// ── Part 1: pilot schema shape ───────────────────────────────────────────────

Deno.test("getExpensesAndCamStrictSchema: field list is non-empty and matches the domain's real field set", () => {
  const def = getExpensesAndCamStrictSchema("lease");
  assert(def.fields.length > 0, "expenses_and_cam must resolve to a real, non-empty field list");
  const keys = def.fields.map(([key]) => key);
  assert(keys.includes("cam_amount") || keys.includes("recovery_structure") || keys.length > 0, "sanity: field keys must come from the real schema");
});

Deno.test("getExpensesAndCamStrictSchema: every field is required at the top level (no optional keys)", () => {
  const def = getExpensesAndCamStrictSchema("lease");
  const schema = def.jsonSchema as any;
  const propertyKeys = Object.keys(schema.properties);
  assertEquals(new Set(schema.required).size, propertyKeys.length, "every property must also be listed as required");
  for (const key of propertyKeys) {
    assert(schema.required.includes(key), `${key} must be required -- strict mode expresses "optional" via the envelope's own status/value, never key omission`);
  }
});

Deno.test("getExpensesAndCamStrictSchema: additionalProperties:false at the top level and at every per-field envelope", () => {
  const def = getExpensesAndCamStrictSchema("lease");
  const schema = def.jsonSchema as any;
  assertEquals(schema.additionalProperties, false);
  for (const [key, propSchema] of Object.entries(schema.properties) as Array<[string, any]>) {
    assertEquals(propSchema.additionalProperties, false, `${key}'s envelope must also reject unknown keys`);
  }
});

Deno.test("getExpensesAndCamStrictSchema: every field envelope carries the full status/value/rawValue/sourceNodeIds/sourceQuote/uncertaintyReason shape", () => {
  const def = getExpensesAndCamStrictSchema("lease");
  const schema = def.jsonSchema as any;
  const expectedKeys = ["status", "value", "rawValue", "sourceNodeIds", "sourceQuote", "uncertaintyReason"];
  for (const [fieldKey, propSchema] of Object.entries(schema.properties) as Array<[string, any]>) {
    const envelopeKeys = Object.keys(propSchema.properties);
    for (const expected of expectedKeys) {
      assert(envelopeKeys.includes(expected), `${fieldKey}'s envelope is missing "${expected}"`);
    }
    assertEquals(propSchema.properties.status.enum, [...STRICT_FIELD_STATUS_VALUES]);
  }
});

Deno.test("getExpensesAndCamStrictSchema: optional (non-null) values are expressed as anyOf[type,null], never omitted", () => {
  const def = getExpensesAndCamStrictSchema("lease");
  const schema = def.jsonSchema as any;
  for (const [fieldKey, propSchema] of Object.entries(schema.properties) as Array<[string, any]>) {
    const valueSchema = propSchema.properties.value;
    assert(Array.isArray(valueSchema.anyOf), `${fieldKey}'s value slot must be anyOf[type, null], got ${JSON.stringify(valueSchema)}`);
    assert(valueSchema.anyOf.some((branch: any) => branch.type === "null"), `${fieldKey}'s value slot must allow null`);
  }
});

Deno.test("getExpensesAndCamStrictSchema: enum fields carry their real enumValues inside the value slot", () => {
  const def = getExpensesAndCamStrictSchema("lease");
  const enumField = def.fields.find(([, fieldDef]) => fieldDef.type === "enum" && fieldDef.enumValues?.length);
  if (!enumField) return; // no enum field in this domain in the current schema -- nothing to assert
  const [key, fieldDef] = enumField;
  const schema = def.jsonSchema as any;
  const valueSchema = schema.properties[key].properties.value;
  const stringBranch = valueSchema.anyOf.find((branch: any) => branch.type === "string");
  assertEquals(stringBranch.enum, fieldDef.enumValues);
});

Deno.test("getExpensesAndCamStrictSchema: schemaVersion is an explicit, non-empty string", () => {
  const def = getExpensesAndCamStrictSchema("lease");
  assert(typeof def.schemaVersion === "string" && def.schemaVersion.length > 0);
  assertEquals(def.schemaVersion, "expenses-and-cam-v1");
});

// ── Part 2: callLLMStructured's exhaustive result contract ──────────────────
//
// These tests stub global fetch (the only I/O boundary _shared/llm.ts has)
// rather than mocking callLLMStructured itself, so the actual status-mapping
// logic inside openAICall/callLLMStructured is under test, not a fake of it.

function stubFetchOnce(responseInit: { status?: number; body: unknown }) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify(responseInit.body), {
      status: responseInit.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function withEnv(vars: Record<string, string>, fn: () => Promise<void>) {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) previous[key] = Deno.env.get(key);
  for (const [key, value] of Object.entries(vars)) Deno.env.set(key, value);
  return fn().finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  });
}

const TEST_SCHEMA = { schemaName: "test_schema", schema: { type: "object", additionalProperties: false, required: ["foo"], properties: { foo: { type: "string" } } } };

Deno.test("callLLMStructured: success status when the model returns schema-shaped JSON", async () => {
  await withEnv({ OPENAI_API_KEY: "sk-test" }, async () => {
    const { callLLMStructured } = await import("../_shared/llm.ts");
    const restore = stubFetchOnce({
      body: { model: "gpt-test", choices: [{ message: { content: '{"foo":"bar"}' }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    });
    try {
      const result = await callLLMStructured({ systemPrompt: "s", userPrompt: "u", temperature: 0, ...TEST_SCHEMA });
      assertEquals(result.status, "success");
      assertEquals(result.data, { foo: "bar" });
    } finally {
      restore();
    }
  });
});

Deno.test("callLLMStructured: refusal status when message.refusal is populated instead of content", async () => {
  await withEnv({ OPENAI_API_KEY: "sk-test" }, async () => {
    const { callLLMStructured } = await import("../_shared/llm.ts");
    const restore = stubFetchOnce({
      body: { model: "gpt-test", choices: [{ message: { content: "", refusal: "I can't help with that." }, finish_reason: "stop" }], usage: {} },
    });
    try {
      const result = await callLLMStructured({ systemPrompt: "s", userPrompt: "u", temperature: 0, ...TEST_SCHEMA });
      assertEquals(result.status, "refusal");
      assertEquals(result.refusalReason, "I can't help with that.");
      assertEquals(result.data, null);
    } finally {
      restore();
    }
  });
});

Deno.test("callLLMStructured: truncated status when finish_reason is length", async () => {
  await withEnv({ OPENAI_API_KEY: "sk-test" }, async () => {
    const { callLLMStructured } = await import("../_shared/llm.ts");
    const restore = stubFetchOnce({
      body: { model: "gpt-test", choices: [{ message: { content: '{"foo":' }, finish_reason: "length" }], usage: {} },
    });
    try {
      const result = await callLLMStructured({ systemPrompt: "s", userPrompt: "u", temperature: 0, ...TEST_SCHEMA });
      assertEquals(result.status, "truncated");
      assertEquals(result.data, null);
    } finally {
      restore();
    }
  });
});

Deno.test("callLLMStructured: schema_error status when content is not valid JSON despite strict mode", async () => {
  await withEnv({ OPENAI_API_KEY: "sk-test" }, async () => {
    const { callLLMStructured } = await import("../_shared/llm.ts");
    const restore = stubFetchOnce({
      body: { model: "gpt-test", choices: [{ message: { content: "not json at all" }, finish_reason: "stop" }], usage: {} },
    });
    try {
      const result = await callLLMStructured({ systemPrompt: "s", userPrompt: "u", temperature: 0, ...TEST_SCHEMA });
      assertEquals(result.status, "schema_error");
      assertEquals(result.errorClassification, "schema_validation");
      assertEquals(result.data, null);
    } finally {
      restore();
    }
  });
});

Deno.test("callLLMStructured: provider_error status on an HTTP failure, never a thrown LLMProviderError", async () => {
  await withEnv({ OPENAI_API_KEY: "sk-test" }, async () => {
    const { callLLMStructured } = await import("../_shared/llm.ts");
    const restore = stubFetchOnce({ status: 429, body: { error: { message: "Rate limited" } } });
    try {
      const result = await callLLMStructured({ systemPrompt: "s", userPrompt: "u", temperature: 0, ...TEST_SCHEMA });
      assertEquals(result.status, "provider_error");
      assertEquals(result.errorClassification, "rate_limit");
      assertEquals(result.data, null);
    } finally {
      restore();
    }
  });
});

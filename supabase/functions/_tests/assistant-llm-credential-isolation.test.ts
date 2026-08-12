// @ts-nocheck
// Section 30 (LLM regression test) — proves the Assistant's LLM client is
// credential-isolated from lease extraction's _shared/llm.ts:
//   - it is not configured unless ALL THREE ASSISTANT_AZURE_OPENAI_* vars
//     are set, even when the extraction AZURE_OPENAI_*/OPENAI_* vars ARE set
//   - it never silently falls back to the extraction credentials
//   - the actual HTTP request it sends uses the Assistant endpoint/key/
//     deployment, never the extraction ones, even when both are configured
//     simultaneously with different values
//   - the two client modules do not import one another
//
// Run: deno test --allow-env --allow-read --no-check --no-lock supabase/functions/_tests/assistant-llm-credential-isolation.test.ts

import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  callAssistantLLMStructured,
  isAssistantLLMConfigured,
} from "../_shared/assistant/assistant-llm.ts";

const ASSISTANT_VARS = ["ASSISTANT_AZURE_OPENAI_ENDPOINT", "ASSISTANT_AZURE_OPENAI_API_KEY", "ASSISTANT_AZURE_OPENAI_DEPLOYMENT"];
const EXTRACTION_VARS = ["AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_DEPLOYMENT", "OPENAI_API_KEY", "OPENAI_MODEL"];

function withEnv(overrides: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) previous[key] = Deno.env.get(key);
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

function clearAll(keys: string[]) {
  const out: Record<string, string | undefined> = {};
  for (const k of keys) out[k] = undefined;
  return out;
}

Deno.test("isAssistantLLMConfigured: false when nothing is set", () => {
  withEnv({ ...clearAll(ASSISTANT_VARS), ...clearAll(EXTRACTION_VARS) }, () => {
    assertEquals(isAssistantLLMConfigured(), false);
  });
});

Deno.test("isAssistantLLMConfigured: false when ONLY the extraction vars are set (no silent fallback)", () => {
  withEnv(
    {
      ...clearAll(ASSISTANT_VARS),
      AZURE_OPENAI_ENDPOINT: "https://extraction-resource.openai.azure.com",
      AZURE_OPENAI_API_KEY: "extraction-key",
      AZURE_OPENAI_DEPLOYMENT: "gpt-5.4-mini",
      OPENAI_API_KEY: "sk-extraction-fallback-key",
    },
    () => {
      assertEquals(isAssistantLLMConfigured(), false);
    },
  );
});

Deno.test("isAssistantLLMConfigured: true only once all three ASSISTANT_AZURE_OPENAI_* vars are set", () => {
  withEnv({ ...clearAll(ASSISTANT_VARS) }, () => {
    assertEquals(isAssistantLLMConfigured(), false);
    withEnv({ ASSISTANT_AZURE_OPENAI_ENDPOINT: "https://assistant-resource.openai.azure.com" }, () => {
      assertEquals(isAssistantLLMConfigured(), false);
      withEnv({ ASSISTANT_AZURE_OPENAI_API_KEY: "assistant-key" }, () => {
        assertEquals(isAssistantLLMConfigured(), false);
        withEnv({ ASSISTANT_AZURE_OPENAI_DEPLOYMENT: "gpt-5.4-mini-3" }, () => {
          assertEquals(isAssistantLLMConfigured(), true);
        });
      });
    });
  });
});

Deno.test("callAssistantLLMStructured: fails safely with a configuration error when unconfigured, does not throw", async () => {
  await withEnv({ ...clearAll(ASSISTANT_VARS) }, async () => {
    const result = await callAssistantLLMStructured({
      systemPrompt: "test",
      userPrompt: "test",
      schemaName: "test_schema",
      schema: { type: "object", properties: {}, additionalProperties: false, required: [] },
    });
    assertEquals(result.status, "provider_error");
    assertEquals(result.classification, "configuration");
    assertStringIncludes(result.errorMessage ?? "", "ASSISTANT_AZURE_OPENAI_ENDPOINT");
  });
});

Deno.test("callAssistantLLMStructured: real HTTP call uses the Assistant credential, never the extraction credential, even when both are configured", async () => {
  const realFetch = globalThis.fetch;
  const capturedRequests: Array<{ url: string; apiKey: string | null; body: any }> = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    const headers = new Headers(init?.headers ?? {});
    capturedRequests.push({ url, apiKey: headers.get("api-key"), body: JSON.parse(init?.body ?? "{}") });
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ ok: true }) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
        model: "gpt-5.4-mini-3",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    await withEnv(
      {
        AZURE_OPENAI_ENDPOINT: "https://extraction-resource.openai.azure.com",
        AZURE_OPENAI_API_KEY: "extraction-key-should-never-be-used",
        AZURE_OPENAI_DEPLOYMENT: "gpt-5.4-mini-extraction",
        ASSISTANT_AZURE_OPENAI_ENDPOINT: "https://assistant-resource.openai.azure.com",
        ASSISTANT_AZURE_OPENAI_API_KEY: "assistant-key-correct",
        ASSISTANT_AZURE_OPENAI_DEPLOYMENT: "gpt-5.4-mini-3",
      },
      async () => {
        const result = await callAssistantLLMStructured({
          systemPrompt: "test",
          userPrompt: "test",
          schemaName: "test_schema",
          schema: { type: "object", properties: { ok: { type: "boolean" } }, additionalProperties: false, required: ["ok"] },
        });
        assertEquals(result.status, "success");
      },
    );
  } finally {
    globalThis.fetch = realFetch;
  }

  assertEquals(capturedRequests.length, 1);
  assertStringIncludes(capturedRequests[0].url, "https://assistant-resource.openai.azure.com");
  assertEquals(capturedRequests[0].apiKey, "assistant-key-correct");
  assertEquals(capturedRequests[0].body.model, "gpt-5.4-mini-3");
});


Deno.test("callAssistantLLMStructured: accepts Azure content-part arrays for structured JSON", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
        model: "gpt-5.4-mini-3",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;

  try {
    await withEnv(
      {
        ASSISTANT_AZURE_OPENAI_ENDPOINT: "https://assistant-resource.openai.azure.com",
        ASSISTANT_AZURE_OPENAI_API_KEY: "assistant-key-correct",
        ASSISTANT_AZURE_OPENAI_DEPLOYMENT: "gpt-5.4-mini-3",
      },
      async () => {
        const result = await callAssistantLLMStructured({
          systemPrompt: "test",
          userPrompt: "test",
          schemaName: "test_schema",
          schema: { type: "object", properties: { ok: { type: "boolean" } }, additionalProperties: false, required: ["ok"] },
        });
        assertEquals(result.status, "success");
        assertEquals(result.data, { ok: true });
      },
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("callAssistantLLMStructured: extracts fenced JSON when provider returns text around it", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "```json\n{\"ok\":true}\n```" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
        model: "gpt-5.4-mini-3",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;

  try {
    await withEnv(
      {
        ASSISTANT_AZURE_OPENAI_ENDPOINT: "https://assistant-resource.openai.azure.com",
        ASSISTANT_AZURE_OPENAI_API_KEY: "assistant-key-correct",
        ASSISTANT_AZURE_OPENAI_DEPLOYMENT: "gpt-5.4-mini-3",
      },
      async () => {
        const result = await callAssistantLLMStructured({
          systemPrompt: "test",
          userPrompt: "test",
          schemaName: "test_schema",
          schema: { type: "object", properties: { ok: { type: "boolean" } }, additionalProperties: false, required: ["ok"] },
        });
        assertEquals(result.status, "success");
        assertEquals(result.data, { ok: true });
      },
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});
Deno.test("structural isolation: assistant-llm.ts does not import _shared/llm.ts, and vice versa", async () => {
  const assistantLlmSource = await Deno.readTextFile(new URL("../_shared/assistant/assistant-llm.ts", import.meta.url));
  const extractionLlmSource = await Deno.readTextFile(new URL("../_shared/llm.ts", import.meta.url));
  assertEquals(/from\s+["'].*\/llm\.ts["']/.test(assistantLlmSource), false, "assistant-llm.ts must not import the extraction llm.ts module");
  assertEquals(/from\s+["'].*assistant-llm\.ts["']/.test(extractionLlmSource), false, "the extraction llm.ts must not import assistant-llm.ts");
});

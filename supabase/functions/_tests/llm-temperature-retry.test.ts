// @ts-nocheck
// Regression test for _shared/llm.ts's automatic retry when a model rejects
// a non-default temperature (reasoning-oriented models -- o-series, and
// some gpt-5.x models -- reject any temperature other than their default).
// Every extraction caller in this codebase sends an explicit temperature
// (usually 0, for deterministic extraction); without this retry, pointing
// OPENAI_MODEL at such a model made every single OpenAI call fail, for
// every document, with no per-document cause -- exactly the "extraction
// returns zero fields regardless of document content" symptom this fixes.
//
// Run: deno test --allow-env --no-lock llm-temperature-retry.test.ts

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

Deno.env.set("OPENAI_API_KEY", "test-key");
Deno.env.set("OPENAI_MODEL", "gpt-5.4-mini");

const { callLLMJSON } = await import("../_shared/llm.ts");

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function successBody(model: string) {
  return {
    model,
    choices: [{ message: { content: JSON.stringify({ ok: true }) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

Deno.test("callLLMJSON retries once without temperature when the model rejects it, and succeeds", async () => {
  const calls: any[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: any) => {
    const body = JSON.parse(init.body as string);
    calls.push(body);
    if (calls.length === 1) {
      return jsonResponse(
        {
          error: {
            message: "Unsupported value: 'temperature' does not support 0 with this model. Only the default (1) value is supported.",
            type: "invalid_request_error",
            param: "temperature",
            code: "unsupported_value",
          },
        },
        400,
      );
    }
    return jsonResponse(successBody("gpt-5.4-mini"));
  }) as typeof fetch;

  try {
    const result = await callLLMJSON({ systemPrompt: "sys", userPrompt: "user", temperature: 0 });
    assertEquals(result.data, { ok: true });
    assertEquals(calls.length, 2);
    assertEquals("temperature" in calls[0], true);
    assertEquals("temperature" in calls[1], false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("callLLMJSON does not retry for an unrelated 400 (e.g. context length exceeded)", async () => {
  const calls: any[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: any) => {
    calls.push(JSON.parse(init.body as string));
    return jsonResponse(
      { error: { message: "This model's maximum context length is 8192 tokens.", type: "invalid_request_error" } },
      400,
    );
  }) as typeof fetch;

  try {
    let threw = false;
    try {
      await callLLMJSON({ systemPrompt: "sys", userPrompt: "user", temperature: 0 });
    } catch (error) {
      threw = true;
      assertEquals((error as any).classification, "context_length_exceeded");
    }
    assertEquals(threw, true);
    assertEquals(calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("callLLMJSON does not retry when the first call already succeeds", async () => {
  const calls: any[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: any) => {
    calls.push(JSON.parse(init.body as string));
    return jsonResponse(successBody("gpt-4o-mini"));
  }) as typeof fetch;

  try {
    const result = await callLLMJSON({ systemPrompt: "sys", userPrompt: "user", temperature: 0 });
    assertEquals(result.data, { ok: true });
    assertEquals(calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

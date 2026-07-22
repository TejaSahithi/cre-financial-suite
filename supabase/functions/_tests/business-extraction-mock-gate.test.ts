// @ts-nocheck
// Azure + Vertex Phase 4E: local mock-gate hardening tests.
// Run: deno test --allow-env --allow-read --no-lock business-extraction-mock-gate.test.ts

import { assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";

const realServe = Deno.serve;
(Deno as any).serve = (..._args: unknown[]) => ({ finished: Promise.resolve(), shutdown: () => {} });
const { __test__: normalizeTest } = await import("../normalize-pdf-output/index.ts");
(Deno as any).serve = realServe;

const ENV_KEYS = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "ENABLE_LOCAL_PROVIDER_MOCKS",
  "DISABLE_EXTERNAL_PROVIDER_CALLS",
  "LOCAL_SUPABASE_RUNTIME",
];

function internalRequest(): Request {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "local-test-service-key";
  return new Request("http://127.0.0.1/functions/v1/normalize-pdf-output", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      "x-internal-service-key": serviceKey,
      "Content-Type": "application/json",
    },
  });
}

async function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const previous = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) previous.set(key, Deno.env.get(key));
  try {
    for (const key of ENV_KEYS) Deno.env.delete(key);
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
    await fn();
  } finally {
    for (const key of ENV_KEYS) Deno.env.delete(key);
    for (const [key, value] of previous.entries()) {
      if (value !== undefined) Deno.env.set(key, value);
    }
  }
}

Deno.test("Phase 4E mock gate permits kong only with local marker and kill switch", async () => {
  await withEnv({
    SUPABASE_URL: "http://kong:8000",
    SUPABASE_SERVICE_ROLE_KEY: "local-test-service-key",
    ENABLE_LOCAL_PROVIDER_MOCKS: "true",
    DISABLE_EXTERNAL_PROVIDER_CALLS: "true",
    LOCAL_SUPABASE_RUNTIME: "true",
  }, () => {
    assertEquals(normalizeTest.isLocalSupabaseUrl(), true);
    assertEquals(
      normalizeTest.resolveMockOpenAIScenario(
        internalRequest(),
        { debug_openai_mock_scenario: "success" },
        "vertex_primary_legacy_fallback",
      ),
      "success",
    );
  });
});

Deno.test("Phase 4E mock gate rejects kong without local marker or kill switch", async () => {
  await withEnv({
    SUPABASE_URL: "http://kong:8000",
    SUPABASE_SERVICE_ROLE_KEY: "local-test-service-key",
    ENABLE_LOCAL_PROVIDER_MOCKS: "true",
    DISABLE_EXTERNAL_PROVIDER_CALLS: "true",
  }, async () => {
    assertEquals(normalizeTest.isLocalSupabaseUrl(), false);
    assertThrows(
      () => normalizeTest.resolveMockOpenAIScenario(
        internalRequest(),
        { debug_openai_mock_scenario: "success" },
        "vertex_primary_legacy_fallback",
      ),
      Error,
      "verified local Supabase runtime",
    );
  });

  await withEnv({
    SUPABASE_URL: "http://kong:8000",
    SUPABASE_SERVICE_ROLE_KEY: "local-test-service-key",
    ENABLE_LOCAL_PROVIDER_MOCKS: "true",
    LOCAL_SUPABASE_RUNTIME: "true",
  }, async () => {
    assertEquals(normalizeTest.isLocalSupabaseUrl(), true);
    assertThrows(
      () => normalizeTest.resolveMockOpenAIScenario(
        internalRequest(),
        { debug_openai_mock_scenario: "success" },
        "vertex_primary_legacy_fallback",
      ),
      Error,
      "DISABLE_EXTERNAL_PROVIDER_CALLS=true",
    );
  });
});

Deno.test("Phase 4E mock gate rejects remote Supabase URL", async () => {
  await withEnv({
    SUPABASE_URL: "https://example-project.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "local-test-service-key",
    ENABLE_LOCAL_PROVIDER_MOCKS: "true",
    DISABLE_EXTERNAL_PROVIDER_CALLS: "true",
    LOCAL_SUPABASE_RUNTIME: "true",
  }, async () => {
    assertEquals(normalizeTest.isLocalSupabaseUrl(), false);
    assertThrows(
      () => normalizeTest.resolveMockOpenAIScenario(
        internalRequest(),
        { debug_openai_mock_scenario: "success" },
        "vertex_primary_legacy_fallback",
      ),
      Error,
      "verified local Supabase runtime",
    );
  });
});
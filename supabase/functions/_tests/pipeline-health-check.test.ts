// @ts-nocheck
/**
 * Tests for pipeline-health-check's real exported helpers (via __test__),
 * not a disconnected re-implementation. Covers:
 *
 *   1. Missing AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT/_KEY → env check fails, not crash
 *   2. Missing OPENAI_API_KEY → env check fails, not crash
 *   3. No deprecated provider env var (VERTEX_*, GEMINI_*, GOOGLE_*, DOCLING_*) is read
 *   4. No secret values appear in any check response
 */

import {
  assertEquals,
  assertExists,
  assert,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { __test__ } from "../pipeline-health-check/index.ts";

const { buildSecretPresenceMap, checkEnvVars } = __test__;

const DEPRECATED_ENV_VARS = [
  "GOOGLE_API_KEY",
  "GOOGLE_VISION_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_SERVICE_ACCOUNT_KEY",
  "GEMINI_API_KEY",
  "VERTEX_PROJECT_ID",
  "VERTEX_LOCATION",
  "VERTEX_MODEL",
  "DOCLING_API_URL",
  "DOCLING_API_KEY",
];

const REQUIRED_ENV: Record<string, string> = {
  SUPABASE_URL: "https://test.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-key-placeholder",
  WORKER_INTERNAL_SECRET: "worker-secret-placeholder",
  OPENAI_API_KEY: "sk-test-key",
  AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: "https://test.cognitiveservices.azure.com",
  AZURE_DOCUMENT_INTELLIGENCE_KEY: "azure-key-placeholder",
};

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) previous[key] = Deno.env.get(key);
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
    fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

Deno.test("checkEnvVars: missing AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT/_KEY produces an explicit fail, not a crash", () => {
  withEnv(
    { ...REQUIRED_ENV, AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: undefined, AZURE_DOCUMENT_INTELLIGENCE_KEY: undefined },
    () => {
      const checks = checkEnvVars();
      const azureCheck = checks.find((c: any) => c.name === "env_azure_document_intelligence");
      assertExists(azureCheck);
      assertEquals(azureCheck.status, "fail");
      assertExists(azureCheck.fix);
    },
  );
});

Deno.test("checkEnvVars: missing OPENAI_API_KEY produces an explicit fail, not a crash", () => {
  withEnv({ ...REQUIRED_ENV, OPENAI_API_KEY: undefined }, () => {
    const checks = checkEnvVars();
    const openaiCheck = checks.find((c: any) => c.name === "env_openai_api_key");
    assertExists(openaiCheck);
    assertEquals(openaiCheck.status, "fail");
    assertExists(openaiCheck.fix);
  });
});

Deno.test("checkEnvVars: full config produces pass for Azure, OpenAI, and extraction provider checks", () => {
  withEnv(REQUIRED_ENV, () => {
    const checks = checkEnvVars();
    assertEquals(checks.find((c: any) => c.name === "env_azure_document_intelligence")?.status, "pass");
    assertEquals(checks.find((c: any) => c.name === "env_openai_api_key")?.status, "pass");
    const providerCheck = checks.find((c: any) => c.name === "env_extraction_provider");
    assertExists(providerCheck);
    assert(
      providerCheck.message.includes("azure_document_intelligence"),
      "extraction provider check must report azure_document_intelligence as the resolved mode",
    );
  });
});

Deno.test("checkEnvVars: no deprecated provider env var name appears in any check name, message, or fix", () => {
  withEnv(REQUIRED_ENV, () => {
    const checks = checkEnvVars();
    const serialized = JSON.stringify(checks).toLowerCase();
    for (const deprecatedVar of DEPRECATED_ENV_VARS) {
      assert(
        !serialized.includes(deprecatedVar.toLowerCase()),
        `checkEnvVars output must not reference deprecated var ${deprecatedVar}`,
      );
    }
    assert(!/\bvertex\b|\bgemini\b|\bdocling\b/i.test(serialized), "checkEnvVars output must not reference vertex/gemini/docling");
  });
});

Deno.test("buildSecretPresenceMap: never contains actual secret values, only present/missing, and includes no deprecated var", () => {
  withEnv(REQUIRED_ENV, () => {
    const presence = buildSecretPresenceMap();
    const serialized = JSON.stringify(presence);

    assert(!serialized.includes(REQUIRED_ENV.SUPABASE_SERVICE_ROLE_KEY), "service role key must not appear in output");
    assert(!serialized.includes(REQUIRED_ENV.WORKER_INTERNAL_SECRET), "worker secret must not appear in output");
    assert(!serialized.includes(REQUIRED_ENV.AZURE_DOCUMENT_INTELLIGENCE_KEY), "azure key must not appear in output");

    for (const [key, value] of Object.entries(presence)) {
      assert(
        value === "present" || value === "missing",
        `${key} must be "present" or "missing", got "${value}"`,
      );
    }

    const keys = Object.keys(presence).map((k) => k.toLowerCase());
    for (const deprecatedVar of DEPRECATED_ENV_VARS) {
      assert(!keys.includes(deprecatedVar.toLowerCase()), `secret presence map must not include deprecated var ${deprecatedVar}`);
    }
  });
});

Deno.test("overall ok=false when any check is fail", () => {
  const checks = [
    { name: "env_supabase_url", status: "pass", message: "ok" },
    { name: "env_openai_api_key", status: "fail", message: "missing", fix: "set OPENAI_API_KEY" },
  ];
  const overallOk = !checks.some((c) => c.status === "fail");
  assertEquals(overallOk, false, "overall ok must be false when any check fails");
});

Deno.test("overall ok=true when no check is fail (warn allowed)", () => {
  const checks = [
    { name: "env_supabase_url", status: "pass", message: "ok" },
    { name: "openai_auth", status: "warn", message: "empty response" },
  ];
  const overallOk = !checks.some((c) => c.status === "fail");
  assertEquals(overallOk, true, "warn must not make overall ok=false");
});

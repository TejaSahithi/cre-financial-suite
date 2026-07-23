// @ts-nocheck
// Regression test for _shared/llm.ts's Azure OpenAI backend. An Azure OpenAI
// resource key is a different credential type than a direct-OpenAI platform
// key and is never valid against api.openai.com — this suite pins down the
// request shape (v1 URL, api-key header, no Authorization/Bearer, deployment
// name as body "model") so a future change can't silently point
// Azure-configured deployments back at the wrong endpoint or the older
// dated /openai/deployments/{name}/chat/completions?api-version=... route.
//
// Production incident this guards against: AZURE_OPENAI_API_VERSION was set
// to a gpt-5.4-mini MODEL version ("2026-03-17"), not a REST api-version —
// those are unrelated Azure concepts that are easy to conflate — combined
// with an *.services.ai.azure.com (Microsoft Foundry) host, which only
// supports the newer deployment-in-path route inconsistently. The v1 route
// takes no api-version at all and works against both *.openai.azure.com and
// *.services.ai.azure.com, which eliminates this whole class of error.
//
// Run: deno test --allow-env --no-lock llm-azure-openai.test.ts

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

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

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>) {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) previous[key] = Deno.env.get(key);
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
  return fn().finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  });
}

Deno.test("callLLMJSON calls the Azure v1 route — exact hostname, exact path, no api-version, api-key header, deployment as body model", async () => {
  await withEnv(
    {
      // The exact production shape: a Microsoft Foundry services.ai.azure.com host.
      AZURE_OPENAI_ENDPOINT: "https://aif-docproc-platform-dev-eus2-01.services.ai.azure.com",
      AZURE_OPENAI_DEPLOYMENT: "gpt-5.4-mini-2",
      // A leftover model-version-shaped value must be completely ignored —
      // the v1 route never reads AZURE_OPENAI_API_VERSION at all.
      AZURE_OPENAI_API_VERSION: "2026-03-17",
      AZURE_OPENAI_API_KEY: "azure-test-key",
      OPENAI_API_KEY: undefined,
      OPENAI_MODEL: undefined,
    },
    async () => {
      const { callLLMJSON } = await import("../_shared/llm.ts");

      let capturedUrl = "";
      let capturedHeaders: Record<string, string> = {};
      let capturedBody: any = null;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (url: string, init: any) => {
        capturedUrl = String(url);
        capturedHeaders = init.headers;
        capturedBody = JSON.parse(init.body as string);
        return jsonResponse(successBody("gpt-5.4-mini-2"));
      }) as typeof fetch;

      try {
        const result = await callLLMJSON({ systemPrompt: "sys", userPrompt: "user", temperature: 0 });
        assertEquals(result.data, { ok: true });

        const parsed = new URL(capturedUrl);
        assertEquals(parsed.hostname, "aif-docproc-platform-dev-eus2-01.services.ai.azure.com");
        assertEquals(parsed.pathname, "/openai/v1/chat/completions");
        assertEquals(parsed.search, "", "the v1 route must never carry an api-version query string");
        assertEquals(capturedUrl, "https://aif-docproc-platform-dev-eus2-01.services.ai.azure.com/openai/v1/chat/completions");

        assertEquals(capturedHeaders["api-key"], "azure-test-key");
        assertEquals("Authorization" in capturedHeaders, false, "Azure OpenAI must never send an OpenAI-style Bearer token");

        assertEquals(capturedBody.model, "gpt-5.4-mini-2", "the deployment name must be sent as the body's model field under the v1 route");
        assertEquals(capturedBody.messages[1], { role: "user", content: "user" });
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );
});

Deno.test("callLLMJSON works identically against a classic *.openai.azure.com host — same v1 path, still no deployment segment", async () => {
  await withEnv(
    {
      AZURE_OPENAI_ENDPOINT: "https://my-resource.openai.azure.com",
      AZURE_OPENAI_DEPLOYMENT: "my-gpt4o-deployment",
      AZURE_OPENAI_API_KEY: "azure-test-key",
    },
    async () => {
      const { callLLMJSON } = await import("../_shared/llm.ts");

      let capturedUrl = "";
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (url: string, init: any) => {
        capturedUrl = String(url);
        return jsonResponse(successBody("my-gpt4o-deployment"));
      }) as typeof fetch;

      try {
        await callLLMJSON({ systemPrompt: "sys", userPrompt: "user", temperature: 0 });
        assertEquals(capturedUrl, "https://my-resource.openai.azure.com/openai/v1/chat/completions");
        assertEquals(capturedUrl.includes("/openai/deployments/"), false, "deployment must never appear as a URL path segment under the v1 route");
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );
});

Deno.test("callLLMJSON falls back to OPENAI_API_KEY for Azure auth when AZURE_OPENAI_API_KEY is unset", async () => {
  await withEnv(
    {
      AZURE_OPENAI_ENDPOINT: "https://my-resource.openai.azure.com",
      AZURE_OPENAI_DEPLOYMENT: "my-deployment",
      AZURE_OPENAI_API_KEY: undefined,
      OPENAI_API_KEY: "shared-secret-key",
    },
    async () => {
      const { callLLMJSON } = await import("../_shared/llm.ts");

      let capturedHeaders: Record<string, string> = {};
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (_url: string, init: any) => {
        capturedHeaders = init.headers;
        return jsonResponse(successBody("my-deployment"));
      }) as typeof fetch;

      try {
        await callLLMJSON({ systemPrompt: "sys", userPrompt: "user", temperature: 0 });
        assertEquals(capturedHeaders["api-key"], "shared-secret-key");
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );
});

Deno.test("callLLMJSON self-heals when AZURE_OPENAI_ENDPOINT is accidentally set to the full sample request URL instead of the resource base URL", async () => {
  await withEnv(
    {
      // The exact shape someone copying an Azure "view code" sample would paste.
      AZURE_OPENAI_ENDPOINT: "https://my-resource.openai.azure.com/openai/deployments/wrong-deployment/chat/completions?api-version=2023-05-15",
      AZURE_OPENAI_DEPLOYMENT: "my-real-deployment",
      AZURE_OPENAI_API_KEY: "azure-test-key",
    },
    async () => {
      const { callLLMJSON } = await import("../_shared/llm.ts");

      let capturedUrl = "";
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (url: string, init: any) => {
        capturedUrl = String(url);
        return jsonResponse(successBody("my-real-deployment"));
      }) as typeof fetch;

      try {
        await callLLMJSON({ systemPrompt: "sys", userPrompt: "user", temperature: 0 });
        // Must self-heal to the bare resource URL, then build the v1 path
        // from that — never keep the accidentally-pasted deployment/api-version.
        assertEquals(
          capturedUrl,
          "https://my-resource.openai.azure.com/openai/v1/chat/completions",
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );
});

Deno.test("isLLMProviderConfigured reflects the active backend's actual credential, not just OPENAI_API_KEY presence", async () => {
  await withEnv(
    { AZURE_OPENAI_ENDPOINT: undefined, OPENAI_API_KEY: undefined, AZURE_OPENAI_API_KEY: undefined },
    async () => {
      const { isLLMProviderConfigured } = await import("../_shared/llm.ts");
      assertEquals(isLLMProviderConfigured(), false, "neither backend configured");
    },
  );

  await withEnv(
    { AZURE_OPENAI_ENDPOINT: "https://my-resource.openai.azure.com", OPENAI_API_KEY: undefined, AZURE_OPENAI_API_KEY: "azure-key" },
    async () => {
      const { isLLMProviderConfigured } = await import("../_shared/llm.ts");
      assertEquals(isLLMProviderConfigured(), true, "Azure endpoint + dedicated Azure key");
    },
  );

  await withEnv(
    { AZURE_OPENAI_ENDPOINT: undefined, OPENAI_API_KEY: "sk-test", AZURE_OPENAI_API_KEY: undefined },
    async () => {
      const { isLLMProviderConfigured } = await import("../_shared/llm.ts");
      assertEquals(isLLMProviderConfigured(), true, "direct OpenAI mode with OPENAI_API_KEY set");
    },
  );
});

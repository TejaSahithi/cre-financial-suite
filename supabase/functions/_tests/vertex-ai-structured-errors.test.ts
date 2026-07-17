// @ts-nocheck
// Azure + Vertex Phase 4E (local implementation): structured
// VertexProviderError classification tests. Uses the same globalThis.fetch
// mocking pattern already established in vertex-fact-ledger.test.ts — no
// live provider calls, no real network egress (every intercepted URL is
// synthetic; anything else falls through to a captured real fetch that
// these tests never actually trigger).
// Run: deno test --allow-env --allow-read --allow-net --no-lock vertex-ai-structured-errors.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { callVertexAI, VertexProviderError } from "../_shared/vertex-ai.ts";

async function makeTestPem(): Promise<string> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8)));
  return `-----BEGIN PRIVATE KEY-----\n${(b64.match(/.{1,64}/g) ?? [b64]).join("\n")}\n-----END PRIVATE KEY-----`;
}

function setCreds(pem: string) {
  Deno.env.set("VERTEX_PROJECT_ID", "test-project");
  Deno.env.set("GOOGLE_CLIENT_EMAIL", "test@test-project.iam.gserviceaccount.com");
  Deno.env.set("GOOGLE_PRIVATE_KEY", pem);
}

function clearCreds() {
  Deno.env.delete("VERTEX_PROJECT_ID");
  Deno.env.delete("GOOGLE_PROJECT_ID");
  Deno.env.delete("GOOGLE_CLIENT_EMAIL");
  Deno.env.delete("GOOGLE_PRIVATE_KEY");
}

function mockOAuthOnly(realFetch: typeof fetch, vertexHandler: (url: string) => Response) {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = input.toString();
    if (url.includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "fake-access-token", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("aiplatform.googleapis.com") && url.includes("generateContent")) {
      return vertexHandler(url);
    }
    return realFetch(input, init);
  }) as typeof fetch;
}

Deno.test("callVertexAI: missing credentials throws VertexProviderError classified auth_error", async () => {
  clearCreds();
  try {
    await callVertexAI({ userPrompt: "test" });
    assert(false, "expected a throw");
  } catch (err) {
    assert(err instanceof VertexProviderError);
    assertEquals(err.classification, "auth_error");
  }
});

Deno.test("callVertexAI: a 429 response is classified rate_limited", async () => {
  const pem = await makeTestPem();
  setCreds(pem);
  const realFetch = globalThis.fetch;
  mockOAuthOnly(realFetch, () => new Response("rate limited", { status: 429 }));
  try {
    await callVertexAI({ userPrompt: "test" });
    assert(false, "expected a throw");
  } catch (err) {
    assert(err instanceof VertexProviderError);
    assertEquals(err.classification, "rate_limited");
    assertEquals(err.httpStatus, 429);
  } finally {
    globalThis.fetch = realFetch;
    clearCreds();
  }
});

Deno.test("callVertexAI: a 500 response is classified server_error", async () => {
  const pem = await makeTestPem();
  setCreds(pem);
  const realFetch = globalThis.fetch;
  mockOAuthOnly(realFetch, () => new Response("internal error", { status: 500 }));
  try {
    await callVertexAI({ userPrompt: "test" });
    assert(false, "expected a throw");
  } catch (err) {
    assert(err instanceof VertexProviderError);
    assertEquals(err.classification, "server_error");
    assertEquals(err.httpStatus, 500);
  } finally {
    globalThis.fetch = realFetch;
    clearCreds();
  }
});

Deno.test("callVertexAI: every model/location combination returning 404 is classified model_unavailable, not generic unknown", async () => {
  const pem = await makeTestPem();
  setCreds(pem);
  const realFetch = globalThis.fetch;
  mockOAuthOnly(realFetch, () => new Response("not found", { status: 404 }));
  try {
    await callVertexAI({ userPrompt: "test" });
    assert(false, "expected a throw");
  } catch (err) {
    assert(err instanceof VertexProviderError);
    assertEquals(err.classification, "model_unavailable");
  } finally {
    globalThis.fetch = realFetch;
    clearCreds();
  }
});

Deno.test("callVertexAI: deadlineAt already in the past throws budget_exhausted immediately, without attempting any request", async () => {
  const pem = await makeTestPem();
  setCreds(pem);
  const realFetch = globalThis.fetch;
  let requestCount = 0;
  mockOAuthOnly(realFetch, () => {
    requestCount++;
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "{}" }] } }] }), { status: 200 });
  });
  try {
    await callVertexAI({ userPrompt: "test", deadlineAt: Date.now() - 1000 });
    assert(false, "expected a throw");
  } catch (err) {
    assert(err instanceof VertexProviderError);
    assertEquals(err.classification, "budget_exhausted");
    assertEquals(requestCount, 0, "no generateContent request should have been attempted past the deadline");
  } finally {
    globalThis.fetch = realFetch;
    clearCreds();
  }
});

Deno.test("callVertexAI: a successful call within budget still succeeds normally (deadlineAt does not change happy-path behavior)", async () => {
  const pem = await makeTestPem();
  setCreds(pem);
  const realFetch = globalThis.fetch;
  mockOAuthOnly(realFetch, () =>
    new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
  try {
    const result = await callVertexAI({ userPrompt: "test", deadlineAt: Date.now() + 60_000 });
    assertEquals(result.content, "ok");
  } finally {
    globalThis.fetch = realFetch;
    clearCreds();
  }
});

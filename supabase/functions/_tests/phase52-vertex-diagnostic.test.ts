// @ts-nocheck
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handlePhase52VertexDiagnosticRequest } from "../phase52-vertex-diagnostic/index.ts";
import { callVertexAISingleRequestDiagnostic } from "../_shared/vertex-ai.ts";

const internalEnv = {
  get(key: string) {
    return {
      SUPABASE_SERVICE_ROLE_KEY: "service-role-placeholder",
      WORKER_INTERNAL_SECRET: "worker-secret-placeholder",
      VERTEX_PROJECT_ID: "project-placeholder",
      VERTEX_LOCATION: "us-central1",
    }[key] ?? "";
  },
};

const cravenSample = [
  "THIS LEASE AGREEMENT is by and between Markets at Choto, LLC, as Landlord,",
  "and Cress Family Restaurants, LLC, as Tenant.",
  "The Premises are Building 9, Suites 3 and 4 at 12350 South Northshore, Knoxville, Tennessee, in The Markets at Choto.",
  "Tenant shall pay its pro-rata share of real estate taxes, insurance premiums, and common area maintenance expenses.",
  "CAM estimate for 2021 is $5.25 per leasable square foot.",
  "Tenant shall also pay a 5 percent administrative fee.",
  "Security Deposit Addendum states a total security deposit of $15,535.36.",
].join(" ");

function request(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new Request("https://example.test/functions/v1/phase52-vertex-diagnostic", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function json(resp: Response) {
  return await resp.json();
}

Deno.test("phase52 diagnostic rejects unauthenticated calls before provider invocation", async () => {
  let calls = 0;
  const resp = await handlePhase52VertexDiagnosticRequest(
    request({ sample_text: cravenSample }),
    {
      env: internalEnv,
      vertexCaller: async () => {
        calls += 1;
        throw new Error("should not run");
      },
    },
  );
  assertEquals(resp.status, 401);
  assertEquals(calls, 0);
  assertEquals((await json(resp)).error_category, "unauthorized");
});

Deno.test("phase52 diagnostic accepts internal auth and invokes the Vertex diagnostic helper once", async () => {
  let calls = 0;
  const resp = await handlePhase52VertexDiagnosticRequest(
    request(
      { sample_text: cravenSample, diagnostic_label: "craven-short-sample" },
      { "x-internal-service-key": "service-role-placeholder" },
    ),
    {
      env: internalEnv,
      now: () => 1000,
      vertexCaller: async (opts) => {
        calls += 1;
        assert(opts.userPrompt.includes("Markets at Choto"));
        assertEquals(opts.responseMimeType, "application/json");
        return {
          content: JSON.stringify({ facts: [{ field: "cam_estimate", value: "$5.25 PSF" }] }),
          model: "gemini-2.5-flash",
          location: "us-central1",
          inputTokens: 123,
          outputTokens: 45,
          latencyMs: 250,
        };
      },
    },
  );
  const body = await json(resp);
  assertEquals(resp.status, 200);
  assertEquals(calls, 1);
  assertEquals(body.success, true);
  assertEquals(body.provider, "vertex");
  assertEquals(body.request_count, 1);
  assertEquals(body.model, "gemini-2.5-flash");
  assertEquals(body.location, "us-central1");
  assertEquals(body.token_usage.input_tokens, 123);
  assertEquals(body.parsed_diagnostic_facts.facts[0].field, "cam_estimate");
});

Deno.test("phase52 diagnostic rejects DB-targeting identifiers and provider overrides", async () => {
  for (const forbidden of ["file_id", "uploaded_file_id", "lease_id", "select", "insert", "debug_business_extraction_provider", "provider"]) {
    let calls = 0;
    const resp = await handlePhase52VertexDiagnosticRequest(
      request({ sample_text: cravenSample, [forbidden]: "bad" }, { "x-internal-service-key": "service-role-placeholder" }),
      {
        env: internalEnv,
        vertexCaller: async () => {
          calls += 1;
          throw new Error("should not run");
        },
      },
    );
    assertEquals(resp.status, 400, forbidden);
    assertEquals(calls, 0, forbidden);
    assert((await json(resp)).message.includes(forbidden));
  }
});

Deno.test("phase52 diagnostic redacts secret-like material from provider errors", async () => {
  const resp = await handlePhase52VertexDiagnosticRequest(
    request({ sample_text: cravenSample }, { "x-internal-service-key": "service-role-placeholder" }),
    {
      env: internalEnv,
      vertexCaller: async () => {
        throw new Error('failure Authorization: Bearer abc.def.ghi {"private_key":"-----BEGIN PRIVATE KEY-----\\nsecret\\n-----END PRIVATE KEY-----","access_token":"secret-token","x-worker-secret":"worker-secret-placeholder"}');
      },
    },
  );
  const body = await json(resp);
  assertEquals(resp.status, 502);
  assertEquals(body.success, false);
  assertEquals(body.request_count, 1);
  assert(!body.sanitized_error.includes("abc.def.ghi"));
  assert(!body.sanitized_error.includes("PRIVATE KEY"));
  assert(!body.sanitized_error.includes("secret-token"));
  assert(!body.sanitized_error.includes("worker-secret-placeholder"));
});

Deno.test("phase52 diagnostic source has no Supabase client, table access, parser, or non-Vertex provider path", async () => {
  const source = await Deno.readTextFile(new URL("../phase52-vertex-diagnostic/index.ts", import.meta.url));
  assert(!/createClient|createAdminClient|verifyUser|\.from\s*\(|\.select\s*\(|\.insert\s*\(|\.update\s*\(|\.delete\s*\(|\.upsert\s*\(|\.rpc\s*\(/.test(source));
  assert(!/parseDocument|parse-pdf-docling|runVertexFactLedgerPipeline|callGemini|callOpenAI|getAzureDocumentIntelligenceConfig|callVertexAIWithFile/.test(source));
});

Deno.test("callVertexAISingleRequestDiagnostic makes one generateContent request with fixed model and location", async () => {
  const previousProject = Deno.env.get("VERTEX_PROJECT_ID");
  const previousLocation = Deno.env.get("VERTEX_LOCATION");
  const previousModel = Deno.env.get("VERTEX_MODEL");
  try {
    Deno.env.set("VERTEX_PROJECT_ID", "phase52-project");
    Deno.env.set("VERTEX_LOCATION", "us-east4");
    Deno.env.set("VERTEX_MODEL", "phase52-model");
    const urls: string[] = [];
    const resp = await callVertexAISingleRequestDiagnostic({
      userPrompt: cravenSample,
      systemPrompt: "Return JSON only.",
      accessToken: "test-access-token",
      fetchImpl: async (url, init) => {
        urls.push(String(url));
        const body = JSON.parse(String(init?.body));
        assertEquals(body.generationConfig.temperature, 0);
        assertEquals(body.generationConfig.responseMimeType, "application/json");
        assertEquals(init?.headers?.Authorization ?? init?.headers?.get?.("Authorization"), "Bearer test-access-token");
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify({ facts: [] }) }] } }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 },
        }), { status: 200 });
      },
    });
    assertEquals(urls.length, 1);
    assert(urls[0].includes("/locations/us-east4/"));
    assert(urls[0].includes("/models/phase52-model:generateContent"));
    assertEquals(resp.model, "phase52-model");
    assertEquals(resp.location, "us-east4");
    assertEquals(resp.inputTokens, 10);
    assertEquals(resp.outputTokens, 4);
  } finally {
    if (previousProject == null) Deno.env.delete("VERTEX_PROJECT_ID"); else Deno.env.set("VERTEX_PROJECT_ID", previousProject);
    if (previousLocation == null) Deno.env.delete("VERTEX_LOCATION"); else Deno.env.set("VERTEX_LOCATION", previousLocation);
    if (previousModel == null) Deno.env.delete("VERTEX_MODEL"); else Deno.env.set("VERTEX_MODEL", previousModel);
  }
});

Deno.test("callVertexAISingleRequestDiagnostic does not retry model or location fallback on failure", async () => {
  const previousProject = Deno.env.get("VERTEX_PROJECT_ID");
  const previousLocation = Deno.env.get("VERTEX_LOCATION");
  const previousModel = Deno.env.get("VERTEX_MODEL");
  try {
    Deno.env.set("VERTEX_PROJECT_ID", "phase52-project");
    Deno.env.set("VERTEX_LOCATION", "us-central1");
    Deno.env.set("VERTEX_MODEL", "phase52-model");
    let calls = 0;
    await assertRejects(
      () => callVertexAISingleRequestDiagnostic({
        userPrompt: cravenSample,
        accessToken: "test-access-token",
        fetchImpl: async () => {
          calls += 1;
          return new Response("not found", { status: 404 });
        },
      }),
      Error,
      "status 404",
    );
    assertEquals(calls, 1);
  } finally {
    if (previousProject == null) Deno.env.delete("VERTEX_PROJECT_ID"); else Deno.env.set("VERTEX_PROJECT_ID", previousProject);
    if (previousLocation == null) Deno.env.delete("VERTEX_LOCATION"); else Deno.env.set("VERTEX_LOCATION", previousLocation);
    if (previousModel == null) Deno.env.delete("VERTEX_MODEL"); else Deno.env.set("VERTEX_MODEL", previousModel);
  }
});

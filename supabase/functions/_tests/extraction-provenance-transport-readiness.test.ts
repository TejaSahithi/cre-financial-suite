// @ts-nocheck
// Release 2 (review correction 3, corrected): the plan originally believed
// provider_invocations.provider's CHECK constraint blocked 'openai'. It
// doesn't -- a later migration (20260855000000_provider_invocations_add_openai.sql)
// already widened it, discovered here when the "prove the blocker" test
// below unexpectedly passed the insert instead of failing it. Both test
// groups now assert the TRUE current state (both providers schema-
// compatible, neither wrapper has a live caller) and keep a live-DB
// regression guard so a future re-narrowing of the constraint is caught.
//
// Run: deno test --allow-all --no-check extraction-provenance-transport-readiness.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.2";
import { evaluateTransportWrapperReadiness } from "../_shared/extraction/document-intelligence-v3/transport-readiness.ts";

Deno.test("evaluateTransportWrapperReadiness: both providers are schema-compatible; neither wrapper has a live caller yet", () => {
  const readiness = evaluateTransportWrapperReadiness();
  assertEquals(readiness.azure.providerConstraint, "compatible");
  assertEquals(readiness.openai.providerConstraint, "compatible");
  assertEquals(readiness.azure.hasLiveCaller, false);
  assertEquals(readiness.openai.hasLiveCaller, false);
  assert(readiness.details.some((d) => d.includes("has any production caller")));
});

// ── Live proof against a real local Postgres ────────────────────────────

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

function adminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function insertOne(client: ReturnType<typeof adminClient>, table: string, values: Record<string, unknown>) {
  const { data, error } = await client.from(table).insert(values).select("*").single();
  if (error) throw new Error(`insert into ${table} failed: ${JSON.stringify(error)}`);
  return data;
}

async function setupRunAndStage(admin: ReturnType<typeof adminClient>, suffix: string) {
  const org = await insertOne(admin, "organizations", {
    name: `Transport Readiness Org ${suffix}`,
    status: "active",
    primary_contact_email: `transport-readiness-${suffix}@example.test`,
  });
  const uploadedFile = await insertOne(admin, "uploaded_files", {
    org_id: org.id,
    module_type: "leases",
    file_name: `transport-readiness-${suffix}.pdf`,
    file_url: `https://example.test/${suffix}.pdf`,
    mime_type: "application/pdf",
    status: "validating",
  });
  const run = await insertOne(admin, "extraction_runs", {
    org_id: org.id,
    uploaded_file_id: uploadedFile.id,
    generation_id: crypto.randomUUID(),
    run_type: "initial_extraction",
    contract_version: "test",
    status: "running",
  });
  const stageRun = await insertOne(admin, "extraction_stage_runs", {
    org_id: org.id,
    run_id: run.id,
    stage: "normalize",
    status: "running",
  });
  return { org, uploadedFile, run, stageRun };
}

Deno.test({
  name: "provider_invocations: inserting provider='openai' succeeds today -- the constraint was already widened by 20260855000000_provider_invocations_add_openai.sql",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, run, stageRun } = await setupRunAndStage(admin, suffix);

    const { data, error } = await admin.from("provider_invocations").insert({
      org_id: org.id,
      run_id: run.id,
      stage_run_id: stageRun.id,
      provider: "openai",
      operation: "fact_extraction_chunk",
      invocation_key: `test:${suffix}:openai`,
      requested_at: new Date().toISOString(),
    }).select("*").single();

    assertEquals(error, null, "openai should be a schema-compatible provider value today");
    assertEquals(data?.provider, "openai");
  },
});

Deno.test({
  name: "provider_invocations: an invalid provider value not in the CHECK constraint's list still fails, proving the constraint is real and enforced (regression guard)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, run, stageRun } = await setupRunAndStage(admin, suffix);

    const { error } = await admin.from("provider_invocations").insert({
      org_id: org.id,
      run_id: run.id,
      stage_run_id: stageRun.id,
      provider: "not_a_real_provider",
      operation: "layout_analysis",
      invocation_key: `test:${suffix}:invalid`,
      requested_at: new Date().toISOString(),
    });

    assert(error, "an unrecognized provider value must still be rejected");
    assertEquals(error.code, "23514");
  },
});

Deno.test({
  name: "provider_invocations: inserting a currently-allowed provider (azure_document_intelligence) succeeds, proving the setup itself is FK-valid",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, run, stageRun } = await setupRunAndStage(admin, suffix);

    const { data, error } = await admin.from("provider_invocations").insert({
      org_id: org.id,
      run_id: run.id,
      stage_run_id: stageRun.id,
      provider: "azure_document_intelligence",
      operation: "layout_analysis",
      invocation_key: `test:${suffix}:azure`,
      requested_at: new Date().toISOString(),
    }).select("*").single();

    assertEquals(error, null);
    assertEquals(data?.provider, "azure_document_intelligence");
  },
});

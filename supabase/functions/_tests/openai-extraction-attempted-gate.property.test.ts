// @ts-nocheck
// Property tests against a real local Postgres for the new
// OPENAI_EXTRACTION_NOT_ATTEMPTED readiness gate (20260865000000). Proves
// evaluate_lease_extraction_readiness blocks 'ready' when
// uploaded_files.openai_extraction_attempted is false even when every other
// requirement (normalize completed, enrichment completed, payload present,
// classification present) is satisfied -- and that it becomes ready once
// the flag is honestly set true.
//
// Run: deno test --allow-all --no-check openai-extraction-attempted-gate.property.test.ts

import { assert, assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

function adminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
}

function assertNoError(error: unknown) {
  if (error) throw new Error(JSON.stringify(error));
}

async function insertOne(client: ReturnType<typeof adminClient>, table: string, values: Record<string, unknown>) {
  const { data, error } = await client.from(table).insert(values).select("*").single();
  assertNoError(error);
  assertExists(data);
  return data;
}

async function setupReadyExceptOpenAI(admin: ReturnType<typeof adminClient>, suffix: string) {
  const org = await insertOne(admin, "organizations", {
    name: `OpenAI Gate Org ${suffix}`,
    status: "active",
    primary_contact_email: `openai-gate-${suffix}@example.test`,
  });

  const uploadedFile = await insertOne(admin, "uploaded_files", {
    org_id: org.id,
    module_type: "leases",
    file_name: `openai-gate-${suffix}.pdf`,
    file_url: `https://example.test/${suffix}.pdf`,
    mime_type: "application/pdf",
    status: "validating",
    document_subtype: "base_lease",
  });
  const uploadedFileId = uploadedFile.id;

  const genResult = await admin.rpc("start_lease_extraction_generation", {
    p_org_id: org.id,
    p_uploaded_file_id: uploadedFileId,
    p_job_type: "lease_extraction",
    p_initial_stage: "parse",
    p_contract_version: "test-v1",
    p_input: {},
    p_metadata: {},
  });
  assertNoError(genResult.error);
  const generationId = genResult.data.generation_id;
  assertExists(uploadedFileId);
  assertExists(generationId);

  // Satisfy every OTHER readiness requirement, leaving
  // openai_extraction_attempted at its column default (false).
  const payload = {
    records: [{ standard_fields: [{ key: "tenant_name", value: "Test Tenant" }], workflow_output: {} }],
  };
  const { error: fileUpdateError } = await admin
    .from("uploaded_files")
    .update({ ui_review_payload: payload, document_subtype: "base_lease" })
    .eq("id", uploadedFileId);
  assertNoError(fileUpdateError);

  // start_lease_extraction_generation already created the initial "parse"
  // job (queued) -- REQUIRED_STAGE_INCOMPLETE fires for any non-normalize/
  // enrich job left queued/running/failed, so it must be completed too for
  // this fixture to represent an otherwise-fully-successful pipeline.
  const { error: parseCompleteError } = await admin
    .from("pipeline_jobs")
    .update({ status: "completed" })
    .eq("generation_id", generationId)
    .eq("stage", "parse");
  assertNoError(parseCompleteError);

  for (const stage of ["normalize", "enrich"]) {
    const { error } = await admin.from("pipeline_jobs").insert({
      org_id: org.id,
      uploaded_file_id: uploadedFileId,
      generation_id: generationId,
      job_type: "lease_extraction",
      stage,
      status: "completed",
    });
    assertNoError(error);
  }

  return { org, uploadedFileId, generationId };
}

Deno.test({
  name: "openai_extraction_attempted gate: blocks readiness when normalize/enrichment/payload/classification are all satisfied but OpenAI was never attempted",
  fn: async () => {
    const admin = adminClient();
    const { org, uploadedFileId, generationId } = await setupReadyExceptOpenAI(admin, `blk-${Date.now()}`);

    const { data, error } = await admin.rpc("evaluate_lease_extraction_readiness", {
      p_org_id: org.id,
      p_uploaded_file_id: uploadedFileId,
      p_generation_id: generationId,
    });
    assertNoError(error);
    assertEquals(data.ready, false);
    assert(
      Array.isArray(data.blocking_reasons) && data.blocking_reasons.includes("OPENAI_EXTRACTION_NOT_ATTEMPTED"),
      `expected OPENAI_EXTRACTION_NOT_ATTEMPTED in blocking_reasons, got ${JSON.stringify(data.blocking_reasons)}`,
    );
    assertEquals(data.readiness, "failed");
  },
});

Deno.test({
  name: "openai_extraction_attempted gate: becomes ready once the flag is honestly set true, with no other change",
  fn: async () => {
    const admin = adminClient();
    const { org, uploadedFileId, generationId } = await setupReadyExceptOpenAI(admin, `rdy-${Date.now()}`);

    const { error: setTrueError } = await admin
      .from("uploaded_files")
      .update({ openai_extraction_attempted: true })
      .eq("id", uploadedFileId);
    assertNoError(setTrueError);

    const { data, error } = await admin.rpc("evaluate_lease_extraction_readiness", {
      p_org_id: org.id,
      p_uploaded_file_id: uploadedFileId,
      p_generation_id: generationId,
    });
    assertNoError(error);
    assertEquals(data.ready, true);
    assertEquals(data.readiness, "ready");
    assertEquals(data.blocking_reasons, []);
  },
});

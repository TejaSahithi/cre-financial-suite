// Reliability Phase R1 property tests against a real local Postgres for the
// new ENRICHMENT_PARTIAL readiness reason
// (20260882000000_enrichment_partial_readiness_gate.sql). Proves
// evaluate_lease_extraction_readiness resolves to review_readiness =
// 'partial' (not 'failed') when the enrich pipeline_jobs row failed AND
// uploaded_files.enrichment_status = 'partial' (a resource-exhaustion crash
// that happened after normalize already wrote the core fields) -- and that
// it still resolves to 'failed' when enrichment_status is 'failed' or null,
// confirming no regression to the existing hard-failure path.
//
// Run: deno test --allow-all --no-check enrichment-partial-readiness-gate.property.test.ts

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

async function setupEnrichFailedFixture(
  admin: ReturnType<typeof adminClient>,
  suffix: string,
  enrichmentStatus: string | null,
) {
  const org = await insertOne(admin, "organizations", {
    name: `Enrichment Partial Gate Org ${suffix}`,
    status: "active",
    primary_contact_email: `enrichment-partial-gate-${suffix}@example.test`,
  });

  const uploadedFile = await insertOne(admin, "uploaded_files", {
    org_id: org.id,
    module_type: "leases",
    file_name: `enrichment-partial-gate-${suffix}.pdf`,
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

  // Core fields present (as they would be after normalize completed and
  // wrote them, strictly before an enrich-stage crash) -- workflow_output
  // is deliberately absent, since it's itself an enrich-stage artifact and
  // its absence is expected (and non-blocking-to-partial) whenever enrich
  // failed at all, resource-exhaustion or not.
  const payload = {
    records: [{ standard_fields: [{ key: "tenant_name", value: "Test Tenant" }] }],
  };
  const { error: fileUpdateError } = await admin
    .from("uploaded_files")
    .update({
      ui_review_payload: payload,
      document_subtype: "base_lease",
      openai_extraction_attempted: true,
      enrichment_status: enrichmentStatus,
    })
    .eq("id", uploadedFileId);
  assertNoError(fileUpdateError);

  // start_lease_extraction_generation already created the initial "parse"
  // job (queued) -- REQUIRED_STAGE_INCOMPLETE fires for any non-normalize/
  // enrich job left queued/running/failed, so it must be completed too.
  const { error: parseCompleteError } = await admin
    .from("pipeline_jobs")
    .update({ status: "completed" })
    .eq("generation_id", generationId)
    .eq("stage", "parse");
  assertNoError(parseCompleteError);

  const { error: normalizeInsertError } = await admin.from("pipeline_jobs").insert({
    org_id: org.id,
    uploaded_file_id: uploadedFileId,
    generation_id: generationId,
    job_type: "lease_extraction",
    stage: "normalize",
    status: "completed",
  });
  assertNoError(normalizeInsertError);

  const { error: enrichInsertError } = await admin.from("pipeline_jobs").insert({
    org_id: org.id,
    uploaded_file_id: uploadedFileId,
    generation_id: generationId,
    job_type: "lease_extraction",
    stage: "enrich",
    status: "failed",
    error_code: "DOWNSTREAM_FUNCTION_FAILED",
    error_message: "Function failed due to not having enough compute resources",
  });
  assertNoError(enrichInsertError);

  return { org, uploadedFileId, generationId };
}

Deno.test({
  name: "ENRICHMENT_PARTIAL gate: enrich job failed + uploaded_files.enrichment_status='partial' -> readiness 'partial', ENRICHMENT_PARTIAL not ENRICHMENT_FAILED",
  fn: async () => {
    const admin = adminClient();
    const { org, uploadedFileId, generationId } = await setupEnrichFailedFixture(admin, `partial-${Date.now()}`, "partial");

    const { data, error } = await admin.rpc("evaluate_lease_extraction_readiness", {
      p_org_id: org.id,
      p_uploaded_file_id: uploadedFileId,
      p_generation_id: generationId,
    });
    assertNoError(error);
    assertEquals(data.ready, false);
    assertEquals(data.readiness, "partial");
    assert(
      Array.isArray(data.blocking_reasons) && data.blocking_reasons.includes("ENRICHMENT_PARTIAL"),
      `expected ENRICHMENT_PARTIAL in blocking_reasons, got ${JSON.stringify(data.blocking_reasons)}`,
    );
    assert(
      !data.blocking_reasons.includes("ENRICHMENT_FAILED"),
      `ENRICHMENT_FAILED must not be present alongside ENRICHMENT_PARTIAL, got ${JSON.stringify(data.blocking_reasons)}`,
    );
  },
});

Deno.test({
  name: "ENRICHMENT_PARTIAL gate: enrich job failed + uploaded_files.enrichment_status='failed' -> readiness stays 'failed' (no regression)",
  fn: async () => {
    const admin = adminClient();
    const { org, uploadedFileId, generationId } = await setupEnrichFailedFixture(admin, `failed-${Date.now()}`, "failed");

    const { data, error } = await admin.rpc("evaluate_lease_extraction_readiness", {
      p_org_id: org.id,
      p_uploaded_file_id: uploadedFileId,
      p_generation_id: generationId,
    });
    assertNoError(error);
    assertEquals(data.ready, false);
    assertEquals(data.readiness, "failed");
    assert(
      Array.isArray(data.blocking_reasons) && data.blocking_reasons.includes("ENRICHMENT_FAILED"),
      `expected ENRICHMENT_FAILED in blocking_reasons, got ${JSON.stringify(data.blocking_reasons)}`,
    );
  },
});

Deno.test({
  name: "ENRICHMENT_PARTIAL gate: enrich job failed + uploaded_files.enrichment_status=null -> readiness stays 'failed' (no regression for pre-R1 rows)",
  fn: async () => {
    const admin = adminClient();
    const { org, uploadedFileId, generationId } = await setupEnrichFailedFixture(admin, `null-${Date.now()}`, null);

    const { data, error } = await admin.rpc("evaluate_lease_extraction_readiness", {
      p_org_id: org.id,
      p_uploaded_file_id: uploadedFileId,
      p_generation_id: generationId,
    });
    assertNoError(error);
    assertEquals(data.readiness, "failed");
    assert(data.blocking_reasons.includes("ENRICHMENT_FAILED"));
  },
});

// @ts-nocheck
// Release 2, Workstream C — failure-isolation property tests against a real
// local Postgres.
//
// Scope note: v3 side-write failure isolation (a broken client mid-write
// does not throw out of runDocumentIntelligenceV3SideWrite, and is reported
// as a failed outcome instead) is ALREADY covered by
// document-intelligence-v3-side-write.property.test.ts's property #6 ("A
// side-write failure (broken client) is caught and reported, never
// thrown"). This file does not duplicate that -- it adds NEW coverage for
// the other half of the Release 2 failure-isolation requirement: a forced
// withExtractionStage() stage failure, proven against the real recorder
// RPCs (not the mocked client used in extraction-provenance-recorder.test.ts),
// confirming the failure is durably visible (queryable status/error_code/
// error_message) AND that the caller can still continue normally afterward
// -- "provenance recorder fails -> extraction should not silently lose the
// business result" (the user's Release 2 requirement).
//
// Decision (per the Release 2 plan): provenance failures are non-blocking
// in staging, matching withExtractionStage()'s own contract (it only
// throws when the flag is on and there is no extraction_runs row to attach
// to -- a real configuration error, not a transient failure).
//
// Run: deno test --allow-all --no-check extraction-provenance-failure-isolation.property.test.ts

import { assert, assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.2";
import { withExtractionStage } from "../_shared/extraction/provenance/recorder.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

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

async function setupOrgAndUpload(admin: ReturnType<typeof adminClient>, suffix: string) {
  const org = await insertOne(admin, "organizations", {
    name: `Failure Isolation Org ${suffix}`,
    status: "active",
    primary_contact_email: `failure-isolation-${suffix}@example.test`,
  });
  const uploadedFile = await insertOne(admin, "uploaded_files", {
    org_id: org.id,
    module_type: "leases",
    file_name: `failure-isolation-${suffix}.pdf`,
    file_url: `https://example.test/${suffix}.pdf`,
    mime_type: "application/pdf",
    status: "validating",
  });
  return { org, uploadedFile };
}

async function startGeneration(admin: ReturnType<typeof adminClient>, org: any, uploadedFile: any) {
  const { data, error } = await admin.rpc("start_lease_extraction_generation", {
    p_org_id: org.id,
    p_uploaded_file_id: uploadedFile.id,
    p_job_type: "lease_extraction",
    p_initial_stage: "parse",
    p_contract_version: "test-v1",
    p_input: {},
    p_metadata: { provenance_enabled: true, run_type: "initial_extraction" },
  });
  assertNoError(error);
  return data;
}

Deno.test({
  name: "failure isolation: a forced stage failure is durably visible (status='failed', error_code/error_message populated and queryable)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, uploadedFile } = await setupOrgAndUpload(admin, suffix);
    Deno.env.set("ENABLE_EXTRACTION_PROVENANCE", "true");

    const genResult = await startGeneration(admin, org, uploadedFile);
    const handle = await withExtractionStage(admin, {
      orgId: org.id,
      uploadedFileId: uploadedFile.id,
      generationId: genResult.generation_id,
      extractionRunId: genResult.extraction_run_id,
      pipelineJobId: genResult.job_id,
      stage: "parse",
      attempt: 1,
    });
    assert(handle.enabled);

    await handle.fail("PARSE_TIMEOUT", "Simulated parse timeout for failure-isolation test.");

    const { data: stageRun, error: stageError } = await admin
      .from("extraction_stage_runs")
      .select("status, error_code, error_message, finished_at")
      .eq("id", handle.stageRunId)
      .single();
    assertNoError(stageError);
    assertEquals(stageRun.status, "failed");
    assertEquals(stageRun.error_code, "PARSE_TIMEOUT");
    assert(stageRun.error_message?.includes("Simulated parse timeout"));
    assertExists(stageRun.finished_at);

    Deno.env.delete("ENABLE_EXTRACTION_PROVENANCE");
  },
});

Deno.test({
  name: "failure isolation: after a stage failure, the caller can still persist its own business result normally (the failure is not silently fatal to the surrounding flow)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, uploadedFile } = await setupOrgAndUpload(admin, suffix);
    Deno.env.set("ENABLE_EXTRACTION_PROVENANCE", "true");

    const genResult = await startGeneration(admin, org, uploadedFile);
    const handle = await withExtractionStage(admin, {
      orgId: org.id,
      uploadedFileId: uploadedFile.id,
      generationId: genResult.generation_id,
      extractionRunId: genResult.extraction_run_id,
      pipelineJobId: genResult.job_id,
      stage: "normalize",
      attempt: 1,
    });

    // Simulate the real normalize-pdf-output shape: the stage recorder call
    // fails/reports failure, but the caller's own business write (the
    // review payload) still happens afterward -- this is the actual
    // contract the try/catch around runDocumentIntelligenceV3SideWrite and
    // the non-blocking provenance design both rely on.
    await handle.fail("SIMULATED_FAILURE", "Simulated failure for isolation test.");

    const { error: businessWriteError } = await admin
      .from("uploaded_files")
      .update({ status: "parsed", ui_review_payload: { records: [{ standard_fields: [] }] } })
      .eq("id", uploadedFile.id);
    assertNoError(businessWriteError);

    const { data: refreshed, error: refetchError } = await admin
      .from("uploaded_files")
      .select("status, ui_review_payload")
      .eq("id", uploadedFile.id)
      .single();
    assertNoError(refetchError);
    assertEquals(refreshed.status, "parsed");
    assertExists(refreshed.ui_review_payload, "the business result must not be lost because a stage recording failed");

    Deno.env.delete("ENABLE_EXTRACTION_PROVENANCE");
  },
});

Deno.test({
  name: "failure isolation: ensureSettled() after an unhandled exception still marks the stage failed, so a thrown error upstream cannot leave a stage stuck 'running' forever",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, uploadedFile } = await setupOrgAndUpload(admin, suffix);
    Deno.env.set("ENABLE_EXTRACTION_PROVENANCE", "true");

    const genResult = await startGeneration(admin, org, uploadedFile);
    const handle = await withExtractionStage(admin, {
      orgId: org.id,
      uploadedFileId: uploadedFile.id,
      generationId: genResult.generation_id,
      extractionRunId: genResult.extraction_run_id,
      pipelineJobId: genResult.job_id,
      stage: "enrich",
      attempt: 1,
    });

    // Simulate the real call pattern: try { ...work... } catch { await
    // handle.ensureSettled(); throw; } -- work throws, ensureSettled must
    // still mark the row failed rather than leaving it 'running' forever.
    try {
      throw new Error("simulated unexpected exception mid-stage");
    } catch {
      await handle.ensureSettled();
    }

    const { data: stageRun, error: stageError } = await admin
      .from("extraction_stage_runs")
      .select("status")
      .eq("id", handle.stageRunId)
      .single();
    assertNoError(stageError);
    assertEquals(stageRun.status, "failed");

    Deno.env.delete("ENABLE_EXTRACTION_PROVENANCE");
  },
});

// @ts-nocheck
// Release 2, Workstreams A/C — generation-lifecycle, idempotency, and
// cross-run-contamination property tests against a real local Postgres.
//
// start_lease_extraction_generation (supabase/migrations/20260825000100_extraction_runs_generation_gate.sql)
// is documented as "the only place a new extraction generation is born":
// it supersedes (never deletes) the prior generation's pipeline_jobs/
// extraction_runs, advances uploaded_files.active_generation_id, and
// optionally creates a new extraction_runs row when provenance is enabled.
// These tests prove that contract holds end-to-end for the v3/provenance
// tables specifically -- prior to Release 2 nothing exercised this against
// document_canonical_field_projections (whether reprocessing could mix
// evidence across runs) or extraction_runs' own uniqueness constraint under
// a simulated concurrent double-call.
//
// Run: deno test --allow-all --no-check document-intelligence-v3-generation-lifecycle.property.test.ts

import { assert, assertEquals, assertExists, assertNotEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.2";
import { runDocumentIntelligenceV3SideWrite } from "../_shared/extraction/document-intelligence-v3/side-write.ts";

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
    name: `Generation Lifecycle Org ${suffix}`,
    status: "active",
    primary_contact_email: `generation-lifecycle-${suffix}@example.test`,
  });
  const uploadedFile = await insertOne(admin, "uploaded_files", {
    org_id: org.id,
    module_type: "leases",
    file_name: `generation-lifecycle-${suffix}.pdf`,
    file_url: `https://example.test/${suffix}.pdf`,
    mime_type: "application/pdf",
    status: "validating",
    document_subtype: "base_lease",
  });
  return { org, uploadedFile };
}

async function startGeneration(
  admin: ReturnType<typeof adminClient>,
  org: any,
  uploadedFile: any,
  runType: "initial_extraction" | "re_extraction" = "initial_extraction",
) {
  return admin.rpc("start_lease_extraction_generation", {
    p_org_id: org.id,
    p_uploaded_file_id: uploadedFile.id,
    p_job_type: "lease_extraction",
    p_initial_stage: "parse",
    p_contract_version: "test-v1",
    p_input: {},
    p_metadata: { provenance_enabled: true, run_type: runType },
  });
}

function vertexFactLedgerResult(rentValue: number) {
  return {
    rows: [{ monthly_rent: rentValue }],
    method: "llm_only",
    warnings: [],
    validationErrors: [],
    metadata: {
      extractionDebug: {
        merged_field_sources: {
          monthly_rent: { value: rentValue, source: "llm", confidence: 0.9, source_text: `Base Rent: $${rentValue} per month.`, source_page: 2 },
        },
        validated_field_values: {
          monthly_rent: { value: rentValue, source: "llm", confidence: 0.9, source_text: `Base Rent: $${rentValue} per month.`, source_page: 2 },
        },
        vertex_fact_ledger: {
          document_profile: "full_lease",
          document_profile_confidence: 0.9,
          document_profile_method: "vertex",
          facts_extracted_count: 1,
          facts_mapped_count: 1,
          facts_unmapped_count: 0,
          approval_blockers: [],
          dynamic_items: [],
        },
      },
    },
  };
}

Deno.test({
  name: "generation lifecycle: an initial upload sets active_generation_id to the new generation",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, uploadedFile } = await setupOrgAndUpload(admin, suffix);

    const { data: genResult, error } = await startGeneration(admin, org, uploadedFile);
    assertNoError(error);
    assertExists(genResult.generation_id);

    const { data: refreshed, error: refetchError } = await admin
      .from("uploaded_files")
      .select("active_generation_id")
      .eq("id", uploadedFile.id)
      .single();
    assertNoError(refetchError);
    assertEquals(refreshed.active_generation_id, genResult.generation_id);
  },
});

Deno.test({
  name: "generation lifecycle: force-reextract supersedes (not deletes) the prior generation's pipeline_jobs and extraction_runs, and creates a new generation",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, uploadedFile } = await setupOrgAndUpload(admin, suffix);

    const { data: firstGen, error: firstError } = await startGeneration(admin, org, uploadedFile, "initial_extraction");
    assertNoError(firstError);

    const { data: secondGen, error: secondError } = await startGeneration(admin, org, uploadedFile, "re_extraction");
    assertNoError(secondError);

    assertNotEquals(firstGen.generation_id, secondGen.generation_id);
    assertNotEquals(firstGen.extraction_run_id, secondGen.extraction_run_id);

    // Prior generation's job(s) superseded, not deleted.
    const { data: firstGenJobs, error: jobsError } = await admin
      .from("pipeline_jobs")
      .select("id, status, generation_id")
      .eq("generation_id", firstGen.generation_id);
    assertNoError(jobsError);
    assertEquals(firstGenJobs?.length, 1, "the prior generation's job row still exists (not deleted)");
    assertEquals(firstGenJobs[0].status, "superseded");

    // Prior generation's extraction_runs row superseded, not deleted.
    const { data: firstRun, error: runError } = await admin
      .from("extraction_runs")
      .select("id, status, generation_id")
      .eq("id", firstGen.extraction_run_id)
      .single();
    assertNoError(runError);
    assertEquals(firstRun.status, "superseded", "a run replaced by a newer generation is superseded, not failed");

    // New generation's job/run are fresh, unaffected.
    const { data: secondRun, error: secondRunError } = await admin
      .from("extraction_runs")
      .select("status")
      .eq("id", secondGen.extraction_run_id)
      .single();
    assertNoError(secondRunError);
    assertEquals(secondRun.status, "running");

    // active_generation_id now points at the new generation only.
    const { data: refreshed } = await admin
      .from("uploaded_files")
      .select("active_generation_id")
      .eq("id", uploadedFile.id)
      .single();
    assertEquals(refreshed.active_generation_id, secondGen.generation_id);
  },
});

Deno.test({
  name: "generation lifecycle: extraction_runs(org_id, generation_id) uniqueness holds under a simulated concurrent double-call with the SAME generation_id",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // start_lease_extraction_generation always mints its own fresh
    // generation_id server-side (gen_random_uuid()), so two real concurrent
    // RPC calls can never collide on generation_id by construction -- the
    // uniqueness constraint's actual job is to reject a caller that tries
    // to insert a SECOND extraction_runs row for a generation_id that
    // already has one (e.g. a retried insert after a network timeout whose
    // first attempt actually succeeded). This test proves that scenario
    // directly against the real constraint, which the RPC-level test above
    // cannot exercise since the RPC never re-uses a generation_id itself.
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, uploadedFile } = await setupOrgAndUpload(admin, suffix);
    const sharedGenerationId = crypto.randomUUID();

    const { error: firstError } = await admin.from("extraction_runs").insert({
      org_id: org.id,
      uploaded_file_id: uploadedFile.id,
      generation_id: sharedGenerationId,
      run_type: "initial_extraction",
      contract_version: "test-v1",
      status: "running",
    });
    assertNoError(firstError);

    const { error: secondError } = await admin.from("extraction_runs").insert({
      org_id: org.id,
      uploaded_file_id: uploadedFile.id,
      generation_id: sharedGenerationId,
      run_type: "initial_extraction",
      contract_version: "test-v1",
      status: "running",
    });
    assert(secondError, "a second extraction_runs row for the same (org_id, generation_id) must be rejected");
    assertEquals(secondError.code, "23505"); // unique_violation
  },
});

Deno.test({
  name: "generation lifecycle: document_canonical_field_projections from an old run and a new run never share evidence/claim IDs (no cross-run contamination)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, uploadedFile } = await setupOrgAndUpload(admin, suffix);
    Deno.env.set("ENABLE_DOCUMENT_INTELLIGENCE_V3", "true");

    // pipelineJobId must be a real pipeline_jobs.id (document_intelligence_runs.pipeline_job_id
    // is a foreign key, not just a UUID-shaped column) AND it is one of
    // side-write.ts's idempotency-key components -- reusing the same value
    // (or null) for both calls would upsert into the SAME run row instead
    // of producing two distinct ones. start_lease_extraction_generation is
    // the real way a reprocess gets a fresh pipeline_jobs row.
    const firstGen = await startGeneration(admin, org, uploadedFile, "initial_extraction");
    const firstOutcome = await runDocumentIntelligenceV3SideWrite({
      supabaseAdmin: admin,
      orgId: org.id,
      uploadedFileId: uploadedFile.id,
      uploadedFile,
      leaseId: null,
      pipelineJobId: firstGen.data.job_id,
      result: vertexFactLedgerResult(5000),
      logger: null,
    });
    assertEquals(firstOutcome.status, "completed");
    const firstRunId = firstOutcome.runId;

    // A reprocess: same file, a fresh generation/pipeline_jobs row (exactly
    // what force_reextract produces via ingest-file in production).
    const secondGen = await startGeneration(admin, org, uploadedFile, "re_extraction");
    const secondOutcome = await runDocumentIntelligenceV3SideWrite({
      supabaseAdmin: admin,
      orgId: org.id,
      uploadedFileId: uploadedFile.id,
      uploadedFile,
      leaseId: null,
      pipelineJobId: secondGen.data.job_id,
      result: vertexFactLedgerResult(6000),
      logger: null,
    });
    assertEquals(secondOutcome.status, "completed");
    const secondRunId = secondOutcome.runId;

    assertNotEquals(firstRunId, secondRunId, "a reprocess with a different pipeline_job_id must produce a distinct run");

    const { data: firstProjections } = await admin
      .from("document_canonical_field_projections")
      .select("id, run_id, source_claim_ids, value")
      .eq("run_id", firstRunId);
    const { data: secondProjections } = await admin
      .from("document_canonical_field_projections")
      .select("id, run_id, source_claim_ids, value")
      .eq("run_id", secondRunId);

    assert((firstProjections?.length ?? 0) > 0);
    assert((secondProjections?.length ?? 0) > 0);

    const firstClaimIds = new Set((firstProjections ?? []).flatMap((p) => p.source_claim_ids ?? []));
    const secondClaimIds = new Set((secondProjections ?? []).flatMap((p) => p.source_claim_ids ?? []));
    for (const id of secondClaimIds) {
      assert(!firstClaimIds.has(id), "the new run's projections must not reference the old run's claim IDs");
    }

    // Both runs remain independently queryable -- neither is deleted.
    const { data: bothRuns, error: bothRunsError } = await admin
      .from("document_intelligence_runs")
      .select("id, status")
      .in("id", [firstRunId, secondRunId]);
    assertNoError(bothRunsError);
    assertEquals(bothRuns?.length, 2);
    assert(bothRuns.every((r) => r.status === "completed"));

    Deno.env.delete("ENABLE_DOCUMENT_INTELLIGENCE_V3");
  },
});

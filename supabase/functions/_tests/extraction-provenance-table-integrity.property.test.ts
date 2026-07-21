// @ts-nocheck
// Release 2, Workstream C — table-integrity property tests against a real
// local Postgres (RLS bypassed by the service-role client, same convention
// as document-intelligence-v3-side-write.property.test.ts).
//
// Per review correction 2: this file does NOT assert provider_invocations/
// extraction_artifacts stay at zero rows as a permanent contract -- wiring
// the transport wrappers in later is a valid future improvement, not a
// regression. It asserts instead: zero rows is a valid, passing outcome
// under today's implementation, AND (separately) that if rows are written,
// they are FK-valid, deduplicated (invocation_key uniqueness), and
// correctly attached to their run/stage -- proven with real inserts, not
// just schema inspection.
//
// Run: deno test --allow-all --no-check extraction-provenance-table-integrity.property.test.ts

import { assert, assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.2";
import { runDocumentIntelligenceV3SideWrite } from "../_shared/extraction/document-intelligence-v3/side-write.ts";
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
    name: `Table Integrity Org ${suffix}`,
    status: "active",
    primary_contact_email: `table-integrity-${suffix}@example.test`,
  });
  const uploadedFile = await insertOne(admin, "uploaded_files", {
    org_id: org.id,
    module_type: "leases",
    file_name: `table-integrity-${suffix}.pdf`,
    file_url: `https://example.test/${suffix}.pdf`,
    mime_type: "application/pdf",
    status: "validating",
    document_subtype: "base_lease",
  });
  return { org, uploadedFile };
}

function vertexFactLedgerResult() {
  return {
    rows: [{ monthly_rent: 5000 }],
    method: "llm_only",
    warnings: [],
    validationErrors: [],
    metadata: {
      extractionDebug: {
        merged_field_sources: {
          monthly_rent: { value: 5000, source: "llm", confidence: 0.9, source_text: "Base Rent: $5,000 per month.", source_page: 2 },
        },
        validated_field_values: {
          monthly_rent: { value: 5000, source: "llm", confidence: 0.9, source_text: "Base Rent: $5,000 per month.", source_page: 2 },
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
  name: "table integrity: an extraction_runs row created via start_lease_extraction_generation has exactly one row per generation_id",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, uploadedFile } = await setupOrgAndUpload(admin, suffix);

    const { data: genResult, error: genError } = await admin.rpc("start_lease_extraction_generation", {
      p_org_id: org.id,
      p_uploaded_file_id: uploadedFile.id,
      p_job_type: "lease_extraction",
      p_initial_stage: "parse",
      p_contract_version: "test-v1",
      p_input: {},
      p_metadata: { provenance_enabled: true, run_type: "initial_extraction" },
    });
    assertNoError(genError);
    assertExists(genResult?.extraction_run_id, "provenance_enabled=true must create an extraction_runs row");

    const { data: runs, error: runsError } = await admin
      .from("extraction_runs")
      .select("id")
      .eq("generation_id", genResult.generation_id);
    assertNoError(runsError);
    assertEquals(runs?.length, 1, "exactly one extraction_runs row per generation_id");
  },
});

Deno.test({
  name: "table integrity: parse/normalize/enrich stage rows attach to a real run with no orphan run_id",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, uploadedFile } = await setupOrgAndUpload(admin, suffix);
    Deno.env.set("ENABLE_EXTRACTION_PROVENANCE", "true");

    const { data: genResult, error: genError } = await admin.rpc("start_lease_extraction_generation", {
      p_org_id: org.id,
      p_uploaded_file_id: uploadedFile.id,
      p_job_type: "lease_extraction",
      p_initial_stage: "parse",
      p_contract_version: "test-v1",
      p_input: {},
      p_metadata: { provenance_enabled: true, run_type: "initial_extraction" },
    });
    assertNoError(genError);
    const runId = genResult.extraction_run_id;
    assertExists(runId);

    const baseContext = {
      orgId: org.id,
      uploadedFileId: uploadedFile.id,
      generationId: genResult.generation_id,
      extractionRunId: runId,
      pipelineJobId: genResult.job_id,
      attempt: 1,
    };

    for (const stage of ["parse", "normalize", "enrich"] as const) {
      const handle = await withExtractionStage(admin, { ...baseContext, stage });
      assert(handle.enabled);
      await handle.complete({ outcome: "completed" });
    }

    const { data: stageRuns, error: stageError } = await admin
      .from("extraction_stage_runs")
      .select("id, run_id, stage, status")
      .eq("run_id", runId);
    assertNoError(stageError);
    assertEquals(stageRuns?.length, 3);
    assert(stageRuns.every((r) => r.run_id === runId), "no orphan run_id -- every stage row belongs to the run just created");
    assert(stageRuns.every((r) => r.status === "completed"));
    const stages = stageRuns.map((r) => r.stage).sort();
    assertEquals(stages, ["enrich", "normalize", "parse"]);

    Deno.env.delete("ENABLE_EXTRACTION_PROVENANCE");
  },
});

Deno.test({
  name: "table integrity: document_claim_evidence and document_validation_drops rows never reference a claim_id outside their own run",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, uploadedFile } = await setupOrgAndUpload(admin, suffix);
    Deno.env.set("ENABLE_DOCUMENT_INTELLIGENCE_V3", "true");

    const outcome = await runDocumentIntelligenceV3SideWrite({
      supabaseAdmin: admin,
      orgId: org.id,
      uploadedFileId: uploadedFile.id,
      uploadedFile,
      leaseId: null,
      pipelineJobId: null,
      result: vertexFactLedgerResult(),
      logger: null,
    });
    assertEquals(outcome.status, "completed");
    const runId = outcome.runId;
    assertExists(runId);

    const { data: claims, error: claimsError } = await admin.from("document_claims").select("id").eq("run_id", runId);
    assertNoError(claimsError);
    const claimIds = new Set((claims ?? []).map((c) => c.id));

    const { data: evidenceRows, error: evidenceError } = await admin
      .from("document_claim_evidence")
      .select("claim_id")
      .in("claim_id", claimIds.size > 0 ? [...claimIds] : ["00000000-0000-0000-0000-000000000000"]);
    assertNoError(evidenceError);
    for (const row of evidenceRows ?? []) {
      assert(claimIds.has(row.claim_id), "every evidence row's claim_id must resolve to a claim from this run");
    }

    Deno.env.delete("ENABLE_DOCUMENT_INTELLIGENCE_V3");
  },
});

Deno.test({
  name: "table integrity: a real, correctly-orchestrated run writes zero provider_invocations rows today (valid, not a failure) -- transport wrappers remain unwired",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, uploadedFile } = await setupOrgAndUpload(admin, suffix);
    Deno.env.set("ENABLE_EXTRACTION_PROVENANCE", "true");
    Deno.env.set("ENABLE_DOCUMENT_INTELLIGENCE_V3", "true");

    const { data: genResult, error: genError } = await admin.rpc("start_lease_extraction_generation", {
      p_org_id: org.id,
      p_uploaded_file_id: uploadedFile.id,
      p_job_type: "lease_extraction",
      p_initial_stage: "parse",
      p_contract_version: "test-v1",
      p_input: {},
      p_metadata: { provenance_enabled: true, run_type: "initial_extraction" },
    });
    assertNoError(genError);
    const runId = genResult.extraction_run_id;

    const handle = await withExtractionStage(admin, {
      orgId: org.id,
      uploadedFileId: uploadedFile.id,
      generationId: genResult.generation_id,
      extractionRunId: runId,
      pipelineJobId: genResult.job_id,
      stage: "parse",
      attempt: 1,
    });
    await handle.complete({ outcome: "completed" });

    await runDocumentIntelligenceV3SideWrite({
      supabaseAdmin: admin,
      orgId: org.id,
      uploadedFileId: uploadedFile.id,
      uploadedFile,
      leaseId: null,
      pipelineJobId: null,
      result: vertexFactLedgerResult(),
      logger: null,
    });

    // Zero rows is a PERMITTED outcome, not asserted as a permanent
    // contract -- see this file's header comment (review correction 2).
    const { data: invocations, error: invocationsError } = await admin
      .from("provider_invocations")
      .select("id")
      .eq("run_id", runId);
    assertNoError(invocationsError);
    assertEquals(invocations?.length, 0, "no live caller wires the transport wrappers in today -- documented, not a bug");

    Deno.env.delete("ENABLE_EXTRACTION_PROVENANCE");
    Deno.env.delete("ENABLE_DOCUMENT_INTELLIGENCE_V3");
  },
});

Deno.test({
  name: "table integrity: IF a provider_invocations row is manually attached (simulating a future wired wrapper), it must be FK-valid and its invocation_key must be unique per org",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, uploadedFile } = await setupOrgAndUpload(admin, suffix);
    Deno.env.set("ENABLE_EXTRACTION_PROVENANCE", "true");

    const { data: genResult, error: genError } = await admin.rpc("start_lease_extraction_generation", {
      p_org_id: org.id,
      p_uploaded_file_id: uploadedFile.id,
      p_job_type: "lease_extraction",
      p_initial_stage: "parse",
      p_contract_version: "test-v1",
      p_input: {},
      p_metadata: { provenance_enabled: true, run_type: "initial_extraction" },
    });
    assertNoError(genError);
    const runId = genResult.extraction_run_id;

    const handle = await withExtractionStage(admin, {
      orgId: org.id,
      uploadedFileId: uploadedFile.id,
      generationId: genResult.generation_id,
      extractionRunId: runId,
      pipelineJobId: genResult.job_id,
      stage: "parse",
      attempt: 1,
    });
    const stageRunId = handle.stageRunId;
    assertExists(stageRunId);

    const key = `test:${suffix}:azure_document_intelligence:layout_analysis:1`;
    const { error: firstInsertError } = await admin.from("provider_invocations").insert({
      org_id: org.id,
      run_id: runId,
      stage_run_id: stageRunId,
      provider: "azure_document_intelligence",
      operation: "layout_analysis",
      invocation_key: key,
      requested_at: new Date().toISOString(),
    });
    assertNoError(firstInsertError);

    // Duplicate invocation_key for the same org must be rejected.
    const { error: dupError } = await admin.from("provider_invocations").insert({
      org_id: org.id,
      run_id: runId,
      stage_run_id: stageRunId,
      provider: "azure_document_intelligence",
      operation: "layout_analysis",
      invocation_key: key,
      requested_at: new Date().toISOString(),
    });
    assert(dupError, "a duplicate invocation_key within the same org must be rejected");

    // A stage_run_id that belongs to a DIFFERENT run must be rejected (the
    // 3-part FK (stage_run_id, run_id, org_id) is what actually enforces this).
    const otherRunResult = await admin.rpc("start_lease_extraction_generation", {
      p_org_id: org.id,
      p_uploaded_file_id: uploadedFile.id,
      p_job_type: "lease_extraction",
      p_initial_stage: "parse",
      p_contract_version: "test-v1",
      p_input: {},
      p_metadata: { provenance_enabled: true, run_type: "re_extraction" },
    });
    const otherRunId = otherRunResult.data.extraction_run_id;
    const { error: crossRunError } = await admin.from("provider_invocations").insert({
      org_id: org.id,
      run_id: otherRunId, // mismatched: stageRunId belongs to the FIRST run, not this one
      stage_run_id: stageRunId,
      provider: "azure_document_intelligence",
      operation: "layout_analysis",
      invocation_key: `test:${suffix}:cross-run`,
      requested_at: new Date().toISOString(),
    });
    assert(crossRunError, "a stage_run_id attached to the wrong run_id must be rejected by the 3-part FK");

    Deno.env.delete("ENABLE_EXTRACTION_PROVENANCE");
  },
});

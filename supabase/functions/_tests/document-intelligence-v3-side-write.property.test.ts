// @ts-nocheck
// Phase 2 integration tests for the Document Intelligence v3 side-write
// (supabase/functions/_shared/extraction/document-intelligence-v3/side-write.ts),
// against a real local Supabase Postgres instance (RLS is bypassed by the
// service-role client, matching how normalize-pdf-output itself writes).
//
// Properties:
//   1. Feature flag disabled: zero DB calls, zero rows written.
//   2. Feature flag enabled + vertex_fact_ledger facts: creates a completed
//      document_intelligence_runs row with real claim/evidence counts.
//   3/4. Claims and their evidence land in document_claims /
//      document_claim_evidence with the mapped field's real value/source.
//   5. A legacy_hybrid-shaped result (no vertex_fact_ledger marker) still
//      completes the run, with claims_count = 0 and zero document_claims rows.
//   6. A side-write failure (broken client) is caught and reported, never
//      thrown -- proving a caller wrapping this call (as normalize-pdf-output
//      does) cannot have its own flow broken by it.
//   7. Retrying with identical inputs (same idempotency key) reuses the same
//      run_id and does not duplicate claims/evidence rows.
//
// Run: deno test --allow-env --allow-read --allow-net --no-lock document-intelligence-v3-side-write.property.test.ts

import { assert, assertEquals, assertExists, assertFalse } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.2";
import { runDocumentIntelligenceV3SideWrite } from "../_shared/extraction/document-intelligence-v3/side-write.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

function adminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
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
    name: `DI v3 Side-Write Org ${suffix}`,
    status: "active",
    primary_contact_email: `di-v3-${suffix}@example.test`,
  });
  const uploadedFile = await insertOne(admin, "uploaded_files", {
    org_id: org.id,
    module_type: "leases",
    file_name: `assignment-${suffix}.pdf`,
    file_url: `https://example.test/${suffix}.pdf`,
    mime_type: "application/pdf",
    status: "validating",
    document_subtype: "assignment",
  });
  return { org, uploadedFile };
}

function vertexFactLedgerResult() {
  return {
    rows: [{ monthly_rent: 5000 }],
    method: "llm_only",
    warnings: [],
    validationErrors: [
      { field: "start_date", message: "Invalid date format", receivedValue: "not-a-date", rowIndex: 0 },
    ],
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
          facts_extracted_count: 2,
          facts_mapped_count: 1,
          facts_unmapped_count: 1,
          approval_blockers: [],
          dynamic_items: [
            {
              item_id: "vertex_fact:clause:governing_law:abc",
              document_id: null,
              item_type: "clause:governing_law",
              label: "Governing Law",
              value: "Delaware",
              source_text: "Governed by the laws of the State of Delaware.",
              source_page: 5,
              confidence: 0.8,
              field_key: null,
            },
          ],
        },
      },
    },
  };
}

function vertexFactLedgerResultWithEvidenceAnchors() {
  const result = vertexFactLedgerResult();
  result.metadata.extractionDebug.vertex_fact_ledger.document_index_source = "canonical_layout";
  result.metadata.extractionDebug.vertex_fact_ledger.document_index_fallback_reason = null;
  result.metadata.extractionDebug.vertex_fact_ledger.evidence_anchors = [
    {
      category: "clause:rent_escalation",
      source_text: "Base Rent: $5,000 per month.",
      source_page: 2,
      block_ids: ["block-3"],
      polygon: [10, 20, 30, 40],
      support_type: "direct_quote",
    },
    {
      category: "clause:governing_law",
      source_text: "Governed by the laws of the State of Delaware.",
      source_page: 5,
      block_ids: [],
      polygon: [],
      support_type: null,
    },
  ];
  return result;
}

function legacyHybridResult() {
  return {
    rows: [{ monthly_rent: 5000 }],
    method: "hybrid",
    warnings: [],
    validationErrors: [],
    metadata: {
      extractionDebug: {
        merged_field_sources: { monthly_rent: { value: 5000, source: "rule", confidence: 0.8 } },
      },
    },
  };
}

Deno.test({
  name: "document intelligence v3 side-write: flag disabled makes zero DB calls and zero rows",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, uploadedFile } = await setupOrgAndUpload(admin, suffix);

    Deno.env.delete("ENABLE_DOCUMENT_INTELLIGENCE_V3");

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

    assertFalse(outcome.attempted);
    assertEquals(outcome.status, "skipped");
    assertEquals(outcome.runId, null);

    const { data: runs, error } = await admin
      .from("document_intelligence_runs")
      .select("id")
      .eq("uploaded_file_id", uploadedFile.id);
    assertNoError(error);
    assertEquals(runs?.length, 0, "no run row should exist when the flag is off");
  },
});

Deno.test({
  name: "document intelligence v3 side-write: flag enabled creates a completed run with real claim/evidence rows",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, uploadedFile } = await setupOrgAndUpload(admin, suffix);

    Deno.env.set("ENABLE_DOCUMENT_INTELLIGENCE_V3", "true");
    try {
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

      assert(outcome.attempted);
      assertEquals(outcome.status, "completed");
      assertExists(outcome.runId);
      assertEquals(outcome.claimsCount, 2); // one mapped field + one dynamic item
      assertEquals(outcome.evidenceCount, 2);
      assertEquals(outcome.validationDropsCount, 1);
      assertEquals(outcome.canonicalFieldProjectionCount, 1);

      const { data: runRow, error: runError } = await admin
        .from("document_intelligence_runs")
        .select("status, contract_version")
        .eq("id", outcome.runId)
        .single();
      assertNoError(runError);
      assertEquals(runRow.status, "completed");
      assertEquals(runRow.contract_version, "document_intelligence_v3.phase1");

      // Task G.3/G.4: claims and evidence actually landed with the right shape.
      const { data: claims, error: claimsError } = await admin
        .from("document_claims")
        .select("*")
        .eq("run_id", outcome.runId);
      assertNoError(claimsError);
      assertEquals(claims?.length, 2);
      const rentClaim = claims.find((c: any) => c.claim_type === "canonical_field");
      assertExists(rentClaim);
      assertEquals(rentClaim.object.field_key, "monthly_rent");
      assertEquals(rentClaim.object.value, 5000);
      assertEquals(rentClaim.extraction_mode, "explicit");

      const { data: evidenceRows, error: evidenceError } = await admin
        .from("document_claim_evidence")
        .select("*")
        .eq("claim_id", rentClaim.id);
      assertNoError(evidenceError);
      assertEquals(evidenceRows?.length, 1);
      assertEquals(evidenceRows[0].page, 2);
      assertEquals(evidenceRows[0].source_text, "Base Rent: $5,000 per month.");
      assertEquals(evidenceRows[0].support_type, "direct_quote");

      const { data: drops, error: dropsError } = await admin
        .from("document_validation_drops")
        .select("*")
        .eq("run_id", outcome.runId);
      assertNoError(dropsError);
      assertEquals(drops?.length, 1);
      assertEquals(drops[0].field_key, "start_date");

      const { data: projections, error: projectionsError } = await admin
        .from("document_canonical_field_projections")
        .select("*")
        .eq("run_id", outcome.runId);
      assertNoError(projectionsError);
      assertEquals(projections?.length, 1);
      assertEquals(projections[0].field_key, "monthly_rent");
      assertEquals(projections[0].status, "auto_populated");
    } finally {
      Deno.env.delete("ENABLE_DOCUMENT_INTELLIGENCE_V3");
    }
  },
});

Deno.test({
  name: "document intelligence v3 side-write: a legacy_hybrid result still completes the run with zero claims (no fabrication)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, uploadedFile } = await setupOrgAndUpload(admin, suffix);

    Deno.env.set("ENABLE_DOCUMENT_INTELLIGENCE_V3", "true");
    try {
      const outcome = await runDocumentIntelligenceV3SideWrite({
        supabaseAdmin: admin,
        orgId: org.id,
        uploadedFileId: uploadedFile.id,
        uploadedFile,
        leaseId: null,
        pipelineJobId: null,
        result: legacyHybridResult(),
        logger: null,
      });

      assert(outcome.attempted);
      assertEquals(outcome.status, "completed");
      assertEquals(outcome.claimsCount, 0);

      const { data: claims, error } = await admin
        .from("document_claims")
        .select("id")
        .eq("run_id", outcome.runId);
      assertNoError(error);
      assertEquals(claims?.length, 0);
    } finally {
      Deno.env.delete("ENABLE_DOCUMENT_INTELLIGENCE_V3");
    }
  },
});

Deno.test({
  name: "document intelligence v3 side-write: a broken client is caught and reported, never thrown",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    Deno.env.set("ENABLE_DOCUMENT_INTELLIGENCE_V3", "true");
    try {
      const brokenClient = {
        from() {
          return {
            upsert() {
              return {
                select() {
                  return {
                    single: async () => ({ data: null, error: { message: "simulated connection failure" } }),
                  };
                },
              };
            },
          };
        },
      };

      let thrown: unknown = null;
      let outcome: any = null;
      try {
        outcome = await runDocumentIntelligenceV3SideWrite({
          supabaseAdmin: brokenClient,
          orgId: "org-x",
          uploadedFileId: "uf-x",
          uploadedFile: {},
          leaseId: null,
          pipelineJobId: null,
          result: vertexFactLedgerResult(),
          logger: null,
        });
      } catch (error) {
        thrown = error;
      }

      assertEquals(thrown, null, "the side-write must never throw, even when its DB client is broken");
      assertExists(outcome);
      assertEquals(outcome.status, "failed");
      assertExists(outcome.error);
    } finally {
      Deno.env.delete("ENABLE_DOCUMENT_INTELLIGENCE_V3");
    }
  },
});

Deno.test({
  name: "document intelligence v3 side-write: retrying with the same inputs reuses the run and does not duplicate claims",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, uploadedFile } = await setupOrgAndUpload(admin, suffix);

    Deno.env.set("ENABLE_DOCUMENT_INTELLIGENCE_V3", "true");
    try {
      const params = {
        supabaseAdmin: admin,
        orgId: org.id,
        uploadedFileId: uploadedFile.id,
        uploadedFile,
        leaseId: null,
        pipelineJobId: null,
        result: vertexFactLedgerResult(),
        logger: null,
      };

      const first = await runDocumentIntelligenceV3SideWrite(params);
      const second = await runDocumentIntelligenceV3SideWrite(params);

      assertEquals(first.runId, second.runId, "identical inputs must resolve to the same run_id");
      assertEquals(second.claimsCount, first.claimsCount);

      const { data: runs, error: runsError } = await admin
        .from("document_intelligence_runs")
        .select("id")
        .eq("uploaded_file_id", uploadedFile.id);
      assertNoError(runsError);
      assertEquals(runs?.length, 1, "retrying must not create a second run row");

      const { data: claims, error: claimsError } = await admin
        .from("document_claims")
        .select("id")
        .eq("run_id", first.runId);
      assertNoError(claimsError);
      assertEquals(claims?.length, first.claimsCount, "retrying must not duplicate claim rows");
    } finally {
      Deno.env.delete("ENABLE_DOCUMENT_INTELLIGENCE_V3");
    }
  },
});

// ── Phase 5: canonical layout summary side-write (Task E) ───────────────────

function azureLikeDoclingRawFixture() {
  return {
    extraction_method: "azure_layout",
    full_text: "[[PAGE 1]]\nLEASE AGREEMENT\n\n[[PAGE 2]]\nBase Rent is $5,000 per month.",
    page_count: 2,
    pages: [
      { page: 1, text: "LEASE AGREEMENT" },
      { page: 2, text: "Base Rent is $5,000 per month." },
    ],
    text_blocks: [
      { block_index: 0, type: "title", text: "LEASE AGREEMENT", page: 1 },
      { block_index: 1, type: "paragraph", text: "Base Rent is $5,000 per month.", page: 2 },
    ],
    tables: [],
    fields: [],
    warnings: [],
    raw_response: null,
    _metadata: {
      provider: "azure_document_intelligence",
      extraction_method: "azure_layout",
      api_version: "2024-11-30",
      page_markers_present: true,
      page_mapping_coverage: 1,
      raw_response_stored: false,
    },
  };
}

Deno.test({
  name: "document intelligence v3 side-write: with docling_raw available and the flag on, layout_summary is computed and persisted on the run row (Phase 5 Task E)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, uploadedFile } = await setupOrgAndUpload(admin, suffix);
    const { error: doclingErr } = await admin
      .from("uploaded_files")
      .update({ docling_raw: azureLikeDoclingRawFixture() })
      .eq("id", uploadedFile.id);
    assertNoError(doclingErr);
    const uploadedFileWithDocling = { ...uploadedFile, docling_raw: azureLikeDoclingRawFixture() };

    Deno.env.set("ENABLE_DOCUMENT_INTELLIGENCE_V3", "true");
    try {
      const outcome = await runDocumentIntelligenceV3SideWrite({
        supabaseAdmin: admin,
        orgId: org.id,
        uploadedFileId: uploadedFile.id,
        uploadedFile: uploadedFileWithDocling,
        leaseId: null,
        pipelineJobId: null,
        result: vertexFactLedgerResult(),
        logger: null,
      });

      assertEquals(outcome.status, "completed");

      const { data: runRow, error: runError } = await admin
        .from("document_intelligence_runs")
        .select("layout_summary")
        .eq("id", outcome.runId)
        .single();
      assertNoError(runError);
      assertEquals(runRow.layout_summary.page_count, 2);
      assertEquals(runRow.layout_summary.text_block_count, 2);
      assertEquals(runRow.layout_summary.layout_provider, "azure_document_intelligence");
      assert(runRow.layout_summary.page_markers_present);
    } finally {
      Deno.env.delete("ENABLE_DOCUMENT_INTELLIGENCE_V3");
    }
  },
});

Deno.test({
  name: "document intelligence v3 side-write: with no docling_raw available, layout_summary is an empty object, not an error",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, uploadedFile } = await setupOrgAndUpload(admin, suffix);

    Deno.env.set("ENABLE_DOCUMENT_INTELLIGENCE_V3", "true");
    try {
      const outcome = await runDocumentIntelligenceV3SideWrite({
        supabaseAdmin: admin,
        orgId: org.id,
        uploadedFileId: uploadedFile.id,
        uploadedFile, // no docling_raw
        leaseId: null,
        pipelineJobId: null,
        result: vertexFactLedgerResult(),
        logger: null,
      });

      assertEquals(outcome.status, "completed");
      const { data: runRow, error: runError } = await admin
        .from("document_intelligence_runs")
        .select("layout_summary")
        .eq("id", outcome.runId)
        .single();
      assertNoError(runError);
      assertEquals(runRow.layout_summary, {});
    } finally {
      Deno.env.delete("ENABLE_DOCUMENT_INTELLIGENCE_V3");
    }
  },
});

// ── Phase 6 Task F: idempotency key enrichment with content_hash ────────────

function azureLikeDoclingRawFixtureVariant() {
  return {
    ...azureLikeDoclingRawFixture(),
    full_text: "[[PAGE 1]]\nDIFFERENT LEASE AGREEMENT\n\n[[PAGE 2]]\nBase Rent is $9,000 per month.",
  };
}

Deno.test({
  name: "document intelligence v3 side-write: same content_hash + same metadata reuses the same run (Phase 6 Task F / H.9)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, uploadedFile } = await setupOrgAndUpload(admin, suffix);
    const uploadedFileWithDocling = { ...uploadedFile, docling_raw: azureLikeDoclingRawFixture() };

    Deno.env.set("ENABLE_DOCUMENT_INTELLIGENCE_V3", "true");
    try {
      const params = {
        supabaseAdmin: admin,
        orgId: org.id,
        uploadedFileId: uploadedFile.id,
        uploadedFile: uploadedFileWithDocling,
        leaseId: null,
        pipelineJobId: null,
        result: vertexFactLedgerResult(),
        logger: null,
      };

      const first = await runDocumentIntelligenceV3SideWrite(params);
      const second = await runDocumentIntelligenceV3SideWrite(params);

      assertEquals(first.status, "completed");
      assertEquals(first.runId, second.runId, "identical content_hash + metadata must resolve to the same run_id");

      const { data: runs, error } = await admin
        .from("document_intelligence_runs")
        .select("id, idempotency_key")
        .eq("uploaded_file_id", uploadedFile.id);
      assertNoError(error);
      assertEquals(runs?.length, 1, "must not create a second run for identical content");
      assert(runs[0].idempotency_key.includes("content_hash:sha256:"), "the stored key must actually include the content_hash");
    } finally {
      Deno.env.delete("ENABLE_DOCUMENT_INTELLIGENCE_V3");
    }
  },
});

Deno.test({
  name: "document intelligence v3 side-write: a different content_hash produces a different run/idempotency key (Phase 6 Task F / H.10)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, uploadedFile } = await setupOrgAndUpload(admin, suffix);

    Deno.env.set("ENABLE_DOCUMENT_INTELLIGENCE_V3", "true");
    try {
      const first = await runDocumentIntelligenceV3SideWrite({
        supabaseAdmin: admin,
        orgId: org.id,
        uploadedFileId: uploadedFile.id,
        uploadedFile: { ...uploadedFile, docling_raw: azureLikeDoclingRawFixture() },
        leaseId: null,
        pipelineJobId: null,
        result: vertexFactLedgerResult(),
        logger: null,
      });
      const second = await runDocumentIntelligenceV3SideWrite({
        supabaseAdmin: admin,
        orgId: org.id,
        uploadedFileId: uploadedFile.id,
        uploadedFile: { ...uploadedFile, docling_raw: azureLikeDoclingRawFixtureVariant() },
        leaseId: null,
        pipelineJobId: null,
        result: vertexFactLedgerResult(),
        logger: null,
      });

      assertEquals(first.status, "completed");
      assertEquals(second.status, "completed");
      assert(first.runId !== second.runId, "different content_hash must produce a different run_id");

      const { data: runs, error } = await admin
        .from("document_intelligence_runs")
        .select("id, idempotency_key, status")
        .eq("uploaded_file_id", uploadedFile.id);
      assertNoError(error);
      assertEquals(runs?.length, 2, "different content must create a second run row, not overwrite the first");

      // Task F: "do not mutate historical completed runs with different keys" --
      // the first run's own row must be untouched by the second call.
      const firstRunRow = runs.find((r: any) => r.id === first.runId);
      assertEquals(firstRunRow.status, "completed");
    } finally {
      Deno.env.delete("ENABLE_DOCUMENT_INTELLIGENCE_V3");
    }
  },
});

Deno.test({
  name: "document intelligence v3 side-write: missing content_hash (no docling_raw) preserves the exact prior 6-part key format (Phase 6 Task F / H.9-H.10 groundwork)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, uploadedFile } = await setupOrgAndUpload(admin, suffix);

    Deno.env.set("ENABLE_DOCUMENT_INTELLIGENCE_V3", "true");
    try {
      const outcome = await runDocumentIntelligenceV3SideWrite({
        supabaseAdmin: admin,
        orgId: org.id,
        uploadedFileId: uploadedFile.id,
        uploadedFile, // no docling_raw -- content_hash cannot be computed
        leaseId: null,
        pipelineJobId: null,
        result: vertexFactLedgerResult(),
        logger: null,
      });

      const { data: runRow, error } = await admin
        .from("document_intelligence_runs")
        .select("idempotency_key")
        .eq("id", outcome.runId)
        .single();
      assertNoError(error);
      assertFalse(runRow.idempotency_key.includes("content_hash:"), "no docling_raw means no content_hash segment at all");
      assertFalse(runRow.idempotency_key.includes("extraction_model:"));
      assertFalse(runRow.idempotency_key.includes("pipeline_version:"));
      assertFalse(runRow.idempotency_key.includes("prompt_bundle_version:"));
      // Exactly the pre-Phase-6 6-part format: org|file|lease|contract|provider|job.
      assertEquals(runRow.idempotency_key.split("|").length, 6);
    } finally {
      Deno.env.delete("ENABLE_DOCUMENT_INTELLIGENCE_V3");
    }
  },
});

// ── Phase 7: evidence anchors persist through the full side-write ───────────

Deno.test({
  name: "document intelligence v3 side-write: evidence anchors with block_ids/polygon persist into document_claim_evidence (Phase 7 Task G.1/G.2)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, uploadedFile } = await setupOrgAndUpload(admin, suffix);

    Deno.env.set("ENABLE_DOCUMENT_INTELLIGENCE_V3", "true");
    try {
      const outcome = await runDocumentIntelligenceV3SideWrite({
        supabaseAdmin: admin,
        orgId: org.id,
        uploadedFileId: uploadedFile.id,
        uploadedFile,
        leaseId: null,
        pipelineJobId: null,
        result: vertexFactLedgerResultWithEvidenceAnchors(),
        logger: null,
      });
      assertEquals(outcome.status, "completed");

      const { data: claims, error: claimsError } = await admin
        .from("document_claims")
        .select("*")
        .eq("run_id", outcome.runId);
      assertNoError(claimsError);
      const rentClaim = claims.find((c: any) => c.claim_type === "canonical_field" && c.object.field_key === "monthly_rent");
      assertExists(rentClaim);

      const { data: evidenceRows, error: evidenceError } = await admin
        .from("document_claim_evidence")
        .select("*")
        .eq("claim_id", rentClaim.id);
      assertNoError(evidenceError);
      assertEquals(evidenceRows.length, 1);
      assertEquals(evidenceRows[0].block_ids, ["block-3"]);
      assertEquals(evidenceRows[0].polygon, [10, 20, 30, 40]);
      assertEquals(evidenceRows[0].support_type, "direct_quote");
    } finally {
      Deno.env.delete("ENABLE_DOCUMENT_INTELLIGENCE_V3");
    }
  },
});

Deno.test({
  name: "document intelligence v3 side-write: retry with the same evidence anchors does not duplicate evidence rows (Phase 7 Task G.5)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, uploadedFile } = await setupOrgAndUpload(admin, suffix);

    Deno.env.set("ENABLE_DOCUMENT_INTELLIGENCE_V3", "true");
    try {
      const params = {
        supabaseAdmin: admin,
        orgId: org.id,
        uploadedFileId: uploadedFile.id,
        uploadedFile,
        leaseId: null,
        pipelineJobId: null,
        result: vertexFactLedgerResultWithEvidenceAnchors(),
        logger: null,
      };

      const first = await runDocumentIntelligenceV3SideWrite(params);
      const second = await runDocumentIntelligenceV3SideWrite(params);
      assertEquals(first.runId, second.runId);

      const { data: evidenceRows, error } = await admin
        .from("document_claim_evidence")
        .select("id, block_ids, polygon")
        .eq("uploaded_file_id", uploadedFile.id);
      assertNoError(error);
      assertEquals(evidenceRows.length, first.evidenceCount, "retry must not duplicate evidence rows, even with real block_ids/polygon");
      assert(evidenceRows.some((e: any) => Array.isArray(e.block_ids) && e.block_ids.includes("block-3")));
    } finally {
      Deno.env.delete("ENABLE_DOCUMENT_INTELLIGENCE_V3");
    }
  },
});

Deno.test({
  name: "document intelligence v3 side-write: canonical_field_projections.source_claim_ids still link to the same claims with real evidence anchors present (Phase 7 Task G.6)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, uploadedFile } = await setupOrgAndUpload(admin, suffix);

    Deno.env.set("ENABLE_DOCUMENT_INTELLIGENCE_V3", "true");
    try {
      const outcome = await runDocumentIntelligenceV3SideWrite({
        supabaseAdmin: admin,
        orgId: org.id,
        uploadedFileId: uploadedFile.id,
        uploadedFile,
        leaseId: null,
        pipelineJobId: null,
        result: vertexFactLedgerResultWithEvidenceAnchors(),
        logger: null,
      });

      const { data: projections, error: projError } = await admin
        .from("document_canonical_field_projections")
        .select("*")
        .eq("run_id", outcome.runId)
        .eq("field_key", "monthly_rent");
      assertNoError(projError);
      assertEquals(projections.length, 1);
      const claimId = projections[0].source_claim_ids[0];
      assertExists(claimId);

      const { data: evidenceForClaim, error: evError } = await admin
        .from("document_claim_evidence")
        .select("block_ids")
        .eq("claim_id", claimId);
      assertNoError(evError);
      assertEquals(evidenceForClaim[0].block_ids, ["block-3"], "the linked claim's evidence must carry the real block_ids");
    } finally {
      Deno.env.delete("ENABLE_DOCUMENT_INTELLIGENCE_V3");
    }
  },
});

Deno.test({
  name: "document intelligence v3 side-write: evidence diagnostic counts on the run row are correct (Phase 7 Task E/G.7)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, uploadedFile } = await setupOrgAndUpload(admin, suffix);

    Deno.env.set("ENABLE_DOCUMENT_INTELLIGENCE_V3", "true");
    try {
      const outcome = await runDocumentIntelligenceV3SideWrite({
        supabaseAdmin: admin,
        orgId: org.id,
        uploadedFileId: uploadedFile.id,
        uploadedFile,
        leaseId: null,
        pipelineJobId: null,
        result: vertexFactLedgerResultWithEvidenceAnchors(),
        logger: null,
      });

      const { data: runRow, error } = await admin
        .from("document_intelligence_runs")
        .select("coverage")
        .eq("id", outcome.runId)
        .single();
      assertNoError(error);
      // monthly_rent: block_ids=["block-3"], polygon populated.
      // Delaware (dynamic item): no block match -> empty block_ids/polygon,
      // but still has real source_text (evidence row still created).
      assertEquals(runRow.coverage.evidence_rows_with_block_ids, 1);
      assertEquals(runRow.coverage.evidence_rows_with_polygon, 1);
      assertEquals(runRow.coverage.evidence_rows_with_source_text, 2);
      assertEquals(runRow.coverage.evidence_rows_without_source_text, 0);
      assertEquals(runRow.coverage.evidence_anchor_source, "canonical_layout");
      assertEquals(runRow.coverage.profile_ensemble.selected_policy_key, "base_lease");
      assertEquals(runRow.coverage.profile_ensemble.profile_source, "vertex_fact_ledger");
      assert(runRow.coverage.extraction_plan.modules_to_run.some((m: any) => m.module_key === "rent_and_charges"));
      assert(runRow.coverage.extraction_plan.modules_to_run.some((m: any) => m.module_key === "cam_rules"));
      assertEquals(runRow.coverage.modules_to_run_count, runRow.coverage.extraction_plan.modules_to_run.length);
      assertEquals(runRow.coverage.phase10_static_coverage_importance.diagnostic_only, true);
      assertEquals(runRow.coverage.phase10_static_coverage_importance.evidence_coverage.claims_total, 2);
      assertEquals(runRow.coverage.static_unmapped_claims_count, 1);
      assert(runRow.coverage.static_unmapped_high_importance_claims_count >= 0);
      assertEquals(runRow.coverage.temporal_supersession.diagnostic_only, true);
      assert(Array.isArray(runRow.coverage.temporal_supersession.document_timeline));
      assertEquals(runRow.coverage.temporal_status, runRow.coverage.temporal_supersession.temporal_status);
    } finally {
      Deno.env.delete("ENABLE_DOCUMENT_INTELLIGENCE_V3");
    }
  },
});

Deno.test({
  name: "document intelligence v3 side-write: evidence_anchor_source is 'unavailable' for a legacy_hybrid result (Phase 7 Task E)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, uploadedFile } = await setupOrgAndUpload(admin, suffix);

    Deno.env.set("ENABLE_DOCUMENT_INTELLIGENCE_V3", "true");
    try {
      const outcome = await runDocumentIntelligenceV3SideWrite({
        supabaseAdmin: admin,
        orgId: org.id,
        uploadedFileId: uploadedFile.id,
        uploadedFile,
        leaseId: null,
        pipelineJobId: null,
        result: legacyHybridResult(),
        logger: null,
      });

      const { data: runRow, error } = await admin
        .from("document_intelligence_runs")
        .select("coverage")
        .eq("id", outcome.runId)
        .single();
      assertNoError(error);
      assertEquals(runRow.coverage.evidence_anchor_source, "unavailable");
      assertEquals(runRow.coverage.evidence_rows_with_block_ids, 0);
    } finally {
      Deno.env.delete("ENABLE_DOCUMENT_INTELLIGENCE_V3");
    }
  },
});


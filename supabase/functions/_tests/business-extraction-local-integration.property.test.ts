// @ts-nocheck
// Azure + Vertex Phase 4E (local implementation): local integration test
// against the REAL locally-served normalize-pdf-output edge function
// (http://127.0.0.1:54321/functions/v1/normalize-pdf-output) and real local
// Postgres. Vertex provider calls are locally mocked only through the
// endpoint's own triple-gated HTTP seam, following the established
// *.property.test.ts pattern (adminClient()/insertOne(), modeled directly
// on delete-uploaded-file.property.test.ts, the closest existing template
// touching uploaded_files/leases/pipeline_jobs together).
//
// Scope note: this file exercises the live-wired legacy_hybrid path, the
// vertex_primary_legacy_fallback mock-scenario path, the fail-closed
// DISABLE_EXTERNAL_PROVIDER_CALLS guard, and an overlapping-request CAS race
// over the real localhost HTTP endpoint. The server process must be started
// with ENABLE_LOCAL_PROVIDER_MOCKS=true, DISABLE_EXTERNAL_PROVIDER_CALLS=true, and LOCAL_SUPABASE_RUNTIME=true
// for the Vertex-scenario tests to run safely.
//
// Run: deno test --allow-env --allow-read --allow-net --no-lock business-extraction-local-integration.property.test.ts

import { assert, assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY must be set for the local HTTP integration test");

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

// Must exceed MIN_LEASE_TEXT_CHARS (500, pipeline-contract.ts) — an earlier
// version of this fixture was too short and was rejected by
// normalize-pdf-output's pre-dispatch parser-text-length guard entirely
// before ever reaching the business-extraction orchestrator, a real finding
// worth recording precisely (an unrelated pre-existing guard, not a Phase
// 4E defect) rather than silently padded away without comment.
const SAMPLE_LEASE_TEXT = `LEASE AGREEMENT

This Lease Agreement ("Lease") is entered into as of January 1, 2027, by and
between Acme Holdings LLC, a Delaware limited liability company
("Landlord"), and Business Extraction Test Tenant Inc, a Delaware
corporation ("Tenant"), for the premises located at 100 Test Plaza, Suite
400, Testville, ST 00000 (the "Premises").

1. TERM. The term of this Lease shall commence on January 1, 2027 (the
"Commencement Date") and shall expire on December 31, 2031 (the
"Expiration Date"), unless sooner terminated as provided herein.

2. RENT. Tenant shall pay Landlord base rent in the amount of Eight
Thousand Five Hundred and 00/100 Dollars ($8,500.00) per month, due and
payable in advance on the first day of each calendar month during the
Term, without demand, deduction, or offset of any kind whatsoever.

3. PREMISES. The rentable square footage of the Premises is agreed to be
approximately 6,200 square feet, and the Premises shall be used solely for
general office purposes and no other purpose without Landlord's prior
written consent.

4. SECURITY DEPOSIT. Upon execution of this Lease, Tenant shall deposit
with Landlord the sum of Seventeen Thousand and 00/100 Dollars
($17,000.00) as security for Tenant's faithful performance of its
obligations under this Lease.
`;

async function insertReadyUploadedFile(admin: ReturnType<typeof adminClient>, org: { id: string }, suffix: string) {
  return insertOne(admin, "uploaded_files", {
    org_id: org.id,
    module_type: "lease",
    file_name: `business-extraction-local-integration-${suffix}.pdf`,
    file_url: "https://example.test/business-extraction-local-integration.pdf",
    status: "pdf_parsed",
    processing_status: "pdf_parsed",
    review_required: true,
    document_subtype: "base_lease",
    docling_raw: {
      extraction_method: "pdf_text",
      full_text: SAMPLE_LEASE_TEXT,
      text_blocks: [{ block_index: 0, type: "paragraph", text: SAMPLE_LEASE_TEXT }],
      tables: [],
      fields: [],
      page_count: 1,
      layout_contract_version: "document_layout_v1",
      _metadata: { provider: "pdf_text", full_text_chars: SAMPLE_LEASE_TEXT.length },
    },
  });
}

function callNormalize(fileId: string, orgId: string, bodyOverrides: Record<string, unknown> = {}) {
  // isInternalServiceRequest()/isInternalCall() recognize a service-role
  // Bearer token ONLY when paired with x-internal-service-key (matching the
  // exact header shape lease-extraction-worker's callInternalFunction()
  // sends) — a bare service-role Bearer token alone falls through to
  // verifyUser()'s user-JWT path, which correctly rejects it (no `sub`
  // claim). An internal-service call resolves to a placeholder
  // user.id="internal-compute" (not a real UUID), so org context must come
  // from x-internal-org-id explicitly, exactly as extractInternalOrgIdFromHeader()
  // expects — otherwise getUserOrgId() fails trying to query memberships
  // with a non-UUID id, as this test's second attempt discovered.
  return fetch(`${SUPABASE_URL}/functions/v1/normalize-pdf-output`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
      "apikey": SERVICE_ROLE_KEY,
      "x-internal-service-key": SERVICE_ROLE_KEY,
      "x-internal-org-id": orgId,
    },
    body: JSON.stringify({ file_id: fileId, ...bodyOverrides }),
  });
}

async function cleanup(admin: ReturnType<typeof adminClient>, org: { id: string } | null, fileId: string | null) {
  if (fileId) {
    await admin.from("leases").delete().eq("extraction_data->>source_file_id", fileId);
    await admin.from("pipeline_jobs").delete().eq("uploaded_file_id", fileId);
    await admin.from("uploaded_files").delete().eq("id", fileId);
  }
  if (org) {
    await admin.from("organizations").delete().eq("id", org.id);
  }
}

Deno.test({
  name: "business-extraction local integration: legacy_hybrid runs end-to-end over the real HTTP endpoint, produces a real persisted result, and is idempotent on retry — no duplicate rows accumulate",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    let org: { id: string } | null = null;
    let file: { id: string } | null = null;

    try {
      org = await insertOne(admin, "organizations", { name: `Business Extraction Local Integration Org ${suffix}`, status: "active" });
      file = await insertReadyUploadedFile(admin, org, suffix);

      // ── First call: real end-to-end run through the orchestrator ──────
      const res1 = await callNormalize(file.id, org.id);
      const body1 = await res1.json().catch(() => ({}));
      assert(res1.status === 200 || res1.status === 422, `unexpected status ${res1.status}: ${JSON.stringify(body1)}`);

      const { data: row1 } = await admin
        .from("uploaded_files")
        .select("status, processing_status, normalized_output, ui_review_payload, extraction_method")
        .eq("id", file.id)
        .maybeSingle();
      assertExists(row1, "uploaded_files row must still exist after normalize");

      // Provenance must be present regardless of which acceptance branch
      // this particular local run's rule/table/LLM extraction landed on —
      // the orchestrator always attaches it.
      const provenance = (row1?.normalized_output as any)?.metadata?.provenance;
      assertExists(provenance, "normalized_output.metadata.provenance must always be present");
      assertEquals(provenance.requested_provider, "legacy_hybrid");
      assertEquals(provenance.effective_provider, "legacy_hybrid");
      assertEquals(provenance.fallback_used, false);
      assertEquals(provenance.provider_mocked, false, "a real (non-mocked) local run must never claim provider_mocked=true");

      const uiProvenance = (row1?.ui_review_payload as any)?.metadata?.provenance;
      assertExists(uiProvenance, "ui_review_payload.metadata.provenance must also be present (dual-location, per Correction 10)");
      assertEquals(uiProvenance.requested_provider, "legacy_hybrid");

      // ── Tenant scoping: a cross-org read must never see this row ──────
      const { data: crossOrgAttempt } = await admin
        .from("uploaded_files")
        .select("id")
        .eq("id", file.id)
        .eq("org_id", crypto.randomUUID())
        .maybeSingle();
      assertEquals(crossOrgAttempt, null, "a mismatched org_id must never return this row");

      // ── Second call: idempotency — no duplicate lease rows, still one file row ──
      const { data: leaseCountBefore } = await admin.from("leases").select("id").eq("extraction_data->>source_file_id", file.id);
      await callNormalize(file.id, org.id);
      const { data: leaseCountAfter } = await admin.from("leases").select("id").eq("extraction_data->>source_file_id", file.id);
      assertEquals(
        (leaseCountAfter ?? []).length,
        (leaseCountBefore ?? []).length,
        "a retry must never create an additional lease row for the same source file",
      );

      const { data: fileRowsAfter } = await admin.from("uploaded_files").select("id").eq("id", file.id);
      assertEquals((fileRowsAfter ?? []).length, 1, "exactly one uploaded_files row must exist, never duplicated by a retry");
    } finally {
      await cleanup(admin, org, file?.id ?? null);
    }
  },
});

const VERTEX_PRIMARY_PROVIDER = "vertex_primary_legacy_fallback";

async function readPersistedOutput(admin: ReturnType<typeof adminClient>, fileId: string) {
  const { data, error } = await admin
    .from("uploaded_files")
    .select("status, processing_status, normalized_output, ui_review_payload, extraction_method")
    .eq("id", fileId)
    .maybeSingle();
  assertNoError(error);
  assertExists(data, "uploaded_files row must exist after normalize");
  return data as any;
}

function provenanceFrom(row: any) {
  const normalized = row?.normalized_output?.metadata?.provenance;
  const ui = row?.ui_review_payload?.metadata?.provenance;
  assertExists(normalized, "normalized_output.metadata.provenance must be persisted");
  assertExists(ui, "ui_review_payload.metadata.provenance must be persisted");
  assertEquals(ui.source_content_hash, normalized.source_content_hash, "persisted output locations must agree on source hash");
  assertExists(normalized.attempt_id, "attempt_id must be present for race comparison");
  assertExists(normalized.semantic_schema_version, "semantic schema metadata must be present");
  assertExists(normalized.source_content_hash, "source content hash must be present");
  return normalized;
}

async function runMockVertexScenario(admin: ReturnType<typeof adminClient>, org: { id: string }, scenario: string, suffix: string) {
  const file = await insertReadyUploadedFile(admin, org, `${suffix}-${scenario}`);
  const res = await callNormalize(file.id, org.id, {
    debug_business_extraction_provider: VERTEX_PRIMARY_PROVIDER,
    debug_vertex_mock_scenario: scenario,
  });
  const body = await res.json().catch(() => ({}));
  assert(res.status >= 200 && res.status < 300, `scenario ${scenario} unexpected status ${res.status}: ${JSON.stringify(body)}`);
  const row = await readPersistedOutput(admin, file.id);
  return { file, row, body, provenance: provenanceFrom(row) };
}

Deno.test({
  name: "business-extraction local HTTP: mocked Vertex scenarios exercise actual normalize workflow and persisted output contract without external provider calls",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    let org: { id: string } | null = null;
    const fileIds: string[] = [];

    try {
      org = await insertOne(admin, "organizations", { name: `Business Extraction Vertex HTTP Org ${suffix}`, status: "active" });
      const expectations = [
        { scenario: "success", effective: "vertex_fact_ledger", fallback: false, acceptance: "accepted", reason: null },
        { scenario: "timeout", effective: "legacy_hybrid", fallback: true, acceptance: null, reason: "timeout" },
        { scenario: "rate_limited", effective: "legacy_hybrid", fallback: true, acceptance: null, reason: "rate_limit" },
        { scenario: "server_error", effective: "legacy_hybrid", fallback: true, acceptance: null, reason: "provider_server_error" },
        { scenario: "malformed_response", effective: "legacy_hybrid", fallback: true, acceptance: null, reason: "malformed_response" },
        { scenario: "empty_extraction", effective: "legacy_hybrid", fallback: true, acceptance: null, reason: "empty_extraction" },
        { scenario: "auth_error", effective: "vertex_fact_ledger", fallback: false, acceptance: "extraction_failed_manual_review", reason: "authentication" },
        { scenario: "conflicting_facts", effective: "vertex_fact_ledger", fallback: false, acceptance: "accepted_needs_review", reason: null },
      ];

      for (const expected of expectations) {
        const { file, row, provenance } = await runMockVertexScenario(admin, org, expected.scenario, suffix);
        fileIds.push(file.id);
        assertEquals(provenance.requested_provider, VERTEX_PRIMARY_PROVIDER, `${expected.scenario}: requested provider`);
        assertEquals(provenance.effective_provider, expected.effective, `${expected.scenario}: effective provider`);
        assertEquals(provenance.fallback_used, expected.fallback, `${expected.scenario}: fallback flag`);
        assertEquals(provenance.provider_mocked, true, `${expected.scenario}: provider_mocked flag proves fixture path, not real Vertex`);
        assertEquals(provenance.mock_scenario, expected.scenario, `${expected.scenario}: mock scenario persisted`);
        if (expected.reason) assertEquals(provenance.fallback_reason, expected.reason, `${expected.scenario}: fallback reason`);
        if (expected.acceptance) assertEquals(provenance.acceptance_state, expected.acceptance, `${expected.scenario}: acceptance state`);
        if (expected.scenario === "conflicting_facts") {
          assert((row.normalized_output?.validationErrors ?? []).length > 0, "conflicting_facts must persist validation errors");
        }
      }
    } finally {
      for (const fileId of fileIds) await cleanup(admin, null, fileId);
      if (org) await cleanup(admin, org, null);
    }
  },
});

Deno.test({
  name: "business-extraction local HTTP: DISABLE_EXTERNAL_PROVIDER_CALLS fail-closes Vertex mode without a mock scenario",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    let org: { id: string } | null = null;
    let file: { id: string } | null = null;

    try {
      org = await insertOne(admin, "organizations", { name: `Business Extraction External Guard Org ${suffix}`, status: "active" });
      file = await insertReadyUploadedFile(admin, org, suffix);
      const res = await callNormalize(file.id, org.id, { debug_business_extraction_provider: VERTEX_PRIMARY_PROVIDER });
      const body = await res.json().catch(() => ({}));
      assertEquals(res.status, 400);
      assert(String(body?.message ?? body?.error ?? "").includes("DISABLE_EXTERNAL_PROVIDER_CALLS=true requires a valid debug_vertex_mock_scenario"));
    } finally {
      await cleanup(admin, org, file?.id ?? null);
    }
  },
});

Deno.test({
  name: "business-extraction local HTTP: overlapping normalize requests lose CAS by attempt/schema/hash metadata, not meaningful-content alone",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    let org: { id: string } | null = null;
    let file: { id: string } | null = null;

    try {
      org = await insertOne(admin, "organizations", { name: `Business Extraction CAS Race Org ${suffix}`, status: "active" });
      file = await insertReadyUploadedFile(admin, org, suffix);
      const body = {
        debug_business_extraction_provider: VERTEX_PRIMARY_PROVIDER,
        debug_vertex_mock_scenario: "success",
      };
      const first = callNormalize(file.id, org.id, {
        ...body,
        debug_before_validating_delay_ms: 200,
        debug_before_minimal_persist_delay_ms: 500,
        debug_after_minimal_persist_delay_ms: 900,
      });
      const second = callNormalize(file.id, org.id, {
        ...body,
        debug_before_validating_delay_ms: 260,
        debug_before_minimal_persist_delay_ms: 650,
      });
      const responses = await Promise.all([first, second]);
      const bodies = await Promise.all(responses.map((res) => res.json().catch(() => ({}))));
      const statuses = responses.map((res) => res.status);
      assert(statuses.every((status) => status >= 200 && status < 300), `unexpected race statuses ${JSON.stringify(statuses)} bodies=${JSON.stringify(bodies)}`);
      const loser = bodies.find((body: any) => body?.race_lost === true) as any;
      assertExists(loser, `one overlapping request must report race_lost=true; bodies=${JSON.stringify(bodies)}`);
      assertEquals(loser.race_compare_reason, "compatible_attempt_schema_hash");
      assertExists(loser.race_winner_attempt_id, "race loser response must include winner attempt identity");
      assertExists(loser.current_attempt_id, "race loser response must include current attempt identity");
      assert(loser.race_winner_attempt_id !== loser.current_attempt_id, "winner and loser attempt ids must be distinct");

      const row = await readPersistedOutput(admin, file.id);
      const provenance = provenanceFrom(row);
      assertEquals(provenance.requested_provider, VERTEX_PRIMARY_PROVIDER);
      assertEquals(provenance.provider_mocked, true);
      assertEquals(provenance.source_content_hash, row.ui_review_payload?.metadata?.provenance?.source_content_hash);
    } finally {
      await cleanup(admin, org, file?.id ?? null);
    }
  },
});
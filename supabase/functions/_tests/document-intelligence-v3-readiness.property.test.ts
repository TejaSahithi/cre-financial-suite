// @ts-nocheck
// Phase 3 integration tests for the Document Intelligence v3 readiness
// evaluator (supabase/functions/_shared/extraction/document-intelligence-v3/readiness.ts),
// against a real local Supabase Postgres instance. Seeds document_intelligence_runs
// / document_claims / document_claim_evidence / document_validation_drops /
// document_canonical_field_projections rows directly (bypassing the Phase 2
// side-write, which is tested separately) so each property below is isolated
// to the readiness evaluator's own logic.
//
// Properties (Phase 3 Task F):
//   1. base_lease required fields are evaluated from durable projections.
//   2. assignment_assumption_amendment does not require monthly_rent/CAM/
//      lease_type/budget fields.
//   3. assignment_assumption_amendment surfaces the original-lease advisory.
//   4. unknown_cre_document does not default to base_lease blockers.
//   5. A missing required projection produces a blocker.
//   6. A populated projection with no evidence is Needs Review / missing_source_evidence.
//   7. Validation drops are surfaced on their field.
//   8. Latest completed run resolves by uploaded_file_id.
//   9. Failed/skipped runs are ignored unless explicitly requested by run_id.
//   10. The evaluator makes no writes (row counts unchanged after evaluation).
//
// Run: deno test --allow-env --allow-read --allow-net --no-lock document-intelligence-v3-readiness.property.test.ts

import { assert, assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.2";
import { evaluateDocumentIntelligenceV3Readiness } from "../_shared/extraction/document-intelligence-v3/readiness.ts";

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
    name: `DI v3 Readiness Org ${suffix}`,
    status: "active",
    primary_contact_email: `di-v3-readiness-${suffix}@example.test`,
  });
  const uploadedFile = await insertOne(admin, "uploaded_files", {
    org_id: org.id,
    module_type: "leases",
    file_name: `readiness-${suffix}.pdf`,
    file_url: `https://example.test/${suffix}.pdf`,
    mime_type: "application/pdf",
    status: "review_required",
    document_subtype: "base_lease",
  });
  return { org, uploadedFile };
}

async function createRun(
  admin: ReturnType<typeof adminClient>,
  opts: { orgId: string; uploadedFileId: string; profileKey: string | null; status?: string; suffix: string },
) {
  return insertOne(admin, "document_intelligence_runs", {
    org_id: opts.orgId,
    uploaded_file_id: opts.uploadedFileId,
    contract_version: "document_intelligence_v3.phase1",
    idempotency_key: `readiness-test-${opts.suffix}`,
    status: opts.status ?? "completed",
    profile_key: opts.profileKey,
    profile_confidence: opts.profileKey ? 0.9 : null,
    profile_status: opts.profileKey ? "auto_detected" : "unclassified",
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
  });
}

async function addProjection(
  admin: ReturnType<typeof adminClient>,
  opts: {
    runId: string;
    orgId: string;
    uploadedFileId: string;
    fieldKey: string;
    value: unknown;
    sourceClaimIds?: string[];
    validationStatus?: string;
  },
) {
  return insertOne(admin, "document_canonical_field_projections", {
    run_id: opts.runId,
    org_id: opts.orgId,
    uploaded_file_id: opts.uploadedFileId,
    field_key: opts.fieldKey,
    value: opts.value,
    normalized_value: opts.value,
    status: opts.value != null ? "auto_populated" : "missing",
    source_claim_ids: opts.sourceClaimIds ?? [],
    confidence: 0.9,
    extraction_mode: "explicit",
    validation_status: opts.validationStatus ?? "passed",
  });
}

async function addClaimWithEvidence(
  admin: ReturnType<typeof adminClient>,
  opts: { runId: string; orgId: string; uploadedFileId: string; fieldKey: string; value: unknown; sourceText?: string | null },
) {
  const claim = await insertOne(admin, "document_claims", {
    run_id: opts.runId,
    org_id: opts.orgId,
    uploaded_file_id: opts.uploadedFileId,
    claim_type: "canonical_field",
    subject: {},
    predicate: "has_value",
    object: { field_key: opts.fieldKey, value: opts.value },
    conditions: [],
    extraction_mode: "explicit",
    confidence: { composite: 0.9 },
    canonical_field_candidates: [opts.fieldKey],
    validation_status: "passed",
    evidence_sufficiency: opts.sourceText ? "strong" : "none",
  });

  if (opts.sourceText) {
    await insertOne(admin, "document_claim_evidence", {
      claim_id: claim.id,
      org_id: opts.orgId,
      uploaded_file_id: opts.uploadedFileId,
      page: 2,
      source_text: opts.sourceText,
      support_type: "direct_quote",
    });
  }

  return claim;
}

Deno.test({
  name: "readiness: base_lease required fields are evaluated from durable projections (Task F.1)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, uploadedFile } = await setupOrgAndUpload(admin, suffix);
    const run = await createRun(admin, { orgId: org.id, uploadedFileId: uploadedFile.id, profileKey: "full_lease", suffix });

    const tenantClaim = await addClaimWithEvidence(admin, {
      runId: run.id, orgId: org.id, uploadedFileId: uploadedFile.id,
      fieldKey: "tenant_name", value: "Acme Inc", sourceText: "Tenant: Acme Inc.",
    });
    await addProjection(admin, {
      runId: run.id, orgId: org.id, uploadedFileId: uploadedFile.id,
      fieldKey: "tenant_name", value: "Acme Inc", sourceClaimIds: [tenantClaim.id],
    });

    const diagnostic = await evaluateDocumentIntelligenceV3Readiness({ supabaseAdmin: admin, orgId: org.id, runId: run.id });

    assertEquals(diagnostic.diagnostic_only, true);
    assertEquals(diagnostic.profile.policy_key, "base_lease");
    assertExists(diagnostic.profile_ensemble);
    assertEquals(diagnostic.profile_ensemble.selected_policy_key, "base_lease");
    assertExists(diagnostic.extraction_plan);
    assert(diagnostic.extraction_plan.modules_to_run.some((m: any) => m.module_key === "rent_and_charges"));
    assertEquals(diagnostic.modules_to_run_count, diagnostic.extraction_plan.modules_to_run.length);
    const tenantField = diagnostic.required_fields.find((f: any) => f.field_key === "tenant_name");
    assertExists(tenantField);
    assertEquals(tenantField.status, "source_backed");
    assertEquals(tenantField.required, true);
    assertEquals(tenantField.evidence_sufficiency, "text_only");
    assert(["critical", "high"].includes(tenantField.importance_level));
    assert(tenantField.importance_reasons.includes("required_for_profile"));
    assert(tenantField.evidence_warnings.includes("text_only_no_block_anchor"));
    assertEquals(diagnostic.evidence_sufficiency_counts.fields_with_text_only_evidence, 1);
    assertEquals(diagnostic.coverage_summary.fields_with_text_only_evidence, 1);
    assertEquals(diagnostic.coverage.diagnostic_only, true);
    assertEquals(diagnostic.coverage.expected_information_coverage.expected_required_fields, 9);
    assertEquals(diagnostic.coverage.expected_information_coverage.found_required_fields, 1);
    assertEquals(diagnostic.coverage.expected_information_coverage.missing_required_fields, 8);
    assertEquals(diagnostic.coverage.evidence_coverage.source_backed_field_count, 1);
    assertEquals(diagnostic.coverage.evidence_coverage.claims_with_evidence, 1);
    assertEquals(diagnostic.importance_summary.diagnostic_only, true);
    assertEquals(diagnostic.temporal_supersession.diagnostic_only, true);
    assert(Array.isArray(diagnostic.document_timeline));
    assert(Array.isArray(diagnostic.supersession_candidates));
    assert(Array.isArray(diagnostic.current_truth_candidates));
    assertEquals(diagnostic.approval_advisory.diagnostic_only, true);
    assert(["advisory_ready", "advisory_needs_review", "advisory_blocked"].includes(diagnostic.approval_advisory.advisory_status));
    // landlord_name etc were never attempted -> missing, not_attempted.
    const landlordField = diagnostic.required_fields.find((f: any) => f.field_key === "landlord_name");
    assertExists(landlordField);
    assertEquals(landlordField.status, "missing");
    assertEquals(landlordField.missing_reason, "not_attempted");
    assert(diagnostic.important_missing_fields.some((field: any) => field.field_key === "landlord_name"));
  },
});

Deno.test({
  name: "readiness: assignment_assumption_amendment does not require monthly_rent/CAM/lease_type/budget fields (Task F.2)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, uploadedFile } = await setupOrgAndUpload(admin, suffix);
    const run = await createRun(admin, { orgId: org.id, uploadedFileId: uploadedFile.id, profileKey: "assignment_amendment", suffix });

    const diagnostic = await evaluateDocumentIntelligenceV3Readiness({ supabaseAdmin: admin, orgId: org.id, runId: run.id });

    assertEquals(diagnostic.profile.policy_key, "assignment_assumption_amendment");
    assert(diagnostic.extraction_plan.modules_to_run.some((m: any) => m.module_key === "amendment_terms"));
    const allOtherTerms = diagnostic.required_fields.find((f: any) => f.field_key === "all_other_terms_remain_same");
    assertExists(allOtherTerms);
    assert(["critical", "high"].includes(allOtherTerms.importance_level));
    const requiredKeys = diagnostic.required_fields.map((f: any) => f.field_key);
    for (const mustNotBeRequired of ["monthly_rent", "lease_type", "cam_amount", "expense_structure"]) {
      assert(!requiredKeys.includes(mustNotBeRequired), `${mustNotBeRequired} must not be required for an assignment doc`);
    }
    // Those same fields should appear as optional/advisory instead.
    const optionalKeys = diagnostic.optional_fields.map((f: any) => f.field_key);
    assert(optionalKeys.includes("monthly_rent"));
    assert(optionalKeys.includes("lease_type"));
    assertEquals(diagnostic.coverage.expected_information_coverage.expected_required_fields, diagnostic.required_fields.length);
    assert(!diagnostic.coverage.field_coverage.required_fields.some((field: any) => field.field_key === "cam_amount"));
  },
});

Deno.test({
  name: "readiness: assignment_assumption_amendment surfaces the original-lease-required advisory (Task F.3)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, uploadedFile } = await setupOrgAndUpload(admin, suffix);
    const run = await createRun(admin, { orgId: org.id, uploadedFileId: uploadedFile.id, profileKey: "assignment", suffix });

    const diagnostic = await evaluateDocumentIntelligenceV3Readiness({ supabaseAdmin: admin, orgId: org.id, runId: run.id });

    assertEquals(diagnostic.advisories.length, 1);
    assertEquals(diagnostic.advisories[0].message, "Original lease required for CAM, expense recovery, and full budget setup.");
    assert(diagnostic.advisories[0].fields.includes("monthly_rent"));
    assertEquals(diagnostic.related_document_coverage.related_documents_missing, ["original_lease"]);
    assert(diagnostic.important_related_documents_missing.some((doc: any) => doc.document_type === "original_lease"));
    assert(["critical", "high"].includes(diagnostic.advisories[0].importance_level));
  },
});

Deno.test({
  name: "readiness: unknown_cre_document does not default to base_lease blockers (Task F.4)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, uploadedFile } = await setupOrgAndUpload(admin, suffix);
    const run = await createRun(admin, { orgId: org.id, uploadedFileId: uploadedFile.id, profileKey: "unrecognized_cre_profile", suffix });

    const diagnostic = await evaluateDocumentIntelligenceV3Readiness({ supabaseAdmin: admin, orgId: org.id, runId: run.id });

    assertEquals(diagnostic.profile.policy_key, "unknown_cre_document");
    assertEquals(diagnostic.required_fields.length, 0, "unknown_cre_document must have zero required fields, not base_lease's 9");
    assertEquals(diagnostic.blockers.length, 0);
    assertEquals(diagnostic.coverage.expected_information_coverage.expected_required_fields, 0);
    assertEquals(diagnostic.readiness.status, "needs_review");
    assertEquals(diagnostic.readiness.reason, "profile_not_classified");
    assertEquals(diagnostic.advisories[0].message, "Document type needs review before final approval rules can be applied.");
  },
});

Deno.test({
  name: "readiness: a missing required projection produces a blocker (Task F.5)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, uploadedFile } = await setupOrgAndUpload(admin, suffix);
    const run = await createRun(admin, { orgId: org.id, uploadedFileId: uploadedFile.id, profileKey: "full_lease", suffix });

    const diagnostic = await evaluateDocumentIntelligenceV3Readiness({ supabaseAdmin: admin, orgId: org.id, runId: run.id });

    assertEquals(diagnostic.blockers.length, 9, "all 9 base_lease required fields are unattempted -> all blockers");
    assert(diagnostic.blockers.every((b: any) => b.reason === "missing"));
    assertEquals(diagnostic.readiness.status, "needs_review");
    assertEquals(diagnostic.readiness.reason, "blockers_present");
  },
});

Deno.test({
  name: "readiness: a populated projection with no evidence is Needs Review / missing_source_evidence (Task F.6)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, uploadedFile } = await setupOrgAndUpload(admin, suffix);
    const run = await createRun(admin, { orgId: org.id, uploadedFileId: uploadedFile.id, profileKey: "full_lease", suffix });

    // A projection with a value but NO source_claim_ids (never linked to a
    // claim/evidence row) -- simulates a value present without evidence.
    await addProjection(admin, {
      runId: run.id, orgId: org.id, uploadedFileId: uploadedFile.id,
      fieldKey: "tenant_name", value: "Acme Inc", sourceClaimIds: [],
    });

    const diagnostic = await evaluateDocumentIntelligenceV3Readiness({ supabaseAdmin: admin, orgId: org.id, runId: run.id });
    const tenantField = diagnostic.required_fields.find((f: any) => f.field_key === "tenant_name");
    assertExists(tenantField);
    assertEquals(tenantField.value_present, true);
    assertEquals(tenantField.source_backed, false);
    assertEquals(tenantField.status, "needs_review");
    assertEquals(tenantField.missing_reason, "missing_source_evidence");
    assert(diagnostic.blockers.some((b: any) => b.field_key === "tenant_name" && b.reason === "unverified"));
  },
});

Deno.test({
  name: "readiness: validation drops are surfaced on their field (Task F.7)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, uploadedFile } = await setupOrgAndUpload(admin, suffix);
    const run = await createRun(admin, { orgId: org.id, uploadedFileId: uploadedFile.id, profileKey: "full_lease", suffix });

    await insertOne(admin, "document_validation_drops", {
      run_id: run.id,
      org_id: org.id,
      uploaded_file_id: uploadedFile.id,
      field_key: "landlord_name",
      bad_value: "<figure>",
      reason: "invalid_markup_value",
      action: "dropped",
    });

    const diagnostic = await evaluateDocumentIntelligenceV3Readiness({ supabaseAdmin: admin, orgId: org.id, runId: run.id });
    const landlordField = diagnostic.required_fields.find((f: any) => f.field_key === "landlord_name");
    assertExists(landlordField);
    assertExists(landlordField.validation_drop);
    assertEquals(landlordField.validation_drop.reason, "invalid_markup_value");
    assertEquals(landlordField.validation_drop.bad_value, "<figure>");
    assertEquals(diagnostic.validation_drop_counts.total, 1);
    assertEquals(diagnostic.validation_drop_counts.by_reason.invalid_markup_value, 1);
    assertEquals(diagnostic.coverage.validation_coverage.validation_drops_total, 1);
    assertEquals(diagnostic.coverage.validation_coverage.invalid_markup_values, 1);
    assert(diagnostic.important_validation_drops.some((drop: any) => drop.field_key === "landlord_name"));
  },
});

Deno.test({
  name: "readiness: the latest completed run resolves by uploaded_file_id (Task F.8)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, uploadedFile } = await setupOrgAndUpload(admin, suffix);

    const older = await createRun(admin, { orgId: org.id, uploadedFileId: uploadedFile.id, profileKey: "full_lease", suffix: `${suffix}-older` });
    await admin.from("document_intelligence_runs").update({ created_at: "2020-01-01T00:00:00.000Z" }).eq("id", older.id);

    const newer = await createRun(admin, { orgId: org.id, uploadedFileId: uploadedFile.id, profileKey: "assignment", suffix: `${suffix}-newer` });

    const diagnostic = await evaluateDocumentIntelligenceV3Readiness({
      supabaseAdmin: admin,
      orgId: org.id,
      uploadedFileId: uploadedFile.id,
    });

    assertEquals(diagnostic.run_id, newer.id, "must resolve to the newer completed run, not the older one");
    assertEquals(diagnostic.profile.policy_key, "assignment_assumption");
  },
});

Deno.test({
  name: "readiness: a failed run is ignored when resolving by uploaded_file_id, but is inspectable when explicitly requested by run_id (Task F.9)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, uploadedFile } = await setupOrgAndUpload(admin, suffix);

    const failed = await createRun(admin, {
      orgId: org.id, uploadedFileId: uploadedFile.id, profileKey: "full_lease", status: "failed", suffix,
    });

    const byFile = await evaluateDocumentIntelligenceV3Readiness({ supabaseAdmin: admin, orgId: org.id, uploadedFileId: uploadedFile.id });
    assertEquals(byFile.available, false, "a failed run must not resolve via uploaded_file_id");
    assertEquals(byFile.readiness.status, "not_available");

    const byRunId = await evaluateDocumentIntelligenceV3Readiness({ supabaseAdmin: admin, orgId: org.id, runId: failed.id });
    assertEquals(byRunId.available, true, "an explicit run_id must still be inspectable even if failed");
    assertEquals(byRunId.run_id, failed.id);
  },
});

Deno.test({
  name: "readiness: the evaluator performs zero writes (Task F.10)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, uploadedFile } = await setupOrgAndUpload(admin, suffix);
    const run = await createRun(admin, { orgId: org.id, uploadedFileId: uploadedFile.id, profileKey: "full_lease", suffix });
    await addProjection(admin, { runId: run.id, orgId: org.id, uploadedFileId: uploadedFile.id, fieldKey: "tenant_name", value: "Acme Inc" });

    const countAll = async () => {
      const tables = ["document_intelligence_runs", "document_claims", "document_claim_evidence", "document_validation_drops", "document_canonical_field_projections"];
      const counts: Record<string, number> = {};
      for (const table of tables) {
        const { count, error } = await admin.from(table).select("id", { count: "exact", head: true }).eq("org_id", org.id);
        assertNoError(error);
        counts[table] = count ?? 0;
      }
      return counts;
    };

    const before = await countAll();
    await evaluateDocumentIntelligenceV3Readiness({ supabaseAdmin: admin, orgId: org.id, runId: run.id });
    await evaluateDocumentIntelligenceV3Readiness({ supabaseAdmin: admin, orgId: org.id, runId: run.id });
    const after = await countAll();

    assertEquals(after, before, "evaluating readiness (even repeatedly) must never change row counts");
  },
});




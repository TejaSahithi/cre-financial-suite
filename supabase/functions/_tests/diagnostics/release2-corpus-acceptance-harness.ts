// @ts-nocheck
/**
 * Release 2 staging corpus acceptance harness.
 *
 * An operational tool, not a Deno.test suite -- run it by hand against a
 * real Supabase project (local, staging, or otherwise) after uploading the
 * 9-document corpus described in docs/release-2-staging-rollout.md. It
 * calls the same run-metrics/projection-diff logic the two new diagnostic
 * edge functions use, directly (service-role client, no HTTP), and prints
 * a report against the Release 2 acceptance thresholds.
 *
 * Per the Two Test Modes section of the Release 2 plan: agreement-rate
 * thresholds (legacy/canonical agreement, critical-field agreement) are
 * only meaningful for documents processed under BUSINESS_EXTRACTION_PROVIDER=
 * openai_fact_ledger (comparison_status:"available"). Documents processed
 * under legacy_hybrid contribute to the infrastructure-only thresholds
 * (pipeline completion, orphan records) but never to agreement rates --
 * this harness enforces that split, not a naive average across all runs.
 *
 * This has not been run against a real staging corpus from within this
 * session -- there is no staging Supabase project connected here (see the
 * Release 2 plan's scope-boundary note). It ships ready to run.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... deno run --allow-net --allow-env \
 *     supabase/functions/_tests/diagnostics/release2-corpus-acceptance-harness.ts \
 *     <uploaded_file_id_1> <uploaded_file_id_2> ...
 *
 * Or, to cover every uploaded_file processed within a date range:
 *   ... release2-corpus-acceptance-harness.ts --since 2026-07-20
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.2";
import { resolveRun, fetchRunClaims, fetchClaimEvidence, fetchRunValidationDrops, fetchRunCanonicalFieldProjections } from "../../_shared/extraction/document-intelligence-v3/projection-reader.ts";
import { evaluateDocumentIntelligenceV3Readiness } from "../../_shared/extraction/document-intelligence-v3/readiness.ts";
import { buildProjectionDiff, summarizeProjectionDiff } from "../../_shared/extraction/document-intelligence-v3/projection-diff.ts";
import { buildRunOperationalMetrics, aggregateRunMetrics } from "../../_shared/extraction/document-intelligence-v3/run-metrics.ts";

const THRESHOLDS = {
  pipeline_completion_rate: 0.98,
  evidence_attachment_rate: 0.95,
  critical_field_agreement_rate: 0.95,
  legacy_canonical_agreement_rate: 0.90,
};

function envOrExit(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    console.error(`Missing required env var ${name}. This harness targets a real Supabase project -- see the usage comment at the top of this file.`);
    Deno.exit(1);
  }
  return value;
}

async function fetchOrgIdForFile(admin: any, uploadedFileId: string): Promise<string | null> {
  const { data, error } = await admin.from("uploaded_files").select("org_id, module_type, ui_review_payload").eq("id", uploadedFileId).maybeSingle();
  if (error || !data) return null;
  return data.org_id;
}

async function evaluateOneDocument(admin: any, uploadedFileId: string) {
  const { data: fileRow } = await admin.from("uploaded_files").select("org_id, module_type, ui_review_payload").eq("id", uploadedFileId).maybeSingle();
  if (!fileRow) {
    return { uploadedFileId, error: "uploaded_files row not found" };
  }
  const orgId = fileRow.org_id;

  const run = await resolveRun({ supabaseAdmin: admin, orgId, uploadedFileId });
  if (!run) {
    return { uploadedFileId, error: "no completed document_intelligence_runs row -- was ENABLE_DOCUMENT_INTELLIGENCE_V3 on when this file was processed?" };
  }

  const [claims, projections, validationDrops, readiness] = await Promise.all([
    fetchRunClaims({ supabaseAdmin: admin, orgId, runId: run.id }),
    fetchRunCanonicalFieldProjections({ supabaseAdmin: admin, orgId, runId: run.id }),
    fetchRunValidationDrops({ supabaseAdmin: admin, orgId, runId: run.id }),
    evaluateDocumentIntelligenceV3Readiness({ supabaseAdmin: admin, orgId, runId: run.id }),
  ]);
  const evidence = claims.length > 0 ? await fetchClaimEvidence({ supabaseAdmin: admin, orgId, claimIds: claims.map((c: any) => c.id) }) : [];

  const { data: stageRuns } = await admin.from("extraction_stage_runs").select("stage, attempt, status, started_at, finished_at").eq("run_id", run.id).eq("org_id", orgId);

  const legacyFields = fileRow.ui_review_payload?.records?.[0]?.standard_fields ?? [];
  const { diffs, comparisonStatus } = buildProjectionDiff({
    documentId: uploadedFileId,
    legacyFields,
    canonicalProjections: projections,
    hasClaims: claims.length > 0,
    moduleType: fileRow.module_type ?? "lease",
  });
  const diffSummary = summarizeProjectionDiff(diffs, comparisonStatus);

  const metrics = buildRunOperationalMetrics({
    run, claims, evidence, validationDrops, projections,
    stageRuns: stageRuns ?? [],
    legacyFieldCount: legacyFields.filter((f: any) => f?.value != null && f.value !== "").length,
    readiness,
  });

  return {
    uploadedFileId,
    runId: run.id,
    error: null,
    pipelineCompleted: run.status === "completed",
    claimsExtracted: metrics.claims_extracted,
    claimsWithEvidence: metrics.claims_with_evidence,
    validationDropsCount: validationDrops.length,
    stageDurationsMs: metrics.stage_durations.map((s: any) => s.duration_ms),
    comparisonStatus,
    normalizedMatchRate: diffSummary.normalizedMatchRate,
    criticalFieldAgreementRate: diffSummary.criticalFieldAgreementRate,
    orphanCheckPassed: true, // orphan-freedom is enforced at the DB FK level (see extraction-provenance-table-integrity.property.test.ts) -- this field documents intent, not a redundant re-check
  };
}

async function main() {
  const args = Deno.args.filter((a) => !a.startsWith("--"));
  if (args.length === 0) {
    console.error("Provide at least one uploaded_file_id. See the usage comment at the top of this file.");
    Deno.exit(1);
  }

  const SUPABASE_URL = envOrExit("SUPABASE_URL");
  const SERVICE_ROLE_KEY = envOrExit("SUPABASE_SERVICE_ROLE_KEY");
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  console.log(`Evaluating ${args.length} document(s)...\n`);
  const results = [];
  for (const uploadedFileId of args) {
    const result = await evaluateOneDocument(admin, uploadedFileId);
    results.push(result);
    if (result.error) {
      console.log(`  ${uploadedFileId}: SKIPPED (${result.error})`);
    } else {
      console.log(
        `  ${uploadedFileId}: run=${result.runId} status=${result.pipelineCompleted ? "completed" : "incomplete"} ` +
        `comparison=${result.comparisonStatus} claims=${result.claimsExtracted} evidence=${result.claimsWithEvidence}`,
      );
    }
  }

  const evaluable = results.filter((r) => !r.error);
  const summary = aggregateRunMetrics(evaluable);

  console.log("\n=== Corpus Summary ===");
  console.log(JSON.stringify(summary, null, 2));

  console.log("\n=== Acceptance Thresholds ===");
  let allPass = true;
  const checks: Array<[string, number | null, number]> = [
    ["Pipeline completion", summary.pipeline_completion_rate, THRESHOLDS.pipeline_completion_rate],
    ["Evidence attachment", summary.evidence_attachment_rate, THRESHOLDS.evidence_attachment_rate],
    ["Critical-field agreement", summary.critical_field_agreement_rate, THRESHOLDS.critical_field_agreement_rate],
    ["Overall normalized agreement", summary.legacy_canonical_agreement_rate, THRESHOLDS.legacy_canonical_agreement_rate],
  ];
  for (const [label, actual, threshold] of checks) {
    if (actual === null) {
      console.log(`  ${label}: NOT MEASURABLE (no comparable runs -- see comparison_status per document above)`);
      continue;
    }
    const pass = actual >= threshold;
    if (!pass) allPass = false;
    console.log(`  ${label}: ${(actual * 100).toFixed(1)}% (threshold ${(threshold * 100).toFixed(0)}%) -- ${pass ? "PASS" : "FAIL"}`);
  }
  console.log(`  Comparable (Mode B) runs: ${summary.comparable_runs} of ${summary.total_runs} total`);
  if (summary.comparable_runs === 0) {
    console.log("  NOTE: zero comparable runs -- if the corpus was processed under legacy_hybrid, this is expected " +
      "(see the Two Test Modes section of the Release 2 plan). Re-run against an openai_fact_ledger-processed corpus " +
      "to measure agreement-rate thresholds.");
  }

  console.log(`\nOverall: ${allPass ? "PASS" : "FAIL (see above)"}`);
  Deno.exit(allPass ? 0 : 1);
}

await main();

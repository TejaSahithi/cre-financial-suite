// @ts-nocheck

import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import { resolveRun, fetchClaimEvidence, fetchRunCanonicalFieldProjections } from "../_shared/extraction/document-intelligence-v3/projection-reader.ts";
import { buildCanonicalReviewFieldRegistry } from "../_shared/extraction/document-intelligence-v3/canonical-review-field-registry.ts";
import { buildEnterpriseReviewPayload } from "../_shared/extraction/document-intelligence-v3/enterprise-review-payload.ts";
import { persistEnterpriseReviewPayload } from "../_shared/extraction/document-intelligence-v3/enterprise-review-persistence.ts";
import { resolveCanonicalReviewRolloutForOrg } from "../_shared/extraction/document-intelligence-v3/canonical-review-rollout.ts";
import { isCanonicalApprovalGatingEnabled, isDocumentSemanticsV6Enabled, isEnterpriseReviewPayloadV2Enabled, isSemanticFieldSearchV6Enabled } from "../_shared/extraction/document-intelligence-v3/feature-flag.ts";
import { buildDefinitionRecords, persistDefinitionRecords } from "../_shared/extraction/document-semantics/definitions.ts";
import { parseCrossReferences } from "../_shared/extraction/document-semantics/cross-reference-parser.ts";
import { resolveCrossReferences, persistCrossReferences } from "../_shared/extraction/document-semantics/cross-reference-resolver.ts";
import { classifyDocumentFamily } from "../_shared/extraction/document-semantics/document-family-classifier.ts";
import { buildDocumentFamilyMember, orderDocumentFamilyMembers } from "../_shared/extraction/document-semantics/document-family-builder.ts";
import { extractAmendmentEffects, persistAmendmentEffects } from "../_shared/extraction/document-semantics/amendment-effect-extractor.ts";
import { buildEnterpriseReviewPayloadV2 } from "../_shared/extraction/document-semantics/enterprise-review-payload-v2.ts";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function parseRequest(req: Request) {
  if (req.method === "GET") {
    const url = new URL(req.url);
    return {
      runId: url.searchParams.get("run_id") || null,
      uploadedFileId: url.searchParams.get("uploaded_file_id") || null,
      generationId: url.searchParams.get("generation_id") || null,
    };
  }
  return req.json().catch(() => ({})).then((body: any) => ({
    runId: typeof body?.runId === "string" ? body.runId : typeof body?.run_id === "string" ? body.run_id : null,
    uploadedFileId: typeof body?.uploadedFileId === "string" ? body.uploadedFileId : typeof body?.uploaded_file_id === "string" ? body.uploaded_file_id : null,
    generationId: typeof body?.generationId === "string" ? body.generationId : typeof body?.generation_id === "string" ? body.generation_id : null,
  }));
}

async function fetchUploadedFile({ supabaseAdmin, orgId, uploadedFileId }: { supabaseAdmin: any; orgId: string; uploadedFileId: string }) {
  const columnSets = [
    "id, org_id, module_type, file_name, ui_review_payload, active_generation_id, canonical_layout_v3, canonical_layout_v3_hash, canonical_layout_v3_schema_version, canonical_layout_v3_adapter_version",
    "id, org_id, module_type, file_name, ui_review_payload, active_generation_id",
    "id, org_id, module_type, file_name, ui_review_payload",
  ];
  let lastError: string | null = null;
  for (const columns of columnSets) {
    const { data, error } = await supabaseAdmin
      .from("uploaded_files")
      .select(columns)
      .eq("id", uploadedFileId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (!error) return data ?? null;
    lastError = error.message;
    console.warn(`[document-intelligence-v4-review-payload] uploaded_files select fallback after error: ${error.message}`);
  }
  throw new Error(`Failed to fetch uploaded_files row: ${lastError ?? "unknown error"}`);
}

async function fetchCurrentEnterprisePayload(args: { supabaseAdmin: any; orgId: string; uploadedFileId: string; runId: string; sourceMode: string; generationId?: string | null; schemaVersion?: string | null }) {
  const { data, error } = await args.supabaseAdmin
    .from("document_enterprise_review_payloads")
    .select("id, payload, payload_hash, source_mode, generation_id, rollout_mode, rollout_source, created_at")
    .eq("org_id", args.orgId)
    .eq("uploaded_file_id", args.uploadedFileId)
    .eq("run_id", args.runId)
    .eq("schema_version", args.schemaVersion ?? "enterprise-review-payload-v1")
    .eq("source_mode", args.sourceMode)
    .eq("is_current", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return { row: null, error: error.message };
  if (!data?.payload) return { row: null, error: null };
  if (args.generationId && data.generation_id && data.generation_id !== args.generationId) return { row: null, error: null };
  return { row: data, error: null };
}

async function fetchActiveReviewOverrides(args: { supabaseAdmin: any; orgId: string; uploadedFileId: string; runId: string; generationId?: string | null }) {
  let query = args.supabaseAdmin
    .from("document_field_review_overrides")
    .select("*")
    .eq("org_id", args.orgId)
    .eq("uploaded_file_id", args.uploadedFileId)
    .eq("run_id", args.runId)
    .eq("is_active", true);
  if (args.generationId) query = query.eq("generation_id", args.generationId);
  const { data, error } = await query;
  if (error) throw new Error(`Failed to fetch active review overrides: ${error.message}`);
  return data ?? [];
}

function canonicalDocumentFromUploadedFile(uploadedFile: any) {
  const layout = uploadedFile?.canonical_layout_v3 ?? null;
  const provider = layout?.provider ?? null;
  return {
    layoutHash: uploadedFile?.canonical_layout_v3_hash ?? layout?.metadata?.canonical_layout_v3?.canonicalLayoutHash ?? null,
    layoutSchemaVersion: uploadedFile?.canonical_layout_v3_schema_version ?? layout?.schema_version ?? null,
    layoutSource: provider === "azure_document_intelligence" ? "azure_native" : layout ? "legacy_lossy" : null,
    geometryAvailable: Array.isArray(layout?.pages) && layout.pages.some((page: any) => Array.isArray(page?.blocks) && page.blocks.some((block: any) => Array.isArray(block?.polygon) && block.polygon.length >= 8)),
  };
}


function semanticBlocksFromUploadedFile(uploadedFile: any) {
  const layout = uploadedFile?.canonical_layout_v3 ?? null;
  const blocks: any[] = [];
  for (const page of layout?.pages ?? []) {
    for (const block of page?.blocks ?? []) {
      const text = block?.text ?? block?.content ?? block?.plain_text ?? "";
      if (!String(text).trim()) continue;
      blocks.push({
        blockId: String(block?.id ?? block?.block_id ?? `${page?.page_number ?? page?.pageNumber ?? 1}:${blocks.length}`),
        text: String(text),
        pageNumber: page?.page_number ?? page?.pageNumber ?? null,
        sectionKey: block?.section_key ?? block?.sectionKey ?? null,
        heading: block?.role === "sectionHeading" || block?.kind === "heading" ? String(text) : block?.heading ?? null,
        documentId: uploadedFile?.id ?? null,
      });
    }
  }
  if (!blocks.length) {
    const records = uploadedFile?.ui_review_payload?.records ?? uploadedFile?.ui_review_payload?.rows ?? [];
    for (const record of records) {
      for (const field of record?.standard_fields ?? []) {
        const sourceText = String(field?.source_text ?? field?.sourceText ?? "").trim();
        const value = String(field?.value ?? field?.normalized_value ?? field?.normalizedValue ?? "").trim();
        const label = String(field?.label ?? field?.field_label ?? "").trim();
        const text = sourceText || (value && value.toLowerCase() !== label.toLowerCase() ? value : "");
        if (text.trim()) blocks.push({ blockId: `legacy-field:${field.field_key ?? blocks.length}`, text, pageNumber: field?.source_page ?? null, sectionKey: null, heading: null, documentId: uploadedFile?.id ?? null });
      }
    }
  }
  return blocks;
}

async function persistSemanticSearchRecords(args: { supabaseAdmin: any; orgId: string; records: any[] }) {
  if (!args.records?.length) return { count: 0, error: null };
  const rows = args.records.map((record) => ({
    organization_id: args.orgId,
    uploaded_file_id: record.uploadedFileId || null,
    document_family_id: record.documentFamilyId || null,
    run_id: record.runId || null,
    generation_id: record.generationId || null,
    entity_type: record.entityType,
    entity_key: record.key,
    label: record.label,
    searchable_text: record.matchedText ?? record.label,
    field_key: record.fieldKey,
    section_key: record.sectionKey,
    page_number: record.pageNumber,
    status: record.status,
    source: record.source,
    evidence_ids: record.evidenceIds ?? [],
    reason_codes: record.reasonCodes ?? [],
    schema_version: "document-semantic-search-record-v1",
  }));
  const scopes = [...new Map(rows.map((row) => [
    [row.uploaded_file_id, row.run_id, row.generation_id].join("|"),
    { uploadedFileId: row.uploaded_file_id, runId: row.run_id, generationId: row.generation_id },
  ])).values()];
  for (const scope of scopes) {
    let deleteQuery = args.supabaseAdmin.from("document_semantic_search_records")
      .delete()
      .eq("organization_id", args.orgId)
      .eq("uploaded_file_id", scope.uploadedFileId);
    if (scope.runId) deleteQuery = deleteQuery.eq("run_id", scope.runId);
    if (scope.generationId) deleteQuery = deleteQuery.eq("generation_id", scope.generationId);
    await deleteQuery;
  }
  const { error } = await args.supabaseAdmin.from("document_semantic_search_records").insert(rows);
  return { count: error ? 0 : rows.length, error: error?.message ?? null };
}
function staleGenerationResponse(args: { currentRunId: string | null; currentGenerationId: string | null }) {
  return jsonResponse({
    error: true,
    errorCode: "stale_review_generation",
    message: "The review payload is stale for this document generation.",
    currentRunId: args.currentRunId,
    currentGenerationId: args.currentGenerationId,
  }, 409);
}

function approvalReadiness(payload: any, approvalGatingEnabled: boolean) {
  return {
    approvalEligible: payload?.validationSummary?.approvalEligible ?? false,
    approvalGatingEnabled,
    blockingIssueCount: payload?.validationSummary?.blockingIssueCount ?? 0,
    warningCount: payload?.validationSummary?.warningCount ?? 0,
    fallbackCount: payload?.coverage?.totals?.legacyFallbacks ?? 0,
    conflictCount: payload?.coverage?.totals?.conflicts ?? 0,
    missingRequiredCount: payload?.validationSummary?.missingRequiredCount ?? 0,
    missingEvidenceCount: payload?.validationSummary?.missingEvidenceCount ?? 0,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (!["GET", "POST"].includes(req.method)) return jsonResponse({ error: true, message: "Method not allowed" }, 405);

    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);
    const parsed = await parseRequest(req);
    if (!parsed.runId && !parsed.uploadedFileId) {
      return jsonResponse({ error: true, message: "One of run_id or uploaded_file_id is required" }, 400);
    }

    const rollout = await resolveCanonicalReviewRolloutForOrg({ supabaseAdmin, orgId, documentFamily: "lease" });
    let run: Record<string, unknown> | null = null;
    let runResolutionError: string | null = null;
    try {
      run = await resolveRun({ supabaseAdmin, orgId, runId: parsed.runId, uploadedFileId: parsed.uploadedFileId });
    } catch (resolveError: any) {
      // resolveRun throws if the underlying v3 tables aren't provisioned in
      // this environment (e.g. document_intelligence_runs doesn't exist).
      // That's operationally identical to "no run exists" -- there is
      // nothing reliable to show from the canonical system either way -- so
      // degrade to the same graceful no-run response below in every
      // rollout mode, instead of letting it propagate to an unhandled 500.
      runResolutionError = resolveError?.message ?? String(resolveError);
    }
    if (!run) {
      let legacyUploadedFile: any = null;
      let legacyFetchError: string | null = null;
      if (parsed.uploadedFileId) {
        try {
          legacyUploadedFile = await fetchUploadedFile({ supabaseAdmin, orgId, uploadedFileId: parsed.uploadedFileId });
        } catch (uploadedFileError: any) {
          legacyFetchError = uploadedFileError?.message ?? String(uploadedFileError);
        }
      }
      return jsonResponse({
        mode: rollout.mode,
        uiAuthority: "legacy",
        enterpriseReviewPayload: null,
        legacyReviewPayload: legacyUploadedFile?.ui_review_payload ?? null,
        authorityReadiness: { ready: false, materialMismatchCount: 0, approvalCriticalMismatchCount: 0, canonicalMissingCount: 0, unsupportedFieldCount: 0, reasons: [runResolutionError ? "document_intelligence_run_resolution_failed" : "no_completed_document_intelligence_run"] },
        diagnostics: { rollout, runResolutionError, legacyFetchError },
      });
    }

    const uploadedFileId = parsed.uploadedFileId ?? run.uploaded_file_id;
    const uploadedFile = await fetchUploadedFile({ supabaseAdmin, orgId, uploadedFileId });
    if (!uploadedFile) return jsonResponse({ error: true, message: "Uploaded file not found for organization" }, 404);

    const currentGenerationId = uploadedFile.active_generation_id ?? run.generation_id ?? null;
    if (parsed.generationId && currentGenerationId && parsed.generationId !== currentGenerationId) {
      return staleGenerationResponse({ currentRunId: run.id ?? null, currentGenerationId });
    }
    if (run.generation_id && uploadedFile.active_generation_id && run.generation_id !== uploadedFile.active_generation_id) {
      return staleGenerationResponse({ currentRunId: run.id ?? null, currentGenerationId });
    }

    const sourceMode = rollout.builderSourceMode;
    const payloadSchemaVersion = isEnterpriseReviewPayloadV2Enabled() && isDocumentSemanticsV6Enabled() ? "enterprise-review-payload-v2" : "enterprise-review-payload-v1";
    const current = await fetchCurrentEnterprisePayload({ supabaseAdmin, orgId, uploadedFileId, runId: run.id, sourceMode, generationId: currentGenerationId, schemaVersion: payloadSchemaVersion });
    if (current.row?.payload) {
      return jsonResponse({
        mode: rollout.mode,
        sourceMode,
        uiAuthority: rollout.uiAuthority,
        enterpriseReviewPayload: current.row.payload,
        legacyReviewPayload: uploadedFile.ui_review_payload ?? null,
        authorityReadiness: current.row.payload.compatibility?.paritySummary?.readiness ?? { ready: false, reasons: ["missing_parity_summary"] },
        approvalReadiness: approvalReadiness(current.row.payload, isCanonicalApprovalGatingEnabled()),
        diagnostics: {
          rollout,
          persistedPayloadId: current.row.id,
          persistedPayloadHash: current.row.payload_hash,
          persistedPayloadReused: true,
          persistenceError: current.error,
        },
      });
    }

    const buildStartedAt = Date.now();
    try {
      const projectionRows = await fetchRunCanonicalFieldProjections({ supabaseAdmin, orgId, runId: run.id });
      const claimIds = [...new Set(projectionRows.flatMap((row: any) => Array.isArray(row?.source_claim_ids) ? row.source_claim_ids : []))];
      const evidenceRows = await fetchClaimEvidence({ supabaseAdmin, orgId, claimIds });
      const activeOverrides = await fetchActiveReviewOverrides({ supabaseAdmin, orgId, uploadedFileId, runId: run.id, generationId: currentGenerationId });
      const registry = buildCanonicalReviewFieldRegistry(uploadedFile.module_type ?? "lease");
      const built = await buildEnterpriseReviewPayload({
        orgId,
        uploadedFileId,
        leaseId: run.lease_id ?? null,
        run,
        generationId: currentGenerationId,
        sourceMode,
        registry,
        projectionRows,
        evidenceRows,
        legacyPayload: uploadedFile.ui_review_payload ?? null,
        canonicalDocument: canonicalDocumentFromUploadedFile(uploadedFile),
        activeOverrides,
      });
      let enterpriseReviewPayload = built.payload;
      const semanticDiagnostics: any = { enabled: false };
      if (isEnterpriseReviewPayloadV2Enabled() && isDocumentSemanticsV6Enabled()) {
        const semanticBlocks = semanticBlocksFromUploadedFile(uploadedFile);
        const definitions = buildDefinitionRecords(semanticBlocks);
        const crossReferences = resolveCrossReferences({ references: parseCrossReferences(semanticBlocks), blocks: semanticBlocks, definitions });
        const familyClassification = classifyDocumentFamily({ filename: uploadedFile.file_name ?? uploadedFile.name ?? null, title: semanticBlocks[0]?.text ?? null, blocks: semanticBlocks });
        const family = buildDocumentFamilyMember({ uploadedFileId, classification: familyClassification, fallbackFamilyId: null });
        const amendmentEffects = extractAmendmentEffects({ blocks: semanticBlocks, sourceUploadedFileId: uploadedFileId, sourceRunId: run.id, sourceGenerationId: String(currentGenerationId ?? run.generation_id ?? ""), documentFamilyId: family.documentFamilyId });
        enterpriseReviewPayload = await buildEnterpriseReviewPayloadV2({
          payloadV1: built.payload,
          documentFamilyId: family.documentFamilyId,
          documentRole: familyClassification.documentRole,
          familyMembers: orderDocumentFamilyMembers([family.member]),
          chronologyStatus: family.chronologyStatus,
          definitions,
          crossReferences,
          amendmentEffects,
          activeOverrides,
          semanticSearchEnabled: isSemanticFieldSearchV6Enabled(),
        });
        semanticDiagnostics.enabled = true;
        semanticDiagnostics.definitionCount = definitions.length;
        semanticDiagnostics.crossReferenceCount = crossReferences.length;
        semanticDiagnostics.amendmentEffectCount = amendmentEffects.length;
        await persistDefinitionRecords({ supabaseAdmin, orgId, uploadedFileId, runId: run.id, generationId: String(currentGenerationId ?? run.generation_id ?? ""), definitions });
        await persistCrossReferences({ supabaseAdmin, orgId, uploadedFileId, runId: run.id, generationId: String(currentGenerationId ?? run.generation_id ?? ""), references: crossReferences });
        if (family.documentFamilyId) await persistAmendmentEffects({ supabaseAdmin, orgId, effects: amendmentEffects });
        await persistSemanticSearchRecords({ supabaseAdmin, orgId, records: enterpriseReviewPayload.semanticSearchRecords ?? [] });
      }
      const persisted = await persistEnterpriseReviewPayload({
        supabaseAdmin,
        payload: enterpriseReviewPayload,
        diagnostics: {
          rolloutMode: rollout.mode,
          rolloutSource: rollout.source,
          payloadBuildDurationMs: Date.now() - buildStartedAt,
          registryVersion: registry[0]?.schemaVersion ?? null,
          projectionAlgorithmVersion: projectionRows.find((row: any) => row?.projection_algorithm_version)?.projection_algorithm_version ?? "projection-resolution-v1",
          integrityViolationCount: built.rejectedProjectionCount,
        },
      });

      return jsonResponse({
        mode: rollout.mode,
        sourceMode,
        uiAuthority: rollout.uiAuthority,
        enterpriseReviewPayload,
        legacyReviewPayload: uploadedFile.ui_review_payload ?? null,
        authorityReadiness: built.authorityReadiness,
        approvalReadiness: approvalReadiness(enterpriseReviewPayload, isCanonicalApprovalGatingEnabled()),
        diagnostics: {
          rollout,
          persistedPayloadId: persisted.id,
          persistenceError: persisted.error,
          rejectedProjectionCount: built.rejectedProjectionCount,
          rejectedProjectionReasons: built.rejectedProjectionReasons,
          activeOverrideCount: activeOverrides.length,
          semanticDiagnostics,
        },
      });
    } catch (buildError: any) {
      // A canonical-payload build failure must never surface as an
      // unhandled 500 to the reviewer -- the legacy ui_review_payload is
      // always a safe, available fallback regardless of rollout mode. This
      // used to be gated to shadow/canonical_hybrid plus an emergency-
      // fallback flag, which meant a legacy-mode org (the default for any
      // unconfigured org) had no fallback at all and a build error 500'd
      // straight through.
      return jsonResponse({
        mode: "legacy",
        sourceMode: "legacy",
        uiAuthority: "legacy",
        enterpriseReviewPayload: null,
        legacyReviewPayload: uploadedFile.ui_review_payload ?? null,
        authorityReadiness: { ready: false, reasons: ["canonical_review_payload_build_failed"] },
        diagnostics: { rollout, emergencyFallback: true, originalMode: rollout.mode, error: buildError?.message ?? String(buildError) },
      });
    }
  } catch (error: any) {
    console.error(`[document-intelligence-v4-review-payload] error: ${error?.message ?? error}`);
    return jsonResponse({ error: true, message: error?.message ?? "Failed to build Release 4 review payload" }, 500);
  }
});

// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import {
  deriveDisplayState,
  extractPipelineMetadata,
  getProgressPercentage,
  isMissingSchemaError,
  sanitizeJob,
  sanitizeLog,
  summarizeNormalizedOutput,
} from "./status-utils.ts";
import { ENRICH_STAGE_SEQUENCE } from "../_shared/extraction/enrich-bounded-stage/stage-sequence.ts";
import { readBoundedStageResults, resolveNextBoundedEnrichStageToResume } from "../_shared/extraction/enrich-bounded-stage/stage-persistence.ts";
import { dispatchBoundedEnrichStageWorker, enqueueBoundedEnrichStage } from "../_shared/extraction/enrich-bounded-stage/dispatch.ts";

const FULL_FILE_SELECT = [
  "id",
  "org_id",
  "file_name",
  "file_url",
  "module_type",
  "mime_type",
  "status",
  "processing_status",
  "progress_percentage",
  "failed_step",
  "error_message",
  "review_required",
  "review_status",
  "document_subtype",
  "extraction_method",
  "openai_extraction_attempted",
  "ui_review_payload",
  "reviewed_output",
  "normalized_output",
  "docling_raw",
  "azure_raw_response",
  "row_count",
  "valid_count",
  "error_count",
  "validation_errors",
  "property_id",
  "building_id",
  "unit_id",
  "active_generation_id",
  "enrichment_status",
  "review_readiness",
  "review_readiness_reasons",
  "artifact_sync_status",
  "created_at",
  "updated_at",
  "processing_started_at",
  "processing_completed_at",
].join(",");

const BASIC_FILE_SELECT = [
  "id",
  "org_id",
  "file_name",
  "file_url",
  "module_type",
  "mime_type",
  "status",
  "progress_percentage",
  "failed_step",
  "error_message",
  "review_required",
  "review_status",
  "extraction_method",
  "openai_extraction_attempted",
  "active_generation_id",
  "enrichment_status",
  "review_readiness",
  "review_readiness_reasons",
  "artifact_sync_status",
  "row_count",
  "valid_count",
  "error_count",
  "validation_errors",
  "created_at",
  "updated_at",
  "processing_started_at",
  "processing_completed_at",
].join(",");

const MINIMAL_FILE_SELECT = [
  "id",
  "org_id",
  "file_name",
  "file_url",
  "module_type",
  "mime_type",
  "status",
  "error_message",
  "row_count",
  "created_at",
  "updated_at",
].join(",");

const FILE_SELECTS = [FULL_FILE_SELECT, BASIC_FILE_SELECT, MINIMAL_FILE_SELECT];

const JOB_SELECT = [
  "id",
  "org_id",
  "uploaded_file_id",
  "lease_id",
  "generation_id",
  "job_type",
  "stage",
  "status",
  "attempt",
  "max_attempts",
  "available_at",
  "started_at",
  "completed_at",
  "error_code",
  "error_message",
  "input",
  "counts",
  "metadata",
  "created_at",
  "updated_at",
].join(",");

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function schemaWarning(source: string, error: any) {
  return {
    source,
    code: error?.code ?? null,
    message: error?.message ?? error?.details ?? "Schema object unavailable",
  };
}

async function fetchFileWithFallback(supabaseAdmin: any, fileId: string, orgId: string, includeDetails: boolean) {
  const warnings: any[] = [];
  const selects = includeDetails ? FILE_SELECTS : [BASIC_FILE_SELECT, MINIMAL_FILE_SELECT];
  let lastError = null;

  for (const columns of selects) {
    const { data, error } = await supabaseAdmin
      .from("uploaded_files")
      .select(columns)
      .eq("id", fileId)
      .eq("org_id", orgId)
      .maybeSingle();

    if (!error) return { data, error: null, warnings };

    lastError = error;
    if (!isMissingSchemaError(error)) break;
    warnings.push(schemaWarning("uploaded_files", error));
  }

  return { data: null, error: lastError, warnings };
}

async function listFilesWithFallback(supabaseAdmin: any, orgId: string, offset: number, limit: number) {
  const warnings: any[] = [];
  let lastError = null;

  for (const columns of [BASIC_FILE_SELECT, MINIMAL_FILE_SELECT]) {
    const { data, error } = await supabaseAdmin
      .from("uploaded_files")
      .select(columns)
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (!error) return { data: data || [], error: null, warnings };

    lastError = error;
    if (!isMissingSchemaError(error)) break;
    warnings.push(schemaWarning("uploaded_files", error));
  }

  return { data: [], error: lastError, warnings };
}

async function fetchLatestJob(supabaseAdmin: any, fileId: string, orgId: string) {
  const { data, error } = await supabaseAdmin
    .from("pipeline_jobs")
    .select(JOB_SELECT)
    .eq("uploaded_file_id", fileId)
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    return { data: null, warning: schemaWarning("pipeline_jobs", error) };
  }
  return { data, warning: null };
}

function isLeaseLikeModule(moduleType: unknown) {
  return /lease/i.test(String(moduleType ?? ""));
}


const BOUNDED_ENRICH_QUEUED_REDISPATCH_AFTER_MS = 30_000;
const BOUNDED_ENRICH_RUNNING_REDISPATCH_AFTER_MS = 10 * 60_000;

function ageMs(value: unknown, now = Date.now()) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? now - parsed : Number.POSITIVE_INFINITY;
}

function activeBoundedJobRedispatchReason(job: Record<string, any>, now = Date.now()) {
  const status = String(job?.status ?? "").toLowerCase();
  const freshestTimestamp = job?.updated_at ?? job?.started_at ?? job?.created_at ?? job?.available_at;
  const queuedTimestamp = job?.available_at ?? job?.created_at ?? job?.updated_at;
  const jobAgeMs = status === "queued" ? ageMs(queuedTimestamp, now) : ageMs(freshestTimestamp, now);

  if (status === "queued" && jobAgeMs >= BOUNDED_ENRICH_QUEUED_REDISPATCH_AFTER_MS) {
    return { reason: "queued_dispatch_not_durable", age_ms: jobAgeMs };
  }
  if (status === "running" && jobAgeMs >= BOUNDED_ENRICH_RUNNING_REDISPATCH_AFTER_MS) {
    return { reason: "running_worker_stale_reclaim", age_ms: jobAgeMs };
  }
  return null;
}

function normalizedOutputReadyForBoundedEnrichment(record: Record<string, any>, generationId: string | null) {
  const normalizedOutput = record?.normalized_output;
  if (!normalizedOutput || typeof normalizedOutput !== "object" || !Array.isArray(normalizedOutput.rows)) {
    return false;
  }
  const normalizedGenerationId = normalizedOutput?.metadata?.generation_id ?? null;
  return Boolean(normalizedGenerationId && generationId && normalizedGenerationId === generationId);
}

async function findActiveNormalizePrerequisite(supabaseAdmin: any, fileId: string, orgId: string, generationId: string) {
  const { data, error } = await supabaseAdmin
    .from("pipeline_jobs")
    .select("id, stage, status, available_at, started_at, created_at, updated_at")
    .eq("uploaded_file_id", fileId)
    .eq("org_id", orgId)
    .eq("generation_id", generationId)
    .in("stage", ["parse", "normalize"])
    .in("status", ["queued", "running"])
    .order("created_at", { ascending: true })
    .limit(1);

  if (error) return null;
  return Array.isArray(data) ? data[0] ?? null : null;
}

async function maybeResumeBoundedEnrichment(supabaseAdmin: any, record: Record<string, any>, orgId: string) {
  const fileId = record?.id;
  const generationId = record?.active_generation_id ?? null;
  const enrichmentState = String(record?.enrichment_status ?? record?.ui_review_payload?.enrichment_status ?? "").toLowerCase();
  const readiness = String(record?.review_readiness ?? "").toLowerCase();
  if (!fileId || !generationId || !isLeaseLikeModule(record?.module_type)) return null;
  if (!["", "pending"].includes(enrichmentState) && !["", "pending"].includes(readiness)) return null;

  const prerequisiteJob = await findActiveNormalizePrerequisite(supabaseAdmin, fileId, orgId, generationId);
  if (prerequisiteJob) {
    return {
      waiting_for_stage: prerequisiteJob.stage,
      job_id: prerequisiteJob.id,
      job_status: prerequisiteJob.status,
    };
  }

  if (!normalizedOutputReadyForBoundedEnrichment(record, generationId)) {
    return { waiting_for_stage: "normalize", reason: "normalized_output_not_ready" };
  }

  const results = readBoundedStageResults(record?.normalized_output);
  const { data: activeJobs, error: activeError } = await supabaseAdmin
    .from("pipeline_jobs")
    .select("id, stage, status, attempt, max_attempts, available_at, started_at, created_at, updated_at")
    .eq("uploaded_file_id", fileId)
    .eq("org_id", orgId)
    .eq("generation_id", generationId)
    .like("stage", "enrich_%")
    .in("status", ["queued", "running"])
    .order("created_at", { ascending: true })
    .limit(1);

  if (activeError) return null;

  const activeJob = Array.isArray(activeJobs) ? activeJobs[0] : null;
  if (activeJob) {
    const redispatch = activeBoundedJobRedispatchReason(activeJob);
    if (!redispatch) return null;

    dispatchBoundedEnrichStageWorker(activeJob.id);
    return {
      resumed_stage: activeJob.stage,
      job_id: activeJob.id,
      existing: true,
      redispatched: true,
      redispatch_reason: redispatch.reason,
      redispatch_age_ms: redispatch.age_ms,
      job_status: activeJob.status,
    };
  }

  const nextStage = resolveNextBoundedEnrichStageToResume({ results, generationId, sequence: ENRICH_STAGE_SEQUENCE });
  if (!nextStage) {
    const { data, error } = await supabaseAdmin.rpc("finalize_lease_extraction_for_review", {
      p_org_id: orgId,
      p_uploaded_file_id: fileId,
      p_generation_id: generationId,
    });
    if (error) {
      console.warn("[pipeline-status] bounded enrichment appears complete but readiness finalization failed:", error.message);
      return { finalized: false, finalization_error: error.message };
    }
    return { finalized: true, readiness: data?.readiness ?? null, ready: data?.ready ?? null };
  }

  const enqueued = await enqueueBoundedEnrichStage({
    supabaseAdmin,
    orgId,
    fileId,
    stage: nextStage,
    generationId,
    moduleType: record?.module_type,
  });
  return enqueued?.id ? { resumed_stage: nextStage, job_id: enqueued.id, existing: !!enqueued.existing } : null;
}

export const __test__ = {
  activeBoundedJobRedispatchReason,
  findActiveNormalizePrerequisite,
  maybeResumeBoundedEnrichment,
  normalizedOutputReadyForBoundedEnrichment,
};
async function fetchRecentLogs(supabaseAdmin: any, fileId: string, orgId: string) {
  const { data, error } = await supabaseAdmin
    .from("pipeline_logs")
    .select("step, level, message, metadata, timestamp")
    .eq("file_id", fileId)
    .eq("org_id", orgId)
    .order("timestamp", { ascending: false })
    .limit(10);

  if (error) {
    return { data: [], warning: schemaWarning("pipeline_logs", error) };
  }
  return { data: data || [], warning: null };
}

function formatFileRecord(record: Record<string, any>, extras: Record<string, any> = {}) {
  const pipeline = extractPipelineMetadata(record);
  // Lightweight Azure response summary (page/paragraph/table/content counts)
  // -- always populated by azure-layout-adapter.ts regardless of the
  // STORE_FULL_AZURE_RAW_RESPONSE flag (that flag only gates the full raw
  // response, not this summary). Surfacing it lets the UI distinguish "Azure
  // saw a real multi-page document but extraction dropped it" from "Azure
  // genuinely received almost nothing" without exposing the full response.
  const doclingSummary =
    (record.docling_raw as any)?.raw_response_summary ??
    (record.azure_raw_response as any)?.raw_response_summary ??
    null;
  // Diagnostic: the OpenAI fact-ledger orchestrator's own internal debug
  // counts (how many facts it extracted vs. how many actually mapped to a
  // standard field, and why) -- persisted in metadata.extractionDebug but
  // never otherwise surfaced. This is the only way to distinguish "OpenAI
  // was never called", "OpenAI returned facts but none mapped", and "OpenAI
  // call itself failed" without direct DB/log access.
  const extractionDebug =
    (record.ui_review_payload as any)?.metadata?.extractionDebug ??
    (record.normalized_output as any)?.metadata?.extractionDebug ??
    null;
  const businessProvenance =
    (record.ui_review_payload as any)?.metadata?.provenance ??
    (record.normalized_output as any)?.metadata?.provenance ??
    null;
  const openaiFactLedgerDebug = extractionDebug?.openai_fact_ledger ?? null;
  const openaiAttemptCount = Number(businessProvenance?.openai_attempt_count ?? 0);
  const openaiFactsExtractedCount = Number(openaiFactLedgerDebug?.facts_extracted_count ?? 0);
  const openaiFactsMappedCount = Number(openaiFactLedgerDebug?.facts_mapped_count ?? 0);
  const openaiFactsUnmappedCount = Number(openaiFactLedgerDebug?.facts_unmapped_count ?? 0);
  const openaiLlmCallCount = Number(openaiFactLedgerDebug?.llm_call_count ?? 0);
  const derivedOpenaiAttempted =
    record.openai_extraction_attempted === true ||
    openaiAttemptCount > 0 ||
    openaiFactsExtractedCount > 0 ||
    Boolean(openaiFactLedgerDebug?.response_id) ||
    Boolean(openaiFactLedgerDebug?.failure_http_status);
  const standardFieldPerFactRatio = openaiFactsExtractedCount > 0
    ? Number((openaiFactsMappedCount / openaiFactsExtractedCount).toFixed(3))
    : null;
  return {
    ok: true,
    error: false,
    file_id: record.id,
    id: record.id,
    org_id: record.org_id ?? null,
    file_name: record.file_name ?? null,
    file_url: record.file_url ?? null,
    module_type: record.module_type ?? null,
    mime_type: record.mime_type ?? null,
    status: record.status ?? null,
    processing_status: record.processing_status ?? null,
    progress_percentage: getProgressPercentage(record),
    progress: getProgressPercentage(record),
    row_count: record.row_count ?? null,
    valid_count: record.valid_count ?? null,
    error_count: record.error_count ?? null,
    validation_errors: Array.isArray(record.validation_errors) ? record.validation_errors : [],
    error_message: record.error_message ?? null,
    failed_step: record.failed_step ?? null,
    review_required: record.review_required ?? null,
    review_status: record.review_status ?? null,
    document_subtype: record.document_subtype ?? null,
    extraction_method: record.extraction_method ?? null,
    openai_extraction_attempted: derivedOpenaiAttempted,
    openai_extraction_attempted_column: record.openai_extraction_attempted ?? null,
    property_id: record.property_id ?? null,
    building_id: record.building_id ?? null,
    unit_id: record.unit_id ?? null,
    active_generation_id: record.active_generation_id ?? null,
    created_at: record.created_at,
    updated_at: record.updated_at,
    processing_started_at: record.processing_started_at ?? null,
    processing_completed_at: record.processing_completed_at ?? null,
    file_metadata: {
      id: record.id,
      file_name: record.file_name ?? null,
      file_url: record.file_url ?? null,
      module_type: record.module_type ?? null,
      mime_type: record.mime_type ?? null,
      org_id: record.org_id ?? null,
      property_id: record.property_id ?? null,
      building_id: record.building_id ?? null,
      unit_id: record.unit_id ?? null,
      created_at: record.created_at,
      updated_at: record.updated_at,
    },
    pipeline,
    docling_summary: doclingSummary,
    business_extraction_debug: {
      parser_method: record.extraction_method ?? null,
      requested_provider: businessProvenance?.requested_provider ?? null,
      effective_provider: businessProvenance?.effective_provider ?? null,
      acceptance_state: businessProvenance?.acceptance_state ?? null,
      fallback_used: businessProvenance?.fallback_used ?? null,
      fallback_reason: businessProvenance?.fallback_reason ?? null,
      openai_attempt_count: openaiAttemptCount,
      openai_attempted: derivedOpenaiAttempted,
      openai_attempted_column: record.openai_extraction_attempted ?? null,
      openai_debug_present: Boolean(openaiFactLedgerDebug),
      openai_llm_call_count: Number.isFinite(openaiLlmCallCount) ? openaiLlmCallCount : null,
      facts_extracted_count: Number.isFinite(openaiFactsExtractedCount) ? openaiFactsExtractedCount : null,
      standard_fields_mapped_from_facts_count: Number.isFinite(openaiFactsMappedCount) ? openaiFactsMappedCount : null,
      unmapped_fact_count: Number.isFinite(openaiFactsUnmappedCount) ? openaiFactsUnmappedCount : null,
      standard_field_per_fact_ratio: standardFieldPerFactRatio,
      fact_counters_are_partitioned: false,
      fact_counter_note: "facts_extracted is source facts; mapped is standard fields populated; unmapped is source facts that did not win a field. They are diagnostics, not mapped + unmapped = total.",
      failure_classification: openaiFactLedgerDebug?.failure_classification ?? null,
      failure_http_status: openaiFactLedgerDebug?.failure_http_status ?? null,
      extraction_mode: openaiFactLedgerDebug?.extraction_mode ?? null,
      architecture: openaiFactLedgerDebug?.architecture ?? null,
      authoritative: openaiFactLedgerDebug?.authoritative ?? null,
      typescript_field_mapping_used: openaiFactLedgerDebug?.typescript_field_mapping_used ?? null,
      stale_attempt_column: record.openai_extraction_attempted === false && derivedOpenaiAttempted,
    },
    openai_fact_ledger_debug: openaiFactLedgerDebug
      ? {
        document_profile: openaiFactLedgerDebug.document_profile ?? null,
        extraction_mode: openaiFactLedgerDebug.extraction_mode ?? null,
        architecture: openaiFactLedgerDebug.architecture ?? null,
        authoritative: openaiFactLedgerDebug.authoritative ?? null,
        typescript_field_mapping_used: openaiFactLedgerDebug.typescript_field_mapping_used ?? null,
        llm_call_count: openaiFactLedgerDebug.llm_call_count ?? null,
        facts_extracted_count: openaiFactLedgerDebug.facts_extracted_count ?? null,
        facts_mapped_count: openaiFactLedgerDebug.facts_mapped_count ?? null,
        facts_unmapped_count: openaiFactLedgerDebug.facts_unmapped_count ?? null,
        mapped_non_null_field_count: openaiFactLedgerDebug.mapped_non_null_field_count ?? null,
        invalid_or_omitted_claim_count: openaiFactLedgerDebug.invalid_or_omitted_claim_count ?? null,
        // Split the above into its two very different causes: an omitted field
        // means the model never mentioned it (truncated/abandoned answer),
        // which is diagnostically nothing like a wrong value. finish_reason
        // "length" is the direct truncation signal.
        omitted_field_count: openaiFactLedgerDebug.omitted_field_count ?? null,
        omitted_field_ratio: openaiFactLedgerDebug.omitted_field_ratio ?? null,
        max_omitted_field_ratio: openaiFactLedgerDebug.max_omitted_field_ratio ?? null,
        finish_reason: openaiFactLedgerDebug.finish_reason ?? null,
        schema_field_count: openaiFactLedgerDebug.schema_field_count ?? null,
        max_output_tokens: openaiFactLedgerDebug.max_output_tokens ?? null,
        output_tokens: openaiFactLedgerDebug.output_tokens ?? null,
        failure_classification: openaiFactLedgerDebug.failure_classification ?? null,
        failure_http_status: openaiFactLedgerDebug.failure_http_status ?? null,
        document_index_source: openaiFactLedgerDebug.document_index_source ?? null,
        // Sectioned/large-document architecture only: a failed section means
        // that slice of the lease produced no usable answer at all (see
        // failure_classification "SECTIONED_RESPONSE_SECTION_FAILURES").
        section_count: openaiFactLedgerDebug.section_count ?? null,
        section_failure_count: openaiFactLedgerDebug.section_failure_count ?? null,
        section_failure_ratio: openaiFactLedgerDebug.section_failure_ratio ?? null,
        max_section_failure_ratio: openaiFactLedgerDebug.max_section_failure_ratio ?? null,
        section_deadline_exhausted: openaiFactLedgerDebug.section_deadline_exhausted ?? null,
        failed_sections: openaiFactLedgerDebug.failed_sections ?? null,
      }
      : null,
    ui_review_payload: record.ui_review_payload ?? null,
    reviewed_output: record.reviewed_output ?? null,
    normalized_output_summary: summarizeNormalizedOutput(record.normalized_output),
    ...extras,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);

    let fileId: string | null = null;
    let includeDetails = false;
    let offset = 0;
    let limit = 50;

    if (req.method === "GET") {
      const url = new URL(req.url);
      fileId = url.searchParams.get("file_id") || null;
      includeDetails = url.searchParams.get("include_details") === "true";
      offset = parseInt(url.searchParams.get("offset") || "0", 10) || 0;
      limit = parseInt(url.searchParams.get("limit") || "50", 10) || 50;
    } else {
      const body = await req.json().catch(() => ({}));
      fileId = body.file_id || null;
      includeDetails = body.include_details === true;
      offset = typeof body.offset === "number" ? body.offset : 0;
      limit = typeof body.limit === "number" ? body.limit : 50;
    }

    if (limit > 100) limit = 100;
    if (limit < 1) limit = 1;
    if (offset < 0) offset = 0;

    if (fileId) {
      const fileResult = await fetchFileWithFallback(supabaseAdmin, fileId, orgId, includeDetails);
      const schemaWarnings = [...fileResult.warnings];

      if (fileResult.error || !fileResult.data) {
        return jsonResponse({
          ok: false,
          error: true,
          error_code: "FILE_NOT_FOUND",
          message: fileResult.error?.message || "Invalid file_id",
          schema_warnings: schemaWarnings,
        }, 404);
      }
      if ("azure_raw_response" in fileResult.data) {
        fileResult.data.docling_raw = fileResult.data.azure_raw_response ?? fileResult.data.docling_raw ?? null;
      }

      const resumeResult = includeDetails
        ? await maybeResumeBoundedEnrichment(supabaseAdmin, fileResult.data, orgId)
        : null;

      const latestJobResult = includeDetails
        ? await fetchLatestJob(supabaseAdmin, fileId, orgId)
        : { data: null, warning: null };
      if (latestJobResult.warning) schemaWarnings.push(latestJobResult.warning);

      const recentLogsResult = includeDetails
        ? await fetchRecentLogs(supabaseAdmin, fileId, orgId)
        : { data: [], warning: null };
      if (recentLogsResult.warning) schemaWarnings.push(recentLogsResult.warning);

      const latestJob = sanitizeJob(latestJobResult.data);
      const display = deriveDisplayState(fileResult.data, latestJobResult.data);

      return jsonResponse(formatFileRecord(fileResult.data, {
        latest_job: latestJob,
        recent_logs: (recentLogsResult.data || []).map(sanitizeLog),
        schema_warnings: schemaWarnings,
        bounded_enrichment_resume: resumeResult,
        ...display,
      }));
    }

    const { count: totalCount, error: countError } = await supabaseAdmin
      .from("uploaded_files")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId);

    const listResult = await listFilesWithFallback(supabaseAdmin, orgId, offset, limit);
    if (listResult.error) {
      return jsonResponse({
        ok: false,
        error: true,
        message: listResult.error.message,
        schema_warnings: listResult.warnings,
      }, isMissingSchemaError(listResult.error) ? 200 : 400);
    }

    return jsonResponse({
      ok: true,
      error: false,
      files: (listResult.data || []).map((record) => formatFileRecord(record, {
        schema_warnings: listResult.warnings,
        ...deriveDisplayState(record, null),
      })),
      total: countError ? null : totalCount ?? 0,
      offset,
      limit,
      schema_warnings: [
        ...(countError && isMissingSchemaError(countError) ? [schemaWarning("uploaded_files_count", countError)] : []),
        ...listResult.warnings,
      ],
    });
  } catch (err) {
    console.error("[pipeline-status] Error:", err?.message || err);
    return jsonResponse({
      ok: false,
      error: true,
      message: err?.message || "Could not load pipeline status.",
    }, 400);
  }
});

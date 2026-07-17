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
  "ui_review_payload",
  "reviewed_output",
  "normalized_output",
  "docling_raw",
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
    property_id: record.property_id ?? null,
    building_id: record.building_id ?? null,
    unit_id: record.unit_id ?? null,
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

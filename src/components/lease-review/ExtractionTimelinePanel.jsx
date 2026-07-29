import React, { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Clock, Database, GitBranch, Loader2, RefreshCw, TimerReset } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { supabase } from "@/services/supabaseClient";

function isMissingSchemaError(error) {
  const text = `${error?.code || ""} ${error?.message || ""} ${error?.details || ""}`.toLowerCase();
  return (
    text.includes("42p01") ||
    text.includes("42703") ||
    text.includes("pgrst204") ||
    text.includes("schema cache") ||
    text.includes("does not exist") ||
    text.includes("could not find")
  );
}

function asDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(value) {
  const date = asDate(value);
  if (!date) return "-";
  return date.toLocaleString();
}

function durationMs(start, end) {
  const startDate = asDate(start);
  const endDate = asDate(end);
  if (!startDate) return null;
  const finalDate = endDate || new Date();
  const ms = finalDate.getTime() - startDate.getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function formatDuration(ms) {
  if (ms == null) return "-";
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

function statusBadgeClass(status) {
  const value = String(status || "unknown").toLowerCase();
  if (["completed", "processed", "ready", "review_required", "success", "succeeded"].includes(value)) return "bg-emerald-100 text-emerald-700";
  if (["running", "queued", "pending", "parsing", "normalizing", "started"].includes(value)) return "bg-blue-100 text-blue-700";
  if (["failed", "error", "blocked"].includes(value)) return "bg-red-100 text-red-700";
  if (["superseded", "retry_pending", "manual_review", "review_required"].includes(value)) return "bg-amber-100 text-amber-800";
  return "bg-slate-100 text-slate-700";
}

function compactJson(value) {
  if (!value || typeof value !== "object") return null;
  const safe = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/text|source|clause|url|email|phone|tenant|landlord|address/i.test(key)) continue;
    safe[key] = entry;
  }
  const text = JSON.stringify(safe);
  return text && text !== "{}" ? text : null;
}

const STAGE_ROUTING = [
  {
    match: /upload_received|uploaded_files/i,
    functionName: "LeaseUpload.jsx -> FileUploader.jsx -> upload-handler",
    trigger: "User selects/uploads the lease file.",
    input: "Browser file, module type, org/user context, file metadata.",
    output: "uploaded_files row plus stored file object. No extraction yet.",
  },
  {
    match: /confirm/i,
    functionName: "confirm-upload",
    trigger: "Upload confirmation after storage succeeds.",
    input: "uploaded_file_id, storage path, file metadata.",
    output: "Confirmed upload row ready for ingestion.",
  },
  {
    match: /ingest/i,
    functionName: "ingest-file",
    trigger: "Confirmed lease upload.",
    input: "uploaded_file_id, module_type=lease, generation id.",
    output: "pipeline_jobs rows for parse/normalize and worker dispatch.",
  },
  {
    match: /parse/i,
    functionName: "lease-extraction-worker -> parse-document-azure",
    trigger: "Worker claims the parse job.",
    input: "File bytes/storage URL, Azure Document Intelligence configuration.",
    output: "Azure layout, page/table/block counts, compact LLM document, parser metadata.",
  },
  {
    match: /normalize/i,
    functionName: "lease-extraction-worker -> normalize-pdf-output",
    trigger: "Worker claims the normalize job after parse completes.",
    input: "Azure compact document, generation id, parser metadata, lease schema.",
    output: "normalized_output, parsed_data, minimal Lease Review payload, extraction debug.",
  },
  {
    match: /whole_document|openai|llm|business_extraction/i,
    functionName: "normalize-pdf-output -> OpenAI/Azure OpenAI strict schema",
    trigger: "Normalize enters lease business extraction.",
    input: "Compact Azure document, strict lease schema, evidence contract.",
    output: "Evidence-backed fields, dynamic findings, conflicts, not-stated field list.",
  },
  {
    match: /enrich_truth|enrich_clause|enrich_financial|clause|financial|domain/i,
    functionName: "lease-extraction-worker -> normalize-pdf-output bounded enrich mode",
    trigger: "Core review payload is persisted and optional enrichment is queued.",
    input: "Existing normalized output, compact evidence, stage-specific domain scope.",
    output: "Clause/evidence/financial enrichment or partial enrichment warning.",
  },
  {
    match: /\benrich\b/i,
    functionName: "lease-extraction-worker -> normalize-pdf-output optional enrich",
    trigger: "Core review payload already exists; optional enrichment is trying to add clauses/evidence/detail.",
    input: "Existing normalized output and parsed Azure layout.",
    output: "Enrichment completion, partial enrichment warning, or retry. Core extracted fields should remain reviewable.",
  },
  {
    match: /review_handoff|review/i,
    functionName: "LeaseReview.jsx",
    trigger: "Review payload becomes available to the UI.",
    input: "ui_review_payload, normalized_output, generation-scoped uploaded file state.",
    output: "Lease Review tabs render sourced fields, statuses, evidence, and debug timeline.",
  },
];

function routingForStage(stage, source) {
  const text = `${stage || ""} ${source || ""}`;
  return STAGE_ROUTING.find((entry) => entry.match.test(text)) || {
    functionName: "pipeline worker / edge function",
    trigger: "Pipeline job or stage event.",
    input: "Stage metadata and generation-scoped uploaded file state.",
    output: "Stage status, logs, and persisted pipeline metadata.",
  };
}

function firstPresent(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function isSensitiveTextKey(key) {
  if (/(chars|char_count|length|count|page_count|table_count|paragraph_count|token|tokens)$/i.test(key)) {
    return false;
  }
  return /source_text|sourceQuote|full_text|markdown|raw_response|fileBase64|clause_text/i.test(key) ||
    /^content$/i.test(key) ||
    /_content$/i.test(key);
}

function sanitizeDetail(value, depth = 0) {
  if (value == null) return value;
  if (depth > 3) return "[nested]";
  if (typeof value === "string") {
    if (value.length > 700) return `${value.slice(0, 700)}...`;
    return value;
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 12).map((item) => sanitizeDetail(item, depth + 1));
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isSensitiveTextKey(key)) {
      out[key] = typeof entry === "string" ? `[omitted ${entry.length} chars]` : "[omitted]";
      continue;
    }
    out[key] = sanitizeDetail(entry, depth + 1);
  }
  return out;
}

function prettyDetail(value) {
  if (value == null || value === "") return "-";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(sanitizeDetail(value), null, 2);
  } catch {
    return String(value);
  }
}

function metadataSummary(metadata) {
  if (!metadata || typeof metadata !== "object") return null;
  const picked = {};
  for (const key of [
    "generation_id",
    "stage",
    "job_id",
    "error_code",
    "error_message",
    "outcome",
    "pageCount",
    "page_count",
    "tableCount",
    "table_count",
    "full_text_chars",
    "mapped_fields_count",
    "dynamic_terms_count",
    "lease_clauses_count",
    "normalize_status",
    "ai_status",
    "telemetry",
  ]) {
    if (metadata[key] !== undefined && metadata[key] !== null) picked[key] = metadata[key];
  }
  return Object.keys(picked).length > 0 ? picked : sanitizeDetail(metadata);
}

function readExtractionDebug(uploadedFile) {
  return uploadedFile?.ui_review_payload?.metadata?.extractionDebug
    ?? uploadedFile?.normalized_output?.metadata?.extractionDebug
    ?? uploadedFile?.extraction_data?.extraction_debug?.extractionDebug
    ?? null;
}

function readProvenance(uploadedFile) {
  return uploadedFile?.ui_review_payload?.metadata?.provenance
    ?? uploadedFile?.normalized_output?.metadata?.provenance
    ?? null;
}

function architectureSummary(uploadedFile) {
  const debug = readExtractionDebug(uploadedFile);
  const openaiDebug = debug?.openai_fact_ledger ?? debug?.vertex_fact_ledger ?? {};
  const provenance = readProvenance(uploadedFile);
  const architecture = firstPresent(openaiDebug.architecture, uploadedFile?.business_extraction_debug?.architecture, "pending");
  const extractionMode = firstPresent(openaiDebug.extraction_mode, uploadedFile?.business_extraction_debug?.extraction_mode, "pending");
  const parser = firstPresent(uploadedFile?.extraction_method, uploadedFile?.business_extraction_debug?.parser_method, "azure_layout");
  const effectiveProvider = firstPresent(provenance?.effective_provider, uploadedFile?.business_extraction_debug?.effective_provider, "openai_fact_ledger");
  const fallbackUsed = firstPresent(provenance?.fallback_used, uploadedFile?.business_extraction_debug?.fallback_used, false);
  const legacyDisabled = openaiDebug.legacy_hybrid_fallback_disabled === true || fallbackUsed === false;
  const sectionCount = firstPresent(openaiDebug.section_count, openaiDebug.compact_document?.section_count, null);
  return {
    parser,
    extractionMode,
    architecture,
    effectiveProvider,
    fallbackUsed,
    legacyDisabled,
    llmCalls: firstPresent(openaiDebug.llm_call_count, uploadedFile?.business_extraction_debug?.openai_llm_call_count, null),
    sectionCount,
    generation: firstPresent(uploadedFile?.active_generation_id, provenance?.generation_id, "-"),
  };
}

async function selectOrEmpty({ table, select, apply }) {
  let query = supabase.from(table).select(select);
  query = apply(query);
  const { data, error } = await query;
  if (!error) return { rows: data || [], warning: null };
  if (isMissingSchemaError(error)) {
    return { rows: [], warning: `${table}: ${error.message}` };
  }
  throw error;
}

async function fetchTimeline(uploadedFileId) {
  const warnings = [];
  const jobsResult = await selectOrEmpty({
    table: "pipeline_jobs",
    select: "id, uploaded_file_id, lease_id, job_type, stage, status, attempt, max_attempts, generation_id, available_at, started_at, completed_at, created_at, updated_at, error_code, error_message, counts, metadata",
    apply: (query) => query.eq("uploaded_file_id", uploadedFileId).order("created_at", { ascending: true }),
  });
  if (jobsResult.warning) warnings.push(jobsResult.warning);

  const logsResult = await selectOrEmpty({
    table: "pipeline_logs",
    select: "step, level, message, metadata, timestamp",
    apply: (query) => query.eq("file_id", uploadedFileId).order("timestamp", { ascending: true }).limit(100),
  });
  if (logsResult.warning) warnings.push(logsResult.warning);

  // extraction_runs_safe / extraction_stage_runs_safe deliberately expose a
  // narrower column set than the base tables (no error_message/output_summary/
  // metadata/pipeline_job_id -- those may carry document content or internal
  // detail, sanitized out of the view granted to authenticated clients).
  // error_code alone is available for a Detail fallback here; full error text
  // comes from pipeline_logs below instead, which already carries it in its
  // own metadata column.
  const runsResult = await selectOrEmpty({
    table: "extraction_runs_safe",
    select: "id, generation_id, run_type, provider_pipeline, contract_version, status, error_code, started_at, completed_at, created_at, updated_at",
    apply: (query) => query.eq("uploaded_file_id", uploadedFileId).order("started_at", { ascending: true }),
  });
  if (runsResult.warning) warnings.push(runsResult.warning);

  let stageRuns = [];
  const runIds = runsResult.rows.map((run) => run.id).filter(Boolean);
  if (runIds.length > 0) {
    const stageResult = await selectOrEmpty({
      table: "extraction_stage_runs_safe",
      select: "id, run_id, stage, attempt, status, provider, error_code, started_at, finished_at, created_at, updated_at",
      apply: (query) => query.in("run_id", runIds).order("started_at", { ascending: true }),
    });
    if (stageResult.warning) warnings.push(stageResult.warning);
    stageRuns = stageResult.rows;
  }

  return {
    jobs: jobsResult.rows,
    logs: logsResult.rows,
    runs: runsResult.rows,
    stageRuns,
    warnings,
  };
}

function TimelineMetric({ icon: Icon, label, value, tone = "slate" }) {
  const toneClass = {
    slate: "border-slate-200 bg-white text-slate-700",
    blue: "border-blue-200 bg-blue-50 text-blue-800",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-800",
    red: "border-red-200 bg-red-50 text-red-800",
    amber: "border-amber-200 bg-amber-50 text-amber-800",
  }[tone] || "border-slate-200 bg-white text-slate-700";

  return (
    <div className={`rounded-lg border p-3 ${toneClass}`}>
      <div className="flex items-center gap-2 text-xs font-semibold uppercase">
        <Icon className="h-4 w-4" />
        {label}
      </div>
      <div className="mt-2 text-lg font-bold text-slate-950">{value}</div>
    </div>
  );
}

function DetailBlock({ label, value }) {
  if (value == null || value === "" || value === "-") return null;
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase text-slate-500">{label}</div>
      <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-slate-200 bg-slate-50 p-2 text-xs leading-relaxed text-slate-700">
        {prettyDetail(value)}
      </pre>
    </div>
  );
}

export default function ExtractionTimelinePanel({ uploadedFile, uploadedFileId, lease }) {
  const fileId = uploadedFileId || uploadedFile?.id || lease?.source_file_id || lease?.extraction_data?.source_file_id || null;

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ["lease-extraction-timeline", fileId],
    enabled: Boolean(fileId && supabase),
    queryFn: () => fetchTimeline(fileId),
    retry: false,
    refetchInterval: (query) => {
      const jobs = query.state.data?.jobs || [];
      const hasActiveJob = jobs.some((job) => ["queued", "running"].includes(String(job.status || "").toLowerCase()));
      const fileActive = ["uploaded", "parsing", "pdf_parsed", "validating", "validated", "storing", "computing"].includes(String(uploadedFile?.status || "").toLowerCase());
      return hasActiveJob || fileActive ? 4000 : false;
    },
  });

  const timelineRows = useMemo(() => {
    const rows = [];
    if (uploadedFile) {
      rows.push({
        key: "file-created",
        source: "uploaded_files",
        stage: "upload_received",
        status: uploadedFile.status || "uploaded",
        startedAt: uploadedFile.created_at,
        finishedAt: uploadedFile.processing_started_at || uploadedFile.updated_at,
        duration: durationMs(uploadedFile.created_at, uploadedFile.processing_started_at || uploadedFile.updated_at),
        detail: uploadedFile.file_name || fileId,
        input: {
          file_name: uploadedFile.file_name,
          mime_type: uploadedFile.mime_type,
          module_type: uploadedFile.module_type,
          file_size: uploadedFile.file_size,
        },
        output: {
          uploaded_file_id: uploadedFile.id,
          status: uploadedFile.status,
          generation_id: uploadedFile.active_generation_id,
        },
      });
      if (uploadedFile.processing_started_at || uploadedFile.processing_completed_at) {
        rows.push({
          key: "file-processing",
          source: "uploaded_files",
          stage: "processing_window",
          status: uploadedFile.processing_status || uploadedFile.status || "unknown",
          startedAt: uploadedFile.processing_started_at || uploadedFile.created_at,
          finishedAt: uploadedFile.processing_completed_at || uploadedFile.updated_at,
          duration: durationMs(uploadedFile.processing_started_at || uploadedFile.created_at, uploadedFile.processing_completed_at || uploadedFile.updated_at),
          detail: uploadedFile.error_message || null,
          input: {
            status_before: uploadedFile.status,
            processing_started_at: uploadedFile.processing_started_at,
          },
          output: {
            processing_status: uploadedFile.processing_status,
            error_message: uploadedFile.error_message,
            failed_step: uploadedFile.failed_step,
          },
        });
      }
    }

    for (const job of data?.jobs || []) {
      rows.push({
        key: `job-${job.id}`,
        source: job.job_type || "pipeline_job",
        stage: job.stage || "pipeline",
        status: job.status || "unknown",
        attempt: job.attempt,
        startedAt: job.started_at || job.created_at,
        finishedAt: job.completed_at || (String(job.status).toLowerCase() === "running" ? null : job.updated_at),
        duration: durationMs(job.started_at || job.created_at, job.completed_at || (String(job.status).toLowerCase() === "running" ? null : job.updated_at)),
        detail: job.error_message || job.error_code || compactJson(job.counts) || compactJson(job.metadata),
        input: {
          job_id: job.id,
          job_type: job.job_type,
          stage: job.stage,
          generation_id: job.generation_id,
          attempt: job.attempt,
          available_at: job.available_at,
          metadata: metadataSummary(job.metadata),
        },
        output: {
          status: job.status,
          error_code: job.error_code,
          error_message: job.error_message,
          counts: metadataSummary(job.counts),
        },
      });
    }

    const runById = new Map((data?.runs || []).map((run) => [run.id, run]));
    for (const stageRun of data?.stageRuns || []) {
      const run = runById.get(stageRun.run_id);
      rows.push({
        key: `stage-${stageRun.id}`,
        source: stageRun.provider || run?.provider_pipeline || "extraction_run",
        stage: stageRun.stage || "stage",
        status: stageRun.status || "unknown",
        attempt: stageRun.attempt,
        startedAt: stageRun.started_at || stageRun.created_at,
        finishedAt: stageRun.finished_at || (String(stageRun.status).toLowerCase() === "running" ? null : stageRun.updated_at),
        duration: durationMs(stageRun.started_at || stageRun.created_at, stageRun.finished_at || (String(stageRun.status).toLowerCase() === "running" ? null : stageRun.updated_at)),
        // error_message/output_summary aren't exposed by extraction_stage_runs_safe
        // (see the comment in fetchTimeline) -- error_code plus the matching
        // pipeline_logs row (below) is where the full detail comes from.
        detail: stageRun.error_code || null,
        input: {
          run_id: stageRun.run_id,
          extraction_run_generation_id: run?.generation_id,
          provider_pipeline: run?.provider_pipeline,
          contract_version: run?.contract_version,
          attempt: stageRun.attempt,
        },
        output: {
          status: stageRun.status,
          provider: stageRun.provider,
          error_code: stageRun.error_code,
        },
      });
    }

    if (uploadedFile) {
      rows.push({
        key: "ui-handoff",
        source: "lease_review_ui",
        stage: "review_handoff",
        status: uploadedFile.review_readiness || uploadedFile.review_status || uploadedFile.processing_status || "unknown",
        startedAt: uploadedFile.processing_completed_at || uploadedFile.updated_at,
        finishedAt: uploadedFile.updated_at,
        duration: durationMs(uploadedFile.processing_completed_at || uploadedFile.updated_at, uploadedFile.updated_at),
        detail: [
          uploadedFile.review_readiness ? `review=${uploadedFile.review_readiness}` : null,
          uploadedFile.enrichment_status ? `enrichment=${uploadedFile.enrichment_status}` : null,
          uploadedFile.artifact_sync_status ? `artifact_sync=${uploadedFile.artifact_sync_status}` : null,
          Array.isArray(uploadedFile.review_readiness_reasons) && uploadedFile.review_readiness_reasons.length > 0
            ? `reasons=${uploadedFile.review_readiness_reasons.join(", ")}`
            : null,
        ].filter(Boolean).join("; "),
        input: {
          ui_review_payload_present: Boolean(uploadedFile.ui_review_payload),
          normalized_output_present: Boolean(uploadedFile.normalized_output),
          generation_id: uploadedFile.active_generation_id,
        },
        output: {
          review_readiness: uploadedFile.review_readiness,
          review_status: uploadedFile.review_status,
          enrichment_status: uploadedFile.enrichment_status,
          artifact_sync_status: uploadedFile.artifact_sync_status,
        },
      });
    }

    return rows
      .map((row) => ({ ...row, routing: routingForStage(row.stage, row.source) }))
      .sort((a, b) => (asDate(a.startedAt)?.getTime() || 0) - (asDate(b.startedAt)?.getTime() || 0));
  }, [data, uploadedFile, fileId]);

  const breakingPoint = useMemo(() => {
    const failedRow = timelineRows.find((row) => ["failed", "error", "blocked"].includes(String(row.status || "").toLowerCase()) || row.detail);
    const errorLog = (data?.logs || []).find((log) => String(log.level || "").toLowerCase() === "error");
    if (failedRow) return `${failedRow.stage}: ${failedRow.detail || failedRow.status}`;
    if (errorLog) return `${errorLog.step || "log"}: ${errorLog.message || "error"}`;
    return "No break detected";
  }, [data?.logs, timelineRows]);

  const totalMs = durationMs(uploadedFile?.created_at, uploadedFile?.processing_completed_at || uploadedFile?.updated_at);
  const activeStatus = uploadedFile?.processing_status || uploadedFile?.status || "unknown";
  const hasFailure = timelineRows.some((row) => ["failed", "error", "blocked"].includes(String(row.status || "").toLowerCase())) || Boolean(uploadedFile?.error_message);
  const architecture = useMemo(() => architectureSummary(uploadedFile), [uploadedFile]);

  if (!fileId) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-slate-600">No source upload is linked to this lease yet.</CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-slate-950">Extraction Timeline</h3>
          <p className="text-xs text-slate-500">File ID: <code>{fileId}</code></p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          {isFetching ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1 h-4 w-4" />}
          Refresh
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <TimelineMetric icon={Database} label="Current State" value={activeStatus} tone={hasFailure ? "red" : "blue"} />
        <TimelineMetric icon={TimerReset} label="Total Elapsed" value={formatDuration(totalMs)} tone="slate" />
        <TimelineMetric icon={Clock} label="Generation" value={uploadedFile?.active_generation_id || "-"} tone="slate" />
        <TimelineMetric icon={hasFailure ? AlertTriangle : CheckCircle2} label="Break Point" value={breakingPoint} tone={hasFailure ? "red" : "emerald"} />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <GitBranch className="h-4 w-4 text-blue-600" />
            Extraction Architecture
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
              <div className="text-[11px] font-semibold uppercase text-slate-500">Parser</div>
              <div className="mt-1 break-words text-sm font-semibold text-slate-900">{architecture.parser}</div>
            </div>
            <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
              <div className="text-[11px] font-semibold uppercase text-slate-500">LLM Mode</div>
              <div className="mt-1 break-words text-sm font-semibold text-slate-900">{architecture.extractionMode}</div>
            </div>
            <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
              <div className="text-[11px] font-semibold uppercase text-slate-500">Architecture</div>
              <div className="mt-1 break-words text-sm font-semibold text-slate-900">{architecture.architecture}</div>
            </div>
            <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
              <div className="text-[11px] font-semibold uppercase text-slate-500">Business Provider</div>
              <div className="mt-1 break-words text-sm font-semibold text-slate-900">{architecture.effectiveProvider}</div>
            </div>
          </div>
          <div className="grid gap-2 text-xs text-slate-700 md:grid-cols-2">
            <div className="rounded-md border border-blue-100 bg-blue-50 p-3">
              Primary path: Azure Document Intelligence layout parser, compact Azure document, strict whole-document OpenAI/Azure OpenAI extraction with evidence validation.
            </div>
            <div className="rounded-md border border-amber-100 bg-amber-50 p-3">
              Large-document path: if the compact prompt is over the model budget, it uses sectioned LLM continuation/reduce. TypeScript legacy fallback is {architecture.legacyDisabled ? "disabled by default" : "enabled by rollback env"}.
            </div>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge className="bg-slate-100 text-slate-700">LLM calls: {architecture.llmCalls ?? "-"}</Badge>
            <Badge className="bg-slate-100 text-slate-700">Sections: {architecture.sectionCount ?? "-"}</Badge>
            <Badge className="bg-slate-100 text-slate-700">Fallback used: {String(architecture.fallbackUsed)}</Badge>
            <Badge className="bg-slate-100 text-slate-700">Generation: {architecture.generation}</Badge>
          </div>
        </CardContent>
      </Card>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          Timeline query failed: {error.message || String(error)}
        </div>
      )}

      {(data?.warnings || []).length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {(data?.warnings || []).map((warning) => <div key={warning}>{warning}</div>)}
        </div>
      )}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3 pb-2">
          <CardTitle className="text-base">Stage Timeline</CardTitle>
          {isLoading && <Loader2 className="h-4 w-4 animate-spin text-slate-400" />}
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Step</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Finished</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Detail</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {timelineRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-sm text-slate-500">No pipeline timeline rows found yet.</TableCell>
                </TableRow>
              ) : timelineRows.map((row) => (
                <TableRow key={row.key}>
                  <TableCell>
                    <div className="font-medium text-slate-900">{row.stage}</div>
                    <div className="text-xs text-slate-500">{row.source}{row.attempt ? ` - attempt ${row.attempt}` : ""}</div>
                  </TableCell>
                  <TableCell><Badge className={statusBadgeClass(row.status)}>{row.status || "unknown"}</Badge></TableCell>
                  <TableCell className="text-xs text-slate-600">{formatDate(row.startedAt)}</TableCell>
                  <TableCell className="text-xs text-slate-600">{formatDate(row.finishedAt)}</TableCell>
                  <TableCell className="text-xs font-medium text-slate-900">{formatDuration(row.duration)}</TableCell>
                  <TableCell className="max-w-lg text-xs text-slate-600">
                    <div className="space-y-2">
                      <div className="break-words">{row.detail || "-"}</div>
                      <details className="rounded-md border border-slate-200 bg-slate-50 p-2">
                        <summary className="cursor-pointer select-none text-[11px] font-semibold uppercase text-slate-500">
                          Function, Input, Output
                        </summary>
                        <div className="mt-2 space-y-2">
                          <div>
                            <div className="text-[11px] font-semibold uppercase text-slate-500">Function Triggered</div>
                            <div className="mt-1 break-words font-medium text-slate-900">{row.routing.functionName}</div>
                            <div className="mt-1 break-words text-slate-600">{row.routing.trigger}</div>
                          </div>
                          <DetailBlock label="Expected Input" value={row.routing.input} />
                          <DetailBlock label="Actual Input Summary" value={row.input} />
                          <DetailBlock label="Expected Output" value={row.routing.output} />
                          <DetailBlock label="Actual Output Summary" value={row.output} />
                        </div>
                      </details>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Pipeline Logs</CardTitle>
        </CardHeader>
        <CardContent>
          {(data?.logs || []).length === 0 ? (
            <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-500">
              No pipeline logs found for this file.
            </div>
          ) : (
            <div className="space-y-3">
              {(data?.logs || []).map((log, index) => {
                const routing = routingForStage(log.step, log.message);
                const meta = metadataSummary(log.metadata);
                return (
                  <div key={`${log.timestamp || index}-${log.step || "log"}`} className="rounded-lg border border-slate-200 bg-white p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <div className="text-xs font-semibold text-slate-950">{log.step || "pipeline_log"}</div>
                        <div className="text-[11px] text-slate-500">{formatDate(log.timestamp)} | {routing.functionName}</div>
                      </div>
                      <Badge className={statusBadgeClass(log.level)}>{log.level || "info"}</Badge>
                    </div>
                    <div className="mt-2 whitespace-pre-wrap break-words text-xs leading-relaxed text-slate-700">
                      {log.message || "-"}
                    </div>
                    <div className="mt-3 grid gap-3 lg:grid-cols-2">
                      <DetailBlock label="Function Triggered" value={`${routing.functionName}\n${routing.trigger}`} />
                      <DetailBlock label="Metadata / Output" value={meta} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

import React, { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Clock, Database, Loader2, RefreshCw, TimerReset } from "lucide-react";
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
  if (["completed", "processed", "ready", "review_required", "success"].includes(value)) return "bg-emerald-100 text-emerald-700";
  if (["running", "queued", "pending", "parsing", "normalizing"].includes(value)) return "bg-blue-100 text-blue-700";
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

  const runsResult = await selectOrEmpty({
    table: "extraction_runs_safe",
    select: "id, generation_id, run_type, provider_pipeline, contract_version, status, error_code, error_message, started_at, completed_at, created_at, updated_at, metadata",
    apply: (query) => query.eq("uploaded_file_id", uploadedFileId).order("started_at", { ascending: true }),
  });
  if (runsResult.warning) warnings.push(runsResult.warning);

  let stageRuns = [];
  const runIds = runsResult.rows.map((run) => run.id).filter(Boolean);
  if (runIds.length > 0) {
    const stageResult = await selectOrEmpty({
      table: "extraction_stage_runs_safe",
      select: "id, run_id, pipeline_job_id, stage, attempt, status, provider, error_code, error_message, started_at, finished_at, created_at, updated_at, output_summary",
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
        detail: stageRun.error_message || stageRun.error_code || compactJson(stageRun.output_summary),
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
      });
    }

    return rows.sort((a, b) => (asDate(a.startedAt)?.getTime() || 0) - (asDate(b.startedAt)?.getTime() || 0));
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
                  <TableCell className="max-w-md truncate text-xs text-slate-600" title={row.detail || ""}>{row.detail || "-"}</TableCell>
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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Step</TableHead>
                <TableHead>Level</TableHead>
                <TableHead>Message</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.logs || []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-sm text-slate-500">No pipeline logs found for this file.</TableCell>
                </TableRow>
              ) : (data?.logs || []).map((log, index) => (
                <TableRow key={`${log.timestamp || index}-${log.step || "log"}`}>
                  <TableCell className="whitespace-nowrap text-xs text-slate-600">{formatDate(log.timestamp)}</TableCell>
                  <TableCell className="text-xs font-medium text-slate-900">{log.step || "-"}</TableCell>
                  <TableCell><Badge className={statusBadgeClass(log.level)}>{log.level || "info"}</Badge></TableCell>
                  <TableCell className="max-w-xl truncate text-xs text-slate-600" title={log.message || ""}>{log.message || compactJson(log.metadata) || "-"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

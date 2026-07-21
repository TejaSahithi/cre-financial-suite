import React, { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, RefreshCw, Link2, Wand2, Copy, Download } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/services/supabaseClient";
import { invokeEdgeFunction } from "@/services/edgeFunctions";
import { persistLeaseExtractionMerge, updateLeaseExtractionField } from "@/services/leaseService";
import {
  fetchDocumentIntelligenceV3Readiness,
  fetchDocumentIntelligenceV3AdvisoryAudit,
  fetchDocumentIntelligenceV3AdvisoryAuditBatch,
  fetchDocumentIntelligenceV3ProjectionDiff,
  fetchDocumentIntelligenceV3RunMetrics,
} from "@/services/documentIntelligenceV3Service";
import {
  LEASE_REVIEW_FIELDS,
  readFieldValue,
  readFieldConfidence,
  readFieldEvidence,
  resolveExtractionStatus,
  hasValidSourceEvidence,
  isCalculatedExtractionStatus,
  isManualExtractionStatus,
  cleanSourceEvidenceText,
} from "@/lib/leaseReviewSchema";
import { normalizeLeaseReviewData } from "@/lib/leaseReviewFieldNormalizer";
import {
  resolveUploadedFileIdForV3Diagnostics,
  summarizeV3Diagnostics,
  summarizeAdvisoryAudit,
  summarizeAdvisoryAuditBatch,
  summarizeProjectionDiffResponse,
  summarizeRunMetricsResponse,
  buildV3DiagnosticsFilename,
  buildV3AdvisoryAuditFilename,
  buildV3AdvisoryAuditBatchFilename,
} from "@/components/lease-review/utils/documentIntelligenceV3Diagnostics";

function prettyJson(value, limit = 4000) {
  try {
    const s = JSON.stringify(value, null, 2);
    if (!s) return "â€”";
    return s.length > limit ? `${s.slice(0, limit)}\nâ€¦[truncated, ${s.length - limit} more chars]` : s;
  } catch {
    return String(value);
  }
}

function Section({ title, count, children, badge }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
        <div className="flex items-center gap-2">
          {badge != null && <Badge className="bg-slate-100 text-slate-700">{badge}</Badge>}
          {count != null && <Badge className="bg-slate-100 text-slate-700">{count}</Badge>}
        </div>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">{children}</CardContent>
    </Card>
  );
}

/**
 * Extraction Debug Panel
 *
 * Shows everything a reviewer needs to diagnose a wrong extraction:
 *   1. Azure Document Intelligence page text (from uploaded_files.docling_raw)
 *   2. Raw OpenAI / pipeline JSON (workflow_output)
 *   3. Normalized mapped fields (extraction_data.fields)
 *   4. Review table rows (per LEASE_REVIEW_FIELDS â€” what the operator sees)
 *   5. Field mapping warnings (extraction_data.workflow_output.validations)
 *   6. Source matching results (per-field source_text + source_page)
 *
 * Plus operator actions:
 *   - Re-run extraction (invokes ingest-file on the source uploaded_files row)
 *   - Re-link source document (set extraction_data.source_file_id manually)
 *   - Apply latest extraction (pull fresh values + evidence from the source's
 *     ui_review_payload into the lease record)
 */
export default function ExtractionDebugPanel({ lease }) {
  const queryClient = useQueryClient();
  const sourceFileId = lease?.source_file_id ?? lease?.extraction_data?.source_file_id ?? null;
  const [rerunning, setRerunning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [relinkOpen, setRelinkOpen] = useState(false);
  const [relinkValue, setRelinkValue] = useState("");
  const [relinking, setRelinking] = useState(false);

  const { data: uploadedFile, isLoading: fileLoading, refetch: refetchUploadedFile } = useQuery({
    queryKey: ["debug-uploaded-file", sourceFileId],
    enabled: !!sourceFileId && !!supabase,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("uploaded_files")
        .select("id, file_name, docling_raw, ui_review_payload, normalized_output, parsed_data, valid_data, extraction_method, status, processing_status, review_status, error_message, module_type, updated_at")
        .eq("id", sourceFileId)
        .maybeSingle();
      // Gracefully handle missing columns (migrations not yet applied).
      if (error) {
        if (error.code === "42703" || /does not exist/i.test(error.message || "")) return null;
        throw error;
      }
      return data;
    },
    retry: false,
  });

  const { data: pipelineLogs = [] } = useQuery({
    queryKey: ["debug-pipeline-logs", sourceFileId],
    enabled: !!sourceFileId && !!supabase,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("pipeline_logs")
        .select("id, step, level, message, metadata, timestamp")
        .eq("file_id", sourceFileId)
        .order("timestamp", { ascending: false })
        .limit(12);
      // Gracefully skip if the table does not exist yet (migration pending).
      if (error) {
        if (error.code === "42P01" || /does not exist/i.test(error.message || "")) return [];
        throw error;
      }
      return data || [];
    },
    retry: false,
  });

  // â”€â”€ Document Intelligence v3 Diagnostics (Phase 4) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Resolved defensively (not just sourceFileId) because the debug
  // uploadedFile row above, once loaded, is the ground truth if the lease's
  // own source_file_id is stale. Fetched strictly on button click (enabled:
  // false) -- never automatically on render.
  const v3UploadedFileId = resolveUploadedFileIdForV3Diagnostics(lease, uploadedFile) || sourceFileId;
  const {
    data: v3Response,
    isFetching: v3Loading,
    refetch: refetchV3Diagnostics,
  } = useQuery({
    queryKey: ["debug-v3-readiness", v3UploadedFileId],
    enabled: false,
    queryFn: () => fetchDocumentIntelligenceV3Readiness({ uploadedFileId: v3UploadedFileId }),
    retry: false,
  });
  const v3Diagnostics = v3Response && !v3Response.error ? summarizeV3Diagnostics(v3Response.readiness) : null;
  const v3FetchError = v3Response?.error ? v3Response.message : null;
  const {
    data: v3AuditResponse,
    isFetching: v3AuditLoading,
    refetch: refetchV3AdvisoryAudit,
  } = useQuery({
    queryKey: ["debug-v3-advisory-audit", v3UploadedFileId, lease?.id],
    enabled: false,
    queryFn: () => fetchDocumentIntelligenceV3AdvisoryAudit({
      uploadedFileId: v3UploadedFileId,
      leaseId: lease?.id ?? null,
    }),
    retry: false,
  });
  const v3AdvisoryAudit = v3AuditResponse && !v3AuditResponse.error
    ? summarizeAdvisoryAudit(v3AuditResponse.advisoryAudit)
    : null;
  const v3AuditFetchError = v3AuditResponse?.error ? v3AuditResponse.message : null;
  const {
    data: v3BatchAuditResponse,
    isFetching: v3BatchAuditLoading,
    refetch: refetchV3AdvisoryAuditBatch,
  } = useQuery({
    queryKey: ["debug-v3-advisory-audit-batch", v3UploadedFileId, lease?.id],
    enabled: false,
    queryFn: () => fetchDocumentIntelligenceV3AdvisoryAuditBatch({
      uploadedFileIds: v3UploadedFileId ? [v3UploadedFileId] : [],
      leaseIds: !v3UploadedFileId && lease?.id ? [lease.id] : [],
      limit: 25,
    }),
    retry: false,
  });
  const v3AdvisoryAuditBatch = v3BatchAuditResponse && !v3BatchAuditResponse.error
    ? summarizeAdvisoryAuditBatch(v3BatchAuditResponse.batchAudit)
    : null;
  const v3BatchAuditFetchError = v3BatchAuditResponse?.error ? v3BatchAuditResponse.message : null;

  // Release 2 -- projection diff (legacy vs. canonical, per field) and
  // run operational metrics. Same fetch-on-click convention as the v3
  // diagnostics above.
  const {
    data: v3ProjectionDiffResponse,
    isFetching: v3ProjectionDiffLoading,
    refetch: refetchV3ProjectionDiff,
  } = useQuery({
    queryKey: ["debug-v3-projection-diff", v3UploadedFileId],
    enabled: false,
    queryFn: () => fetchDocumentIntelligenceV3ProjectionDiff({ uploadedFileId: v3UploadedFileId }),
    retry: false,
  });
  const v3ProjectionDiff = v3ProjectionDiffResponse && !v3ProjectionDiffResponse.error
    ? summarizeProjectionDiffResponse(v3ProjectionDiffResponse.projectionDiff)
    : null;
  const v3ProjectionDiffFetchError = v3ProjectionDiffResponse?.error ? v3ProjectionDiffResponse.message : null;

  const {
    data: v3RunMetricsResponse,
    isFetching: v3RunMetricsLoading,
    refetch: refetchV3RunMetrics,
  } = useQuery({
    queryKey: ["debug-v3-run-metrics", v3UploadedFileId],
    enabled: false,
    queryFn: () => fetchDocumentIntelligenceV3RunMetrics({ uploadedFileId: v3UploadedFileId }),
    retry: false,
  });
  const v3RunMetrics = v3RunMetricsResponse && !v3RunMetricsResponse.error
    ? summarizeRunMetricsResponse(v3RunMetricsResponse.runMetrics)
    : null;
  const v3RunMetricsFetchError = v3RunMetricsResponse?.error ? v3RunMetricsResponse.message : null;

  const handleLoadV3Diagnostics = async () => {
    if (!v3UploadedFileId) {
      toast.error("No source file linked to this lease â€” cannot load v3 diagnostics.");
      return;
    }
    const result = await refetchV3Diagnostics();
    if (result?.data?.error) {
      console.error("[ExtractionDebug] v3 readiness fetch failed:", result.data.message);
    }
  };

  const handleCopyV3DiagnosticsJson = async () => {
    if (!v3Diagnostics) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(v3Diagnostics, null, 2));
      toast.success("v3 diagnostic JSON copied to clipboard.");
    } catch (err) {
      console.error("[ExtractionDebug] copy v3 diagnostics failed:", err);
      toast.error("Could not copy to clipboard.");
    }
  };

  const handleDownloadV3DiagnosticsJson = () => {
    if (!v3Diagnostics) return;
    try {
      const blob = new Blob([JSON.stringify(v3Diagnostics, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = buildV3DiagnosticsFilename(v3Diagnostics.uploadedFileId || v3UploadedFileId);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("[ExtractionDebug] download v3 diagnostics failed:", err);
      toast.error("Could not download JSON.");
    }
  };

  const handleLoadV3AdvisoryAudit = async () => {
    if (!v3UploadedFileId && !lease?.id) {
      toast.error("No source file or lease id available for this advisory audit.");
      return;
    }
    const result = await refetchV3AdvisoryAudit();
    if (result?.data?.error) {
      console.error("[ExtractionDebug] v3 advisory audit fetch failed:", result.data.message);
    }
  };

  const handleCopyV3AdvisoryAuditJson = async () => {
    if (!v3AdvisoryAudit) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(v3AdvisoryAudit.raw ?? v3AdvisoryAudit, null, 2));
      toast.success("v3 advisory audit JSON copied to clipboard.");
    } catch (err) {
      console.error("[ExtractionDebug] copy v3 advisory audit failed:", err);
      toast.error("Could not copy to clipboard.");
    }
  };

  const handleDownloadV3AdvisoryAuditJson = () => {
    if (!v3AdvisoryAudit) return;
    try {
      const blob = new Blob([JSON.stringify(v3AdvisoryAudit.raw ?? v3AdvisoryAudit, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = buildV3AdvisoryAuditFilename(v3AdvisoryAudit.uploadedFileId || v3UploadedFileId);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("[ExtractionDebug] download v3 advisory audit failed:", err);
      toast.error("Could not download JSON.");
    }
  };

  const handleLoadV3AdvisoryAuditBatch = async () => {
    if (!v3UploadedFileId && !lease?.id) {
      toast.error("No source file or lease id available for this batch advisory audit.");
      return;
    }
    const result = await refetchV3AdvisoryAuditBatch();
    if (result?.data?.error) {
      console.error("[ExtractionDebug] v3 batch advisory audit fetch failed:", result.data.message);
    }
  };

  const handleCopyV3AdvisoryAuditBatchJson = async () => {
    if (!v3AdvisoryAuditBatch) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(v3AdvisoryAuditBatch.raw ?? v3AdvisoryAuditBatch, null, 2));
      toast.success("v3 batch advisory audit JSON copied to clipboard.");
    } catch (err) {
      console.error("[ExtractionDebug] copy v3 batch advisory audit failed:", err);
      toast.error("Could not copy to clipboard.");
    }
  };

  const handleDownloadV3AdvisoryAuditBatchJson = () => {
    if (!v3AdvisoryAuditBatch) return;
    try {
      const blob = new Blob([JSON.stringify(v3AdvisoryAuditBatch.raw ?? v3AdvisoryAuditBatch, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = buildV3AdvisoryAuditBatchFilename(v3UploadedFileId || lease?.id);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("[ExtractionDebug] download v3 batch advisory audit failed:", err);
      toast.error("Could not download JSON.");
    }
  };

  // Release 2 -- projection diff / run metrics load handlers, same
  // fetch-on-click pattern as the v3 diagnostics above.
  const handleLoadV3ProjectionDiff = async () => {
    if (!v3UploadedFileId) {
      toast.error("No source file linked to this lease — cannot load the projection diff.");
      return;
    }
    const result = await refetchV3ProjectionDiff();
    if (result?.data?.error) {
      console.error("[ExtractionDebug] v3 projection diff fetch failed:", result.data.message);
    }
  };

  const handleLoadV3RunMetrics = async () => {
    if (!v3UploadedFileId) {
      toast.error("No source file linked to this lease — cannot load run metrics.");
      return;
    }
    const result = await refetchV3RunMetrics();
    if (result?.data?.error) {
      console.error("[ExtractionDebug] v3 run metrics fetch failed:", result.data.message);
    }
  };

  const doclingRaw = uploadedFile?.docling_raw || null;
  const fullText = doclingRaw?.full_text || "";
  const textBlocks = Array.isArray(doclingRaw?.text_blocks) ? doclingRaw.text_blocks : [];
  const doclingFields = Array.isArray(doclingRaw?.fields) ? doclingRaw.fields : [];

  const workflowOutput = lease?.extraction_data?.workflow_output || null;
  const extractionFields = lease?.extraction_data?.fields || {};
  const fieldEvidence = lease?.extraction_data?.field_evidence || extractionFields;
  const confidenceScores = lease?.extraction_data?.confidence_scores || {};
  const validations = Array.isArray(workflowOutput?.validations) ? workflowOutput.validations : [];
  const workflowItems = [
    workflowOutput?.extracted_document_items,
    workflowOutput?.clause_records,
    ...(Array.isArray(workflowOutput?.records)
      ? [workflowOutput.records[0]?.extracted_document_items, workflowOutput.records[0]?.clause_records]
      : []),
    lease?.extraction_data?.extracted_document_items,
    lease?.extraction_data?.clause_records,
  ].flatMap((rows) => (Array.isArray(rows) ? rows : []));
  const fieldMapItems = [
    workflowOutput?.lease_fields,
    ...(Array.isArray(workflowOutput?.records) ? [workflowOutput.records[0]?.lease_fields] : []),
    lease?.extraction_data?.fields,
  ].flatMap((map, mapIdx) => {
    if (!map || typeof map !== "object" || Array.isArray(map)) return [];
    return Object.entries(map).map(([key, entry]) => ({
      item_id: `field-map-${mapIdx}-${key}`,
      item_type: key,
      field_key: key,
      display_tab: null,
      maps_to_fixed_field: LEASE_REVIEW_FIELDS.some((field) => field.key === key),
      creates_dynamic_row: !LEASE_REVIEW_FIELDS.some((field) => field.key === key),
      source_page: entry?.source_page ?? entry?.page_number ?? entry?.page ?? null,
      source_text: entry?.source_clause ?? entry?.source_text ?? entry?.exact_source_text ?? null,
      extraction_status: entry?.extraction_status ?? null,
    }));
  });
  const uniqueItems = [];
  const seenItemKeys = new Set();
  for (const item of [...workflowItems, ...fieldMapItems]) {
    const key = `${item?.item_type || item?.field_key || ""}|${item?.source_page ?? ""}|${item?.source_text || item?.source_clause || ""}`;
    if (seenItemKeys.has(key)) continue;
    seenItemKeys.add(key);
    uniqueItems.push(item);
  }
  // Single normalized source of truth (leaseReviewFieldNormalizer.js) â€” the
  // same object StandardFieldsByGroup/DynamicFindings/ClauseRecordsTable/
  // CamExpenseRulesPanel/ApprovalBlockersPanel all read. Previously this
  // panel derived its own, narrower `uniqueItems` union (below) that omitted
  // lease_clauses and the uploaded_files.ui_review_payload fallback tree
  // entirely â€” which is exactly why "Mapped fields: 0 / Clause records: 0"
  // could show here while the real tabs displayed data. dynamic_items_extracted
  // and clause_records_count now read from this shared normalization instead.
  const normalized = useMemo(() => normalizeLeaseReviewData(lease), [lease]);

  const extractionDebug = lease?.extraction_data?.extraction_debug || {};
  // The pipeline's full extractionDebug lives on the uploaded_files
  // normalized_output too. Fall back to it when the lease row's own
  // extraction_debug hasn't been refreshed yet (the initial review-approve
  // path doesn't copy it onto the lease).
  const pipelineDebug = uploadedFile?.normalized_output?.metadata?.extractionDebug
    || uploadedFile?.normalized_output?.metadata?.extraction_debug
    || {};
  const pipelineMeta =
    uploadedFile?.ui_review_payload?.metadata?.pipeline
    || uploadedFile?.normalized_output?.metadata?.pipeline
    || uploadedFile?.docling_raw?._metadata?.pipeline
    || {};
  const debugRead = (key) => extractionDebug?.[key] ?? pipelineDebug?.[key];
  // Release 1: how much of the schema has real (enforced) domain/evidence
  // validation vs. advisory-only vs. no check at all -- see
  // schemas.ts#getEvidencePolicyCoverage. Admin-only visibility so the
  // configuration gap stays honest rather than looking silently "done".
  const evidencePolicyCoverage =
    uploadedFile?.normalized_output?.metadata?.evidence_policy_coverage
    || uploadedFile?.ui_review_payload?.metadata?.evidence_policy_coverage
    || null;
  const rejectedCandidates =
    debugRead("rejected_candidates")
    || pipelineDebug?.openai_fact_ledger?.rejected_candidates
    || [];
  const doclingPagesParsed = workflowOutput?.summary?.docling_pages_parsed
    ?? workflowOutput?.summary?.pages_detected
    ?? new Set(textBlocks.map((block) => block?.page ?? block?.page_number ?? block?.source_page).filter(Boolean)).size;
  const pdfPageCountTotal = workflowOutput?.summary?.pdf_page_count_total
    ?? lease?.extraction_data?.docling_raw?.page_count
    ?? null;

  // â”€â”€ Azure Parser (Stage 1: PDF/image â†’ text) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // The parser tags its output via `extraction_method` on docling_raw â€”
  // "azure_layout" or "azure_document_intelligence" means Azure Document Intelligence read the document.
  // We probe several sources because the field is set by parser.ts and
  // surfaces in different places depending on which write path ran.
  const parserSource = (
    (debugRead("azure_parser_source") ?? debugRead("vision_parser_source"))
    || uploadedFile?.docling_raw?.extraction_method
    || lease?.extraction_data?.docling_raw?.extraction_method
    || doclingRaw?.extraction_method
    || uploadedFile?.extraction_method
    || ""
  ).toString().toLowerCase();
  const visionParserUsed = (debugRead("azure_parser_used") ?? debugRead("vision_parser_used")) === true
    || parserSource === "azure_layout" || parserSource === "azure_document_intelligence"
    || parserSource === "hybrid"
    // Last-resort signal: any text block tagged with an Azure source.
    || textBlocks.some((b) => String(b?.source || "").toLowerCase().includes("azure"));
  const visionParserPages = debugRead("azure_parser_pages_count") ?? debugRead("vision_parser_pages_count")
    ?? pdfPageCountTotal
    ?? doclingPagesParsed
    ?? null;
  const visionParserLabel = visionParserUsed
    ? (parserSource === "hybrid"
      ? `used (hybrid${visionParserPages ? `, ${visionParserPages} pages` : ""})`
      : `used${visionParserPages ? ` (${visionParserPages} pages)` : ""}`)
    : (parserSource ? `not used (parser: ${parserSource})` : "not used");

  // â”€â”€ OpenAI Field Extraction (Stage 2: Azure text â†’ LLM JSON) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const visionTriggered = Boolean(
    debugRead("openai_field_extraction_used") ?? debugRead("vision_field_extraction_used")
    ?? debugRead("vision_fallback_triggered")
    ?? debugRead("llm_file_mode_used"),
  );
  const fileBase64Available = debugRead("fileBase64_available");
  const weakTextDetected = debugRead("weak_text_detected");
  const llmFieldsCount = debugRead("openai_field_extraction_fields_count") ?? debugRead("vision_field_extraction_fields_count")
    ?? debugRead("llm_fields_extracted");
  const visionFieldSkipReason = debugRead("openai_field_extraction_skipped_reason") ?? debugRead("vision_field_extraction_skipped_reason")
    ?? debugRead("vision_fallback_skipped_reason")
    ?? (fileBase64Available === false
      ? "file_bytes_unavailable"
      : (weakTextDetected === false
        ? "parser_text_sufficient"
        : (llmFieldsCount === 0 ? "llm_returned_zero_fields" : null)));
  const visionFieldLabel = visionTriggered
    ? `used${typeof llmFieldsCount === "number" ? ` (${llmFieldsCount} fields)` : ""}`
    : (visionFieldSkipReason === "parser_text_sufficient"
      ? "not run â€” parser text sufficient"
      : visionFieldSkipReason === "file_bytes_unavailable"
        ? "skipped â€” file bytes unavailable"
        : visionFieldSkipReason === "llm_returned_zero_fields"
          ? "attempted, returned zero fields"
          : visionFieldSkipReason
            ? `skipped â€” ${visionFieldSkipReason}`
            : "not run");

  const debugSummary = {
    uploaded_file_id: uploadedFile?.id ?? sourceFileId ?? "-",
    lease_id: lease?.id ?? "-",
    extraction_contract_version: debugRead("extraction_contract_version") ?? "-",
    extraction_build_version: debugRead("extraction_build_version") ?? "-",
    extraction_run_id: debugRead("extraction_run_id") ?? "-",
    pipeline_job_id: debugRead("pipeline_job_id") ?? "-",
    source_file_id: debugRead("source_file_id") ?? "-",
    normalized_at: debugRead("normalized_at") ?? "-",
    uploaded_file_updated_at: uploadedFile?.updated_at ? new Date(uploadedFile.updated_at).toLocaleString() : "-",
    worker_attempt: debugRead("worker_attempt") ?? "-",
    uploaded_file_status: uploadedFile?.status ?? "-",
    processing_status: uploadedFile?.processing_status ?? "-",
    parser_status: pipelineMeta?.parser_status ?? debugRead("parser_status") ?? "-",
    normalize_status: pipelineMeta?.normalize_status ?? debugRead("normalize_status") ?? "-",
    ai_status: pipelineMeta?.ai_status ?? debugRead("ai_status") ?? "-",
    review_status: pipelineMeta?.review_status ?? uploadedFile?.review_status ?? "-",
    error_code: pipelineMeta?.error_code ?? debugRead("error_code") ?? "-",
    error_message: pipelineMeta?.error_message ?? uploadedFile?.error_message ?? debugRead("error_message") ?? "-",
    pipeline_attempt: pipelineMeta?.attempt ?? "-",
    pipeline_duration_ms: pipelineMeta?.total_duration_ms ?? "-",
    docling_raw_present: pipelineMeta?.docling_raw_present ?? Boolean(doclingRaw),
    ocr_used: pipelineMeta?.ocr_used ?? "-",
    // Headline mapping diagnostics â€” first so a failure is immediately visible.
    mapping_failure_reason:
      debugRead("mapping_failure_reason")
      ?? workflowOutput?.mapping_failure_reason
      ?? workflowOutput?.summary?.mapping_failure_reason
      ?? "none",
    core_mapping_failed:
      (debugRead("core_mapping_failed") ?? workflowOutput?.summary?.core_mapping_failed)
        ? "yes"
        : "no",
    lease_structure:
      debugRead("lease_structure")
      ?? workflowOutput?.lease_structure
      ?? workflowOutput?.summary?.lease_structure
      ?? "unknown",
    full_text_chars:
      debugRead("full_text_chars")
      ?? workflowOutput?.summary?.full_text_chars
      ?? debugRead("embedded_text_chars_total")
      ?? fullText.length,
    parser_source: debugRead("parser_source") ?? parserSource ?? "unknown",
    mapped_standard_fields_count:
      debugRead("mapped_standard_fields_count")
      ?? workflowOutput?.summary?.mapped_standard_fields_count
      ?? Object.values(workflowOutput?.lease_fields || {}).filter((f) => f?.value != null && f?.value !== "").length,
    value_only_fields_count:
      debugRead("value_only_fields_count")
      ?? workflowOutput?.summary?.value_only_fields_count
      ?? 0,
    fields_rejected_missing_source_count:
      debugRead("fields_rejected_missing_source_count")
      ?? workflowOutput?.summary?.fields_rejected_missing_source_count
      ?? 0,
    ui_review_payload_fields_count: debugRead("ui_review_payload_fields_count") ?? "â€”",
    document_profile: workflowOutput?.document_profile || workflowOutput?.summary?.document_profile || "unknown",
    selected_document_profile: workflowOutput?.selected_document_profile || workflowOutput?.summary?.selected_document_profile || workflowOutput?.document_profile || workflowOutput?.summary?.document_profile || "unknown",
    assignment_signal_count: workflowOutput?.assignment_signal_count ?? workflowOutput?.summary?.assignment_signal_count ?? 0,
    amendment_signal_count: workflowOutput?.amendment_signal_count ?? workflowOutput?.summary?.amendment_signal_count ?? 0,
    profile_detection_signals: JSON.stringify(workflowOutput?.profile_detection_signals || workflowOutput?.summary?.profile_detection_signals || {}),
    // Show both metrics so reviewers do not mistake Azure text-block pages
    // count for the actual PDF page count. Azure reads multi-page PDFs
    // natively when file bytes are sent.
    pdf_page_count_total: pdfPageCountTotal != null ? pdfPageCountTotal : "â€”",
    docling_pages_parsed: doclingPagesParsed,
    // Two distinct Azure/OpenAI stages â€” keeping them separate so reviewers can
    // tell whether Azure read the document at all (parser) from whether
    // it pulled structured fields from the bytes (field extraction).
    azure_parser: visionParserLabel,
    openai_field_extraction: visionFieldLabel,
    fixed_fields_extracted: workflowOutput?.summary?.fixed_fields_extracted ?? Object.values(workflowOutput?.lease_fields || {}).filter((field) => field?.extraction_status === "extracted").length,
    // Previously `uniqueItems.length` â€” a narrower, independently-maintained
    // union that omitted lease_clauses entirely (see the `normalized` note
    // above). Now reads the same union ClauseRecordsTable/DynamicFindings use.
    dynamic_items_extracted: normalized.dynamicFindings.length,
    dynamic_items_displayed: uniqueItems.filter((item) => item?.creates_dynamic_row && item?.display_tab !== "clause_records").length,
    mapped_items_count: uniqueItems.filter((item) => item?.maps_to_fixed_field).length,
    unmapped_items_count: uniqueItems.filter((item) => !item?.maps_to_fixed_field).length,
    clause_records_count: normalized.clauseRecords.length,
    // New tiles (this task) â€” all read from the same shared `normalized`
    // object every other Lease Review section now uses.
    standard_fields_total: normalized.standardFields.length,
    standard_fields_populated: normalized.debugCounts.standard_fields_populated,
    // Release 1: evidence-policy coverage + rejected-candidate audit trail.
    evidence_policy_enforced: evidencePolicyCoverage ? `${evidencePolicyCoverage.enforced} / ${evidencePolicyCoverage.total}` : "â€”",
    evidence_policy_advisory: evidencePolicyCoverage ? `${evidencePolicyCoverage.advisory} / ${evidencePolicyCoverage.total}` : "â€”",
    evidence_policy_unconfigured: evidencePolicyCoverage ? `${evidencePolicyCoverage.unconfigured} / ${evidencePolicyCoverage.total}` : "â€”",
    rejected_candidates_count: rejectedCandidates.length,
    standard_fields_source_backed: normalized.debugCounts.standard_fields_source_backed,
    dynamic_findings_count: normalized.dynamicFindings.length,
    expense_rules_count: normalized.expenseRules.length,
    critical_dates_count: normalized.criticalDates.length,
    approval_blockers_count: normalized.debugCounts.approval_blockers_count,
    approval_blockers_source: normalized.approvalBlockers.source,
    lease_expense_rules_generated: workflowOutput?.summary?.lease_expense_rules_generated ?? (workflowOutput?.expense_rules?.length || 0),
    real_expense_rules_generated_count: workflowOutput?.summary?.real_expense_rules_generated_count
      ?? (workflowOutput?.expense_rules || []).filter((r) => r?.rule_type !== "coverage_gap" && r?.generation_source !== "original_lease_required").length,
    coverage_gap_rules_generated_count: workflowOutput?.summary?.coverage_gap_rules_generated_count
      ?? (workflowOutput?.expense_rules || []).filter((r) => r?.rule_type === "coverage_gap" || r?.generation_source === "original_lease_required").length,
    original_lease_required_count: workflowOutput?.summary?.original_lease_required_count
      ?? (workflowOutput?.expense_rules || []).filter((r) => r?.generation_source === "original_lease_required").length,
    template_rules_skipped_count: workflowOutput?.summary?.template_rules_skipped_count ?? 0,
    explicit_expense_clause_count: workflowOutput?.summary?.explicit_expense_clause_count ?? 0,
    assignment_expense_short_circuit_applied: workflowOutput?.summary?.assignment_expense_short_circuit_applied
      ? "yes"
      : "no",
    coverage_gaps_generated: workflowOutput?.summary?.coverage_gaps_generated ?? uniqueItems.filter((item) => item?.requires_original_lease || item?.extraction_status === "needs_review").length,
    rejected_generic_source_count: workflowOutput?.summary?.rejected_generic_source_count ?? 0,
  };

  const reviewTableRows = useMemo(() => {
    return LEASE_REVIEW_FIELDS.map((field) => {
      const value = readFieldValue(lease, field.key);
      const confidence = readFieldConfidence(lease, field.key);
      const evidence = readFieldEvidence(lease, field.key);
      const status = resolveExtractionStatus(lease, field.key, { value, confidence, evidence });
      return {
        key: field.key,
        label: field.label,
        required: !!field.required,
        value,
        confidence,
        sourcePage: evidence.sourcePage,
        sourceText: evidence.sourceText,
        rawValue: evidence.rawValue,
        status,
      };
    });
  }, [lease]);

  const sourceMatching = reviewTableRows.filter((r) => r.value != null && r.value !== "");
  const missingEvidence = reviewTableRows.filter(
    (r) => r.value != null && r.value !== "" && !hasValidSourceEvidence({ sourcePage: r.sourcePage, sourceText: r.sourceText }),
  );
  const statusCounts = reviewTableRows.reduce(
    (acc, row) => {
      const hasValue = row.value !== null && row.value !== undefined && row.value !== "";
      const evidence = { sourcePage: row.sourcePage, sourceText: row.sourceText };
      if (hasValue && row.status === "extracted" && hasValidSourceEvidence(evidence) && typeof row.confidence === "number") {
        acc.extracted_source_backed_count += 1;
      }
      if (hasValue && row.status === "missing_source_evidence") acc.missing_source_evidence_count += 1;
      if (row.status === "calculated") acc.calculated_count += 1;
      if (isManualExtractionStatus(row.status)) acc.manual_count += 1;
      if (row.status === "not_found") acc.not_found_count += 1;
      return acc;
    },
    {
      extracted_source_backed_count: 0,
      missing_source_evidence_count: 0,
      calculated_count: 0,
      manual_count: 0,
      not_found_count: 0,
    },
  );
  debugSummary.extracted_source_backed_count = statusCounts.extracted_source_backed_count;
  debugSummary.missing_source_evidence_count = statusCounts.missing_source_evidence_count;
  debugSummary.calculated_count = statusCounts.calculated_count;
  debugSummary.manual_count = statusCounts.manual_count;
  debugSummary.not_found_count = statusCounts.not_found_count;
  debugSummary.dynamic_rows_missing_source_count = uniqueItems.filter((item) =>
    item?.creates_dynamic_row
    && (item?.value ?? item?.normalized_value ?? item?.raw_value) != null
    && !hasValidSourceEvidence({
      sourcePage: item?.source_page ?? item?.page_number ?? item?.page,
      sourceText: item?.source_text ?? item?.source_clause ?? item?.exact_source_text,
    })
  ).length;
  debugSummary.accept_blocked_missing_source_count = missingEvidence.filter((row) => row.required).length;
  const rawFieldTrace = Array.isArray(debugRead("field_trace")) ? debugRead("field_trace") : [];
  const fieldTraceRows = rawFieldTrace.map((trace) => {
    const rendered = reviewTableRows.find((row) => row.key === trace.field_key);
    const resolverFound = rendered ? rendered.value != null && rendered.value !== "" : Boolean(trace.resolver_found_value);
    const resolverStatus = rendered?.status ?? trace.resolver_status ?? null;
    let finalReason = trace.final_blank_reason ?? null;
    if (!rendered) finalReason = finalReason || "dynamic_row_filter_hidden";
    else if (resolverFound && resolverStatus === "missing_source_evidence") finalReason = "missing_source_evidence";
    else if (resolverFound && finalReason === "llm_did_not_return") finalReason = null;
    return {
      ...trace,
      resolver_found_value: resolverFound,
      resolver_value: rendered?.value ?? trace.resolver_value ?? null,
      resolver_status: resolverStatus,
      rendered_in_tab: Boolean(rendered),
      final_blank_reason: finalReason,
    };
  });
  const missingTraceRows = fieldTraceRows.filter((trace) => trace.final_blank_reason);
  const missingTraceByReason = missingTraceRows.reduce((acc, trace) => {
    acc[trace.final_blank_reason] = (acc[trace.final_blank_reason] || 0) + 1;
    return acc;
  }, {});
  debugSummary.missing_fields_count = missingTraceRows.length || debugRead("missing_fields_count") || 0;
  debugSummary.missing_by_reason = JSON.stringify(
    Object.keys(missingTraceByReason).length ? missingTraceByReason : (debugRead("missing_by_reason") || {}),
  );
  debugSummary.unmapped_llm_keys = JSON.stringify(debugRead("unmapped_llm_keys") || []);
  debugSummary.rejected_fields_with_reasons = JSON.stringify(debugRead("rejected_fields_with_reasons") || []);
  debugSummary.persisted_but_not_rendered_fields = JSON.stringify(debugRead("persisted_but_not_rendered_fields") || []);

  // â”€â”€ Actions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  const handleRerunExtraction = async () => {
    if (!sourceFileId) {
      toast.error("This lease has no source file linked. Use Re-link Source Document first.");
      return;
    }
    setRerunning(true);
    try {
      const moduleType = uploadedFile?.module_type || "leases";
      const data = await invokeEdgeFunction("ingest-file", {
        file_id: sourceFileId,
        module_type: moduleType,
        force_reextract: true,
      });
      if (data?.error) throw new Error(data?.message || "Re-extraction failed");
      toast.success("Re-extraction kicked off. The source file will reprocess; refresh in a moment then run Apply Latest Extraction.");
      await refetchUploadedFile();
    } catch (err) {
      console.error("[ExtractionDebug] re-run failed:", err);
      toast.error(err?.message || "Could not re-run extraction");
    } finally {
      setRerunning(false);
    }
  };

  const handleApplyLatestExtraction = async () => {
    if (!sourceFileId || !uploadedFile) {
      toast.error("No source file available to read from.");
      return;
    }
    setApplying(true);
    try {
      const reviewedRow = (uploadedFile.ui_review_payload?.records || uploadedFile.ui_review_payload?.rows || [])[0];
      const wf = uploadedFile.ui_review_payload?.metadata?.workflow_output;
      const workflowOutputFromFile = Array.isArray(wf?.records) ? wf.records[0] : wf || null;

      const fieldsWithEvidence = {};
      const evidenceMap = {};
      const confidenceMap = {};
      const normalizeIncomingExtractionStatus = ({ value, confidence, sourcePage, sourceText, extractionStatus }) => {
        const explicit = String(extractionStatus || "").trim().toLowerCase();
        if (isCalculatedExtractionStatus(explicit)) return "calculated";
        if (isManualExtractionStatus(explicit)) return explicit;
        if (value == null || value === "") return "not_found";
        if (!hasValidSourceEvidence({ sourcePage, sourceText })) return "missing_source_evidence";
        return typeof confidence === "number" && !Number.isNaN(confidence) ? "extracted" : "extracted_no_confidence";
      };

      if (reviewedRow) {
        const allFields = [
          ...(reviewedRow.standard_fields || []),
          ...(reviewedRow.custom_fields || []),
        ];
        for (const field of allFields) {
          if (!field?.field_key) continue;
          const sourceText = cleanSourceEvidenceText(field.evidence?.source_clause ?? field.evidence?.source_text);
          const sourcePage = field.evidence?.page_number ?? field.evidence?.source_page ?? null;
          const confidence = typeof field.confidence === "number" ? field.confidence : null;
          const extractionStatus = normalizeIncomingExtractionStatus({
            value: field.value ?? null,
            confidence,
            sourcePage,
            sourceText,
            extractionStatus: field.status ?? null,
          });
          fieldsWithEvidence[field.field_key] = {
            value: field.value ?? null,
            confidence,
            source: field.source ?? null,
            source_page: sourcePage,
            source_text: sourceText,
            raw_value: field.original_value ?? field.evidence?.raw_value ?? null,
            extraction_status: extractionStatus,
          };
          evidenceMap[field.field_key] = {
            raw_value: field.original_value ?? field.evidence?.raw_value ?? null,
            source_page: sourcePage,
            source_text: sourceText,
            extraction_status: extractionStatus,
          };
          if (typeof field.confidence === "number") {
            confidenceMap[field.field_key] = field.confidence <= 1 ? Math.round(field.confidence * 100) : Math.round(field.confidence);
          }
        }
      }

      const isSourceBackedEntry = (entry) =>
        entry && typeof entry === "object" && hasValidSourceEvidence({
          sourcePage: entry.source_page,
          sourceText: entry.source_text,
        }) && !isCalculatedExtractionStatus(entry.extraction_status);
      const mergedFields = { ...(lease.extraction_data?.fields || {}) };
      const mergedEvidence = { ...(lease.extraction_data?.field_evidence || {}) };
      for (const [key, entry] of Object.entries(fieldsWithEvidence)) {
        const prev = mergedFields[key];
        if (isSourceBackedEntry(entry) || !isSourceBackedEntry(prev)) {
          mergedFields[key] = entry;
        }
      }
      for (const [key, entry] of Object.entries(evidenceMap)) {
        const prev = mergedEvidence[key];
        if (isSourceBackedEntry(entry) || !isSourceBackedEntry(prev)) {
          mergedEvidence[key] = entry;
        }
      }

      const nextExtraction = {
        ...(lease.extraction_data || {}),
        fields: mergedFields,
        field_evidence: mergedEvidence,
        confidence_scores: { ...(lease.extraction_data?.confidence_scores || {}), ...confidenceMap },
        ...(workflowOutputFromFile ? { workflow_output: workflowOutputFromFile } : {}),
        evidence_refreshed_at: new Date().toISOString(),
      };

      await persistLeaseExtractionMerge({
        leaseId: lease.id,
        action: "lease_extraction_debug_applied",
        patch: nextExtraction,
      });
      toast.success("Lease refreshed with latest extraction from source file.");
      queryClient.invalidateQueries({ queryKey: ["lease", lease.id] });
    } catch (err) {
      console.error("[ExtractionDebug] apply latest failed:", err);
      toast.error(err?.message || "Could not apply latest extraction");
    } finally {
      setApplying(false);
    }
  };

  const handleRelinkSource = async () => {
    const trimmed = relinkValue.trim();
    if (!trimmed) {
      toast.error("Enter an uploaded_files ID to link.");
      return;
    }
    setRelinking(true);
    try {
      // Verify the file exists and belongs to the same org before writing.
      const { data: file, error: lookupErr } = await supabase
        .from("uploaded_files")
        .select("id, org_id, file_name")
        .eq("id", trimmed)
        .maybeSingle();
      if (lookupErr) throw lookupErr;
      if (!file) throw new Error(`No uploaded_files row found for id ${trimmed}`);
      if (file.org_id && lease.org_id && file.org_id !== lease.org_id) {
        throw new Error("Source file belongs to a different organization");
      }
      await updateLeaseExtractionField({
        leaseId: lease.id,
        fieldArea: "source_link",
        action: "source_file_relinked_debug",
        patch: {
          source_file_id: trimmed,
          source_file_name: file.file_name ?? null,
          source_relinked_at: new Date().toISOString(),
        },
      });
      toast.success(`Source file linked: ${file.file_name || trimmed}`);
      setRelinkOpen(false);
      setRelinkValue("");
      queryClient.invalidateQueries({ queryKey: ["lease", lease.id] });
      queryClient.invalidateQueries({ queryKey: ["debug-uploaded-file", trimmed] });
    } catch (err) {
      console.error("[ExtractionDebug] relink failed:", err);
      toast.error(err?.message || "Could not relink source document");
    } finally {
      setRelinking(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
        <div>
          For diagnosing extraction issues. Read-only view of every layer between the document and the review table.
          {sourceFileId ? null : (
            <div className="mt-1 text-amber-900">
              No source file is linked to this lease. Use <strong>Re-link Source Document</strong> to point this lease at an uploaded file.
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={handleRerunExtraction}
            disabled={rerunning || !sourceFileId}
            title={sourceFileId ? "Re-runs ingest-file on the source upload" : "No source file linked"}
          >
            {rerunning ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
            Re-run Extraction
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleApplyLatestExtraction}
            disabled={applying || !sourceFileId || !uploadedFile?.ui_review_payload}
            title="Copy the latest extraction (values + evidence) from the source file into this lease"
          >
            {applying ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Wand2 className="mr-1 h-3.5 w-3.5" />}
            Apply Latest Extraction
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setRelinkOpen((open) => !open)}
          >
            <Link2 className="mr-1 h-3.5 w-3.5" />
            Re-link Source Document
          </Button>
        </div>
      </div>

      {relinkOpen && (
        <Card>
          <CardContent className="space-y-2 p-4">
            <Label className="text-xs font-semibold text-slate-700">uploaded_files.id</Label>
            <p className="text-[11px] text-slate-500">
              Paste the row ID of the uploaded file you want this lease to point at. Find it on the Upload Lease page's
              File ID line.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={relinkValue}
                onChange={(e) => setRelinkValue(e.target.value)}
                placeholder="e08b313e-65b6-49d1-a24d-3875c27bb5a7"
                className="flex-1 min-w-[280px]"
              />
              <Button
                size="sm"
                onClick={handleRelinkSource}
                disabled={relinking || !relinkValue.trim()}
                className="bg-blue-600 hover:bg-blue-700"
              >
                {relinking && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                Link
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setRelinkOpen(false); setRelinkValue(""); }}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Section
        title="Document Intelligence v3 Diagnostics"
        badge="diagnostic_only"
        count={v3Diagnostics ? (v3Diagnostics.available ? "loaded" : "not available") : "not loaded"}
      >
        <p className="text-slate-500">
          Opt-in, read-only diagnostic from the Document Intelligence v3 pipeline. Advisory only â€” does
          not affect Lease Review fields, blockers, or the approval workflow.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={handleLoadV3Diagnostics}
            disabled={v3Loading || !v3UploadedFileId}
            title={v3UploadedFileId ? "Fetch document-intelligence-v3-readiness for this document" : "No source file linked"}
          >
            {v3Loading && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            Load v3 Diagnostics
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleLoadV3AdvisoryAudit}
            disabled={v3AuditLoading || (!v3UploadedFileId && !lease?.id)}
            title={v3UploadedFileId || lease?.id ? "Compare v3 advisory with current review snapshot" : "No source file or lease id linked"}
          >
            {v3AuditLoading && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            Load v3 Advisory Audit
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleLoadV3AdvisoryAuditBatch}
            disabled={v3BatchAuditLoading || (!v3UploadedFileId && !lease?.id)}
            title={v3UploadedFileId || lease?.id ? "Run a diagnostic-only batch audit for this document" : "No source file or lease id linked"}
          >
            {v3BatchAuditLoading && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            Run Batch Advisory Audit
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleLoadV3ProjectionDiff}
            disabled={v3ProjectionDiffLoading || !v3UploadedFileId}
            title={v3UploadedFileId ? "Compare legacy vs. canonical field projections (Release 2)" : "No source file linked"}
          >
            {v3ProjectionDiffLoading && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            Load Projection Diff
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleLoadV3RunMetrics}
            disabled={v3RunMetricsLoading || !v3UploadedFileId}
            title={v3UploadedFileId ? "Load run operational metrics and table-write health (Release 2)" : "No source file linked"}
          >
            {v3RunMetricsLoading && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            Load Run Metrics
          </Button>
          {v3AdvisoryAuditBatch && (
            <>
              <Button size="sm" variant="outline" onClick={handleCopyV3AdvisoryAuditBatchJson}>
                <Copy className="mr-1 h-3.5 w-3.5" />
                Copy Batch JSON
              </Button>
              <Button size="sm" variant="outline" onClick={handleDownloadV3AdvisoryAuditBatchJson}>
                <Download className="mr-1 h-3.5 w-3.5" />
                Download Batch JSON
              </Button>
            </>
          )}
        {v3AdvisoryAudit && (
            <>
              <Button size="sm" variant="outline" onClick={handleCopyV3AdvisoryAuditJson}>
                <Copy className="mr-1 h-3.5 w-3.5" />
                Copy Audit JSON
              </Button>
              <Button size="sm" variant="outline" onClick={handleDownloadV3AdvisoryAuditJson}>
                <Download className="mr-1 h-3.5 w-3.5" />
                Download Audit JSON
              </Button>
            </>
          )}
          {v3Diagnostics && (
            <>
              <Button size="sm" variant="outline" onClick={handleCopyV3DiagnosticsJson}>
                <Copy className="mr-1 h-3.5 w-3.5" />
                Copy v3 Diagnostic JSON
              </Button>
              <Button size="sm" variant="outline" onClick={handleDownloadV3DiagnosticsJson}>
                <Download className="mr-1 h-3.5 w-3.5" />
                Download v3 Diagnostic JSON
              </Button>
            </>
          )}
        </div>

        {v3FetchError && (
          <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-red-700">
            Could not load v3 diagnostics: {v3FetchError}
          </div>
        )}

        {!v3Diagnostics && !v3FetchError && (
          <p className="text-slate-500">
            Click &ldquo;Load v3 Diagnostics&rdquo; to fetch the readiness diagnostic for this document.
          </p>
        )}

        {v3Diagnostics && !v3Diagnostics.available && (
          <p className="text-slate-500">{v3Diagnostics.notAvailableMessage}</p>
        )}

        {v3AuditFetchError && (
          <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-red-700">
            Could not load v3 advisory audit: {v3AuditFetchError}
          </div>
        )}
          {v3BatchAuditFetchError && (
          <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-red-700">
            Could not load v3 batch advisory audit: {v3BatchAuditFetchError}
          </div>
        )}

        {v3AdvisoryAuditBatch && (
          <div className="space-y-2 rounded border border-slate-200 bg-white p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[11px] font-semibold uppercase text-slate-500">V3 Batch Advisory Audit Report</div>
              <Badge className="bg-slate-100 text-slate-700">diagnostic_only</Badge>
            </div>
            <p className="text-xs text-slate-500">
              Current-document batch report for admin QA. It is read-only and does not call approval workflows.
            </p>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
              {[
                ["total", v3AdvisoryAuditBatch.total],
                ["generated_at", v3AdvisoryAuditBatch.generatedAt || "-"],
                ["agreement_counts", prettyJson(v3AdvisoryAuditBatch.agreementCounts, 500)],
                ["discrepancy_counts", prettyJson(v3AdvisoryAuditBatch.discrepancyCounts, 700)],
                ["risk_summary", prettyJson(v3AdvisoryAuditBatch.riskSummary, 500)],
              ].map(([key, value]) => (
                <div key={key} className="rounded border border-slate-200 bg-slate-50 px-3 py-2">
                  <div className="text-[10px] font-semibold uppercase text-slate-500">{key.replace(/_/g, " ")}</div>
                  <pre className="mt-1 whitespace-pre-wrap text-[11px] font-semibold text-slate-900">{String(value ?? "-")}</pre>
                </div>
              ))}
            </div>
            <div className="grid gap-2 lg:grid-cols-2">
              <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2">
                <div className="text-[10px] font-semibold uppercase text-slate-500">Advisory Status Counts</div>
                <pre className="mt-1 max-h-36 overflow-auto whitespace-pre-wrap text-[11px] text-slate-700">{prettyJson(v3AdvisoryAuditBatch.advisoryStatusCounts, 700)}</pre>
              </div>
              <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2">
                <div className="text-[10px] font-semibold uppercase text-slate-500">Current Status Counts</div>
                <pre className="mt-1 max-h-36 overflow-auto whitespace-pre-wrap text-[11px] text-slate-700">{prettyJson(v3AdvisoryAuditBatch.currentStatusCounts, 700)}</pre>
              </div>
            </div>
            <div className="max-h-64 overflow-auto rounded border border-slate-200">
              <table className="w-full text-[11px]">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-2 py-1 text-left">Uploaded File</th>
                    <th className="px-2 py-1 text-left">Run</th>
                    <th className="px-2 py-1 text-left">Lease</th>
                    <th className="px-2 py-1 text-left">Profile</th>
                    <th className="px-2 py-1 text-left">v3 Advisory</th>
                    <th className="px-2 py-1 text-left">Current</th>
                    <th className="px-2 py-1 text-left">Agreement</th>
                    <th className="px-2 py-1 text-left">Discrepancies</th>
                  </tr>
                </thead>
                <tbody>
                  {v3AdvisoryAuditBatch.results.map((row, index) => (
                    <tr key={`${row.uploaded_file_id || row.run_id || row.lease_id || index}`} className="border-t border-slate-100">
                      <td className="px-2 py-1 text-slate-600">{row.uploaded_file_id || "-"}</td>
                      <td className="px-2 py-1 text-slate-600">{row.run_id || "-"}</td>
                      <td className="px-2 py-1 text-slate-600">{row.lease_id || "-"}</td>
                      <td className="px-2 py-1 text-slate-600">{row.profile_key || "-"}</td>
                      <td className="px-2 py-1 text-slate-600">{row.v3_advisory_status || "-"}</td>
                      <td className="px-2 py-1 text-slate-600">{row.current_status || "-"}</td>
                      <td className="px-2 py-1 font-medium text-slate-700">{row.agreement_level || "-"}</td>
                      <td className="px-2 py-1 text-slate-600" title={prettyJson(row.discrepancies, 1200)}>{row.discrepancy_count ?? 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}


        {v3AdvisoryAudit && (
          <div className="space-y-2 rounded border border-slate-200 bg-slate-50 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[11px] font-semibold uppercase text-slate-500">V3 Advisory Audit / Current Review Comparison</div>
              <Badge className="bg-slate-100 text-slate-700">diagnostic_only</Badge>
            </div>
            <p className="text-xs text-slate-500">
              Read-only comparison only. This does not change Lease Review approval behavior or call approve_lease_workflow.
            </p>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
              {[
                ["v3_advisory_status", v3AdvisoryAudit.v3Status],
                ["current_review_status", v3AdvisoryAudit.currentStatus],
                ["agreement_level", v3AdvisoryAudit.agreementLevel],
                ["discrepancy_count", v3AdvisoryAudit.discrepancyCount],
                ["audit_status", v3AdvisoryAudit.auditStatus],
              ].map(([key, value]) => (
                <div key={key} className="rounded border border-slate-200 bg-white px-3 py-2">
                  <div className="text-[10px] font-semibold uppercase text-slate-500">{key.replace(/_/g, " ")}</div>
                  <div className="mt-1 text-sm font-semibold text-slate-900">{String(value ?? "-")}</div>
                </div>
              ))}
            </div>
            <div className="grid gap-2 lg:grid-cols-2">
              {[
                ["Discrepancies by Type", v3AdvisoryAudit.discrepancies.map((item) => ({ type: item.type, severity: item.severity, message: item.message }))],
                ["False Positive Risks", v3AdvisoryAudit.falsePositiveRisks],
                ["False Negative Risks", v3AdvisoryAudit.falseNegativeRisks],
                ["Recommendations", v3AdvisoryAudit.recommendations],
                ["Missing Inputs", v3AdvisoryAudit.missingInputs],
                ["Current Review Snapshot", v3AdvisoryAudit.currentReviewSnapshot],
              ].map(([label, value]) => (
                <div key={label} className="rounded border border-slate-200 bg-white px-3 py-2">
                  <div className="text-[10px] font-semibold uppercase text-slate-500">{label}</div>
                  {Array.isArray(value) && value.length === 0 ? (
                    <p className="mt-1 text-xs text-slate-500">None</p>
                  ) : (
                    <pre className="mt-1 max-h-44 overflow-auto whitespace-pre-wrap text-[11px] text-slate-700">{prettyJson(value, 1400)}</pre>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {v3ProjectionDiffFetchError && (
          <p className="text-xs text-red-600">Projection diff error: {v3ProjectionDiffFetchError}</p>
        )}
        {v3ProjectionDiff && (
          <div className="space-y-2 rounded border border-slate-200 bg-slate-50 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[11px] font-semibold uppercase text-slate-500">Projection Diff (Release 2) — Legacy vs. Canonical</div>
              <Badge className="bg-slate-100 text-slate-700">diagnostic_only</Badge>
            </div>
            <p className="text-xs text-slate-500">
              Compares ui_review_payload (legacy) against this run&apos;s document_canonical_field_projections
              (canonical), per field, with type-aware normalization. Read-only — no UI field ever reads from
              canonical projections yet.
            </p>
            {v3ProjectionDiff.comparisonStatus !== "available" ? (
              <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                <span className="font-semibold">comparison_status: {v3ProjectionDiff.comparisonStatus}</span>
                {v3ProjectionDiff.comparisonStatus === "unavailable_no_fact_ledger" && (
                  <p className="mt-1">
                    No claims exist for this run — expected under BUSINESS_EXTRACTION_PROVIDER=legacy_hybrid
                    (Mode A, infrastructure verification only). Nothing to compare, not a 0% agreement.
                  </p>
                )}
                {v3ProjectionDiff.comparisonStatus === "unavailable_no_projections" && (
                  <p className="mt-1">
                    Claims exist for this run but produced zero canonical field projections — a real gap
                    worth investigating, distinct from the legacy_hybrid case above.
                  </p>
                )}
              </div>
            ) : (
              <>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  {[
                    ["field_count", v3ProjectionDiff.summary?.fieldCount ?? "—"],
                    ["exact_match_rate", v3ProjectionDiff.summary?.exactMatchRate != null ? `${(v3ProjectionDiff.summary.exactMatchRate * 100).toFixed(1)}%` : "—"],
                    ["normalized_match_rate", v3ProjectionDiff.summary?.normalizedMatchRate != null ? `${(v3ProjectionDiff.summary.normalizedMatchRate * 100).toFixed(1)}%` : "—"],
                    ["critical_field_agreement_rate", v3ProjectionDiff.summary?.criticalFieldAgreementRate != null ? `${(v3ProjectionDiff.summary.criticalFieldAgreementRate * 100).toFixed(1)}%` : "—"],
                    ["material_conflict_count", v3ProjectionDiff.summary?.materialConflictCount ?? "—"],
                    ["ambiguous_date_count", v3ProjectionDiff.summary?.ambiguousDateCount ?? "—"],
                    ["evidence_page_mismatch_count", v3ProjectionDiff.summary?.evidencePageMismatchCount ?? "—"],
                  ].map(([key, value]) => (
                    <div key={key} className="rounded border border-slate-200 bg-white px-3 py-2">
                      <div className="text-[10px] font-semibold uppercase text-slate-500">{key.replace(/_/g, " ")}</div>
                      <div className="mt-1 text-sm font-semibold text-slate-900">{String(value)}</div>
                    </div>
                  ))}
                </div>
                <div className="max-h-72 overflow-auto rounded border border-slate-200">
                  <table className="w-full text-[11px]">
                    <thead className="bg-slate-50">
                      <tr>
                        <th className="px-2 py-1 text-left">Field</th>
                        <th className="px-2 py-1 text-left">Legacy Value</th>
                        <th className="px-2 py-1 text-left">Canonical Value</th>
                        <th className="px-2 py-1 text-left">Difference</th>
                        <th className="px-2 py-1 text-left">Materiality</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...v3ProjectionDiff.diffs]
                        .sort((a, b) => {
                          const order = { critical: 0, material: 1, informational: 2 };
                          return (order[a.materiality] ?? 3) - (order[b.materiality] ?? 3);
                        })
                        .map((diff) => (
                          <tr key={diff.fieldKey} className="border-t border-slate-100">
                            <td className="px-2 py-1 font-medium text-slate-700">{diff.fieldKey}</td>
                            <td className="px-2 py-1 text-slate-600">{String(diff.legacyValue ?? "—")}</td>
                            <td className="px-2 py-1 text-slate-600">{String(diff.canonicalValue ?? "—")}</td>
                            <td className="px-2 py-1 text-slate-600">
                              {diff.differenceType}
                              {diff.dateAmbiguous && <span className="ml-1 text-amber-600">(ambiguous format)</span>}
                            </td>
                            <td className="px-2 py-1">
                              <Badge
                                className={
                                  diff.materiality === "critical"
                                    ? "bg-red-100 text-red-700"
                                    : diff.materiality === "material"
                                      ? "bg-amber-100 text-amber-700"
                                      : "bg-slate-100 text-slate-600"
                                }
                              >
                                {diff.materiality}
                              </Badge>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}

        {v3RunMetricsFetchError && (
          <p className="text-xs text-red-600">Run metrics error: {v3RunMetricsFetchError}</p>
        )}
        {v3RunMetrics && (
          <div className="space-y-2 rounded border border-slate-200 bg-slate-50 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[11px] font-semibold uppercase text-slate-500">Run Operational Metrics (Release 2)</div>
              <Badge className="bg-slate-100 text-slate-700">diagnostic_only</Badge>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {[
                ["pages_received", v3RunMetrics.metrics?.pages_received ?? "—"],
                ["pages_parsed", v3RunMetrics.metrics?.pages_parsed ?? "—"],
                ["canonical_blocks", v3RunMetrics.metrics?.canonical_blocks ?? "—"],
                ["canonical_tables", v3RunMetrics.metrics?.canonical_tables ?? "—"],
                ["claims_extracted", v3RunMetrics.metrics?.claims_extracted ?? "—"],
                ["claims_with_evidence", v3RunMetrics.metrics?.claims_with_evidence ?? "—"],
                ["claims_rejected", v3RunMetrics.metrics?.claims_rejected ?? "—"],
                ["canonical_projections_created", v3RunMetrics.metrics?.canonical_projections_created ?? "—"],
                ["legacy_fields_populated", v3RunMetrics.metrics?.legacy_fields_populated ?? "—"],
                ["canonical_fields_populated", v3RunMetrics.metrics?.canonical_fields_populated ?? "—"],
              ].map(([key, value]) => (
                <div key={key} className="rounded border border-slate-200 bg-white px-3 py-2">
                  <div className="text-[10px] font-semibold uppercase text-slate-500">{key.replace(/_/g, " ")}</div>
                  <div className="mt-1 text-sm font-semibold text-slate-900">{String(value)}</div>
                </div>
              ))}
            </div>
            <div className="rounded border border-slate-200 bg-white px-3 py-2">
              <div className="text-[10px] font-semibold uppercase text-slate-500">
                readiness ({v3RunMetrics.metrics?.readiness_source ?? "computed"}, version {v3RunMetrics.metrics?.readiness_version ?? "—"}) — not a persisted historical value, recomputed on every load
              </div>
              <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-[11px] text-slate-700">
                {prettyJson({ status: v3RunMetrics.metrics?.readiness?.readiness?.status, blockers: v3RunMetrics.metrics?.readiness?.blockers?.length ?? 0 }, 800)}
              </pre>
            </div>
            {v3RunMetrics.metrics?.stage_failures?.length > 0 && (
              <div className="rounded border border-red-200 bg-red-50 px-3 py-2">
                <div className="text-[10px] font-semibold uppercase text-red-600">stage_failures</div>
                <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-[11px] text-red-700">{prettyJson(v3RunMetrics.metrics.stage_failures, 1000)}</pre>
              </div>
            )}
            <div className="grid gap-2 lg:grid-cols-2">
              <div className="rounded border border-slate-200 bg-white px-3 py-2">
                <div className="text-[10px] font-semibold uppercase text-slate-500">transport_wrapper_readiness</div>
                <pre className="mt-1 whitespace-pre-wrap text-[11px] text-slate-700">{prettyJson(v3RunMetrics.transportWrapperReadiness, 600)}</pre>
              </div>
              <div className="rounded border border-slate-200 bg-white px-3 py-2">
                <div className="text-[10px] font-semibold uppercase text-slate-500">stage_durations</div>
                <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-[11px] text-slate-700">{prettyJson(v3RunMetrics.metrics?.stage_durations, 600)}</pre>
              </div>
            </div>
          </div>
        )}

        {v3RunMetrics?.tableHealth?.length > 0 && (
          <div className="space-y-2 rounded border border-slate-200 bg-white p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[11px] font-semibold uppercase text-slate-500">Provenance / Table-Write Health (Release 2)</div>
              <Badge className="bg-slate-100 text-slate-700">diagnostic_only</Badge>
            </div>
            <p className="text-xs text-slate-500">
              Expected-row rules are provider-aware — a healthy legacy_hybrid run with zero claims/
              projections is labeled &ldquo;expected,&rdquo; not broken. See run_type in diagnostics_context.
            </p>
            <div className="overflow-auto rounded border border-slate-200">
              <table className="w-full text-[11px]">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-2 py-1 text-left">Table</th>
                    <th className="px-2 py-1 text-left">Rule</th>
                    <th className="px-2 py-1 text-left">Actual Count</th>
                    <th className="px-2 py-1 text-left">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {v3RunMetrics.tableHealth.map((row) => (
                    <tr key={row.table} className="border-t border-slate-100">
                      <td className="px-2 py-1 font-medium text-slate-700">{row.table}</td>
                      <td className="px-2 py-1 text-slate-600">{row.rule}</td>
                      <td className="px-2 py-1 text-slate-600">{row.actualCount}</td>
                      <td className="px-2 py-1">
                        {row.unexpected ? (
                          <Badge className="bg-red-100 text-red-700">missing expected rows</Badge>
                        ) : (
                          <Badge className="bg-emerald-100 text-emerald-700">as expected</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {v3Diagnostics && v3Diagnostics.available && (
          <div className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {[
                ["diagnostic_only", String(v3Diagnostics.diagnosticOnly)],
                ["run_id", v3Diagnostics.runId || "â€”"],
                ["uploaded_file_id", v3Diagnostics.uploadedFileId || "â€”"],
                ["lease_id", v3Diagnostics.leaseId || "â€”"],
                ["profile_key", v3Diagnostics.profile.profile_key || "â€”"],
                ["policy_key", v3Diagnostics.profile.policy_key],
                ["profile_confidence", v3Diagnostics.profile.confidence ?? "â€”"],
                ["profile_status", v3Diagnostics.profile.status],
                ["readiness_status", v3Diagnostics.readinessStatus],
                ["readiness_reason", v3Diagnostics.readinessReason || "â€”"],
                ["blockers_count", v3Diagnostics.blockers.length],
                ["advisories_count", v3Diagnostics.advisories.length],
              ].map(([key, value]) => (
                <div key={key} className="rounded border border-slate-200 bg-white px-3 py-2">
                  <div className="text-[10px] font-semibold uppercase text-slate-500">{key.replace(/_/g, " ")}</div>
                  <div className="mt-1 text-sm font-semibold text-slate-900">{String(value)}</div>
                </div>
              ))}
            </div>

            {v3Diagnostics.profileEnsemble && (
              <div className="space-y-2 rounded border border-slate-200 bg-slate-50 p-3">
                <div className="text-[11px] font-semibold uppercase text-slate-500">Profile Ensemble</div>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
                  {[
                    ["selected_profile", v3Diagnostics.profileEnsemble.selectedProfileKey || "-"],
                    ["selected_policy", v3Diagnostics.profileEnsemble.selectedPolicyKey || "-"],
                    ["confidence", v3Diagnostics.profileEnsemble.confidence ?? "-"],
                    ["status", v3Diagnostics.profileEnsemble.status || "-"],
                    ["source", v3Diagnostics.profileEnsemble.source || "-"],
                  ].map(([key, value]) => (
                    <div key={key} className="rounded border border-slate-200 bg-white px-3 py-2">
                      <div className="text-[10px] font-semibold uppercase text-slate-500">{key.replace(/_/g, " ")}</div>
                      <div className="mt-1 text-sm font-semibold text-slate-900">{String(value)}</div>
                    </div>
                  ))}
                </div>
                {v3Diagnostics.profileEnsemble.candidates.length > 0 && (
                  <div className="max-h-44 overflow-auto rounded border border-slate-200 bg-white">
                    <table className="w-full text-[11px]">
                      <thead className="bg-slate-50">
                        <tr>
                          <th className="px-2 py-1 text-left">Candidate</th>
                          <th className="px-2 py-1 text-left">Confidence</th>
                          <th className="px-2 py-1 text-left">Source</th>
                          <th className="px-2 py-1 text-left">Signals</th>
                        </tr>
                      </thead>
                      <tbody>
                        {v3Diagnostics.profileEnsemble.candidates.map((candidate, index) => (
                          <tr key={`${candidate.profile_key}-${candidate.source}-${index}`} className="border-t border-slate-100">
                            <td className="px-2 py-1 font-medium text-slate-700">{candidate.profile_key}</td>
                            <td className="px-2 py-1 text-slate-600">{candidate.confidence ?? "-"}</td>
                            <td className="px-2 py-1 text-slate-600">{candidate.source || "-"}</td>
                            <td className="max-w-[360px] truncate px-2 py-1 font-mono text-slate-500" title={prettyJson(candidate.signals, 2000)}>{prettyJson(candidate.signals, 180)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {(v3Diagnostics.profileEnsemble.disagreements.length > 0 || v3Diagnostics.profileEnsemble.fallbackReason) && (
                  <pre className="max-h-36 overflow-auto rounded bg-white p-2 font-mono text-[11px] text-amber-700">
                    {prettyJson({ disagreements: v3Diagnostics.profileEnsemble.disagreements, fallback_reason: v3Diagnostics.profileEnsemble.fallbackReason }, 1200)}
                  </pre>
                )}
              </div>
            )}

            {v3Diagnostics.extractionPlan && (
              <div className="space-y-2 rounded border border-slate-200 bg-slate-50 p-3">
                <div className="text-[11px] font-semibold uppercase text-slate-500">Extraction Plan</div>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  {[
                    ["profile", v3Diagnostics.extractionPlan.profileKey || "-"],
                    ["status", v3Diagnostics.extractionPlan.status || "planned"],
                    ["modules_to_run", v3Diagnostics.modulesToRunCount],
                    ["modules_skipped", v3Diagnostics.modulesSkippedCount],
                  ].map(([key, value]) => (
                    <div key={key} className="rounded border border-slate-200 bg-white px-3 py-2">
                      <div className="text-[10px] font-semibold uppercase text-slate-500">{key.replace(/_/g, " ")}</div>
                      <div className="mt-1 text-sm font-semibold text-slate-900">{String(value)}</div>
                    </div>
                  ))}
                </div>
                <div className="grid gap-2 lg:grid-cols-2">
                  <div>
                    <div className="mb-1 text-[10px] font-semibold uppercase text-slate-500">Modules To Run</div>
                    <ul className="max-h-48 space-y-1 overflow-auto rounded border border-slate-200 bg-white p-2">
                      {v3Diagnostics.extractionPlan.modulesToRun.map((module) => (
                        <li key={module.module_key} className="text-xs text-slate-700">
                          <span className="font-semibold">{module.module_key}</span>
                          <span className="text-slate-500"> - {module.reason}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <div className="mb-1 text-[10px] font-semibold uppercase text-slate-500">Modules Skipped</div>
                    {v3Diagnostics.extractionPlan.modulesSkipped.length === 0 ? (
                      <p className="rounded border border-slate-200 bg-white p-2 text-xs text-slate-500">None</p>
                    ) : (
                      <ul className="max-h-48 space-y-1 overflow-auto rounded border border-slate-200 bg-white p-2">
                        {v3Diagnostics.extractionPlan.modulesSkipped.map((module) => (
                          <li key={module.module_key} className="text-xs text-slate-700">
                            <span className="font-semibold">{module.module_key}</span>
                            <span className="text-amber-700"> - {module.reason}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
                {(v3Diagnostics.relatedDocumentsNeeded.length > 0 || v3Diagnostics.plannerWarnings.length > 0) && (
                  <div className="grid gap-2 lg:grid-cols-2">
                    <div className="rounded border border-slate-200 bg-white px-3 py-2">
                      <div className="text-[10px] font-semibold uppercase text-slate-500">Related Documents Needed</div>
                      <div className="mt-1 text-xs text-slate-700">{v3Diagnostics.relatedDocumentsNeeded.join(", ") || "None"}</div>
                    </div>
                    <div className="rounded border border-slate-200 bg-white px-3 py-2">
                      <div className="text-[10px] font-semibold uppercase text-slate-500">Planner Warnings</div>
                      <div className="mt-1 text-xs text-amber-700">{v3Diagnostics.plannerWarnings.join(", ") || "None"}</div>
                    </div>
                  </div>
                )}
              </div>
            )}
            {v3Diagnostics.packageGraph && (
              <div className="space-y-2 rounded border border-slate-200 bg-slate-50 p-3">
                <div className="text-[11px] font-semibold uppercase text-slate-500">Document Package Graph</div>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  {[
                    ["package_id", v3Diagnostics.packageGraph.packageId || "-"],
                    ["package_key", v3Diagnostics.packageGraph.packageKey || "-"],
                    ["graph_status", v3Diagnostics.packageGraph.graphStatus || "not_available"],
                    ["diagnostic_only", String(v3Diagnostics.packageGraph.diagnosticOnly)],
                    ["documents", v3Diagnostics.packageGraph.documents.length],
                    ["requirements", v3Diagnostics.relatedDocumentRequirements.length],
                    ["relationships", v3Diagnostics.packageGraph.relationships.length],
                    ["candidates", v3Diagnostics.candidateRelatedDocuments.length],
                  ].map(([key, value]) => (
                    <div key={key} className="rounded border border-slate-200 bg-white px-3 py-2">
                      <div className="text-[10px] font-semibold uppercase text-slate-500">{key.replace(/_/g, " ")}</div>
                      <div className="mt-1 text-sm font-semibold text-slate-900">{String(value)}</div>
                    </div>
                  ))}
                </div>
                {v3Diagnostics.packageGraph.error && (
                  <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800">
                    Package graph unavailable: {v3Diagnostics.packageGraph.error}
                  </p>
                )}
                <div className="grid gap-2 lg:grid-cols-2">
                  <div className="rounded border border-slate-200 bg-white px-3 py-2">
                    <div className="text-[10px] font-semibold uppercase text-slate-500">Package Documents</div>
                    {v3Diagnostics.packageGraph.documents.length === 0 ? (
                      <p className="mt-1 text-xs text-slate-500">No package documents recorded.</p>
                    ) : (
                      <pre className="mt-1 max-h-44 overflow-auto whitespace-pre-wrap text-[11px] text-slate-700">{prettyJson(v3Diagnostics.packageGraph.documents, 1200)}</pre>
                    )}
                  </div>
                  <div className="rounded border border-slate-200 bg-white px-3 py-2">
                    <div className="text-[10px] font-semibold uppercase text-slate-500">Related Document Requirements</div>
                    {v3Diagnostics.relatedDocumentRequirements.length === 0 ? (
                      <p className="mt-1 text-xs text-slate-500">None</p>
                    ) : (
                      <pre className="mt-1 max-h-44 overflow-auto whitespace-pre-wrap text-[11px] text-slate-700">{prettyJson(v3Diagnostics.relatedDocumentRequirements, 1200)}</pre>
                    )}
                  </div>
                  <div className="rounded border border-slate-200 bg-white px-3 py-2">
                    <div className="text-[10px] font-semibold uppercase text-slate-500">Document Relationships</div>
                    {v3Diagnostics.packageGraph.relationships.length === 0 ? (
                      <p className="mt-1 text-xs text-slate-500">None</p>
                    ) : (
                      <pre className="mt-1 max-h-44 overflow-auto whitespace-pre-wrap text-[11px] text-slate-700">{prettyJson(v3Diagnostics.packageGraph.relationships, 1200)}</pre>
                    )}
                  </div>
                  <div className="rounded border border-slate-200 bg-white px-3 py-2">
                    <div className="text-[10px] font-semibold uppercase text-slate-500">Candidate Related Documents</div>
                    {v3Diagnostics.candidateRelatedDocuments.length === 0 ? (
                      <p className="mt-1 text-xs text-slate-500">None</p>
                    ) : (
                      <pre className="mt-1 max-h-44 overflow-auto whitespace-pre-wrap text-[11px] text-slate-700">{prettyJson(v3Diagnostics.candidateRelatedDocuments, 1200)}</pre>
                    )}
                  </div>
                </div>
              </div>
            )}
            {v3Diagnostics.temporalSupersession && (
              <div className="space-y-2 rounded border border-slate-200 bg-slate-50 p-3">
                <div className="text-[11px] font-semibold uppercase text-slate-500">Temporal / Supersession Diagnostics</div>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  {[
                    ["temporal_status", v3Diagnostics.temporalSupersession.temporalStatus || "not_available"],
                    ["timeline_items", v3Diagnostics.temporalSupersession.documentTimeline.length],
                    ["effective_periods", v3Diagnostics.temporalSupersession.effectivePeriods.length],
                    ["supersession_candidates", v3Diagnostics.temporalSupersession.supersessionCandidates.length],
                    ["current_truth_candidates", v3Diagnostics.temporalSupersession.currentTruthCandidates.length],
                    ["unresolved_conflicts", v3Diagnostics.temporalSupersession.unresolvedTemporalConflicts.length],
                    ["missing_inputs", v3Diagnostics.temporalSupersession.missingTemporalInputs.length],
                    ["diagnostic_only", String(v3Diagnostics.temporalSupersession.diagnosticOnly)],
                  ].map(([key, value]) => (
                    <div key={key} className="rounded border border-slate-200 bg-white px-3 py-2">
                      <div className="text-[10px] font-semibold uppercase text-slate-500">{key.replace(/_/g, " ")}</div>
                      <div className="mt-1 text-sm font-semibold text-slate-900">{String(value)}</div>
                    </div>
                  ))}
                </div>
                <div className="grid gap-2 lg:grid-cols-2">
                  {[
                    ["Document Timeline", v3Diagnostics.temporalSupersession.documentTimeline],
                    ["Effective Periods", v3Diagnostics.temporalSupersession.effectivePeriods],
                    ["Supersession Candidates", v3Diagnostics.temporalSupersession.supersessionCandidates],
                    ["Current Truth Candidates", v3Diagnostics.temporalSupersession.currentTruthCandidates],
                    ["Unresolved Temporal Conflicts", v3Diagnostics.temporalSupersession.unresolvedTemporalConflicts],
                    ["Missing Temporal Inputs", v3Diagnostics.temporalSupersession.missingTemporalInputs],
                    ["Temporal Warnings", v3Diagnostics.temporalSupersession.warnings],
                  ].map(([label, value]) => (
                    <div key={label} className="rounded border border-slate-200 bg-white px-3 py-2">
                      <div className="text-[10px] font-semibold uppercase text-slate-500">{label}</div>
                      {Array.isArray(value) && value.length === 0 ? (
                        <p className="mt-1 text-xs text-slate-500">None</p>
                      ) : (
                        <pre className="mt-1 max-h-44 overflow-auto whitespace-pre-wrap text-[11px] text-slate-700">{prettyJson(value, 1200)}</pre>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {v3Diagnostics.approvalAdvisory && (
              <div className="space-y-2 rounded border border-slate-200 bg-slate-50 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[11px] font-semibold uppercase text-slate-500">V3 Approval Advisory Simulation</div>
                  <Badge className="bg-slate-100 text-slate-700">diagnostic_only</Badge>
                </div>
                <p className="text-xs text-slate-500">
                  Advisory simulation only. This does not change Lease Review approval behavior or call approve_lease_workflow.
                </p>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  {[
                    ["advisory_status", v3Diagnostics.approvalAdvisory.advisoryStatus],
                    ["would_block_approval", String(v3Diagnostics.approvalAdvisory.wouldBlockApproval)],
                    ["would_allow_approval", String(v3Diagnostics.approvalAdvisory.wouldAllowApproval)],
                    ["policy_key", v3Diagnostics.approvalAdvisory.policyKey || "-"],
                    ["blocking_if_enforced", v3Diagnostics.approvalAdvisory.blockerCountsBySeverity.blocking_if_enforced || 0],
                    ["needs_review", v3Diagnostics.approvalAdvisory.blockerCountsBySeverity.needs_review || 0],
                    ["advisory", v3Diagnostics.approvalAdvisory.blockerCountsBySeverity.advisory || 0],
                    ["informational", v3Diagnostics.approvalAdvisory.blockerCountsBySeverity.informational || 0],
                  ].map(([key, value]) => (
                    <div key={key} className="rounded border border-slate-200 bg-white px-3 py-2">
                      <div className="text-[10px] font-semibold uppercase text-slate-500">{key.replace(/_/g, " ")}</div>
                      <div className="mt-1 text-sm font-semibold text-slate-900">{String(value)}</div>
                    </div>
                  ))}
                </div>
                {v3Diagnostics.approvalAdvisory.advisoryReason && (
                  <div className="rounded border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700">
                    <span className="font-semibold uppercase text-slate-500">Advisory Reason: </span>
                    {v3Diagnostics.approvalAdvisory.advisoryReason}
                  </div>
                )}
                <div className="grid gap-2 lg:grid-cols-2">
                  {[
                    ["Missing Critical Fields", v3Diagnostics.approvalAdvisory.missingCriticalFields],
                    ["Evidence Issues", v3Diagnostics.approvalAdvisory.evidenceIssues],
                    ["Validation Issues", v3Diagnostics.approvalAdvisory.validationIssues],
                    ["Coverage Issues", v3Diagnostics.approvalAdvisory.coverageIssues],
                    ["Related Document Issues", v3Diagnostics.approvalAdvisory.relatedDocumentIssues],
                    ["Temporal Issues", v3Diagnostics.approvalAdvisory.temporalIssues],
                    ["Recommended Actions", v3Diagnostics.approvalAdvisory.blockers.map((item) => ({
                      blocker_type: item.blocker_type,
                      severity: item.severity,
                      field_key: item.field_key,
                      recommended_action: item.recommended_action,
                    }))],
                    ["Future Gate Inputs", v3Diagnostics.approvalAdvisory.futureGateInputs],
                  ].map(([label, value]) => (
                    <div key={label} className="rounded border border-slate-200 bg-white px-3 py-2">
                      <div className="text-[10px] font-semibold uppercase text-slate-500">{label}</div>
                      {Array.isArray(value) && value.length === 0 ? (
                        <p className="mt-1 text-xs text-slate-500">None</p>
                      ) : (
                        <pre className="mt-1 max-h-44 overflow-auto whitespace-pre-wrap text-[11px] text-slate-700">{prettyJson(value, 1200)}</pre>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {v3Diagnostics.coverage && (
              <div className="space-y-2 rounded border border-slate-200 bg-slate-50 p-3">
                <div className="text-[11px] font-semibold uppercase text-slate-500">Coverage Diagnostics</div>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  {[
                    ["Processing Coverage", v3Diagnostics.coverage.processing],
                    ["Evidence Coverage", v3Diagnostics.coverage.evidence],
                    ["Expected Information Coverage", v3Diagnostics.coverage.expectedInformation],
                    ["Module Coverage", v3Diagnostics.coverage.module],
                    ["Related Document Coverage", v3Diagnostics.coverage.relatedDocument],
                    ["Validation Coverage", v3Diagnostics.coverage.validation],
                    ["Overall Coverage", v3Diagnostics.coverage.overall],
                  ].map(([label, value]) => (
                    <div key={label} className="rounded border border-slate-200 bg-white px-3 py-2">
                      <div className="text-[10px] font-semibold uppercase text-slate-500">{label}</div>
                      <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-[11px] text-slate-700">{prettyJson(value, 700)}</pre>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {v3Diagnostics.importance && (
              <div className="space-y-2 rounded border border-slate-200 bg-slate-50 p-3">
                <div className="text-[11px] font-semibold uppercase text-slate-500">Importance Diagnostics</div>
                <div className="grid gap-2 lg:grid-cols-2">
                  <div className="rounded border border-slate-200 bg-white px-3 py-2">
                    <div className="text-[10px] font-semibold uppercase text-slate-500">Importance Summary</div>
                    <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-[11px] text-slate-700">{prettyJson(v3Diagnostics.importance.summary, 900)}</pre>
                  </div>
                  <div className="rounded border border-slate-200 bg-white px-3 py-2">
                    <div className="text-[10px] font-semibold uppercase text-slate-500">Critical/high Missing Fields</div>
                    {v3Diagnostics.importantMissingFields.length === 0 ? (
                      <p className="mt-1 text-xs text-slate-500">None</p>
                    ) : (
                      <ul className="mt-1 max-h-40 space-y-1 overflow-auto text-xs text-slate-700">
                        {v3Diagnostics.importantMissingFields.map((field) => (
                          <li key={field.field_key}>
                            <span className="font-semibold">{field.field_key}</span>
                            <span className="text-amber-700"> - {field.importance_level}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div className="rounded border border-slate-200 bg-white px-3 py-2">
                    <div className="text-[10px] font-semibold uppercase text-slate-500">Critical/high Validation Drops</div>
                    {v3Diagnostics.importantValidationDrops.length === 0 ? (
                      <p className="mt-1 text-xs text-slate-500">None</p>
                    ) : (
                      <ul className="mt-1 max-h-40 space-y-1 overflow-auto text-xs text-slate-700">
                        {v3Diagnostics.importantValidationDrops.map((drop, index) => (
                          <li key={`${drop.field_key}-${index}`}>
                            <span className="font-semibold">{drop.field_key || "unknown_field"}</span>
                            <span className="text-amber-700"> - {drop.reason}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div className="rounded border border-slate-200 bg-white px-3 py-2">
                    <div className="text-[10px] font-semibold uppercase text-slate-500">High-importance Advisories</div>
                    {v3Diagnostics.importance.highImportanceAdvisories.length === 0 ? (
                      <p className="mt-1 text-xs text-slate-500">None</p>
                    ) : (
                      <ul className="mt-1 max-h-40 space-y-1 overflow-auto text-xs text-slate-700">
                        {v3Diagnostics.importance.highImportanceAdvisories.map((advisory, index) => (
                          <li key={index}>{advisory.message}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div className="rounded border border-slate-200 bg-white px-3 py-2">
                    <div className="text-[10px] font-semibold uppercase text-slate-500">Unmapped High-importance Claims</div>
                    {v3Diagnostics.unmappedHighImportanceClaims.length === 0 ? (
                      <p className="mt-1 text-xs text-slate-500">None</p>
                    ) : (
                      <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-[11px] text-slate-700">{prettyJson(v3Diagnostics.unmappedHighImportanceClaims, 900)}</pre>
                    )}
                  </div>
                  <div className="rounded border border-slate-200 bg-white px-3 py-2">
                    <div className="text-[10px] font-semibold uppercase text-slate-500">Important Related Documents Missing</div>
                    {v3Diagnostics.importantRelatedDocumentsMissing.length === 0 ? (
                      <p className="mt-1 text-xs text-slate-500">None</p>
                    ) : (
                      <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-[11px] text-slate-700">{prettyJson(v3Diagnostics.importantRelatedDocumentsMissing, 900)}</pre>
                    )}
                  </div>
                </div>
              </div>
            )}
            {v3Diagnostics.blockers.length > 0 && (
              <div>
                <div className="mb-1 text-[11px] font-semibold uppercase text-slate-500">Blockers</div>
                <ul className="space-y-0.5">
                  {v3Diagnostics.blockers.map((b, i) => (
                    <li key={`${b.field_key}-${i}`} className="rounded bg-red-50 px-2 py-1 text-red-700">
                      <span className="font-medium">{b.field_key}</span> â€” {b.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {v3Diagnostics.advisories.length > 0 && (
              <div>
                <div className="mb-1 text-[11px] font-semibold uppercase text-slate-500">Advisories</div>
                <ul className="space-y-0.5">
                  {v3Diagnostics.advisories.map((a, i) => (
                    <li key={i} className="rounded bg-amber-50 px-2 py-1 text-amber-800">
                      {a.message}
                      {a.fields?.length ? <span className="text-amber-600"> ({a.fields.join(", ")})</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded border border-slate-200 bg-white px-3 py-2">
                <div className="text-[10px] font-semibold uppercase text-slate-500">Required Fields</div>
                <div className="mt-1 text-sm text-slate-900">
                  {v3Diagnostics.requiredFieldsSummary.total} total â€” {v3Diagnostics.requiredFieldsSummary.sourceBacked} source-backed,{" "}
                  {v3Diagnostics.requiredFieldsSummary.missing} missing, {v3Diagnostics.requiredFieldsSummary.needsReview} needs review
                </div>
              </div>
              <div className="rounded border border-slate-200 bg-white px-3 py-2">
                <div className="text-[10px] font-semibold uppercase text-slate-500">Optional Fields</div>
                <div className="mt-1 text-sm text-slate-900">
                  {v3Diagnostics.optionalFieldsSummary.total} total â€” {v3Diagnostics.optionalFieldsSummary.sourceBacked} source-backed,{" "}
                  {v3Diagnostics.optionalFieldsSummary.missing} missing, {v3Diagnostics.optionalFieldsSummary.needsReview} needs review
                </div>
              </div>
            </div>

            <div>
              <div className="mb-1 text-[11px] font-semibold uppercase text-slate-500">Evidence Sufficiency Summary</div>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {v3Diagnostics.evidenceSufficiencySummary.map((item) => (
                  <div key={item.key} className="rounded border border-slate-200 bg-white px-3 py-2">
                    <div className="text-[10px] font-semibold uppercase text-slate-500">{item.label}</div>
                    <div className="mt-1 text-sm font-semibold text-slate-900">{item.count}</div>
                  </div>
                ))}
              </div>
            </div>

            {(v3Diagnostics.requiredFieldsSummary.total > 0 || v3Diagnostics.optionalFieldsSummary.total > 0) && (
              <details>
                <summary className="cursor-pointer text-slate-700 hover:text-slate-900">Field-level detail</summary>
                <div className="mt-2 max-h-72 overflow-auto rounded border border-slate-200">
                  <table className="w-full text-[11px]">
                    <thead className="bg-slate-50">
                      <tr>
                        <th className="px-2 py-1 text-left">Field</th>
                        <th className="px-2 py-1 text-left">Required</th>
                        <th className="px-2 py-1 text-left">Status</th>
                        <th className="px-2 py-1 text-left">Source-backed</th>
                        <th className="px-2 py-1 text-left">Evidence Sufficiency</th>
                        <th className="px-2 py-1 text-left">Evidence Warnings</th>
                        <th className="px-2 py-1 text-left">Confidence</th>
                        <th className="px-2 py-1 text-left">Missing Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...v3Diagnostics.requiredFieldsSummary.fields, ...v3Diagnostics.optionalFieldsSummary.fields].map((f) => (
                        <tr key={f.field_key} className="border-t border-slate-100">
                          <td className="px-2 py-1 font-medium text-slate-700">{f.field_key}</td>
                          <td className="px-2 py-1 text-slate-600">{f.required ? "yes" : "no"}</td>
                          <td className="px-2 py-1 text-slate-600">{f.status}</td>
                          <td className="px-2 py-1 text-slate-600">{f.source_backed ? "yes" : "no"}</td>
                          <td className="px-2 py-1 text-slate-600">{f.evidence_sufficiency || "none"}</td>
                          <td className="max-w-[260px] px-2 py-1 text-amber-700">
                            {Array.isArray(f.evidence_warnings) && f.evidence_warnings.length > 0 ? f.evidence_warnings.join(", ") : "-"}
                          </td>
                          <td className="px-2 py-1 text-slate-600">{typeof f.confidence === "number" ? f.confidence : "â€”"}</td>
                          <td className="px-2 py-1 text-amber-700">{f.missing_reason || "â€”"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}

            <div>
              <div className="mb-1 text-[11px] font-semibold uppercase text-slate-500">
                Validation Drops ({v3Diagnostics.validationDrops.length})
              </div>
              {v3Diagnostics.validationDrops.length === 0 ? (
                <p className="text-emerald-700">No validation drops recorded for this run.</p>
              ) : (
                <ul className="space-y-0.5">
                  {v3Diagnostics.validationDrops.map((d, i) => (
                    <li key={`${d.field_key}-${i}`} className="rounded bg-amber-50 px-2 py-1 text-amber-800">
                      <span className="font-medium">{d.field_key}</span>{" "}
                      <span className="font-mono text-[10px]">{d.reason}</span>{" "}
                      {d.bad_value != null && <span className="text-amber-600">= {String(d.bad_value)}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded border border-slate-200 bg-white px-3 py-2">
                <div className="text-[10px] font-semibold uppercase text-slate-500">Claim Counts</div>
                <pre className="mt-1 whitespace-pre-wrap text-[11px] text-slate-700">{prettyJson(v3Diagnostics.claimCounts, 500)}</pre>
              </div>
              <div className="rounded border border-slate-200 bg-white px-3 py-2">
                <div className="text-[10px] font-semibold uppercase text-slate-500">Evidence Counts</div>
                <pre className="mt-1 whitespace-pre-wrap text-[11px] text-slate-700">{prettyJson(v3Diagnostics.evidenceCounts, 500)}</pre>
              </div>
              <div className="rounded border border-slate-200 bg-white px-3 py-2">
                <div className="text-[10px] font-semibold uppercase text-slate-500">Validation Drop Counts</div>
                <pre className="mt-1 whitespace-pre-wrap text-[11px] text-slate-700">{prettyJson(v3Diagnostics.validationDropCounts, 500)}</pre>
              </div>
              <div className="rounded border border-slate-200 bg-white px-3 py-2">
                <div className="text-[10px] font-semibold uppercase text-slate-500">Source-backed Counts</div>
                <pre className="mt-1 whitespace-pre-wrap text-[11px] text-slate-700">{prettyJson(v3Diagnostics.sourceBackedCounts, 500)}</pre>
              </div>
              <div className="rounded border border-slate-200 bg-white px-3 py-2">
                <div className="text-[10px] font-semibold uppercase text-slate-500">Evidence Sufficiency Counts</div>
                <pre className="mt-1 whitespace-pre-wrap text-[11px] text-slate-700">{prettyJson(v3Diagnostics.evidenceSufficiencyCounts, 700)}</pre>
              </div>
            </div>

            {v3Diagnostics.layoutSummary && (
              <div>
                <div className="mb-1 text-[11px] font-semibold uppercase text-slate-500">Canonical Layout Summary</div>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  {[
                    ["page_count", v3Diagnostics.layoutSummary.pageCount ?? "â€”"],
                    ["full_text_chars", v3Diagnostics.layoutSummary.fullTextChars],
                    ["text_blocks", v3Diagnostics.layoutSummary.textBlockCount],
                    ["tables", v3Diagnostics.layoutSummary.tableCount],
                    ["figures", v3Diagnostics.layoutSummary.figureCount],
                    ["signature_regions", v3Diagnostics.layoutSummary.signatureRegionCount],
                    ["page_markers_present", String(v3Diagnostics.layoutSummary.pageMarkersPresent)],
                    ["layout_provider", v3Diagnostics.layoutSummary.layoutProvider || "â€”"],
                  ].map(([key, value]) => (
                    <div key={key} className="rounded border border-slate-200 bg-white px-3 py-2">
                      <div className="text-[10px] font-semibold uppercase text-slate-500">{key.replace(/_/g, " ")}</div>
                      <div className="mt-1 text-sm font-semibold text-slate-900">{String(value)}</div>
                    </div>
                  ))}
                </div>
                {v3Diagnostics.layoutSummary.warnings.length > 0 && (
                  <p className="mt-1 text-amber-700">
                    Layout warnings: {v3Diagnostics.layoutSummary.warnings.join(", ")}
                  </p>
                )}
              </div>
            )}

            {v3Diagnostics.evidenceAnchorDiagnostics && (
              <div>
                <div className="mb-1 text-[11px] font-semibold uppercase text-slate-500">Evidence Anchor Diagnostics</div>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
                  {[
                    ["with_block_ids", v3Diagnostics.evidenceAnchorDiagnostics.withBlockIds],
                    ["with_polygon", v3Diagnostics.evidenceAnchorDiagnostics.withPolygon],
                    ["with_source_text", v3Diagnostics.evidenceAnchorDiagnostics.withSourceText],
                    ["without_source_text", v3Diagnostics.evidenceAnchorDiagnostics.withoutSourceText],
                    ["anchor_source", v3Diagnostics.evidenceAnchorDiagnostics.anchorSource],
                  ].map(([key, value]) => (
                    <div key={key} className="rounded border border-slate-200 bg-white px-3 py-2">
                      <div className="text-[10px] font-semibold uppercase text-slate-500">{key.replace(/_/g, " ")}</div>
                      <div className="mt-1 text-sm font-semibold text-slate-900">{String(value)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <details>
              <summary className="cursor-pointer text-slate-700 hover:text-slate-900">Coverage summary</summary>
              <pre className="mt-2 max-h-48 overflow-auto rounded bg-slate-50 p-2 font-mono text-[11px] text-slate-700">{prettyJson(v3Diagnostics.coverageSummary)}</pre>
            </details>
          </div>
        )}
      </Section>

      <Section title="Extraction Summary" count={`${debugSummary.dynamic_items_extracted} discovered items`}>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {Object.entries(debugSummary).map(([key, value]) => (
            <div key={key} className="rounded border border-slate-200 bg-white px-3 py-2">
              <div className="text-[10px] font-semibold uppercase text-slate-500">{key.replace(/_/g, " ")}</div>
              <div className="mt-1 text-sm font-semibold text-slate-900">{String(value ?? "-")}</div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Pipeline Stage Events" count={`${pipelineLogs.length} recent`}>
        {pipelineLogs.length === 0 ? (
          <p className="text-slate-500">No pipeline stage events have been logged for this source file yet.</p>
        ) : (
          <div className="max-h-64 overflow-auto rounded border border-slate-200">
            <table className="w-full text-[11px]">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-2 py-1 text-left">Time</th>
                  <th className="px-2 py-1 text-left">Stage</th>
                  <th className="px-2 py-1 text-left">Level</th>
                  <th className="px-2 py-1 text-left">Status</th>
                  <th className="px-2 py-1 text-left">Error</th>
                  <th className="px-2 py-1 text-left">Counts</th>
                </tr>
              </thead>
              <tbody>
                {pipelineLogs.map((log) => {
                  const metadata = log?.metadata || {};
                  return (
                    <tr key={log.id} className="border-t border-slate-100">
                      <td className="px-2 py-1 text-slate-600">{log.timestamp ? new Date(log.timestamp).toLocaleString() : "-"}</td>
                      <td className="px-2 py-1 font-medium text-slate-700">{metadata.stage || log.step || "-"}</td>
                      <td className="px-2 py-1 text-slate-600">{log.level || "-"}</td>
                      <td className="px-2 py-1 text-slate-600">{metadata.status || "-"}</td>
                      <td className="px-2 py-1 text-amber-700">{metadata.error_code || "-"}</td>
                      <td className="max-w-[280px] truncate px-2 py-1 text-slate-600" title={prettyJson(metadata, 1200)}>
                        {[
                          metadata.full_text_chars != null ? `chars=${metadata.full_text_chars}` : null,
                          metadata.page_count != null ? `pages=${metadata.page_count}` : null,
                          metadata.mapped_fields_count != null ? `mapped=${metadata.mapped_fields_count}` : null,
                          metadata.lease_clauses_count != null ? `clauses=${metadata.lease_clauses_count}` : null,
                        ].filter(Boolean).join(" ") || "-"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section
        title="Field-Level Missing Trace"
        count={`${missingTraceRows.length} missing / blocked`}
        badge={`${fieldTraceRows.length} traced`}
      >
        {fieldTraceRows.length === 0 ? (
          <p className="text-slate-500">No field_trace is stored yet. Re-run extraction to populate field-level trace.</p>
        ) : (
          <>
            <div className="grid gap-2 md:grid-cols-3">
              <div className="rounded border border-slate-200 bg-white px-3 py-2">
                <div className="text-[10px] font-semibold uppercase text-slate-500">Missing Fields</div>
                <div className="mt-1 text-sm font-semibold text-slate-900">{missingTraceRows.length}</div>
              </div>
              <div className="rounded border border-slate-200 bg-white px-3 py-2">
                <div className="text-[10px] font-semibold uppercase text-slate-500">Missing By Reason</div>
                <pre className="mt-1 whitespace-pre-wrap text-[11px] text-slate-700">{prettyJson(missingTraceByReason, 1000)}</pre>
              </div>
              <div className="rounded border border-slate-200 bg-white px-3 py-2">
                <div className="text-[10px] font-semibold uppercase text-slate-500">Unmapped LLM Keys</div>
                <pre className="mt-1 whitespace-pre-wrap text-[11px] text-slate-700">{prettyJson(debugRead("unmapped_llm_keys") || [], 1000)}</pre>
              </div>
            </div>
            <div className="max-h-80 overflow-auto rounded border border-slate-200">
              <table className="w-full text-[11px]">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-2 py-1 text-left">Field</th>
                    <th className="px-2 py-1 text-left">Reason</th>
                    <th className="px-2 py-1 text-left">Requested</th>
                    <th className="px-2 py-1 text-left">LLM Returned</th>
                    <th className="px-2 py-1 text-left">Validator</th>
                    <th className="px-2 py-1 text-left">Workflow</th>
                    <th className="px-2 py-1 text-left">Persisted</th>
                    <th className="px-2 py-1 text-left">Rendered</th>
                  </tr>
                </thead>
                <tbody>
                  {fieldTraceRows.slice(0, 80).map((trace) => (
                    <tr key={trace.field_key} className="border-t border-slate-100">
                      <td className="px-2 py-1 font-medium text-slate-700" title={trace.expected_aliases?.join(", ")}>
                        {trace.display_label || trace.field_key}
                      </td>
                      <td className="px-2 py-1 text-amber-700">{trace.final_blank_reason || "ok"}</td>
                      <td className="px-2 py-1 text-slate-600">{trace.requested_from_llm ? "yes" : "no"}</td>
                      <td className="max-w-[180px] truncate px-2 py-1 text-slate-600" title={trace.llm_source_text || ""}>
                        {trace.llm_returned_aliases?.length ? trace.llm_returned_aliases.join(", ") : "â€”"}
                      </td>
                      <td className="px-2 py-1 text-slate-600" title={trace.validator_rejection_reason || ""}>{trace.validator_status || "â€”"}</td>
                      <td className="max-w-[160px] truncate px-2 py-1 text-slate-600">{trace.workflow_value ?? "â€”"}</td>
                      <td className="max-w-[160px] truncate px-2 py-1 text-slate-600">{trace.persisted_value ?? "â€”"}</td>
                      <td className="max-w-[160px] truncate px-2 py-1 text-slate-600">{trace.resolver_value ?? "â€”"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Section>

      <Section
        title="1. Azure Document Intelligence text/layout"
        count={`${textBlocks.length} blocks`}
        badge={uploadedFile?.extraction_method || "azure_document_intelligence"}
      >
        {fileLoading ? (
          <div className="flex items-center gap-2 text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading source fileâ€¦
          </div>
        ) : !sourceFileId ? (
          <p className="text-slate-500">No source file linked to this lease.</p>
        ) : (
          <>
            <details>
              <summary className="cursor-pointer text-slate-700 hover:text-slate-900">Full text ({fullText.length.toLocaleString()} chars)</summary>
              <pre className="mt-2 max-h-72 overflow-auto rounded bg-slate-50 p-2 font-mono text-[11px] text-slate-700">{fullText || "(empty)"}</pre>
            </details>
            <details>
              <summary className="cursor-pointer text-slate-700 hover:text-slate-900">Text blocks ({textBlocks.length})</summary>
              <pre className="mt-2 max-h-72 overflow-auto rounded bg-slate-50 p-2 font-mono text-[11px] text-slate-700">{prettyJson(textBlocks.slice(0, 50))}</pre>
            </details>
            <details>
              <summary className="cursor-pointer text-slate-700 hover:text-slate-900">Azure key/value fields ({doclingFields.length})</summary>
              <pre className="mt-2 max-h-72 overflow-auto rounded bg-slate-50 p-2 font-mono text-[11px] text-slate-700">{prettyJson(doclingFields)}</pre>
            </details>
          </>
        )}
      </Section>

      <Section
        title="2. Raw extraction / OpenAI JSON"
        count={`${Object.keys(workflowOutput?.lease_fields || {}).length} lease_fields`}
      >
        {!workflowOutput ? (
          <p className="text-slate-500">No workflow_output captured on this lease yet.</p>
        ) : (
          <>
            <details open>
              <summary className="cursor-pointer text-slate-700 hover:text-slate-900">workflow_output.lease_fields</summary>
              <pre className="mt-2 max-h-72 overflow-auto rounded bg-slate-50 p-2 font-mono text-[11px] text-slate-700">{prettyJson(workflowOutput.lease_fields)}</pre>
            </details>
            <details>
              <summary className="cursor-pointer text-slate-700 hover:text-slate-900">workflow_output.expense_rules ({workflowOutput.expense_rules?.length || 0})</summary>
              <pre className="mt-2 max-h-72 overflow-auto rounded bg-slate-50 p-2 font-mono text-[11px] text-slate-700">{prettyJson(workflowOutput.expense_rules)}</pre>
            </details>
            <details>
              <summary className="cursor-pointer text-slate-700 hover:text-slate-900">workflow_output.cam_profile</summary>
              <pre className="mt-2 max-h-72 overflow-auto rounded bg-slate-50 p-2 font-mono text-[11px] text-slate-700">{prettyJson(workflowOutput.cam_profile)}</pre>
            </details>
            <details>
              <summary className="cursor-pointer text-slate-700 hover:text-slate-900">workflow_output.lease_clauses ({workflowOutput.lease_clauses?.length || 0})</summary>
              <pre className="mt-2 max-h-72 overflow-auto rounded bg-slate-50 p-2 font-mono text-[11px] text-slate-700">{prettyJson(workflowOutput.lease_clauses)}</pre>
            </details>
          </>
        )}
      </Section>

      <Section
        title="3. Normalized mapped fields (lease.extraction_data.fields)"
        count={`${Object.keys(extractionFields).length} keys`}
      >
        <pre className="max-h-72 overflow-auto rounded bg-slate-50 p-2 font-mono text-[11px] text-slate-700">{prettyJson(extractionFields)}</pre>
      </Section>

      <Section
        title="4. Review table rows (what the operator sees)"
        count={`${reviewTableRows.length} fields`}
      >
        <div className="max-h-72 overflow-auto rounded border border-slate-200">
          <table className="w-full text-[11px]">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-2 py-1 text-left">Field</th>
                <th className="px-2 py-1 text-left">Value</th>
                <th className="px-2 py-1 text-left">Conf</th>
                <th className="px-2 py-1 text-left">Page</th>
                <th className="px-2 py-1 text-left">Source Text</th>
                <th className="px-2 py-1 text-left">Status</th>
              </tr>
            </thead>
            <tbody>
              {reviewTableRows.map((row) => (
                <tr key={row.key} className="border-t border-slate-100">
                  <td className="px-2 py-1 font-medium text-slate-700">{row.label}{row.required && <span className="ml-1 text-red-500">*</span>}</td>
                  <td className="px-2 py-1 text-slate-900">{row.value == null ? "â€”" : String(row.value)}</td>
                  <td className="px-2 py-1 text-slate-600">{typeof row.confidence === "number" ? `${Math.round(row.confidence)}%` : "â€”"}</td>
                  <td className="px-2 py-1 text-slate-600">{row.sourcePage ?? "â€”"}</td>
                  <td className="max-w-[260px] truncate px-2 py-1 italic text-slate-500" title={row.sourceText ?? ""}>{row.sourceText ?? "â€”"}</td>
                  <td className="px-2 py-1 text-slate-600">{row.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section
        title="5. Field mapping warnings"
        count={validations.filter((v) => v?.pass === false).length}
      >
        {validations.length === 0 ? (
          <p className="text-slate-500">No workflow validation results.</p>
        ) : (
          <ul className="space-y-1">
            {validations.map((v, i) => (
              <li key={i} className={`rounded px-2 py-1 ${v?.pass === false ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700"}`}>
                <span className="font-mono text-[10px]">{v?.rule || "rule"}</span>{" â€” "}
                {v?.message || ""}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="6. Source matching results"
        count={`${sourceMatching.length - missingEvidence.length} of ${sourceMatching.length} have evidence`}
        badge={missingEvidence.length > 0 ? `${missingEvidence.length} missing` : "ok"}
      >
        {sourceMatching.length === 0 ? (
          <p className="text-slate-500">No fields have a value to match yet.</p>
        ) : missingEvidence.length === 0 ? (
          <p className="text-emerald-700">Every populated field has source page or source text.</p>
        ) : (
          <div>
            <p className="mb-1 text-amber-800">Fields with a value but no source evidence â€” these cannot be auto-accepted:</p>
            <ul className="space-y-0.5">
              {missingEvidence.map((row) => (
                <li key={row.key} className="rounded bg-amber-50 px-2 py-1 text-amber-800">
                  <span className="font-medium">{row.label}</span>{" "}
                  <span className="text-amber-600">= {String(row.value)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>

      <Section title="confidence_scores" count={Object.keys(confidenceScores).length}>
        <pre className="max-h-48 overflow-auto rounded bg-slate-50 p-2 font-mono text-[11px] text-slate-700">{prettyJson(confidenceScores)}</pre>
      </Section>
    </div>
  );
}







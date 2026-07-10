import React, { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, RefreshCw, Link2, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/services/supabaseClient";
import { invokeEdgeFunction } from "@/services/edgeFunctions";
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
import { mergeLatestExtraction } from "@/components/lease-review/utils/applyLatestExtractionMerge";

function prettyJson(value, limit = 4000) {
  try {
    const s = JSON.stringify(value, null, 2);
    if (!s) return "—";
    return s.length > limit ? `${s.slice(0, limit)}\n…[truncated, ${s.length - limit} more chars]` : s;
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
 *   1. Docling page text (from uploaded_files.docling_raw)
 *   2. Raw Gemini / pipeline JSON (workflow_output)
 *   3. Normalized mapped fields (extraction_data.fields)
 *   4. Review table rows (per LEASE_REVIEW_FIELDS — what the operator sees)
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
  const doclingPagesParsed = workflowOutput?.summary?.docling_pages_parsed
    ?? workflowOutput?.summary?.pages_detected
    ?? new Set(textBlocks.map((block) => block?.page ?? block?.page_number ?? block?.source_page).filter(Boolean)).size;
  const pdfPageCountTotal = workflowOutput?.summary?.pdf_page_count_total
    ?? lease?.extraction_data?.docling_raw?.page_count
    ?? null;

  // ── Vision Parser (Stage 1: PDF/image → text) ─────────────────────────
  // The parser tags its output via `extraction_method` on docling_raw —
  // "gemini_vision" or "hybrid" means Gemini Vision read the document.
  // We probe several sources because the field is set by parser.ts and
  // surfaces in different places depending on which write path ran.
  const parserSource = (
    debugRead("vision_parser_source")
    || uploadedFile?.docling_raw?.extraction_method
    || lease?.extraction_data?.docling_raw?.extraction_method
    || doclingRaw?.extraction_method
    || uploadedFile?.extraction_method
    || ""
  ).toString().toLowerCase();
  const visionParserUsed = debugRead("vision_parser_used") === true
    || parserSource === "gemini_vision"
    || parserSource === "hybrid"
    // Last-resort signal: any text block tagged with gemini_vision source.
    || textBlocks.some((b) => String(b?.source || "").toLowerCase().includes("gemini_vision"));
  const visionParserPages = debugRead("vision_parser_pages_count")
    ?? pdfPageCountTotal
    ?? doclingPagesParsed
    ?? null;
  const visionParserLabel = visionParserUsed
    ? (parserSource === "hybrid"
      ? `used (hybrid${visionParserPages ? `, ${visionParserPages} pages` : ""})`
      : `used${visionParserPages ? ` (${visionParserPages} pages)` : ""}`)
    : (parserSource ? `not used (parser: ${parserSource})` : "not used");

  // ── Vision Field Extraction (Stage 2: file bytes → LLM JSON) ──────────
  const visionTriggered = Boolean(
    debugRead("vision_field_extraction_used")
    ?? debugRead("vision_fallback_triggered")
    ?? debugRead("llm_file_mode_used"),
  );
  const fileBase64Available = debugRead("fileBase64_available");
  const weakTextDetected = debugRead("weak_text_detected");
  const llmFieldsCount = debugRead("vision_field_extraction_fields_count")
    ?? debugRead("llm_fields_extracted");
  const visionFieldSkipReason = debugRead("vision_field_extraction_skipped_reason")
    ?? debugRead("vision_fallback_skipped_reason")
    ?? (fileBase64Available === false
      ? "file_bytes_unavailable"
      : (weakTextDetected === false
        ? "parser_text_sufficient"
        : (llmFieldsCount === 0 ? "llm_returned_zero_fields" : null)));
  const visionFieldLabel = visionTriggered
    ? `used${typeof llmFieldsCount === "number" ? ` (${llmFieldsCount} fields)` : ""}`
    : (visionFieldSkipReason === "parser_text_sufficient"
      ? "not run — parser text sufficient"
      : visionFieldSkipReason === "file_bytes_unavailable"
        ? "skipped — file bytes unavailable"
        : visionFieldSkipReason === "llm_returned_zero_fields"
          ? "attempted, returned zero fields"
          : visionFieldSkipReason
            ? `skipped — ${visionFieldSkipReason}`
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
    // Headline mapping diagnostics — first so a failure is immediately visible.
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
    ui_review_payload_fields_count: debugRead("ui_review_payload_fields_count") ?? "—",
    document_profile: workflowOutput?.document_profile || workflowOutput?.summary?.document_profile || "unknown",
    selected_document_profile: workflowOutput?.selected_document_profile || workflowOutput?.summary?.selected_document_profile || workflowOutput?.document_profile || workflowOutput?.summary?.document_profile || "unknown",
    assignment_signal_count: workflowOutput?.assignment_signal_count ?? workflowOutput?.summary?.assignment_signal_count ?? 0,
    amendment_signal_count: workflowOutput?.amendment_signal_count ?? workflowOutput?.summary?.amendment_signal_count ?? 0,
    profile_detection_signals: JSON.stringify(workflowOutput?.profile_detection_signals || workflowOutput?.summary?.profile_detection_signals || {}),
    // Show both metrics so reviewers don't mistake Docling's per-page text
    // count for the actual PDF page count. Vision reads multi-page PDFs
    // natively when file bytes are sent (see vision_processed flag).
    pdf_page_count_total: pdfPageCountTotal != null ? pdfPageCountTotal : "—",
    docling_pages_parsed: doclingPagesParsed,
    // Two distinct Vision stages — keeping them separate so reviewers can
    // tell whether Gemini read the document at all (parser) from whether
    // it pulled structured fields from the bytes (field extraction).
    vision_parser: visionParserLabel,
    vision_field_extraction: visionFieldLabel,
    fixed_fields_extracted: workflowOutput?.summary?.fixed_fields_extracted ?? Object.values(workflowOutput?.lease_fields || {}).filter((field) => field?.extraction_status === "extracted").length,
    dynamic_items_extracted: workflowOutput?.summary?.dynamic_items_extracted ?? uniqueItems.length,
    dynamic_items_displayed: workflowOutput?.summary?.dynamic_items_displayed ?? uniqueItems.filter((item) => item?.creates_dynamic_row && item?.display_tab !== "clause_records").length,
    mapped_items_count: workflowOutput?.summary?.mapped_items_count ?? uniqueItems.filter((item) => item?.maps_to_fixed_field).length,
    unmapped_items_count: workflowOutput?.summary?.unmapped_items_count ?? uniqueItems.filter((item) => !item?.maps_to_fixed_field).length,
    clause_records_count: workflowOutput?.summary?.clause_records_count ?? uniqueItems.length,
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

  // ── Actions ──────────────────────────────────────────────────────────

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
        patch: applyLatestPatch,
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
                        {trace.llm_returned_aliases?.length ? trace.llm_returned_aliases.join(", ") : "—"}
                      </td>
                      <td className="px-2 py-1 text-slate-600" title={trace.validator_rejection_reason || ""}>{trace.validator_status || "—"}</td>
                      <td className="max-w-[160px] truncate px-2 py-1 text-slate-600">{trace.workflow_value ?? "—"}</td>
                      <td className="max-w-[160px] truncate px-2 py-1 text-slate-600">{trace.persisted_value ?? "—"}</td>
                      <td className="max-w-[160px] truncate px-2 py-1 text-slate-600">{trace.resolver_value ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Section>

      <Section
        title="1. Docling page text"
        count={`${textBlocks.length} blocks`}
        badge={uploadedFile?.extraction_method || "docling"}
      >
        {fileLoading ? (
          <div className="flex items-center gap-2 text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading source file…
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
              <summary className="cursor-pointer text-slate-700 hover:text-slate-900">Docling key/value fields ({doclingFields.length})</summary>
              <pre className="mt-2 max-h-72 overflow-auto rounded bg-slate-50 p-2 font-mono text-[11px] text-slate-700">{prettyJson(doclingFields)}</pre>
            </details>
          </>
        )}
      </Section>

      <Section
        title="2. Raw extraction / Gemini JSON"
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
                  <td className="px-2 py-1 text-slate-900">{row.value == null ? "—" : String(row.value)}</td>
                  <td className="px-2 py-1 text-slate-600">{typeof row.confidence === "number" ? `${Math.round(row.confidence)}%` : "—"}</td>
                  <td className="px-2 py-1 text-slate-600">{row.sourcePage ?? "—"}</td>
                  <td className="max-w-[260px] truncate px-2 py-1 italic text-slate-500" title={row.sourceText ?? ""}>{row.sourceText ?? "—"}</td>
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
                <span className="font-mono text-[10px]">{v?.rule || "rule"}</span>{" — "}
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
            <p className="mb-1 text-amber-800">Fields with a value but no source evidence — these cannot be auto-accepted:</p>
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

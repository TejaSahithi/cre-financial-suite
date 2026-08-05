import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  Eye,
  FileText,
  Loader2,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import FileUploader, { getFriendlyExtractionLabel } from "@/components/FileUploader";
import {
  ensureLeaseReviewDraftForUpload,
  getCurrentGenerationFailureNotice,
  getLeaseUploadReviewStatusLabel,
  getLeaseReviewActionState,
  hasActiveLeaseExtractionJob,
  isLeaseUploadReviewReady,
  resolveLeaseReviewIdFromUploadRecord,
} from "@/lib/leaseUploadReviewAction";
import ScopeSelector from "@/components/ScopeSelector";
import DeleteConfirmDialog from "@/components/DeleteConfirmDialog";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import useOrgQuery from "@/hooks/useOrgQuery";
import { supabase } from "@/services/supabaseClient";
import { invokeEdgeFunction } from "@/services/edgeFunctions";
import { updateLeaseExtractionField, deleteUploadedFile } from "@/services/leaseService";
import { getStoredActingOrgId } from "@/lib/actingOrg";
import { resolveWritableOrgId } from "@/lib/orgUtils";
import { getLeaseUploadPipelineState } from "@/lib/leaseUploadPipelineState";
import { createPageUrl } from "@/utils";

// Statuses that still need polling because a backend stage is in flight.
const ACTIVE_STATUSES = new Set([
  "uploaded",
  "parsing",
  "parsed",
  "pdf_parsed",
  "validating",
  "validated",
  "storing",
  "stored",
  "computing",
]);

function statusBadgeStyle(status) {
  if (status === "failed") return "bg-red-100 text-red-700";
  if (status === "completed") return "bg-emerald-100 text-emerald-700";
  if (status === "review_required") return "bg-amber-100 text-amber-800";
  return "bg-slate-100 text-slate-700";
}

const FAILURE_STAGE_LABELS = {
  upload: "Upload",
  parse: "Document parsing",
  normalize: "Normalization",
  ai_extraction: "AI extraction",
  review_draft: "Review draft",
  rule_extraction: "Expense rule extraction",
  approval: "Approval",
};

function compactText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function firstText(...values) {
  for (const value of values) {
    const text = compactText(value);
    if (text) return text;
  }
  return "";
}

function displayCode(value) {
  const text = compactText(value);
  return text ? text.replace(/_/g, " ") : "";
}

function extractPipelineMetadataFromRecord(record, reviewPayload) {
  return (
    reviewPayload?.metadata?.pipeline ||
    record?.ui_review_payload?.metadata?.pipeline ||
    record?.normalized_output?.metadata?.pipeline ||
    record?.docling_raw?._metadata?.pipeline ||
    record?.docling_raw?._metadata ||
    {}
  );
}

const MINIMAL_UPLOADED_FILE_SELECT = "id, file_name, file_url, status, error_message, row_count, org_id, created_at, updated_at";

async function fetchUploadedFileStatus(id) {
  if (!id) return { data: null, error: null };

  // Super-admin / multi-org users have no stored acting org on a fresh
  // session; without the header pipeline-status returns 400 on every call.
  // Resolve the same fallback invokeEdgeFunction uses.
  const actingOrgId = getStoredActingOrgId() || await resolveWritableOrgId(null).catch(() => null);
  const { data, error } = await supabase.functions.invoke("pipeline-status", {
    body: { file_id: id, include_details: true },
    headers: actingOrgId ? { "x-acting-org-id": actingOrgId } : {},
  });

  if (!error && data && data.error !== true) {
    return { data: normalizePipelineStatusRecord(data, id), error: null };
  }

  const fallback = await supabase
    .from("uploaded_files")
    .select(MINIMAL_UPLOADED_FILE_SELECT)
    .eq("id", id)
    .maybeSingle();

  if (!fallback.error && fallback.data) {
    return {
      data: normalizePipelineStatusRecord({
        ...fallback.data,
        file_id: fallback.data.id,
        file_metadata: fallback.data,
        schema_warnings: data?.schema_warnings || [],
        display_state: "unknown",
        message: data?.message || "Pipeline status details are temporarily unavailable.",
      }, id),
      error: null,
    };
  }

  return { data: null, error: error || fallback.error || new Error("Could not load pipeline status.") };
}

function normalizePipelineStatusRecord(data, id) {
  const fileMetadata = data?.file_metadata || {};
  const pipeline = data?.pipeline || {};
  const status = data?.status || statusFromDisplayState(data?.display_state);
  const normalizedOutput = data?.normalized_output || {};
  return {
    id: data?.id || data?.file_id || fileMetadata.id || id,
    org_id: data?.org_id || fileMetadata.org_id || null,
    file_name: data?.file_name || fileMetadata.file_name || "Lease document",
    file_url: data?.file_url || fileMetadata.file_url || null,
    lease_id: data?.lease_id || data?.leaseId || fileMetadata.lease_id || null,
    leaseId: data?.leaseId || data?.lease_id || fileMetadata.leaseId || null,
    metadata: data?.metadata || fileMetadata.metadata || null,
    extraction_data: data?.extraction_data || fileMetadata.extraction_data || null,
    status,
    processing_status: data?.processing_status || data?.display_state || null,
    failed_step: data?.failed_step || pipeline.stage || data?.latest_job?.stage || null,
    error_message: data?.error_message || data?.message || data?.latest_job?.error_message || null,
    review_required: data?.review_required ?? null,
    review_status: data?.review_status ?? null,
    document_subtype: data?.document_subtype || fileMetadata.document_subtype || null,
    extraction_method: data?.extraction_method || null,
    openai_extraction_attempted: data?.openai_extraction_attempted ?? null,
    openai_extraction_attempted_column: data?.openai_extraction_attempted_column ?? null,
    ui_review_payload: data?.ui_review_payload || null,
    reviewed_output: data?.reviewed_output || null,
    normalized_output: {
      ...normalizedOutput,
      metadata: {
        ...(normalizedOutput?.metadata || {}),
        pipeline,
      },
    },
    row_count: data?.row_count ?? null,
    property_id: data?.property_id || fileMetadata.property_id || null,
    building_id: data?.building_id || fileMetadata.building_id || null,
    unit_id: data?.unit_id || fileMetadata.unit_id || null,
    active_generation_id: data?.active_generation_id || fileMetadata.active_generation_id || null,
    review_readiness: data?.review_readiness ?? null,
    review_readiness_reasons: Array.isArray(data?.review_readiness_reasons) ? data.review_readiness_reasons : [],
    docling_summary: data?.docling_summary ?? null,
    business_extraction_debug: data?.business_extraction_debug ?? null,
    openai_fact_ledger_debug: data?.openai_fact_ledger_debug ?? null,
    updated_at: data?.updated_at || fileMetadata.updated_at || null,
    created_at: data?.created_at || fileMetadata.created_at || null,
    display_state: data?.display_state || null,
    display_message: data?.message || null,
    next_action: data?.next_action || null,
    enrichment_state: data?.enrichment_state ?? null,
    latest_job: data?.latest_job || null,
    recent_logs: data?.recent_logs || [],
    schema_warnings: data?.schema_warnings || [],
  };
}

function statusFromDisplayState(displayState) {
  switch (displayState) {
    case "queued":
      return "uploaded";
    case "parsing":
      return "parsing";
    case "normalizing":
    case "extracting":
    case "creating_review":
      return "validating";
    case "ready_for_review":
      return "review_required";
    case "blocked":
    case "failed":
      return "failed";
    default:
      return null;
  }
}

// Status-like values that should never be surfaced as error codes in the UI.
const STATUS_VALUES = new Set([
  "ready_for_review", "review_required", "parsing", "parsed", "pdf_parsed",
  "validating", "validated", "storing", "stored", "computing", "completed",
  "uploaded", "lease_extraction_queued", "pending", "queued", "running",
]);

function buildPipelineFailure(record, reviewPayload) {
  if (!record || record.status !== "failed") return null;

  const pipeline = extractPipelineMetadataFromRecord(record, reviewPayload);
  const parserStatus = firstText(pipeline.parser_status);
  const normalizeStatus = firstText(pipeline.normalize_status);
  const aiStatus = firstText(pipeline.ai_status);
  const stage = firstText(pipeline.stage, record.failed_step, record.latest_job?.stage) || "pipeline";

  // Use the job-level error_code as the most reliable source — it is set by
  // the worker (e.g. DOWNSTREAM_AUTH_FAILED) and does not confuse status
  // values like "ready_for_review" with error codes.
  const jobErrorCode = firstText(record.latest_job?.error_code);
  const pipelineErrorCode = firstText(pipeline.error_code, parserStatus, normalizeStatus, aiStatus);
  // Exclude processing_status fallback — it holds lifecycle states, not error codes.
  const rawErrorCode = jobErrorCode || pipelineErrorCode;
  const errorCode = rawErrorCode && !STATUS_VALUES.has(rawErrorCode) ? rawErrorCode : (jobErrorCode || pipelineErrorCode || "");

  const rawMessage = firstText(
    record.latest_job?.error_message,
    pipeline.error_message,
    record.error_message,
  );
  const fullTextChars = Number(pipeline.full_text_chars ?? 0);
  const pageCount = pipeline.page_count ?? null;

  let reason = rawMessage;
  let recovery = "Re-run extraction after fixing the document or backend configuration.";

  const combined = `${parserStatus} ${errorCode} ${rawMessage}`;
  if (/DOWNSTREAM_AUTH_FAILED|401|parse.*returned 401|unauthorized.*parse/i.test(combined)) {
    reason = rawMessage || "The extraction worker could not authenticate to the document parser.";
    recovery = "Ensure WORKER_INTERNAL_SECRET is set in Supabase secrets and redeploy the Edge Functions, then retry.";
  } else if (/parse_timeout|PARSE_TIMEOUT|timed out|timeout/i.test(combined)) {
    reason = "The document parser timed out before it could produce readable lease text.";
    recovery = "Upload a smaller/optimized PDF, or deploy a longer-running/background parser before retrying.";
  } else if (/EMPTY_PARSE_TEXT|parse_completed_empty_text/i.test(`${parserStatus} ${errorCode}`)) {
    reason = "The parser completed, but produced no readable lease text.";
    recovery = "Upload a text-searchable PDF or OCR-optimized copy, then re-run extraction.";
  } else if (/INSUFFICIENT_PARSE_TEXT|parse_completed_insufficient_text/i.test(`${parserStatus} ${errorCode}`)) {
    reason = `The parser produced only ${Number.isFinite(fullTextChars) ? fullTextChars : 0} readable characters, which is not enough for lease extraction.`;
    recovery = "Upload a cleaner/text-searchable lease PDF, then re-run extraction.";
  } else if (/PARSER_PROVIDER_UNAVAILABLE|No parser backend|Azure Document Intelligence|OpenAI|provider/i.test(`${errorCode} ${rawMessage}`)) {
    reason = rawMessage || "No configured parser/OCR provider is available for this document.";
    recovery = "Check Supabase secrets for Azure Document Intelligence and OpenAI, redeploy the Edge Functions, then retry.";
  } else if (/EMPTY_PARSE_TEXT|INSUFFICIENT_PARSE_TEXT/i.test(rawMessage)) {
    reason = "The document could not be parsed into readable lease text.";
    recovery = "Upload a text-searchable or OCR-optimized PDF, then re-run extraction.";
  } else if (!reason) {
    reason = "The extraction pipeline stopped before a Lease Review draft could be created.";
  }

  const stageLabel = FAILURE_STAGE_LABELS[stage] || displayCode(stage) || "Pipeline";
  return {
    stage,
    stageLabel,
    errorCode: errorCode || "PIPELINE_FAILED",
    reason,
    recovery,
    fullTextChars: Number.isFinite(fullTextChars) ? fullTextChars : null,
    pageCount,
    provider: firstText(pipeline.provider_used, record.extraction_method),
  };
}

export default function LeaseUpload() {
  const location = useLocation();
  const navigate = useNavigate();
  const urlParams = new URLSearchParams(location.search);
  const queryPropertyId = urlParams.get("property");
  const queryBuildingId = urlParams.get("building");
  const queryUnitId = urlParams.get("unit");
  const queryFileId = urlParams.get("file_id") || urlParams.get("file");

  const [scopeProperty, setScopeProperty] = useState(queryPropertyId || "all");
  const [scopeBuilding, setScopeBuilding] = useState(queryBuildingId || "all");
  const [scopeUnit, setScopeUnit] = useState(queryUnitId || "all");
  const [fileId, setFileId] = useState(queryFileId || null);
  const [fileRecord, setFileRecord] = useState(null);
  const [loadingRecord, setLoadingRecord] = useState(false);
  const [openingReview, setOpeningReview] = useState(false);
  const [retryingExtraction, setRetryingExtraction] = useState(false);
  const [deletingUpload, setDeletingUpload] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [linkedLeaseId, setLinkedLeaseId] = useState(null);
  const [leaseReviewHandoffError, setLeaseReviewHandoffError] = useState(null);
  const retriedUploadedFiles = useRef(new Set());
  const preparedLeaseDraftFiles = useRef(new Set());
  // Ref keeps the latest fileRecord status visible inside the polling interval
  // without requiring the interval to be recreated on every status change.
  const fileRecordStatusRef = useRef(null);
  const fileRecordActiveJobRef = useRef(false);

  // Keep ref in sync so polling interval always reads the latest status.
  fileRecordStatusRef.current = fileRecord?.status ?? null;
  fileRecordActiveJobRef.current = hasActiveLeaseExtractionJob(fileRecord);

  const { data: properties = [] } = useOrgQuery("Property");
  const { data: buildings = [] } = useOrgQuery("Building");
  const { data: units = [] } = useOrgQuery("Unit");

  useEffect(() => {
    let nextProperty = queryPropertyId || "all";
    let nextBuilding = queryBuildingId || "all";
    const nextUnit = queryUnitId || "all";

    const selectedUnit = queryUnitId ? units.find((unit) => unit.id === queryUnitId) : null;
    const selectedBuilding =
      (queryBuildingId ? buildings.find((building) => building.id === queryBuildingId) : null) ||
      (selectedUnit?.building_id ? buildings.find((building) => building.id === selectedUnit.building_id) : null);

    if (selectedUnit?.building_id && nextBuilding === "all") {
      nextBuilding = selectedUnit.building_id;
    }
    if (selectedUnit?.property_id && nextProperty === "all") {
      nextProperty = selectedUnit.property_id;
    }
    if (selectedBuilding?.property_id && nextProperty === "all") {
      nextProperty = selectedBuilding.property_id;
    }

    setScopeProperty(nextProperty);
    setScopeBuilding(nextBuilding);
    setScopeUnit(nextUnit);
  }, [queryPropertyId, queryBuildingId, queryUnitId, buildings, units]);

  useEffect(() => {
    if (queryFileId && queryFileId !== fileId) {
      setFileId(queryFileId);
      setFileRecord(null);
    }
  }, [queryFileId, fileId]);

  const scopedBuildings = useMemo(
    () => (scopeProperty !== "all" ? buildings.filter((building) => building.property_id === scopeProperty) : buildings),
    [buildings, scopeProperty],
  );

  const scopedUnits = useMemo(() => {
    if (scopeBuilding !== "all") {
      const buildingUnits = units.filter((unit) => unit.building_id === scopeBuilding);
      if (buildingUnits.length > 0) return buildingUnits;

      const selectedScopeBuilding = buildings.find((building) => building.id === scopeBuilding);
      const fallbackPropertyId =
        selectedScopeBuilding?.property_id || (scopeProperty !== "all" ? scopeProperty : null);
      return fallbackPropertyId ? units.filter((unit) => unit.property_id === fallbackPropertyId) : [];
    }

    if (scopeProperty !== "all") {
      return units.filter((unit) => unit.property_id === scopeProperty);
    }

    return units;
  }, [units, scopeBuilding, scopeProperty, buildings]);

  const selectedProperty = scopeProperty !== "all"
    ? properties.find((property) => property.id === scopeProperty) ?? null
    : null;
  const selectedBuilding = scopeBuilding !== "all"
    ? buildings.find((building) => building.id === scopeBuilding) ?? null
    : null;
  const selectedUnit = scopeUnit !== "all"
    ? units.find((unit) => unit.id === scopeUnit) ?? null
    : null;
  const leaseListUrl = useMemo(() => {
    const params = new URLSearchParams(location.search);
    if (fileId) params.set("view", "drafts");
    else params.delete("view");
    const search = params.toString();
    return createPageUrl("Leases") + (search ? `?${search}` : "");
  }, [fileId, location.search]);
  const effectiveBuildingId =
    selectedUnit?.building_id ||
    (scopeBuilding !== "all" ? scopeBuilding : null);
  const effectiveBuilding = effectiveBuildingId
    ? buildings.find((building) => building.id === effectiveBuildingId) ?? selectedBuilding
    : selectedBuilding;
  const effectivePropertyId =
    selectedUnit?.property_id ||
    selectedBuilding?.property_id ||
    (scopeProperty !== "all" ? scopeProperty : null);
  const effectiveProperty = effectivePropertyId
    ? properties.find((property) => property.id === effectivePropertyId) ?? selectedProperty
    : selectedProperty;
  const unitLabel = selectedUnit?.unit_number || selectedUnit?.unit_id_code || null;
  const propertyDetail = effectiveProperty
    ? [
        effectiveProperty.name,
        effectiveProperty.property_id_code ? `ID ${effectiveProperty.property_id_code}` : null,
        effectiveProperty.address || null,
      ].filter(Boolean)
    : [];
  const buildingDetail = effectiveBuilding
    ? [
        effectiveBuilding.name,
        effectiveBuilding.building_id_code ? `ID ${effectiveBuilding.building_id_code}` : null,
        effectiveBuilding.address || null,
      ].filter(Boolean)
    : [];
  const unitDetail = selectedUnit
    ? [
        unitLabel,
        selectedUnit.unit_type || null,
        selectedUnit.floor ? `Floor ${selectedUnit.floor}` : null,
      ].filter(Boolean)
    : [];

  const updateScopeParams = ({ property = scopeProperty, building = scopeBuilding, unit = scopeUnit }) => {
    const params = new URLSearchParams(location.search);
    if (property && property !== "all") params.set("property", property);
    else params.delete("property");
    if (building && building !== "all") params.set("building", building);
    else params.delete("building");
    if (unit && unit !== "all") params.set("unit", unit);
    else params.delete("unit");

    navigate({
      pathname: location.pathname,
      search: params.toString() ? `?${params.toString()}` : "",
    });
  };

  const fetchFileRecord = useCallback(async (id) => {
    if (!id) return;
    setLoadingRecord(true);
    const { data, error } = await fetchUploadedFileStatus(id);

    setLoadingRecord(false);

    if (error) {
      toast.error(`Could not load pipeline status: ${error.message}`);
      return;
    }
    setFileRecord(data);
  }, []);

  useEffect(() => {
    if (!fileId) return undefined;

    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      await fetchFileRecord(fileId);
    };

    // Initial fetch immediately on mount / fileId change.
    poll();

    // The interval reads fileRecordStatusRef.current (always up-to-date) instead
    // of closing over fileRecord?.status (stale). This also avoids recreating the
    // interval on every status update, preventing the polling cascade memory leak.
    const interval = window.setInterval(() => {
      // status alone is not enough: normalize-pdf-output can flip
      // uploaded_files.status to 'review_required' (core fields already
      // saved) WHILE the separate, deferred enrich job is still running in
      // the background. Stopping polling on status alone freezes the UI on
      // that snapshot forever -- it never learns enrich later completed or
      // failed. fileRecordActiveJobRef tracks latest_job independently of
      // status for exactly this gap.
      if (!ACTIVE_STATUSES.has(fileRecordStatusRef.current) && !fileRecordActiveJobRef.current) {
        return;
      }
      poll();
    }, 3000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
    // Only recreate when fileId changes — NOT on every status change.
  }, [fileId]);

  useEffect(() => {
    if (!fileId || fileRecord?.status !== "uploaded" || retriedUploadedFiles.current.has(fileId)) {
      return undefined;
    }

    let cancelledEffect = false;
    retriedUploadedFiles.current.add(fileId);
    const retryTimer = window.setTimeout(async () => {
      if (cancelledEffect) return;
      // A file sitting at status='uploaded' is now the awaiting-confirmation
      // state by design — it is NOT stuck, the user just hasn't clicked
      // Proceed/Cancel yet. Only auto-retry ingest-file for a file that was
      // already confirmed and somehow got stuck back at 'uploaded' (a
      // genuine pipeline hiccup), never for one still awaiting the
      // confirmation gate. If confirmed_at can't be read (e.g. the
      // migration hasn't landed in this environment yet), default to NOT
      // retrying — the whole point of this gate is to never call
      // ingest-file without positive confirmation.
      let confirmedAt = null;
      try {
        const { data: confirmRow, error: confirmCheckError } = await supabase
          .from("uploaded_files")
          .select("confirmed_at")
          .eq("id", fileId)
          .maybeSingle();
        if (confirmCheckError) throw confirmCheckError;
        confirmedAt = confirmRow?.confirmed_at ?? null;
      } catch (checkErr) {
        console.warn("[LeaseUpload] could not read confirmed_at for stuck-upload check:", checkErr?.message);
        return;
      }
      if (cancelledEffect || !confirmedAt) return;

      invokeEdgeFunction("ingest-file", {
        file_id: fileId,
        module_type: "leases",
      }, {}, { page: "LeaseUpload", action: "auto_retry" })
        .then((data) => {
          if (data?.error) {
            toast.error(data?.message || "Could not start lease extraction.");
            return;
          }
          toast.success("Lease extraction restarted.");
          fetchFileRecord(fileId);
        })
        .catch((error) => {
          toast.error(error?.message || "Could not start lease extraction.");
        });
    }, 8000);

    return () => {
      cancelledEffect = true;
      window.clearTimeout(retryTimer);
    };
  }, [fileId, fileRecord?.status]);

  const handleUploadComplete = (result) => {
    if (!result?.file_id) return;
    if (result.awaiting_confirmation) {
      // FileUploader's own Proceed/Cancel + preview prompt handles this step.
      // Do NOT setFileId yet — doing so would immediately unmount
      // FileUploader's confirmation card before the user ever sees it. This
      // page only starts tracking the file once Proceed has actually been
      // clicked and extraction has started.
      return;
    }
    setFileId(result.file_id);
    setFileRecord(null);
    if (result.processing_error) {
      toast.error(`Lease uploaded, but parsing failed: ${result.processing_error}`);
      fetchFileRecord(result.file_id);
      return;
    }
    if (result.processing_started) {
      toast.success("Lease extraction started.");
      fetchFileRecord(result.file_id);
    }
  };

  const retryExtraction = useCallback(async () => {
    if (!fileId) return;
    setRetryingExtraction(true);
    try {
      // force_reextract=true resets the file status back to 'uploaded' so the
      // pipeline FSM accepts the parsing transition even when the file is stuck
      // at 'validating' or 'parsing' (e.g. after a 546 compute-resource error).
      const data = await invokeEdgeFunction("ingest-file", {
        file_id: fileId,
        module_type: "leases",
        force_reextract: true,
      }, {}, { page: "LeaseUpload", action: "manual_retry" });

      if (data?.error) {
        toast.error(data?.message || "Could not restart extraction.");
        await fetchFileRecord(fileId);
        return;
      }

      toast.success("Extraction restarted.");
      await fetchFileRecord(fileId);
    } catch (error) {
      toast.error(error?.message || "Could not restart extraction.");
      await fetchFileRecord(fileId);
    } finally {
      setRetryingExtraction(false);
    }
  }, [fileId, fetchFileRecord]);

  // Open Lease Review for the lease draft tied to this file. The click path is
  // find-or-create: use any existing linked lease first, otherwise ask the
  // server-owned review-approve flow to prepare the draft from this upload.
  const openLeaseReview = async () => {
    if (!fileId) return;
    setOpeningReview(true);
    setLeaseReviewHandoffError(null);
    try {
      const { leaseId } = await ensureLeaseReviewDraftForUpload({
        fileId,
        fileRecord,
        linkedLeaseId,
        findLeaseByFileId,
        prepareLeaseReviewDraft: (body) => invokeEdgeFunction("review-approve", body, {}, {
          page: "LeaseUpload",
          action: "prepare_review_draft",
        }),
        linkLeaseToUploadedFile,
      });

      setLinkedLeaseId(leaseId);
      navigate(createPageUrl("LeaseReview", { id: leaseId }));
    } catch (error) {
      console.error("[LeaseUpload] Could not create Lease Review record from this upload:", error?.cause || error);
      const message = "Could not create Lease Review record from this upload.";
      setLeaseReviewHandoffError(message);
      toast.error(message);
    } finally {
      setOpeningReview(false);
    }
  };

  const handleViewDocument = async () => {
    const url = await resolveUploadedFileUrl(fileRecord);
    if (!url) {
      toast.error("Document URL is not available.");
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const handleDeleteUpload = async () => {
    if (!fileId) return;
    setDeletingUpload(true);
    try {
      await deleteUploadedFile(fileId);
      toast.success("Upload deleted.");
      setFileId(null);
      setFileRecord(null);
      setConfirmDelete(false);
    } catch (error) {
      toast.error(error?.message || "Could not delete upload");
    } finally {
      setDeletingUpload(false);
    }
  };

  const reviewPayload = fileRecord?.ui_review_payload || null;
  const reviewedRows = reviewPayload?.records || reviewPayload?.rows || [];
  const pipelineFailure = useMemo(
    () => buildPipelineFailure(fileRecord, reviewPayload),
    [fileRecord, reviewPayload],
  );
  const extractionQuality = useMemo(
    () => assessLeaseExtractionQuality(reviewedRows),
    [reviewedRows]
  );
  const hasMeaningfulExtraction = useMemo(
    () => hasMeaningfulLeaseExtraction(reviewedRows),
    [reviewedRows],
  );
  const fallbackWarnings = reviewPayload?.global_warnings || reviewPayload?.warnings || [];
  const isOpenAINotConfigured = fallbackWarnings.some((w) =>
    /openai is not configured|openai api key|no llm configured|OPENAI_API_KEY/i.test(String(w)),
  );
  const isManualReviewFallback =
    reviewPayload?.pipeline_method === "manual_review_fallback" ||
    reviewPayload?.pipeline_method === "parse_failed_manual_review" ||
    reviewPayload?.extraction_method === "manual_review_fallback" ||
    reviewPayload?.metadata?.manualReviewFallback === true ||
    reviewPayload?.metadata?.parse_failed === true;
  const isTimeoutReviewPending =
    reviewPayload?.pipeline_method === "timeout_review_pending" ||
    reviewPayload?.extraction_method === "timeout_review_pending" ||
    reviewPayload?.metadata?.timeoutReviewPending === true ||
    fallbackWarnings.some((warning) =>
      /timed out|timeout|still running|running in the background|timeout_review_pending/i.test(String(warning)),
    );
  const isEmptyExtractionFallback =
    !hasMeaningfulExtraction &&
    !isTimeoutReviewPending &&
    (
      isManualReviewFallback ||
      reviewPayload?.extraction_method === "none" ||
      reviewPayload?.pipeline_method === "fallback" ||
      fallbackWarnings.some((warning) =>
        /text is too short|no structured fields|manual review/i.test(String(warning)),
      )
    );

  useEffect(() => {
    if (
      !fileId ||
      !fileRecord ||
      !isLeaseUploadReviewReady(fileRecord) ||
      resolveLeaseReviewIdFromUploadRecord(fileRecord) ||
      preparedLeaseDraftFiles.current.has(fileId)
    ) {
      return undefined;
    }

    preparedLeaseDraftFiles.current.add(fileId);
    let cancelled = false;

    (async () => {
      try {
        const linkedLease = await findLeaseByFileId(fileId);
        if (!cancelled) setLinkedLeaseId(linkedLease?.id || null);
        if (!linkedLease?.id && !cancelled) {
          preparedLeaseDraftFiles.current.delete(fileId);
        }
      } catch (error) {
        if (!cancelled) {
          preparedLeaseDraftFiles.current.delete(fileId);
        }
        console.warn("[LeaseUpload] Could not resolve linked lease review:", error?.message || error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [fileId, fileRecord]);

  const hasActiveExtractionJob = hasActiveLeaseExtractionJob(fileRecord);
  const failed = fileRecord?.status === "failed";
  const latestJobFailed = fileRecord?.latest_job?.status === "failed";
  const latestJobOptionalEnrichFailure =
    latestJobFailed &&
    fileRecord?.latest_job?.stage === "enrich" &&
    fileRecord?.status === "review_required";

  const uploadPipelineState = useMemo(
    () => getLeaseUploadPipelineState(fileRecord),
    [fileRecord],
  );
  const isStuckInPipeline = uploadPipelineState.isLongRunning;

  const reviewReadyForAction = isLeaseUploadReviewReady(fileRecord);
  const leaseReviewAction = getLeaseReviewActionState(fileRecord, linkedLeaseId);
  const canOpenReview = leaseReviewAction.showOpenButton;
  const uploadStatusLabel = hasActiveExtractionJob
    ? getFriendlyExtractionLabel(fileRecord?.latest_job?.stage || fileRecord?.processing_status || "parsing")
    : getLeaseUploadReviewStatusLabel(
      fileRecord,
      getFriendlyExtractionLabel(fileRecord?.status),
    );
  const hasValidReviewPayload =
    reviewReadyForAction &&
    fileRecord?.ui_review_payload != null &&
    fileRecord?.status !== "failed";
  const reviewReadinessState = String(fileRecord?.review_readiness || "").toLowerCase();
  const enrichmentState = String(fileRecord?.enrichment_status || fileRecord?.enrichment_state || "").toLowerCase();
  const extractionReviewFullyReady =
    hasValidReviewPayload &&
    ["ready", "approval_ready", "complete", "completed"].includes(reviewReadinessState) &&
    !["pending", "queued", "running", "started"].includes(enrichmentState);
  const reviewPayloadNotice = extractionReviewFullyReady
    ? {
      title: "Extraction ready",
      message: "Your lease fields are ready for review.",
      className: "border-emerald-200 bg-emerald-50 text-emerald-900",
      detailClassName: "text-emerald-700",
    }
    : {
      title: "Review draft available",
      message: "Extraction produced review fields, but enrichment/readiness checks are still pending. Review can start, but approval may remain blocked until those checks finish.",
      className: "border-amber-200 bg-amber-50 text-amber-900",
      detailClassName: "text-amber-700",
    };
  const currentGenerationFailureNotice = useMemo(
    () => getCurrentGenerationFailureNotice(fileRecord),
    [fileRecord],
  );

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <Link to={leaseListUrl} className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700">
        <ArrowLeft className="h-4 w-4" /> Back to Leases
      </Link>

      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Upload Lease</h1>
        <p className="text-sm text-slate-500">
          Intake a lease document. AI extraction runs automatically; review and approval happen in Lease Review.
        </p>
      </div>

      <Card>
        <CardContent className="space-y-3 p-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Lease Scope</h2>
            <p className="text-xs text-slate-500">Choose the property, building, and unit context for this upload.</p>
          </div>
          <ScopeSelector
            properties={properties}
            buildings={scopedBuildings}
            units={scopedUnits}
            selectedProperty={scopeProperty}
            selectedBuilding={scopeBuilding}
            selectedUnit={scopeUnit}
            onPropertyChange={(value) => {
              setScopeProperty(value);
              setScopeBuilding("all");
              setScopeUnit("all");
              updateScopeParams({ property: value, building: "all", unit: "all" });
            }}
            onBuildingChange={(value) => {
              setScopeBuilding(value);
              setScopeUnit("all");
              updateScopeParams({ property: scopeProperty, building: value, unit: "all" });
            }}
            onUnitChange={(value) => {
              setScopeUnit(value);
              updateScopeParams({ property: scopeProperty, building: scopeBuilding, unit: value });
            }}
          />
          <div className="text-xs text-slate-500">
            <div className="grid gap-2 rounded-xl border border-slate-200 bg-slate-50/70 p-3 sm:grid-cols-3">
              <div className="space-y-1">
                <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">Property</div>
                <div className="font-medium text-slate-700">{effectiveProperty?.name || "All properties"}</div>
                <div className="text-[11px] text-slate-500">{propertyDetail.slice(1).join(" • ") || "No property selected"}</div>
              </div>
              <div className="space-y-1">
                <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">Building</div>
                <div className="font-medium text-slate-700">{effectiveBuilding?.name || "All buildings"}</div>
                <div className="text-[11px] text-slate-500">{buildingDetail.slice(1).join(" • ") || "No building selected"}</div>
              </div>
              <div className="space-y-1">
                <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">Unit</div>
                <div className="font-medium text-slate-700">{unitLabel || "All units"}</div>
                <div className="text-[11px] text-slate-500">{unitDetail.slice(1).join(" • ") || "No unit selected"}</div>
              </div>
            </div>
            <div className="mt-2">
              Scope:{" "}
              {[effectiveProperty?.name, effectiveBuilding?.name, unitLabel]
                .filter(Boolean)
                .join(" - ") || "No specific scope selected"}
            </div>
          </div>
        </CardContent>
      </Card>

      {!fileId && (
        <FileUploader
          defaultFileType="leases"
          allowedFileTypes={["leases"]}
          propertyId={effectivePropertyId || undefined}
          buildingId={scopeBuilding !== "all" ? scopeBuilding : undefined}
          unitId={scopeUnit !== "all" ? scopeUnit : undefined}
          multiple={false}
          onUploadComplete={handleUploadComplete}
          onOpenReview={openLeaseReview}
          title="Upload Lease Document"
          description="Upload a base lease, amendment, assignment, consent, extension, or addendum. Scanned PDFs are processed server-side with OCR."
        />
      )}

      {fileId && (
        <Card>
          <CardContent className="space-y-4 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100">
                  <FileText className="h-5 w-5 text-slate-500" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-slate-900">{fileRecord?.file_name || "Lease document"}</p>
                  <p className="text-xs text-slate-500">File ID: {fileId}</p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {loadingRecord && <Loader2 className="h-4 w-4 animate-spin text-slate-400" />}
                <Badge className={statusBadgeStyle(fileRecord?.status)}>
                  {uploadStatusLabel}
                </Badge>
                {fileRecord?.document_subtype && (
                  <Badge className="bg-blue-50 text-blue-700">{fileRecord.document_subtype.replace(/_/g, " ")}</Badge>
                )}
                {reviewReadyForAction && (
                  <Badge className="bg-amber-100 text-amber-800">Review Required</Badge>
                )}
              </div>
            </div>

            {hasValidReviewPayload && !hasActiveExtractionJob && (
              <div className={`rounded-lg border p-3 ${reviewPayloadNotice.className}`}>
                <p className="text-sm font-medium">{reviewPayloadNotice.title}</p>
                <p className={`text-xs ${reviewPayloadNotice.detailClassName}`}>{reviewPayloadNotice.message}</p>
              </div>
            )}

            {currentGenerationFailureNotice.show && (
              <div className="rounded-lg border border-orange-200 bg-orange-50 p-3">
                <p className="text-sm font-medium text-orange-900">New extraction attempt failed</p>
                <p className="text-xs text-orange-700">{currentGenerationFailureNotice.message}</p>
              </div>
            )}

            <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-3">
              {canOpenReview && (
                <Button
                  onClick={openLeaseReview}
                  disabled={openingReview}
                  size="sm"
                  className="bg-teal-600 hover:bg-teal-700"
                >
                  {openingReview && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  <ExternalLink className="mr-2 h-4 w-4" />
                  Open Lease Review
                </Button>
              )}
              <Button
                onClick={retryExtraction}
                disabled={retryingExtraction}
                size="sm"
                variant="outline"
              >
                {retryingExtraction ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" />
                )}
                Re-run Extraction
              </Button>
              <Button
                onClick={handleViewDocument}
                disabled={!fileRecord?.file_url}
                size="sm"
                variant="outline"
              >
                <Eye className="mr-2 h-4 w-4" />
                View Document
              </Button>
              <Button
                onClick={() => setConfirmDelete(true)}
                disabled={deletingUpload}
                size="sm"
                variant="outline"
                className="border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700"
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Delete Upload
              </Button>
            </div>

            {leaseReviewHandoffError && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-700">
                {leaseReviewHandoffError}
              </div>
            )}

          </CardContent>
        </Card>
      )}

      {fileId && (
        <Card>
          <CardContent className="p-4">
            <h3 className="text-sm font-semibold text-slate-900">Processing Status</h3>
            <p className="mt-1 text-sm font-medium text-blue-600">
              {uploadStatusLabel}
            </p>
            {uploadPipelineState.isWaiting && (
              <div className="mt-2 grid gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600 sm:grid-cols-3">
                <div>
                  <div className="font-semibold uppercase tracking-wide text-slate-400">Current stage</div>
                  <div className="mt-0.5 font-medium text-slate-700">{displayCode(uploadPipelineState.stage) || "Processing"}</div>
                </div>
                <div>
                  <div className="font-semibold uppercase tracking-wide text-slate-400">Last update</div>
                  <div className="mt-0.5 font-medium text-slate-700">
                    {uploadPipelineState.elapsedLabel ? `${uploadPipelineState.elapsedLabel} ago` : "Waiting for first update"}
                  </div>
                </div>
                <div>
                  <div className="font-semibold uppercase tracking-wide text-slate-400">Backend action</div>
                  <div className="mt-0.5 font-medium text-slate-700">{fileRecord?.next_action || "wait"}</div>
                </div>
              </div>
            )}
            <details className="mt-3 text-xs text-slate-400">
              <summary className="cursor-pointer select-none">Advanced</summary>
              <div className="mt-1 space-y-0.5 pl-2">
                <p>status: {fileRecord?.status ?? "—"}</p>
                <p>processing_status: {fileRecord?.processing_status ?? "—"}</p>
                <p>current_stage: {uploadPipelineState.stage ?? "—"}</p>
                <p>latest_job: {fileRecord?.latest_job?.status ?? "—"}</p>
                <p>enrichment_status: {fileRecord?.enrichment_state ?? "—"}</p>
                <p>failed_step: {failed ? fileRecord?.failed_step ?? "—" : "—"}</p>
                <p>error_message: {failed ? fileRecord?.error_message ?? "—" : "—"}</p>
                {latestJobFailed && (
                  <>
                    <p>latest_job_error_code: {latestJobOptionalEnrichFailure ? "OPTIONAL_ENRICHMENT_PARTIAL" : fileRecord?.latest_job?.error_code ?? "—"}</p>
                    <p>latest_job_error_message: {latestJobOptionalEnrichFailure ? "Core extraction is review-ready; optional enrichment hit compute limits and should be rerun through bounded enrichment." : fileRecord?.latest_job?.error_message ?? "—"}</p>
                  </>
                )}
                {fileRecord?.docling_summary && (
                  <>
                    <p>azure_page_count: {fileRecord.docling_summary.page_count ?? "—"}</p>
                    <p>azure_paragraph_count: {fileRecord.docling_summary.paragraph_count ?? "—"}</p>
                    <p>azure_table_count: {fileRecord.docling_summary.table_count ?? "—"}</p>
                    <p>azure_content_length: {fileRecord.docling_summary.content_length ?? "—"}</p>
                    <p>azure_raw_response_stored: {String(fileRecord.docling_summary.raw_response_stored ?? "—")}</p>
                  </>
                )}
                <p>active_generation: {fileRecord?.active_generation_id ?? "—"}</p>
                <p>
                  latest_job_generation: {fileRecord?.latest_job?.generation_id ?? "—"}
                  {currentGenerationFailureNotice.show ? " (current — failed)" : ""}
                </p>
                <p>parser_method: {fileRecord?.business_extraction_debug?.parser_method ?? fileRecord?.extraction_method ?? "—"}</p>
                {fileRecord?.business_extraction_debug && (
                  <>
                    <p>business_requested_provider: {fileRecord.business_extraction_debug.requested_provider ?? "—"}</p>
                    <p>business_effective_provider: {fileRecord.business_extraction_debug.effective_provider ?? "—"}</p>
                    <p>business_acceptance_state: {fileRecord.business_extraction_debug.acceptance_state ?? "—"}</p>
                    <p>business_fallback_used: {String(fileRecord.business_extraction_debug.fallback_used ?? "—")}</p>
                    <p>openai_primary_attempted: {String(fileRecord.business_extraction_debug.openai_attempted ?? "—")}</p>
                    <p>openai_attempt_count: {fileRecord.business_extraction_debug.openai_attempt_count ?? "—"}</p>
                    {fileRecord.business_extraction_debug.stale_attempt_column && (
                      <p className="text-amber-600">
                        openai_attempt_column_stale: db column is false, durable payload shows OpenAI evidence
                      </p>
                    )}
                  </>
                )}
                {fileRecord?.openai_fact_ledger_debug && (
                  <>
                    <p>openai_document_profile: {fileRecord.openai_fact_ledger_debug.document_profile ?? "—"}</p>
                    <p>openai_extraction_mode: {fileRecord.openai_fact_ledger_debug.extraction_mode ?? "—"}</p>
                    <p>openai_architecture: {fileRecord.openai_fact_ledger_debug.architecture ?? "—"}</p>
                    <p>openai_authoritative: {String(fileRecord.openai_fact_ledger_debug.authoritative ?? "—")}</p>
                    <p>typescript_field_mapping_used: {String(fileRecord.openai_fact_ledger_debug.typescript_field_mapping_used ?? "—")}</p>
                    <p>openai_llm_call_count: {fileRecord.openai_fact_ledger_debug.llm_call_count ?? "—"}</p>
                    <p>openai_facts_extracted_count: {fileRecord.openai_fact_ledger_debug.facts_extracted_count ?? "—"}</p>
                    <p>openai_standard_fields_mapped_from_facts: {fileRecord.business_extraction_debug?.standard_fields_mapped_from_facts_count ?? fileRecord.openai_fact_ledger_debug.facts_mapped_count ?? "—"}</p>
                    <p>openai_standard_field_per_fact_ratio: {fileRecord.business_extraction_debug?.standard_field_per_fact_ratio ?? "—"}</p>
                    <p>openai_mapped_non_null_field_count: {fileRecord.openai_fact_ledger_debug.mapped_non_null_field_count ?? "—"}</p>
                    <p>openai_unmapped_fact_count: {fileRecord.business_extraction_debug?.unmapped_fact_count ?? fileRecord.openai_fact_ledger_debug.facts_unmapped_count ?? "—"}</p>
                    {fileRecord.business_extraction_debug?.fact_counter_note && (
                      <p>{fileRecord.business_extraction_debug.fact_counter_note}</p>
                    )}
                    <p>openai_invalid_or_omitted_claim_count: {fileRecord.openai_fact_ledger_debug.invalid_or_omitted_claim_count ?? "—"}</p>
                    <p>openai_failure_classification: {fileRecord.openai_fact_ledger_debug.failure_classification ?? "—"}</p>
                    <p>openai_failure_http_status: {fileRecord.openai_fact_ledger_debug.failure_http_status ?? "—"}</p>
                  </>
                )}
                <p>review_readiness: {fileRecord?.review_readiness ?? "—"}</p>
                {fileRecord?.review_readiness_reasons?.length > 0 && (
                  <p>review_readiness_reasons: {fileRecord.review_readiness_reasons.join(", ")}</p>
                )}
              </div>
            </details>
            {Array.isArray(fileRecord?.recent_logs) && fileRecord.recent_logs.length > 0 && (
              <details className="mt-3 text-xs text-slate-400">
                <summary className="cursor-pointer select-none">Pipeline Logs</summary>
                <div className="mt-1 space-y-1.5 pl-2">
                  {fileRecord.recent_logs.map((log, index) => (
                    <div key={`${log.created_at || index}-${log.stage || index}`} className="border-l-2 border-slate-200 pl-2">
                      <p className="font-medium text-slate-600">
                        {log.stage || "—"} · {log.status || "—"}
                        {log.error_code ? ` · ${displayCode(log.error_code)}` : ""}
                      </p>
                      {(log.message || log.error_message) && (
                        <p className="text-slate-500">{log.error_message || log.message}</p>
                      )}
                    </div>
                  ))}
                </div>
              </details>
            )}
            {failed && (
              <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                <div className="font-medium">
                  {pipelineFailure?.stageLabel || "Pipeline"} failed
                  {pipelineFailure?.errorCode ? `: ${displayCode(pipelineFailure.errorCode)}` : ""}
                </div>
                <div className="mt-1 text-xs text-red-600">
                  {pipelineFailure?.reason || "The extraction pipeline stopped before a Lease Review draft could be created."}
                </div>
              </div>
            )}
            {isStuckInPipeline && !failed && (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                <span>
                  {uploadPipelineState.message || "Extraction is taking longer than usual."} {" "}Click <strong>Re-run Extraction</strong> to reset and retry.
                </span>
                <Button
                  size="sm"
                  onClick={retryExtraction}
                  disabled={retryingExtraction}
                  className="shrink-0 bg-amber-600 text-white hover:bg-amber-700"
                >
                  {retryingExtraction ? (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-1 h-3.5 w-3.5" />
                  )}
                  Re-run Extraction
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {fileRecord?.status === "failed" && (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="flex flex-wrap items-start justify-between gap-3 p-4 text-sm text-red-700">
            <div className="max-w-3xl space-y-1">
              <div className="font-medium">
                {pipelineFailure?.stageLabel || "Pipeline"} failed
                {pipelineFailure?.errorCode ? `: ${displayCode(pipelineFailure.errorCode)}` : ""}
              </div>
              <div>{pipelineFailure?.reason || fileRecord.error_message || "Processing failed."}</div>
              {pipelineFailure?.recovery && (
                <div className="text-xs text-red-600">{pipelineFailure.recovery}</div>
              )}
              {(pipelineFailure?.fullTextChars != null || pipelineFailure?.pageCount || pipelineFailure?.provider) && (
                <div className="text-xs text-red-500">
                  {[
                    pipelineFailure?.provider ? `provider: ${pipelineFailure.provider}` : null,
                    pipelineFailure?.pageCount ? `pages: ${pipelineFailure.pageCount}` : null,
                    pipelineFailure?.fullTextChars != null ? `readable chars: ${pipelineFailure.fullTextChars}` : null,
                  ].filter(Boolean).join(" | ")}
                </div>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={retryExtraction}
              disabled={retryingExtraction}
              className="border-red-200 bg-white text-red-700 hover:bg-red-100"
            >
              {retryingExtraction && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Retry extraction
            </Button>
          </CardContent>
        </Card>
      )}

      {fileRecord?.status === "review_required" && isEmptyExtractionFallback && (
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm text-amber-800">
            <span>
              {isOpenAINotConfigured
                ? "AI extraction is unavailable - OpenAI is not configured. Set OPENAI_API_KEY in your Supabase project secrets, then retry. You can also open Lease Review to fill fields manually."
                : isManualReviewFallback
                  ? (() => {
                      const reason = fallbackWarnings.find((w) =>
                        w && !String(w).toLowerCase().includes("automatic extraction did not finish"),
                      );
                      return reason
                        ? `Extraction pipeline failed: ${String(reason).slice(0, 200)}. Check Supabase edge function logs for details, or open Lease Review to fill fields manually.`
                        : "Extraction pipeline failed. Check Supabase edge function logs, or open Lease Review to fill fields manually.";
                    })()
                  : "Automatic extraction did not return mapped values for this file. Retry extraction to use the latest parser fix, or open Lease Review to continue manually."}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={retryExtraction}
              disabled={retryingExtraction}
              className="border-amber-200 bg-white text-amber-800 hover:bg-amber-100"
            >
              {retryingExtraction && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Retry automatic extraction
            </Button>
          </CardContent>
        </Card>
      )}

      {fileRecord?.status === "review_required" && !isEmptyExtractionFallback && extractionQuality.suspicious && (
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm text-amber-800">
            <span>
              This extraction looks stale or misparsed: {extractionQuality.reasons.join("; ")}.
              Retry extraction to rebuild the review payload with the latest parser fix.
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={retryExtraction}
              disabled={retryingExtraction}
              className="border-amber-200 bg-white text-amber-800 hover:bg-amber-100"
            >
              {retryingExtraction && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Retry automatic extraction
            </Button>
          </CardContent>
        </Card>
      )}

      {fileRecord?.status === "completed" && (
        <Card className="border-emerald-200 bg-emerald-50">
          <CardContent className="flex items-center gap-2 p-4 text-sm text-emerald-700">
            <CheckCircle2 className="h-4 w-4" />
            Lease data was stored. Continue in Lease Review to verify and approve the lease abstract.
          </CardContent>
        </Card>
      )}

      <DeleteConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this lease upload?"
        description="This removes the uploaded file record. Any downstream lease draft created from it will remain — delete it separately from the Leases list if needed."
        confirmLabel="Delete upload"
        loading={deletingUpload}
        onConfirm={handleDeleteUpload}
      />
    </div>
  );
}

async function linkLeaseToUploadedFile(leaseId, fileRecord) {
  if (!leaseId || !fileRecord?.id) return null;

  const sourceFileId = fileRecord.id;
  const { data: lease, error: fetchError } = await supabase
    .from("leases")
    .select("id, source_file_id, extraction_data")
    .eq("id", leaseId)
    .maybeSingle();

  if (fetchError) {
    console.warn("[LeaseUpload] Could not inspect Lease Review source link:", fetchError.message);
  }


  const extractionSourceFileId = lease?.source_file_id || lease?.extraction_data?.source_file_id || null;
  if (extractionSourceFileId !== sourceFileId) {
    try {
      await updateLeaseExtractionField({
        leaseId,
        fieldArea: "source_link",
        action: "source_file_linked_on_upload",
        patch: {
          source_file_id: sourceFileId,
          source_file_name: fileRecord.file_name ?? null,
          document_subtype: fileRecord.document_subtype ?? null,
          source_file_linked_at: new Date().toISOString(),
        },
      });
    } catch (error) {
      console.warn("[LeaseUpload] Could not refresh extraction_data source link:", error?.message || error);
    }
  }

  return leaseId;
}


async function findLeaseByFileId(fileId) {
  if (!fileId) return null;

  const attempts = [
    (query) => query.eq("source_file_id", fileId),
    (query) => query.filter("extraction_data->>source_file_id", "eq", fileId),
    (query) => query.filter("extraction_data->>uploaded_file_id", "eq", fileId),
  ];

  for (const applyFilter of attempts) {
    const query = supabase
      .from("leases")
      .select("id, source_file_id, extraction_data")
      .order("updated_at", { ascending: false })
      .limit(1);
    const { data, error } = await applyFilter(query).maybeSingle();
    if (!error && data?.id) return data;
  }

  const { data: link, error: linkError } = await supabase
    .from("document_links")
    .select("entity_id")
    .eq("file_id", fileId)
    .eq("entity_type", "lease")
    .in("link_role", ["source", "source_file"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!linkError && link?.entity_id) return { id: link.entity_id };

  return null;
}

function getRecordValue(record, key) {
  if (record?.values && Object.prototype.hasOwnProperty.call(record.values, key)) return record.values[key];
  const standard = record?.standard_fields?.find?.((field) => field.field_key === key);
  if (standard) return standard.value;
  const custom = record?.custom_fields?.find?.((field) => field.field_key === key);
  if (custom) return custom.value;
  const field = record?.fields?.[key];
  if (field && typeof field === "object" && "value" in field) return field.value;
  return field;
}

function assessLeaseExtractionQuality(records) {
  const first = records?.[0] || null;
  if (!first) {
    return { suspicious: false, reasons: [] };
  }

  const reasons = [];
  const tenantName = String(getRecordValue(first, "tenant_name") || "").trim();
  const propertyName = String(getRecordValue(first, "property_name") || "").trim();
  const propertyAddress = String(getRecordValue(first, "property_address") || "").trim();
  const customFields = Array.isArray(first.custom_fields) ? first.custom_fields : [];

  if (/^(signature|date)\s*:/i.test(tenantName)) {
    reasons.push("tenant name was filled with signature/date text");
  }

  if (propertyAddress && /^\d{1,3}$/.test(propertyName)) {
    reasons.push("property name was reduced to a table row number");
  }

  const noisyCustomFieldCount = customFields.filter((field) =>
    /^(https|before_move|total_due_before_move|garage_space_g|the_lease_begins_at_12|rent_received_after_5|fixed_term_lease)$/i
      .test(String(field?.field_key || "")),
  ).length;

  if (noisyCustomFieldCount >= 2) {
    reasons.push("legacy table fragments were saved as custom fields");
  }

  if ((records?.length || 0) > 1) {
    reasons.push("multiple lease records were created from one document");
  }

  return {
    suspicious: reasons.length > 0,
    reasons,
  };
}

function hasMeaningfulLeaseExtraction(records) {
  return (records || []).some((record) =>
    Object.values(getComparableRecordValues(record)).some((value) => isMeaningfulLeaseValue(value)),
  );
}

function getComparableRecordValues(record) {
  if (record?.values && typeof record.values === "object") return record.values;

  const fieldEntries = [
    ...(Array.isArray(record?.standard_fields) ? record.standard_fields : []),
    ...(Array.isArray(record?.custom_fields) ? record.custom_fields : []),
  ]
    .filter((field) => field?.field_key)
    .map((field) => [field.field_key, field.value]);

  return Object.fromEntries(fieldEntries);
}

function isMeaningfulLeaseValue(value) {
  if (value == null) return false;
  if (typeof value === "number") return Number.isFinite(value) && value !== 0;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.some((item) => isMeaningfulLeaseValue(item));
  if (typeof value === "object") return Object.values(value).some((item) => isMeaningfulLeaseValue(item));

  const text = String(value).trim();
  if (!text) return false;
  if (/^(n\/a|na|null|none|unknown|tbd|lease review draft)$/i.test(text)) return false;
  return true;
}


async function resolveUploadedFileUrl(fileRecord) {
  if (!fileRecord) return null;

  const storagePath = deriveFinancialUploadPath(fileRecord);
  if (storagePath) {
    const { data, error } = await supabase.storage
      .from("financial-uploads")
      .createSignedUrl(storagePath, 60 * 60);

    if (!error && data?.signedUrl) {
      return data.signedUrl;
    }
  }

  return fileRecord.file_url || null;
}

function deriveFinancialUploadPath(fileRecord) {
  const rawUrl = String(fileRecord?.file_url || "");
  const publicPrefix = "/storage/v1/object/public/financial-uploads/";
  const signPrefix = "/storage/v1/object/sign/financial-uploads/";

  const publicIndex = rawUrl.indexOf(publicPrefix);
  if (publicIndex >= 0) {
    return rawUrl.slice(publicIndex + publicPrefix.length).split("?")[0];
  }

  const signIndex = rawUrl.indexOf(signPrefix);
  if (signIndex >= 0) {
    return rawUrl.slice(signIndex + signPrefix.length).split("?")[0];
  }

  if (fileRecord?.org_id && fileRecord?.id) {
    return `${fileRecord.org_id}/${fileRecord.id}`;
  }

  return null;
}

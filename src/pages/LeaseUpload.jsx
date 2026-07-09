import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
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
import FileUploader from "@/components/FileUploader";
import ScopeSelector from "@/components/ScopeSelector";
import DeleteConfirmDialog from "@/components/DeleteConfirmDialog";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { clearCache } from "@/services/api";
import { leaseService, deleteUploadedFile } from "@/services/leaseService";
import useOrgQuery from "@/hooks/useOrgQuery";
import { supabase } from "@/services/supabaseClient";
import { invokeEdgeFunction } from "@/services/edgeFunctions";
import { getStoredActingOrgId } from "@/lib/actingOrg";
import { cleanSourceEvidenceText } from "@/lib/leaseReviewSchema";
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

// Visual processing pipeline shown to the user.
const PIPELINE_STAGES = [
  { key: "uploaded", label: "Uploaded" },
  { key: "ocr", label: "OCR Processing" },
  { key: "text_extracted", label: "Text Extracted" },
  { key: "ai_extracting", label: "AI Extracting" },
  { key: "ai_extracted", label: "AI Extracted" },
  { key: "needs_review", label: "Needs Review" },
];

// Map raw uploaded_files.status to a stepper position.
function pipelineProgress(status) {
  switch (status) {
    case "uploaded":
      return { activeIndex: 0, failed: false };
    case "parsing":
      return { activeIndex: 1, failed: false };
    case "parsed":
    case "pdf_parsed":
      return { activeIndex: 2, failed: false };
    case "validating":
      return { activeIndex: 3, failed: false };
    case "validated":
    case "storing":
    case "stored":
    case "computing":
      return { activeIndex: 4, failed: false };
    case "review_required":
    case "completed":
      return { activeIndex: 5, failed: false };
    case "failed":
      return { activeIndex: -1, failed: true };
    default:
      return { activeIndex: 0, failed: false };
  }
}

function statusBadgeStyle(status) {
  if (status === "failed") return "bg-red-100 text-red-700";
  if (status === "completed") return "bg-emerald-100 text-emerald-700";
  if (status === "review_required") return "bg-amber-100 text-amber-800";
  return "bg-slate-100 text-slate-700";
}

function statusLabelFor(status) {
  if (!status) return "Waiting";
  if (status === "review_required") return "Needs Review";
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
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

  const actingOrgId = getStoredActingOrgId();
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
  return {
    id: data?.id || data?.file_id || fileMetadata.id || id,
    org_id: data?.org_id || fileMetadata.org_id || null,
    file_name: data?.file_name || fileMetadata.file_name || "Lease document",
    file_url: data?.file_url || fileMetadata.file_url || null,
    status: data?.status || statusFromDisplayState(data?.display_state),
    processing_status: data?.processing_status || data?.display_state || null,
    failed_step: data?.failed_step || pipeline.stage || data?.latest_job?.stage || null,
    error_message: data?.error_message || data?.message || data?.latest_job?.error_message || null,
    review_required: data?.review_required ?? null,
    review_status: data?.review_status ?? null,
    document_subtype: data?.document_subtype || fileMetadata.document_subtype || null,
    extraction_method: data?.extraction_method || null,
    ui_review_payload: data?.ui_review_payload || null,
    reviewed_output: data?.reviewed_output || null,
    normalized_output: { metadata: { pipeline } },
    row_count: data?.row_count ?? null,
    property_id: data?.property_id || fileMetadata.property_id || null,
    building_id: data?.building_id || fileMetadata.building_id || null,
    unit_id: data?.unit_id || fileMetadata.unit_id || null,
    updated_at: data?.updated_at || fileMetadata.updated_at || null,
    created_at: data?.created_at || fileMetadata.created_at || null,
    display_state: data?.display_state || null,
    display_message: data?.message || null,
    next_action: data?.next_action || null,
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
  } else if (/PARSER_PROVIDER_UNAVAILABLE|No parser backend|Docling|Vertex|provider/i.test(`${errorCode} ${rawMessage}`)) {
    reason = rawMessage || "No configured parser/OCR provider is available for this document.";
    recovery = "Check Supabase secrets for Docling or Vertex/Gemini, redeploy the Edge Functions, then retry.";
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
  const queryClient = useQueryClient();
  const urlParams = new URLSearchParams(location.search);
  const queryPropertyId = urlParams.get("property");
  const queryBuildingId = urlParams.get("building");
  const queryUnitId = urlParams.get("unit");

  const [scopeProperty, setScopeProperty] = useState(queryPropertyId || "all");
  const [scopeBuilding, setScopeBuilding] = useState(queryBuildingId || "all");
  const [scopeUnit, setScopeUnit] = useState(queryUnitId || "all");
  const [fileId, setFileId] = useState(null);
  const [fileRecord, setFileRecord] = useState(null);
  const [loadingRecord, setLoadingRecord] = useState(false);
  const [openingReview, setOpeningReview] = useState(false);
  const [retryingExtraction, setRetryingExtraction] = useState(false);
  const [deletingUpload, setDeletingUpload] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const retriedUploadedFiles = useRef(new Set());
  const retriedManualFallbackFiles = useRef(new Set());
  const preparedLeaseDraftFiles = useRef(new Set());
  // Ref keeps the latest fileRecord status visible inside the polling interval
  // without requiring the interval to be recreated on every status change.
  const fileRecordStatusRef = useRef(null);

  // Keep ref in sync so polling interval always reads the latest status.
  fileRecordStatusRef.current = fileRecord?.status ?? null;

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

  const invalidateLeaseQueries = async () => {
    clearCache();
    await queryClient.invalidateQueries({ queryKey: ["Lease"] });
  };

  // Accept an explicit snapshot to avoid stale-closure issues in effects.
  const ensureLeaseDraft = async ({ silent = false, record: recordOverride } = {}) => {
    if (!fileId) return null;

    // Use the caller-supplied snapshot when provided; fall back to state.
    const record = recordOverride ?? fileRecord;

    const existing = await findLeaseByFileId(fileId);
    if (existing?.id) {
      await invalidateLeaseQueries();
      return existing.id;
    }

    // Statuses where the file has been processed enough that a lease draft is
    // either already expected or can be safely manufactured client-side.
    const fileIsReady =
      record?.review_required === true ||
      ["review_required", "validated", "approved", "storing", "stored", "computing", "completed"].includes(record?.status || "");

    if (!fileIsReady) {
      return null;
    }

    let data = null;
    let edgeFailed = false;
    let edgeError = null;
    try {
      data = await invokeEdgeFunction("review-approve", {
        file_id: fileId,
        action: "prepare",
        review_payload: record?.ui_review_payload || null,
      });
    } catch (prepareErr) {
      if (!isUnsupportedPrepareAction(prepareErr)) {
        edgeFailed = true;
        edgeError = prepareErr;
      } else {
        try {
          data = await invokeEdgeFunction("review-approve", {
            file_id: fileId,
            action: "approve",
            review_payload: record?.ui_review_payload || null,
          });
        } catch (approveErr) {
          edgeFailed = true;
          edgeError = approveErr;
        }
      }
    }

    if (!edgeFailed) {
      const insertedLeaseId =
        data?.store_result?.inserted_ids?.[0] ||
        data?.store_result?.insertedIds?.[0] ||
        null;

      await fetchFileRecord(fileId);
      const linkedLeaseId = insertedLeaseId || (await findLeaseByFileId(fileId))?.id || null;
      if (linkedLeaseId) {
        await ensureLeaseSourceFileLink(linkedLeaseId, record || { id: fileId });
        await invalidateLeaseQueries();
        return linkedLeaseId;
      }
    }

    // Client-side fallback. If review-approve isn't usable on this deployment
    // (older function, schema drift, or any 4xx), create the lease row
    // directly from the reviewed UI payload so the user can still open Lease
    // Review and edit fields. This is the same shape review-approve would
    // produce on the happy path.
    try {
      const fallbackLeaseId = await createLeaseDraftFromUploadedFile(fileId, record);
      if (fallbackLeaseId) {
        await invalidateLeaseQueries();
        await fetchFileRecord(fileId);
        return fallbackLeaseId;
      }
    } catch (fallbackErr) {
      console.warn("[LeaseUpload] client-side lease draft fallback failed:", fallbackErr?.message || fallbackErr);
    }

    if (edgeError && !silent) {
      toast.error(edgeError?.message || "Could not prepare lease review draft.");
    } else if (!silent) {
      toast.info("Lease review draft is being prepared. Try again in a moment.");
    }
    return null;
  };

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
      if (!ACTIVE_STATUSES.has(fileRecordStatusRef.current)) {
        return;
      }
      poll();
    }, 3000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
    // Only recreate when fileId changes — NOT on every status change.
  }, [fileId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!fileId || fileRecord?.status !== "uploaded" || retriedUploadedFiles.current.has(fileId)) {
      return undefined;
    }

    retriedUploadedFiles.current.add(fileId);
    const retryTimer = window.setTimeout(() => {
      invokeEdgeFunction("ingest-file", {
        file_id: fileId,
        module_type: "leases",
      })
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

    return () => window.clearTimeout(retryTimer);
  }, [fileId, fileRecord?.status]);

  const handleUploadComplete = (result) => {
    if (!result?.file_id) return;
    setFileId(result.file_id);
    setFileRecord(null);
    if (result.processing_error) {
      toast.error(`Lease uploaded, but parsing failed: ${result.processing_error}`);
      fetchFileRecord(result.file_id);
      return;
    }
    toast.success("Lease uploaded. The extraction pipeline is running.");
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
      });

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

  // Open Lease Review for the lease draft tied to this file. If a draft does
  // not yet exist, send the existing extraction to the review pipeline (which
  // creates the lease draft on the backend) and then navigate. The actual
  // approval still happens in Lease Review — this just promotes the raw AI
  // output into a reviewable draft, per the upgraded workflow.
  const openLeaseReview = async () => {
    if (!fileId) return;
    setOpeningReview(true);
    try {
      const leaseId = await ensureLeaseDraft({ record: fileRecord });
      if (leaseId) {
        navigate(createPageUrl("LeaseReview", { id: leaseId }));
      } else {
        toast.info("Lease review draft is still being prepared. Try again in a moment.");
      }
    } catch (error) {
      toast.error(error?.message || "Could not open Lease Review");
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
  const isVertexNotConfigured = fallbackWarnings.some((w) =>
    /vertex ai is not fully configured|no llm configured|VERTEX_PROJECT_ID|GOOGLE_SERVICE_ACCOUNT/i.test(String(w)),
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
      fileRecord.status !== "review_required" ||
      fileRecord.review_required !== true ||
      preparedLeaseDraftFiles.current.has(fileId)
    ) {
      return undefined;
    }

    preparedLeaseDraftFiles.current.add(fileId);
    let cancelled = false;

    // Capture the current fileRecord snapshot so the async call doesn't
    // read stale state from a re-render that fires mid-execution.
    const capturedRecord = fileRecord;
    (async () => {
      try {
        const leaseId = await ensureLeaseDraft({ silent: true, record: capturedRecord });
        if (!leaseId && !cancelled) {
          preparedLeaseDraftFiles.current.delete(fileId);
        }
      } catch (error) {
        if (!cancelled) {
          preparedLeaseDraftFiles.current.delete(fileId);
        }
        console.warn("[LeaseUpload] Could not auto-stage lease draft:", error?.message || error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [fileId, fileRecord, queryClient]);

  useEffect(() => {
    if (
      !fileId ||
      fileRecord?.status !== "review_required" ||
      !isEmptyExtractionFallback ||
      retriedManualFallbackFiles.current.has(fileId)
    ) {
      return undefined;
    }

    const staleStatusHelperBug = fallbackWarnings.some((warning) =>
      String(warning).includes(".catch is not a function"),
    );
    const emptyExtraction = fallbackWarnings.some((warning) =>
      /text is too short|no structured fields/i.test(String(warning)),
    );
    if (!staleStatusHelperBug && !emptyExtraction) return undefined;

    retriedManualFallbackFiles.current.add(fileId);
    const retryTimer = window.setTimeout(() => {
      retryExtraction();
    }, 750);

    return () => window.clearTimeout(retryTimer);
  }, [fileId, fileRecord?.status, isEmptyExtractionFallback, fallbackWarnings, retryExtraction]);

  const { activeIndex, failed } = pipelineProgress(fileRecord?.status);

  // Detect a stuck pipeline: if the file has been in an intermediate active
  // status for more than 3 minutes without progressing, the backend likely
  // hit a compute-resource limit and left the status frozen. Show a clear
  // message and make Re-run visible.
  const isStuckInPipeline = useMemo(() => {
    const stuckStatuses = new Set(["parsing", "validating", "validated", "storing"]);
    if (!stuckStatuses.has(fileRecord?.status)) return false;
    const updatedAt = fileRecord?.updated_at ? new Date(fileRecord.updated_at).getTime() : 0;
    if (!updatedAt) return false;
    return Date.now() - updatedAt > 3 * 60 * 1000; // stuck for > 3 minutes
  }, [fileRecord?.status, fileRecord?.updated_at]);

  // "Open Lease Review" is only meaningful when there is an actual review
  // payload (i.e. extraction produced fields the user can inspect/approve).
  // A failed parse produces a blocked placeholder payload — not a real review.
  // Hiding the button avoids confusion and prevents navigating to an empty review.
  const hasValidReviewPayload =
    fileRecord?.review_required === true &&
    fileRecord?.ui_review_payload != null &&
    fileRecord?.status !== "failed";

  const canOpenReview = hasValidReviewPayload || [
    "review_required",
    "validating",
    "validated",
    "approved",
    "storing",
    "stored",
    "computing",
    "completed",
  ].includes(fileRecord?.status || "");

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
                <Badge className={statusBadgeStyle(fileRecord?.status)}>{statusLabelFor(fileRecord?.status)}</Badge>
                {fileRecord?.document_subtype && (
                  <Badge className="bg-blue-50 text-blue-700">{fileRecord.document_subtype.replace(/_/g, " ")}</Badge>
                )}
                {fileRecord?.status === "review_required" && (
                  <Badge className="bg-amber-100 text-amber-800">Review Required</Badge>
                )}
              </div>
            </div>

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
          </CardContent>
        </Card>
      )}

      {fileId && (
        <Card>
          <CardContent className="p-4">
            <h3 className="text-sm font-semibold text-slate-900">Processing Status</h3>
            <p className="text-xs text-slate-500">
              The intake pipeline runs automatically. Once extraction is ready, open Lease Review to inspect fields.
            </p>
            <ol className="mt-3 grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
              {PIPELINE_STAGES.map((stage, idx) => {
                const isComplete = !failed && idx < activeIndex;
                const isCurrent = !failed && idx === activeIndex;
                return (
                  <li
                    key={stage.key}
                    className={`flex items-start gap-2 rounded-lg border p-2 ${
                      isCurrent
                        ? "border-blue-200 bg-blue-50"
                        : isComplete
                        ? "border-emerald-200 bg-emerald-50/60"
                        : "border-slate-200 bg-slate-50"
                    }`}
                  >
                    <span
                      className={`mt-0.5 flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold ${
                        isComplete
                          ? "bg-emerald-500 text-white"
                          : isCurrent
                          ? "bg-blue-500 text-white"
                          : "bg-slate-300 text-white"
                      }`}
                    >
                      {isComplete ? "✓" : idx + 1}
                    </span>
                    <span
                      className={`text-xs font-medium ${
                        isCurrent ? "text-blue-700" : isComplete ? "text-emerald-700" : "text-slate-600"
                      }`}
                    >
                      {stage.label}
                    </span>
                  </li>
                );
              })}
            </ol>
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
                  Extraction appears stuck — the AI pipeline may have run out of compute resources.
                  Click <strong>Re-run Extraction</strong> to reset and retry.
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
              {isVertexNotConfigured
                ? "AI extraction is unavailable — Vertex AI is not configured. Set VERTEX_PROJECT_ID and GOOGLE_SERVICE_ACCOUNT_KEY in your Supabase project secrets, then retry. You can also open Lease Review to fill fields manually."
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

async function findLeaseByFileId(fileId) {
  const { data, error } = await supabase
    .from("leases")
    .select("id")
    .filter("extraction_data->>source_file_id", "eq", fileId)
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return data;
}

async function ensureLeaseSourceFileLink(leaseId, fileRecordOrId) {
  if (!leaseId || !fileRecordOrId) return null;

  let fileRecord = typeof fileRecordOrId === "string" ? { id: fileRecordOrId } : fileRecordOrId;
  if (!fileRecord?.file_name) {
    const { data } = await fetchUploadedFileStatus(fileRecord.id);
    fileRecord = { ...fileRecord, ...(data || {}) };
  }

  const { data: lease, error } = await supabase
    .from("leases")
    .select("id, extraction_data")
    .eq("id", leaseId)
    .maybeSingle();
  if (error || !lease) return null;

  const currentExtraction = lease.extraction_data || {};
  if (currentExtraction.source_file_id === fileRecord.id) {
    return lease.id;
  }

  const nextExtraction = {
    ...currentExtraction,
    source_file_id: fileRecord.id,
    source_file_name: fileRecord.file_name ?? currentExtraction.source_file_name ?? null,
    document_subtype: currentExtraction.document_subtype ?? fileRecord.document_subtype ?? null,
    source_file_linked_at: new Date().toISOString(),
  };

  const { error: updateError } = await supabase
    .from("leases")
    .update({ extraction_data: nextExtraction })
    .eq("id", lease.id);
  if (updateError) {
    console.warn("[LeaseUpload] could not persist source_file_id on lease draft:", updateError.message);
    return null;
  }

  return lease.id;
}

// Client-side lease-draft creation. Used when review-approve fails or isn't
// available on the deployment. Mirrors the row shape that review-approve's
// ensureLeaseReviewDrafts produces, so downstream Lease Review can edit the
// draft normally.
async function createLeaseDraftFromUploadedFile(fileId, cachedFileRecord) {
  if (!fileId) return null;

  let fileRecord = cachedFileRecord;
  if (!fileRecord || !fileRecord.org_id) {
    const { data, error } = await fetchUploadedFileStatus(fileId);
    if (error || !data) return null;
    fileRecord = data;
  }

  const candidateRows =
    extractRowsFromUiReview(fileRecord?.ui_review_payload) ||
    asArrayOrNull(fileRecord?.reviewed_output?.final_records) ||
    asArrayOrNull(fileRecord?.valid_data) ||
    asArrayOrNull(fileRecord?.parsed_data) ||
    [];
  const firstRow = candidateRows[0] || {};

  const confidenceScores = collectConfidenceFromPayload(fileRecord?.ui_review_payload);
  const lowConfidenceFields = Object.entries(confidenceScores)
    .filter(([, score]) => typeof score === "number" && score < 75)
    .map(([field]) => field);

  // Pull per-field evidence (source page, exact source text) AND the workflow
  // output so the Lease Review table can render Raw / Page / Source Text /
  // Confidence columns even when the lease was created via this fallback
  // instead of review-approve. Without this, evidence is silently lost.
  const fieldsWithEvidence = buildFieldsWithEvidence(fileRecord?.ui_review_payload);
  const fieldEvidence = buildFieldEvidenceMap(fileRecord?.ui_review_payload);
  const workflowOutput = extractWorkflowOutputForFirstRow(fileRecord?.ui_review_payload);
  // Carry the consolidated extraction diagnostics (incl. mapping_failure_reason)
  // onto the lease so Lease Review / Extraction Debug can read them directly.
  const extractionDebug =
    fileRecord?.ui_review_payload?.metadata?.extractionDebug
    || fileRecord?.ui_review_payload?.metadata?.extraction_debug
    || null;

  const numeric = (v) => {
    if (v == null || v === "") return null;
    const n = Number(String(v).replace(/[$,%\s,]/g, ""));
    return Number.isFinite(n) ? n : null;
  };
  const normalizeDate = (v) => {
    if (!v) return null;
    const text = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
    const d = new Date(text);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  };

  const payload = {
    org_id: fileRecord.org_id,
    property_id: firstRow.property_id ?? fileRecord.property_id ?? null,
    building_id: firstRow.building_id ?? fileRecord.building_id ?? null,
    unit_id: firstRow.unit_id ?? fileRecord.unit_id ?? null,
    // Preserve null when extraction returned no tenant_name. The previous
    // "Lease Review Draft" string fallback was being persisted to the lease
    // row and displayed as the extracted tenant. List views can show
    // "Untitled" as a UI label without writing it into the data column.
    tenant_name: firstRow.tenant_name || null,
    start_date: normalizeDate(firstRow.start_date || firstRow.lease_start),
    end_date: normalizeDate(firstRow.end_date || firstRow.lease_end),
    commencement_date: normalizeDate(firstRow.commencement_date),
    expiration_date: normalizeDate(firstRow.expiration_date),
    lease_date: normalizeDate(firstRow.lease_date),
    rent_commencement_date: normalizeDate(firstRow.rent_commencement_date),
    // Preserve null when extraction returned no rent value. Defaulting to 0
    // here surfaces in Lease Review as a confirmed "$0 Extracted" badge,
    // which is wrong — extraction never produced a value. Leave it null so
    // the resolver reports Not Found / Needs Review correctly.
    monthly_rent: numeric(firstRow.monthly_rent ?? firstRow.base_rent),
    annual_rent: numeric(firstRow.annual_rent),
    square_footage: numeric(firstRow.square_footage ?? firstRow.total_sf),
    lease_type: firstRow.lease_type ?? null,
    cam_amount: numeric(firstRow.cam_amount),
    nnn_amount: numeric(firstRow.nnn_amount),
    security_deposit: numeric(firstRow.security_deposit),
    escalation_rate: numeric(firstRow.escalation_rate),
    escalation_type: firstRow.escalation_type ?? null,
    escalation_timing: firstRow.escalation_timing ?? null,
    free_rent_months: numeric(firstRow.free_rent_months),
    renewal_options: firstRow.renewal_options ?? null,
    renewal_type: firstRow.renewal_type ?? null,
    status: "draft",
    notes: firstRow.notes ?? null,
    extraction_data: {
      source: "client_fallback",
      source_file_id: fileRecord.id,
      source_file_name: fileRecord.file_name ?? null,
      document_subtype: fileRecord.document_subtype ?? null,
      confidence_scores: confidenceScores,
      // Replace bare row with per-field { value, confidence, source, evidence }
      // so the Lease Review reader can pull source_page + source_text.
      fields: fieldsWithEvidence,
      field_evidence: fieldEvidence,
      // Forward the workflow output (lease_fields with full provenance) so
      // the UI's getWorkflowLeaseFields resolver lights up Raw / Page /
      // Source Text / Confidence columns.
      workflow_output: workflowOutput,
      extraction_debug: extractionDebug,
    },
    confidence_score: averageConfidence(confidenceScores),
    low_confidence_fields: lowConfidenceFields,
    extracted_fields: firstRow,
  };

  const created = await leaseService.create(payload);
  return created?.id || null;
}

function asArrayOrNull(value) {
  return Array.isArray(value) && value.length > 0 ? value : null;
}

function extractRowsFromUiReview(payload) {
  if (!payload) return null;
  const records = payload.records || payload.rows;
  if (!Array.isArray(records) || records.length === 0) return null;
  return records.map((record) => {
    if (record?.values && typeof record.values === "object") return record.values;
    const row = {};
    for (const field of record?.standard_fields || []) {
      if (field?.field_key && field?.status !== "rejected") row[field.field_key] = field.value ?? null;
    }
    for (const field of record?.custom_fields || []) {
      if (field?.field_key && field?.status !== "rejected") row[field.field_key] = field.value ?? null;
    }
    return row;
  });
}

// Build extraction_data.fields as { key: { value, confidence, source, evidence }
// }. The Lease Review reader uses this when probing each field for raw +
// page + source-text + status. Bare row values (the previous shape) had no
// evidence, which is why the columns rendered as "—".
function buildFieldsWithEvidence(payload) {
  const records = payload?.records || payload?.rows || [];
  const record = records[0];
  if (!record) return {};
  const out = {};
  const fields = [
    ...(record.standard_fields || []),
    ...(record.custom_fields || []),
  ];
  for (const field of fields) {
    if (!field?.field_key) continue;
    if (field.status === "rejected") continue;
    const sourceText = cleanExtractedSourceText(field.evidence?.source_clause ?? field.evidence?.source_text);
    out[field.field_key] = {
      value: field.value ?? null,
      confidence: typeof field.confidence === "number" ? field.confidence : null,
      source: field.source ?? null,
      evidence: field.evidence ?? null,
      // Mirror evidence as flat keys so the resolver finds them regardless
      // of whether it reads from extraction_data.fields[key] or
      // extraction_data.field_evidence[key].
      source_page: field.evidence?.page_number ?? field.evidence?.source_page ?? null,
      source_text: sourceText,
      raw_value: field.original_value ?? field.evidence?.raw_value ?? null,
      extraction_status: field.status ?? null,
    };
  }
  const workflowOutput = extractWorkflowOutputForFirstRow(payload);
  for (const [fieldKey, field] of Object.entries(workflowOutput?.lease_fields || {})) {
    if (!field || typeof field !== "object") continue;
    out[fieldKey] = {
      ...(out[fieldKey] || {}),
      value: field.value ?? out[fieldKey]?.value ?? null,
      confidence: field.confidence_score ?? out[fieldKey]?.confidence ?? null,
      source_page: field.source_page ?? out[fieldKey]?.source_page ?? null,
      source_text: cleanExtractedSourceText(field.source_clause) ?? out[fieldKey]?.source_text ?? null,
      raw_value: field.value ?? out[fieldKey]?.raw_value ?? null,
      extraction_status: field.extraction_status ?? out[fieldKey]?.extraction_status ?? null,
    };
  }
  if (!out.square_footage && out.rentable_area_sqft) out.square_footage = { ...out.rentable_area_sqft, value: out.rentable_area_sqft.value };
  if (!out.premises_address && out.property_address) out.premises_address = { ...out.property_address, value: out.property_address.value };
  return out;
}

// Build extraction_data.field_evidence keyed by field. This is the primary
// shape the resolver expects when populated by review-approve; the
// client-side fallback now produces it too.
function buildFieldEvidenceMap(payload) {
  const records = payload?.records || payload?.rows || [];
  const record = records[0];
  if (!record) return {};
  const out = {};
  for (const field of record.standard_fields || []) {
    if (!field?.field_key || !field?.evidence) continue;
    const sourceText = cleanExtractedSourceText(field.evidence.source_clause ?? field.evidence.source_text);
    out[field.field_key] = {
      raw_value: field.original_value ?? field.evidence.raw_value ?? null,
      source_page: field.evidence.page_number ?? field.evidence.source_page ?? null,
      source_text: sourceText,
      extraction_status: field.status ?? null,
    };
  }
  const workflowOutput = extractWorkflowOutputForFirstRow(payload);
  for (const [fieldKey, field] of Object.entries(workflowOutput?.lease_fields || {})) {
    if (!field || typeof field !== "object") continue;
    out[fieldKey] = {
      raw_value: field.value ?? null,
      source_page: field.source_page ?? null,
      source_text: cleanExtractedSourceText(field.source_clause),
      extraction_status: field.extraction_status ?? null,
    };
  }
  if (!out.square_footage && out.rentable_area_sqft) out.square_footage = { ...out.rentable_area_sqft };
  if (!out.premises_address && out.property_address) out.premises_address = { ...out.property_address };
  return out;
}

// Delegate to the canonical implementation in leaseReviewSchema so all callers
// use identical filtering logic and there is only one definition to maintain.
const cleanExtractedSourceText = cleanSourceEvidenceText;

// The normalize-pdf-output edge function stores the per-row workflow output
// (lease_fields, expense_rules, cam_profile, lease_clauses) under
// ui_review_payload.metadata.workflow_output.records[rowIndex]. Pull the
// first row's view so extraction_data.workflow_output mirrors what
// review-approve would have written on the happy path.
function extractWorkflowOutputForFirstRow(payload) {
  const wf = payload?.metadata?.workflow_output;
  if (!wf) return null;
  if (Array.isArray(wf.records)) {
    return wf.records[0] ?? null;
  }
  return wf;
}

function collectConfidenceFromPayload(payload) {
  const scores = {};
  const records = payload?.records || payload?.rows || [];
  for (const record of records) {
    const fields = [
      ...(record?.standard_fields || []),
      ...(record?.custom_fields || []),
    ];
    for (const field of fields) {
      if (!field?.field_key) continue;
      const c = field.confidence;
      if (typeof c !== "number") continue;
      scores[field.field_key] = c <= 1 ? Math.round(c * 100) : Math.round(c);
    }
  }
  return scores;
}

function averageConfidence(scores) {
  const values = Object.values(scores).filter((s) => typeof s === "number" && !Number.isNaN(s));
  if (values.length === 0) return null;
  return Math.round(values.reduce((sum, s) => sum + s, 0) / values.length);
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

function isUnsupportedPrepareAction(error) {
  const message = String(error?.message || "").toLowerCase();
  if (/invalid action[:\s]*prepare/.test(message)) return true;
  if (/unknown action[:\s]*prepare/.test(message)) return true;
  if (/unsupported action[:\s]*prepare/.test(message)) return true;
  if (/prepare/.test(message) && /(invalid|unknown|unsupported|bad request|not supported)/.test(message)) return true;
  // Some deployed builds drop the message; fall back to status-only detection
  // so an old function returning a generic 400 still triggers the approve path.
  const status = Number(error?.context?.status ?? error?.status ?? error?.statusCode ?? 0);
  if (status === 400 || status === 404 || status === 405) return true;
  return false;
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

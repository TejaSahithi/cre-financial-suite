import React, { useEffect, useMemo, useRef, useState } from "react";
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
import useOrgQuery from "@/hooks/useOrgQuery";
import { supabase } from "@/services/supabaseClient";
import { invokeEdgeFunction } from "@/services/edgeFunctions";
import { createPageUrl } from "@/utils";

// Statuses that still need polling because a backend stage is in flight.
const ACTIVE_STATUSES = new Set([
  "uploaded",
  "parsing",
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

  const fetchFileRecord = async (id) => {
    if (!id) return;
    setLoadingRecord(true);
    let { data, error } = await supabase
      .from("uploaded_files")
      .select(
        "id, file_name, file_url, status, error_message, review_required, review_status, " +
        "document_subtype, extraction_method, ui_review_payload, reviewed_output, row_count, " +
        "property_id, building_id, unit_id, updated_at",
      )
      .eq("id", id)
      .maybeSingle();

    if (error) {
      const fallback = await supabase
        .from("uploaded_files")
        .select("id, file_name, file_url, status, error_message, row_count, updated_at")
        .eq("id", id)
        .maybeSingle();
      data = fallback.data;
      error = fallback.error;
    }

    setLoadingRecord(false);

    if (error) {
      toast.error(`Could not load review data: ${error.message}`);
      return;
    }
    setFileRecord(data);
  };

  const invalidateLeaseQueries = async () => {
    clearCache();
    await queryClient.invalidateQueries({ queryKey: ["Lease"] });
  };

  const ensureLeaseDraft = async ({ silent = false } = {}) => {
    if (!fileId) return null;

    const existing = await findLeaseByFileId(fileId);
    if (existing?.id) {
      await invalidateLeaseQueries();
      return existing.id;
    }

    if (fileRecord?.review_required !== true && fileRecord?.status !== "review_required") {
      return null;
    }

    const data = await invokeEdgeFunction("review-approve", {
      file_id: fileId,
      action: "prepare",
      review_payload: fileRecord?.ui_review_payload || null,
    });

    const insertedLeaseId =
      data?.store_result?.inserted_ids?.[0] ||
      data?.store_result?.insertedIds?.[0] ||
      null;

    await fetchFileRecord(fileId);

    const linkedLeaseId = insertedLeaseId || (await findLeaseByFileId(fileId))?.id || null;
    if (linkedLeaseId) {
      await invalidateLeaseQueries();
      return linkedLeaseId;
    }

    if (!silent) {
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

    poll();
    const interval = window.setInterval(() => {
      if (!ACTIVE_STATUSES.has(fileRecord?.status)) {
        return;
      }
      poll();
    }, 3000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [fileId, fileRecord?.status]);

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

  const retryExtraction = async () => {
    if (!fileId) return;
    setRetryingExtraction(true);
    try {
      const data = await invokeEdgeFunction("ingest-file", {
        file_id: fileId,
        module_type: "leases",
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
  };

  // Open Lease Review for the lease draft tied to this file. If a draft does
  // not yet exist, send the existing extraction to the review pipeline (which
  // creates the lease draft on the backend) and then navigate. The actual
  // approval still happens in Lease Review — this just promotes the raw AI
  // output into a reviewable draft, per the upgraded workflow.
  const openLeaseReview = async () => {
    if (!fileId) return;
    setOpeningReview(true);
    try {
      const leaseId = await ensureLeaseDraft();
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

  const handleViewDocument = () => {
    const url = fileRecord?.file_url;
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
      const { error } = await supabase.from("uploaded_files").delete().eq("id", fileId);
      if (error) throw error;
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
  const extractionQuality = useMemo(
    () => assessLeaseExtractionQuality(reviewedRows),
    [reviewedRows]
  );
  const hasMeaningfulExtraction = useMemo(
    () => hasMeaningfulLeaseExtraction(reviewedRows),
    [reviewedRows],
  );
  const fallbackWarnings = reviewPayload?.global_warnings || reviewPayload?.warnings || [];
  const isManualReviewFallback =
    reviewPayload?.pipeline_method === "manual_review_fallback" ||
    reviewPayload?.extraction_method === "manual_review_fallback" ||
    reviewPayload?.metadata?.manualReviewFallback === true;
  const isEmptyExtractionFallback =
    !hasMeaningfulExtraction &&
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

    (async () => {
      try {
        const leaseId = await ensureLeaseDraft({ silent: true });
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
  }, [fileId, fileRecord?.status, isEmptyExtractionFallback, fallbackWarnings]);

  const { activeIndex, failed } = pipelineProgress(fileRecord?.status);
  const canOpenReview =
    fileRecord?.status === "review_required" || fileRecord?.status === "completed";

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
              <Button
                onClick={openLeaseReview}
                disabled={openingReview || !canOpenReview}
                size="sm"
                className="bg-teal-600 hover:bg-teal-700"
              >
                {openingReview && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                <ExternalLink className="mr-2 h-4 w-4" />
                Open Lease Review
              </Button>
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
                Pipeline failed. Use Re-run Extraction to retry.
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {fileRecord?.status === "failed" && (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm text-red-700">
            <span>{fileRecord.error_message || "Processing failed."}</span>
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
              Automatic extraction did not return mapped values for this file. Retry extraction to use the latest parser fix, or open Lease Review to continue manually.
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
    .eq("extraction_data->>source_file_id", fileId)
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return data;
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

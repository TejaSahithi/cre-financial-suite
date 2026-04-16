import React, { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, CheckCircle2, FileText, Loader2 } from "lucide-react";
import { toast } from "sonner";
import FileUploader from "@/components/FileUploader";
import ReviewPanel from "@/components/ReviewPanel";
import ScopeSelector from "@/components/ScopeSelector";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import useOrgQuery from "@/hooks/useOrgQuery";
import { supabase } from "@/services/supabaseClient";
import { createPageUrl } from "@/utils";

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

export default function LeaseUpload() {
  const location = useLocation();
  const navigate = useNavigate();
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
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);

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
  const effectivePropertyId =
    selectedUnit?.property_id ||
    selectedBuilding?.property_id ||
    (scopeProperty !== "all" ? scopeProperty : null);

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
    const { data, error } = await supabase
      .from("uploaded_files")
      .select(
        "id, file_name, status, error_message, review_required, review_status, " +
        "document_subtype, extraction_method, ui_review_payload, row_count, updated_at",
      )
      .eq("id", id)
      .maybeSingle();
    setLoadingRecord(false);

    if (error) {
      toast.error(`Could not load review data: ${error.message}`);
      return;
    }
    setFileRecord(data);
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

  const handleUploadComplete = (result) => {
    if (!result?.file_id) return;
    setFileId(result.file_id);
    setFileRecord(null);
    toast.success("Lease uploaded. The canonical extraction pipeline is running.");
  };

  const approveReview = async (editedRows) => {
    if (!fileId) return;
    setApproving(true);
    const { data, error } = await supabase.functions.invoke("review-approve", {
      body: {
        file_id: fileId,
        action: "approve",
        edited_rows: editedRows,
      },
    });
    setApproving(false);

    if (error || data?.error) {
      toast.error(data?.message || error?.message || "Review approval failed");
      return;
    }

    toast.success("Lease review approved and storage started.");
    await fetchFileRecord(fileId);
  };

  const rejectReview = async (reason) => {
    if (!fileId) return;
    setRejecting(true);
    const { data, error } = await supabase.functions.invoke("review-approve", {
      body: {
        file_id: fileId,
        action: "reject",
        reject_reason: reason,
      },
    });
    setRejecting(false);

    if (error || data?.error) {
      toast.error(data?.message || error?.message || "Review rejection failed");
      return;
    }

    toast.success("Lease extraction rejected.");
    await fetchFileRecord(fileId);
  };

  const statusLabel = fileRecord?.status ? fileRecord.status.replace(/_/g, " ") : "waiting";
  const reviewPayload = fileRecord?.ui_review_payload || null;

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <Link to={createPageUrl("Leases") + location.search} className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700">
        <ArrowLeft className="h-4 w-4" /> Back to Leases
      </Link>

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
            Scope:{" "}
            {[selectedProperty?.name, selectedBuilding?.name, selectedUnit?.unit_number || selectedUnit?.unit_id_code]
              .filter(Boolean)
              .join(" - ") || "No specific scope selected"}
          </div>
        </CardContent>
      </Card>

      {!fileId && (
        <FileUploader
          defaultFileType="leases"
          allowedFileTypes={["leases"]}
          propertyId={effectivePropertyId || undefined}
          multiple={false}
          onUploadComplete={handleUploadComplete}
          title="Upload Lease Document"
          description="Upload a base lease, amendment, assignment, consent, extension, or addendum. Scanned PDFs are processed server-side with OCR."
        />
      )}

      {fileId && (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100">
                <FileText className="h-5 w-5 text-slate-500" />
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-900">{fileRecord?.file_name || "Lease document"}</p>
                <p className="text-xs text-slate-500">File ID: {fileId}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {loadingRecord && <Loader2 className="h-4 w-4 animate-spin text-slate-400" />}
              <Badge className="bg-slate-100 text-slate-700">{statusLabel}</Badge>
              {fileRecord?.document_subtype && (
                <Badge className="bg-blue-50 text-blue-700">{fileRecord.document_subtype.replace(/_/g, " ")}</Badge>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {fileRecord?.status === "failed" && (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="p-4 text-sm text-red-700">
            {fileRecord.error_message || "Processing failed."}
          </CardContent>
        </Card>
      )}

      {fileRecord?.status === "review_required" && reviewPayload && (
        <ReviewPanel
          payload={reviewPayload}
          approving={approving}
          rejecting={rejecting}
          onApprove={approveReview}
          onReject={rejectReview}
        />
      )}

      {fileRecord?.status === "review_required" && !reviewPayload && (
        <Card>
          <CardContent className="p-8 text-center">
            <Loader2 className="mx-auto mb-3 h-8 w-8 animate-spin text-blue-600" />
            <p className="text-sm text-slate-500">Preparing the review payload...</p>
          </CardContent>
        </Card>
      )}

      {fileRecord?.status === "completed" && (
        <Card className="border-emerald-200 bg-emerald-50">
          <CardContent className="flex items-center gap-2 p-4 text-sm text-emerald-700">
            <CheckCircle2 className="h-4 w-4" />
            Lease data was stored and compute jobs were started successfully.
          </CardContent>
        </Card>
      )}
    </div>
  );
}

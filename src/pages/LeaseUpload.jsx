import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { AlertTriangle, ArrowLeft, Calculator, CheckCircle2, DollarSign, FileText, Loader2, Plus, Upload } from "lucide-react";
import { toast } from "sonner";
import FileUploader from "@/components/FileUploader";
import ReviewPanel from "@/components/ReviewPanel";
import ScopeSelector from "@/components/ScopeSelector";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import useOrgQuery from "@/hooks/useOrgQuery";
import { supabase } from "@/services/supabaseClient";
import { invokeEdgeFunction } from "@/services/edgeFunctions";
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
  const [savingReview, setSavingReview] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [retryingExtraction, setRetryingExtraction] = useState(false);
  const retriedUploadedFiles = useRef(new Set());
  const retriedManualFallbackFiles = useRef(new Set());

  const { data: properties = [] } = useOrgQuery("Property");
  const { data: buildings = [] } = useOrgQuery("Building");
  const { data: units = [] } = useOrgQuery("Unit");
  const { data: expenses = [] } = useOrgQuery("Expense");

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
  const effectiveProperty = effectivePropertyId
    ? properties.find((property) => property.id === effectivePropertyId) ?? selectedProperty
    : selectedProperty;

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
        "id, file_name, status, error_message, review_required, review_status, " +
        "document_subtype, extraction_method, ui_review_payload, reviewed_output, row_count, " +
        "property_id, building_id, unit_id, updated_at",
      )
      .eq("id", id)
      .maybeSingle();

    if (error) {
      const fallback = await supabase
        .from("uploaded_files")
        .select("id, file_name, status, error_message, row_count, updated_at")
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
    toast.success("Lease uploaded. The canonical extraction pipeline is running.");
  };

  const saveReview = async (reviewPayload) => {
    if (!fileId) return;
    setSavingReview(true);
    try {
      const data = await invokeEdgeFunction("review-approve", {
        file_id: fileId,
        action: "save",
        review_payload: reviewPayload,
      });

      if (data?.error) {
        toast.error(data?.message || "Review save failed");
        return;
      }

      toast.success("Review draft saved.");
      await fetchFileRecord(fileId);
    } catch (error) {
      toast.error(error?.message || "Review save failed");
    } finally {
      setSavingReview(false);
    }
  };

  const approveReview = async (reviewPayload) => {
    if (!fileId) return;
    setApproving(true);
    try {
      const data = await invokeEdgeFunction("review-approve", {
        file_id: fileId,
        action: "approve",
        review_payload: reviewPayload,
      });

      if (data?.error) {
        toast.error(data?.message || "Review approval failed");
        return;
      }

      const insertedLeaseId =
        data?.store_result?.inserted_ids?.[0] ||
        data?.store_result?.insertedIds?.[0] ||
        null;

      if (data?.already_approved) {
        toast.info("This extraction was already sent to Lease Review.");
      } else {
        toast.success("Lease draft sent to Lease Review.");
      }
      await fetchFileRecord(fileId);

      if (insertedLeaseId) {
        navigate(createPageUrl("LeaseReview", { id: insertedLeaseId }));
      }
    } catch (error) {
      toast.error(error?.message || "Review approval failed");
    } finally {
      setApproving(false);
    }
  };

  const rejectReview = async (reason) => {
    if (!fileId) return;
    setRejecting(true);
    try {
      const data = await invokeEdgeFunction("review-approve", {
        file_id: fileId,
        action: "reject",
        reject_reason: reason,
      });

      if (data?.error) {
        toast.error(data?.message || "Review rejection failed");
        return;
      }

      toast.success("Lease extraction rejected.");
      await fetchFileRecord(fileId);
    } catch (error) {
      toast.error(error?.message || "Review rejection failed");
    } finally {
      setRejecting(false);
    }
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

  const statusLabel = fileRecord?.status ? fileRecord.status.replace(/_/g, " ") : "waiting";
  const reviewPayload = fileRecord?.ui_review_payload || null;
  const reviewedRows = reviewPayload?.records || reviewPayload?.rows || [];
  const leaseFiscalYear = inferLeaseFiscalYear(reviewedRows);
  const expenseScope = useMemo(() => {
    const propertyId = effectivePropertyId;
    if (!propertyId) {
      return {
        propertyId: null,
        fiscalYear: leaseFiscalYear,
        scoped: [],
        recoverable: [],
        recoverableTotal: 0,
      };
    }

    const scoped = expenses.filter((expense) => {
      if (expense.property_id !== propertyId) return false;
      if (scopeBuilding !== "all" && expense.building_id && expense.building_id !== scopeBuilding) return false;
      if (scopeUnit !== "all" && expense.unit_id && expense.unit_id !== scopeUnit) return false;
      if (leaseFiscalYear && Number(expense.fiscal_year) !== Number(leaseFiscalYear)) return false;
      return true;
    });
    const recoverable = scoped.filter((expense) => {
      const classification = String(expense.classification || "").toLowerCase();
      return classification === "recoverable" || classification === "cam" || classification === "nnn" || classification === "";
    });

    return {
      propertyId,
      fiscalYear: leaseFiscalYear,
      scoped,
      recoverable,
      recoverableTotal: recoverable.reduce((sum, expense) => sum + (Number(expense.amount) || 0), 0),
    };
  }, [expenses, effectivePropertyId, scopeBuilding, scopeUnit, leaseFiscalYear]);
  const isManualReviewFallback =
    reviewPayload?.pipeline_method === "manual_review_fallback" ||
    reviewPayload?.extraction_method === "manual_review_fallback" ||
    reviewPayload?.metadata?.manualReviewFallback === true;
  const fallbackWarnings = reviewPayload?.global_warnings || reviewPayload?.warnings || [];
  const isEmptyExtractionFallback =
    isManualReviewFallback ||
    reviewPayload?.extraction_method === "none" ||
    reviewPayload?.pipeline_method === "fallback" ||
    fallbackWarnings.some((warning) =>
      /text is too short|no structured fields|manual review/i.test(String(warning)),
    );

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
              Automatic extraction did not return mapped values for this file. Retry extraction to use the latest parser fix, or continue manually below.
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

      {fileRecord?.status === "review_required" && reviewPayload && (
        <>
          <ReviewPanel
            payload={reviewPayload}
            approving={approving}
            saving={savingReview}
            rejecting={rejecting}
            approveLabel="Send to Lease Review"
            approveDescription="Creates a reviewed lease draft, then opens Lease Review for confidence checks, team review, and signature approval."
            onApprove={approveReview}
            onSave={saveReview}
            onReject={rejectReview}
          />
          <ExpenseCamReadinessCard
            expenseScope={expenseScope}
            propertyName={effectiveProperty?.name}
            scopeParams={{
              property: effectivePropertyId,
              building: scopeBuilding !== "all" ? scopeBuilding : undefined,
              unit: scopeUnit !== "all" ? scopeUnit : undefined,
            }}
          />
        </>
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

function inferLeaseFiscalYear(records) {
  const first = records?.[0] || null;
  const dateValue = getRecordValue(first, "start_date") || getRecordValue(first, "assignment_effective_date") || getRecordValue(first, "end_date");
  const parsedDate = dateValue ? new Date(String(dateValue)) : null;
  if (parsedDate && !Number.isNaN(parsedDate.getTime())) return parsedDate.getFullYear();
  return new Date().getFullYear();
}

function ExpenseCamReadinessCard({ expenseScope, propertyName, scopeParams }) {
  const hasProperty = !!expenseScope.propertyId;
  const hasRecoverableExpenses = expenseScope.recoverable.length > 0;
  const scopedParams = Object.fromEntries(
    Object.entries(scopeParams || {}).filter(([, value]) => value !== undefined && value !== null && value !== "all"),
  );
  const addExpenseUrl = createPageUrl("AddExpense", scopedParams);
  const bulkImportUrl = createPageUrl("BulkImport", scopedParams);
  const camUrl = createPageUrl("CAMCalculation", {
    property_id: expenseScope.propertyId,
    year: expenseScope.fiscalYear,
  });

  return (
    <Card className={hasRecoverableExpenses ? "border-emerald-200 bg-emerald-50/60" : "border-amber-200 bg-amber-50/70"}>
      <CardContent className="space-y-4 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex gap-3">
            <div className={`mt-0.5 flex h-10 w-10 items-center justify-center rounded-xl ${hasRecoverableExpenses ? "bg-emerald-100" : "bg-amber-100"}`}>
              {hasRecoverableExpenses ? (
                <DollarSign className="h-5 w-5 text-emerald-700" />
              ) : (
                <AlertTriangle className="h-5 w-5 text-amber-700" />
              )}
            </div>
            <div>
              <h3 className="text-sm font-semibold text-slate-900">Expenses and CAM readiness</h3>
              <p className="mt-1 max-w-2xl text-xs leading-relaxed text-slate-600">
                Lease documents can provide CAM terms and recovery hints, but actual CAM must be calculated from expense records.
                Expenses inherit this lease upload scope when you add or import them.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge className="bg-white text-slate-700">
              FY {expenseScope.fiscalYear}
            </Badge>
            <Badge className={hasRecoverableExpenses ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-800"}>
              {expenseScope.recoverable.length} recoverable expenses
            </Badge>
          </div>
        </div>

        {!hasProperty ? (
          <div className="rounded-lg border border-amber-200 bg-white p-3 text-xs text-amber-800">
            Select a property scope before adding expenses or running CAM. CAM requires a property, fiscal year, leases, and recoverable expenses.
          </div>
        ) : hasRecoverableExpenses ? (
          <div className="rounded-lg border border-emerald-200 bg-white p-3 text-xs text-emerald-800">
            Found {expenseScope.recoverable.length} recoverable expense line item(s)
            {propertyName ? ` for ${propertyName}` : ""}, totaling ${expenseScope.recoverableTotal.toLocaleString()}.
            You can now calculate CAM from actual expenses.
          </div>
        ) : (
          <div className="rounded-lg border border-amber-200 bg-white p-3 text-xs text-amber-800">
            No recoverable expenses were found for this lease scope and fiscal year. Add individual expenses or bulk import expense lines, then run CAM.
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <ActionLinkButton
            to={addExpenseUrl}
            disabled={!hasProperty}
            variant="outline"
            className="bg-white"
            icon={Plus}
          >
            Add expense manually
          </ActionLinkButton>
          <ActionLinkButton
            to={bulkImportUrl}
            disabled={!hasProperty}
            variant="outline"
            className="bg-white"
            icon={Upload}
          >
            Bulk import expenses
          </ActionLinkButton>
          <ActionLinkButton
            to={camUrl}
            disabled={!hasProperty || !hasRecoverableExpenses}
            className="bg-teal-600 hover:bg-teal-700"
            icon={Calculator}
          >
            Calculate CAM from expenses
          </ActionLinkButton>
        </div>
      </CardContent>
    </Card>
  );
}

function ActionLinkButton({ to, disabled, children, icon: Icon, variant, className }) {
  const button = (
    <Button size="sm" variant={variant} disabled={disabled} className={className}>
      {Icon && <Icon className="mr-2 h-4 w-4" />}
      {children}
    </Button>
  );

  return disabled ? button : <Link to={to}>{button}</Link>;
}

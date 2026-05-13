import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, Calculator, CheckCircle2, DollarSign, FileText, Loader2, Plus, Upload } from "lucide-react";
import { toast } from "sonner";
import FileUploader from "@/components/FileUploader";
import ReviewPanel from "@/components/ReviewPanel";
import ScopeSelector from "@/components/ScopeSelector";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import useOrgQuery from "@/hooks/useOrgQuery";
import { expenseService } from "@/services/expenseService";
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

const EXPLICIT_LEASE_CHARGE_FIELDS = [
  { key: "cam_amount", label: "CAM" },
  { key: "nnn_amount", label: "NNN" },
  { key: "insurance_reimbursement_amount", label: "Insurance Reimbursement" },
  { key: "tax_reimbursement_amount", label: "Tax Reimbursement" },
  { key: "utility_reimbursement_amount", label: "Utility Reimbursement" },
];

const EXPENSE_RULE_HINT_PATTERN = /(responsibility|reimbursement|recoverable|non_recoverable|conditional|cap|expense_stop|base_year|gross_up|admin_fee|management_fee|exclusion|utility|tax|insurance|cam|nnn|maintenance)/i;

function asLeaseAmount(value) {
  if (value == null || value === "") return null;
  const normalized = Number(String(value).replace(/[$,% ,]/g, ""));
  return Number.isFinite(normalized) ? normalized : null;
}

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
  const leaseExpensePreview = useMemo(
    () => summarizeLeaseExpenseSignals(reviewedRows),
    [reviewedRows]
  );
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

  const { data: workflowSummary } = useQuery({
    queryKey: ["lease-upload-expense-workflow", effectivePropertyId, scopeBuilding, scopeUnit, leaseFiscalYear],
    queryFn: () =>
      expenseService.getWorkflowSummary({
        propertyId: effectivePropertyId,
        buildingId: scopeBuilding !== "all" ? scopeBuilding : null,
        unitId: scopeUnit !== "all" ? scopeUnit : null,
        fiscalYear: leaseFiscalYear,
      }),
    enabled: Boolean(effectivePropertyId),
  });

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
            workflowSummary={workflowSummary}
            extractionPreview={leaseExpensePreview}
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

function summarizeLeaseExpenseSignals(records) {
  const first = records?.[0] || null;
  if (!first) {
    return {
      explicitCharges: [],
      ruleHints: [],
    };
  }

  const fields = [];
  const pushField = (fieldKey, label, value) => {
    if (value == null || value === "") return;
    fields.push({ fieldKey, label, value });
  };

  (first.standard_fields || []).forEach((field) => {
    pushField(field.field_key, field.label || field.field_key, field.value);
  });
  (first.custom_fields || []).forEach((field) => {
    pushField(field.field_key, field.label || field.field_key, field.value);
  });
  Object.entries(first.values || {}).forEach(([fieldKey, value]) => {
    pushField(fieldKey, fieldKey, value);
  });
  Object.entries(first.fields || {}).forEach(([fieldKey, field]) => {
    const value = field && typeof field === "object" && "value" in field ? field.value : field;
    pushField(fieldKey, fieldKey, value);
  });

  const fieldByKey = new Map();
  for (const field of fields) {
    if (!fieldByKey.has(field.fieldKey)) {
      fieldByKey.set(field.fieldKey, field);
    }
  }

  const explicitCharges = EXPLICIT_LEASE_CHARGE_FIELDS.flatMap((definition) => {
    const value = getRecordValue(first, definition.key);
    const amount = asLeaseAmount(value);
    if (!amount || amount <= 0) return [];
    return [{ ...definition, amount }];
  });

  const explicitKeys = new Set(EXPLICIT_LEASE_CHARGE_FIELDS.map((definition) => definition.key));
  const ruleHints = [...fieldByKey.values()]
    .filter((field) => !explicitKeys.has(field.fieldKey))
    .filter((field) => EXPENSE_RULE_HINT_PATTERN.test(field.fieldKey))
    .map((field) => ({
      key: field.fieldKey,
      label: String(field.label || field.fieldKey).replace(/_/g, " "),
      value: String(field.value),
    }));

  return {
    explicitCharges,
    ruleHints,
  };
}

function ExpenseCamReadinessCard({ expenseScope, workflowSummary, extractionPreview, propertyName, scopeParams }) {
  const hasProperty = !!expenseScope.propertyId;
  const hasRecoverableExpenses = expenseScope.recoverable.length > 0;
  const hasApprovedRules = (workflowSummary?.approvedRuleLeaseCount || 0) > 0;
  const extractedChargeCount = extractionPreview?.explicitCharges?.length || 0;
  const extractedRuleHintCount = extractionPreview?.ruleHints?.length || 0;
  const scopedParams = Object.fromEntries(
    Object.entries(scopeParams || {}).filter(([, value]) => value !== undefined && value !== null && value !== "all"),
  );
  const addExpenseUrl = createPageUrl("AddExpense", scopedParams);
  const bulkImportUrl = createPageUrl("BulkImport", scopedParams);
  const reviewUrl = createPageUrl("ExpenseReview", scopedParams);
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
            <Badge className="bg-white text-slate-700">
              {extractedChargeCount} lease charge fields
            </Badge>
            <Badge className="bg-white text-slate-700">
              {extractedRuleHintCount} CAM/rule hints
            </Badge>
            <Badge className="bg-white text-slate-700">
              {workflowSummary?.approvedRuleLeaseCount || 0} approved rule sets
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
        ) : extractedChargeCount > 0 ? (
          <div className="rounded-lg border border-blue-200 bg-white p-3 text-xs text-blue-800">
            The lease already contains {extractedChargeCount} explicit charge field(s) such as CAM/NNN/reimbursements.
            Those values will prefill lease-derived expense rows after lease approval, but full CAM still needs approved actual expense inputs.
          </div>
        ) : hasApprovedRules ? (
          <div className="rounded-lg border border-blue-200 bg-white p-3 text-xs text-blue-800">
            Lease expense rules are approved for this scope, but actual expense rows are still missing.
            Add expenses or bulk import them before CAM calculation.
          </div>
        ) : (
          <div className="rounded-lg border border-amber-200 bg-white p-3 text-xs text-amber-800">
            No recoverable expenses were found for this lease scope and fiscal year. Add individual expenses or bulk import expense lines, then run CAM.
          </div>
        )}

        {(extractedChargeCount > 0 || extractedRuleHintCount > 0) && (
          <div className="rounded-lg border border-slate-200 bg-white p-3">
            <div className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Lease expense extraction preview</div>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <div>
                <div className="text-xs font-medium text-slate-700">Explicit lease charges</div>
                {extractionPreview.explicitCharges.length > 0 ? (
                  <div className="mt-2 space-y-2">
                    {extractionPreview.explicitCharges.map((charge) => (
                      <div key={charge.key} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-xs">
                        <span className="font-medium text-slate-700">{charge.label}</span>
                        <span className="font-semibold text-slate-900">${charge.amount.toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="mt-2 text-xs text-slate-500">No explicit recurring charge amount was extracted from the lease review payload yet.</div>
                )}
              </div>
              <div>
                <div className="text-xs font-medium text-slate-700">Rule / responsibility hints</div>
                {extractionPreview.ruleHints.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {extractionPreview.ruleHints.slice(0, 8).map((hint) => (
                      <Badge key={hint.key} className="bg-slate-100 text-slate-700">
                        {hint.label}
                      </Badge>
                    ))}
                    {extractionPreview.ruleHints.length > 8 ? (
                      <Badge className="bg-slate-100 text-slate-700">+{extractionPreview.ruleHints.length - 8} more</Badge>
                    ) : null}
                  </div>
                ) : (
                  <div className="mt-2 text-xs text-slate-500">No CAM rule hints were detected in the current extracted field set yet.</div>
                )}
              </div>
            </div>
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
            to={reviewUrl}
            disabled={!hasProperty}
            variant="outline"
            className="bg-white"
            icon={FileText}
          >
            Expense review
          </ActionLinkButton>
          <ActionLinkButton
            to={camUrl}
            disabled={!hasProperty || (!hasRecoverableExpenses && !hasApprovedRules)}
            className="bg-teal-600 hover:bg-teal-700"
            icon={Calculator}
          >
            Review CAM readiness
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

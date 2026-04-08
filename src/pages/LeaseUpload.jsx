import React, { useEffect, useMemo, useState } from "react";
import { leaseService } from "@/services/leaseService";
import useOrgId from "@/hooks/useOrgId";
import useOrgQuery from "@/hooks/useOrgQuery";
import { extractFromFile } from "@/services/documentExtractor";
import { supabase } from "@/services/supabaseClient";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import ScopeSelector from "@/components/ScopeSelector";
import { Upload, FileText, CheckCircle2, Loader2, ArrowLeft, ArrowRight, Pencil, AlertTriangle, Check, X } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { createPageUrl } from "@/utils";

const EMPTY_LEASE = {
  tenant_name: "",
  lease_type: "triple_net",
  start_date: "",
  end_date: "",
  monthly_rent: 0,
  annual_rent: 0,
  base_rent: 0,
  rent_per_sf: 0,
  square_footage: 0,
  security_deposit: 0,
  cam_amount: 0,
  escalation_rate: 3,
  renewal_options: "",
  ti_allowance: 0,
  free_rent_months: 0,
  notes: "",
  confidence_scores: {},
};

const NUMERIC_LEASE_FIELDS = new Set([
  "monthly_rent",
  "annual_rent",
  "base_rent",
  "rent_per_sf",
  "square_footage",
  "security_deposit",
  "cam_amount",
  "escalation_rate",
  "ti_allowance",
  "free_rent_months",
]);

const LONG_TEXT_LEASE_FIELDS = new Set(["notes", "renewal_options", "property_address"]);

function coerceLeaseFieldValue(field, rawValue) {
  const value = typeof rawValue === "string" ? rawValue.trim() : rawValue;
  if (NUMERIC_LEASE_FIELDS.has(field)) {
    if (value === "" || value == null) return null;
    const numericValue = Number(String(value).replace(/[$,%\s,]/g, ""));
    return Number.isFinite(numericValue) ? numericValue : null;
  }
  return value === "" ? "" : value;
}

async function resolveWritableOrgId(currentOrgId) {
  if (currentOrgId && currentOrgId !== "__none__") return currentOrgId;

  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (user?.app_metadata?.org_id) return user.app_metadata.org_id;

    const { data: membership } = await supabase
      .from("memberships")
      .select("org_id")
      .eq("user_id", user?.id)
      .limit(1)
      .maybeSingle();

    if (membership?.org_id) return membership.org_id;

    const { data: org } = await supabase
      .from("organizations")
      .select("id")
      .limit(1)
      .maybeSingle();

    return org?.id || null;
  } catch {
    return null;
  }
}

export default function LeaseUpload() {
  const { orgId } = useOrgId();
  const location = useLocation();
  const navigate = useNavigate();
  const urlParams = new URLSearchParams(location.search);
  const queryPropertyId = urlParams.get("property");
  const queryBuildingId = urlParams.get("building");
  const queryUnitId = urlParams.get("unit");
  const [step, setStep] = useState(1);
  const [file, setFile] = useState(null);
  const [extractedData, setExtractedData] = useState(null);
  const [extracting, setExtracting] = useState(false);
  const [savedLeaseId, setSavedLeaseId] = useState(null);
  const [editingField, setEditingField] = useState(null);
  const [draftFieldValue, setDraftFieldValue] = useState("");
  const [scopeProperty, setScopeProperty] = useState(queryPropertyId || "all");
  const [scopeBuilding, setScopeBuilding] = useState(queryBuildingId || "all");
  const [scopeUnit, setScopeUnit] = useState(queryUnitId || "all");

  const { data: properties = [] } = useOrgQuery("Property");
  const { data: buildings = [] } = useOrgQuery("Building");
  const { data: units = [] } = useOrgQuery("Unit");

  useEffect(() => {
    let nextProperty = queryPropertyId || "all";
    let nextBuilding = queryBuildingId || "all";
    let nextUnit = queryUnitId || "all";

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
    [buildings, scopeProperty]
  );

  const scopedUnits = useMemo(() => {
    if (scopeBuilding !== "all") {
      const buildingUnits = units.filter((unit) => unit.building_id === scopeBuilding);
      if (buildingUnits.length > 0) {
        return buildingUnits;
      }

      const selectedScopeBuilding = buildings.find((building) => building.id === scopeBuilding);
      const fallbackPropertyId =
        selectedScopeBuilding?.property_id || (scopeProperty !== "all" ? scopeProperty : null);

      if (fallbackPropertyId) {
        return units.filter((unit) => unit.property_id === fallbackPropertyId);
      }
      return [];
    }
    if (scopeProperty !== "all") {
      return units.filter((unit) => unit.property_id === scopeProperty);
    }
    return units;
  }, [units, scopeBuilding, scopeProperty, buildings]);

  const selectedProperty = scopeProperty !== "all" ? properties.find((property) => property.id === scopeProperty) ?? null : null;
  const selectedBuilding = scopeBuilding !== "all" ? buildings.find((building) => building.id === scopeBuilding) ?? null : null;
  const selectedUnit = scopeUnit !== "all" ? units.find((unit) => unit.id === scopeUnit) ?? null : null;
  const effectivePropertyId = selectedUnit?.property_id || selectedBuilding?.property_id || (scopeProperty !== "all" ? scopeProperty : null);

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

  const handlePropertyChange = (value) => {
    setScopeProperty(value);
    setScopeBuilding("all");
    setScopeUnit("all");
    updateScopeParams({ property: value, building: "all", unit: "all" });
  };

  const handleBuildingChange = (value) => {
    setScopeBuilding(value);
    setScopeUnit("all");
    updateScopeParams({ property: scopeProperty, building: value, unit: "all" });
  };

  const handleUnitChange = (value) => {
    setScopeUnit(value);
    updateScopeParams({ property: scopeProperty, building: scopeBuilding, unit: value });
  };

  const beginFieldEdit = (field, value) => {
    setEditingField(field);
    setDraftFieldValue(value == null || value === false ? "" : String(value));
  };

  const cancelFieldEdit = () => {
    setEditingField(null);
    setDraftFieldValue("");
  };

  const saveFieldEdit = (field) => {
    setExtractedData((prev) => ({
      ...prev,
      [field]: coerceLeaseFieldValue(field, draftFieldValue),
      confidence_scores: {
        ...(prev?.confidence_scores || {}),
        [field]: Math.max(prev?.confidence_scores?.[field] || 85, 95),
      },
    }));
    cancelFieldEdit();
  };

  const handleFileSelect = async (e) => {
    const selectedFile = e.target.files[0];
    if (!selectedFile) return;

    setFile(selectedFile);
    setStep(2);
    setExtracting(true);

    try {
      const result = await extractFromFile(selectedFile, "lease");
      const firstRow = result.rows?.[0] || {};
      setExtractedData({
        ...EMPTY_LEASE,
        ...firstRow,
        confidence_scores: firstRow.confidence_scores || {},
      });
    } catch {
      setExtractedData({ ...EMPTY_LEASE });
    } finally {
      setExtracting(false);
      setStep(3);
    }
  };

  const saveLease = async () => {
    if (!extractedData) return;

    try {
      const writableOrgId = await resolveWritableOrgId(orgId);
      const monthlyRent = extractedData.monthly_rent ||
        extractedData.base_rent ||
        (extractedData.annual_rent ? Math.round(Number(extractedData.annual_rent) / 12) : 0);

      const annualRent = extractedData.annual_rent || (monthlyRent * 12);

      const newLease = await leaseService.create({
        tenant_name: extractedData.tenant_name || "",
        lease_type: extractedData.lease_type || null,
        start_date: extractedData.start_date || null,
        end_date: extractedData.end_date || null,
        monthly_rent: monthlyRent,
        annual_rent: annualRent,
        rent_per_sf: extractedData.rent_per_sf || null,
        square_footage: extractedData.total_sf || extractedData.square_footage || 0,
        security_deposit: extractedData.security_deposit || 0,
        cam_amount: extractedData.cam_amount || 0,
        escalation_rate: extractedData.escalation_rate || 0,
        renewal_options: extractedData.renewal_options || null,
        ti_allowance: extractedData.ti_allowance || 0,
        free_rent_months: extractedData.free_rent_months || 0,
        notes: extractedData.notes || null,
        status: "active",
        created_by: "lease_upload",
        ...(effectivePropertyId ? { property_id: effectivePropertyId } : {}),
        ...(scopeUnit !== "all" ? { unit_id: scopeUnit } : {}),
        ...(writableOrgId ? { org_id: writableOrgId } : {}),
      });

      setSavedLeaseId(newLease.id);
      setStep(4);
    } catch (err) {
      console.error("[LeaseUpload] saveLease error:", err);
      alert("Failed to save lease: " + (err?.message || "Unknown error"));
    }
  };

  const steps = [
    { num: 1, label: "Upload Document" },
    { num: 2, label: "AI Extraction" },
    { num: 3, label: "Review Fields" },
    { num: 4, label: "Validate & Sign" },
  ];

  const confidenceColor = (score) => {
    if (score >= 90) return "text-emerald-600 bg-emerald-50";
    if (score >= 75) return "text-amber-600 bg-amber-50";
    return "text-red-600 bg-red-50";
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <Link to={createPageUrl("Leases") + location.search} className="text-sm text-slate-500 hover:text-slate-700 flex items-center gap-1">
        <ArrowLeft className="w-4 h-4" /> Back to Leases
      </Link>

      <Card>
        <CardContent className="p-4 space-y-3">
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
            onPropertyChange={handlePropertyChange}
            onBuildingChange={handleBuildingChange}
            onUnitChange={handleUnitChange}
          />
          <div className="text-xs text-slate-500">
            Scope:
            {" "}
            {[selectedProperty?.name, selectedBuilding?.name, selectedUnit?.unit_number || selectedUnit?.unit_id_code]
              .filter(Boolean)
              .join(" Â· ") || "No specific scope selected"}
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center gap-2">
        {steps.map((item, index) => (
          <React.Fragment key={item.num}>
            <div className="flex items-center gap-2">
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${
                  step >= item.num ? "bg-emerald-500 text-white" : "bg-slate-200 text-slate-500"
                }`}
              >
                {step > item.num ? <CheckCircle2 className="w-4 h-4" /> : item.num}
              </div>
              <span className={`text-sm font-medium ${step >= item.num ? "text-slate-900" : "text-slate-400"}`}>
                {item.label}
              </span>
            </div>
            {index < steps.length - 1 && <div className={`flex-1 h-0.5 ${step > item.num ? "bg-emerald-500" : "bg-slate-200"}`} />}
          </React.Fragment>
        ))}
      </div>

      {step === 1 && (
        <Card>
          <CardContent className="p-12 text-center">
            <div className="w-16 h-16 bg-slate-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
              <Upload className="w-8 h-8 text-slate-400" />
            </div>
            <h2 className="text-xl font-bold text-slate-900 mb-2">Upload Lease Document</h2>
            <p className="text-slate-500 text-sm mb-6">
              Upload PDF, Word, Excel, CSV, or text lease files.
              <br />
              The extractor will pull all identifiable lease fields for review.
            </p>
            <label>
              <input type="file" accept=".csv,.xlsx,.xls,.pdf,.docx,.doc,.txt" className="hidden" onChange={handleFileSelect} />
              <Button asChild className="bg-[#1a2744] hover:bg-[#243b67] cursor-pointer">
                <span>Browse Files</span>
              </Button>
            </label>
            <p className="text-xs text-slate-400 mt-3">Supports CSV, Excel, PDF, Word, and TXT</p>
          </CardContent>
        </Card>
      )}

      {step === 2 && (
        <Card>
          <CardContent className="p-12 text-center">
            {extracting ? (
              <Loader2 className="w-12 h-12 animate-spin text-blue-600 mx-auto mb-4" />
            ) : (
              <FileText className="w-12 h-12 text-blue-600 mx-auto mb-4" />
            )}
            <h2 className="text-xl font-bold text-slate-900 mb-2">Extraction in Progress</h2>
            <p className="text-slate-500 text-sm">Analyzing the lease document and extracting fields...</p>
            <p className="text-xs text-slate-400 mt-2">{file?.name}</p>
          </CardContent>
        </Card>
      )}

      {step === 3 && extractedData && (
        <div className="grid lg:grid-cols-2 gap-6">
          <Card>
            <CardContent className="p-4">
              <div className="bg-slate-100 rounded-lg p-8 min-h-[500px] flex items-center justify-center">
                <div className="text-center">
                  <FileText className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                  <p className="text-sm text-slate-400">{file?.name}</p>
                  <p className="text-xs text-slate-300 mt-1">Document Preview</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-slate-900">Extraction Results</h2>
              <div className="flex gap-2 text-xs">
                <Badge className="bg-emerald-50 text-emerald-700">review all fields</Badge>
              </div>
            </div>
            {Object.entries(extractedData)
              .filter(([key]) => key !== "confidence_scores")
              .map(([key, value]) => (
                <Card key={key} className="border">
                  <CardContent className="p-4 flex items-start justify-between">
                    <div className="flex-1 pr-4">
                      <div className="flex items-center gap-2">
                        <p className="text-[10px] font-semibold text-slate-500 uppercase">{key.replace(/_/g, " ")}</p>
                        <Badge className={`text-[10px] ${confidenceColor(extractedData.confidence_scores?.[key] || 85)}`}>
                          {extractedData.confidence_scores?.[key] || 85}%
                        </Badge>
                      </div>
                      {editingField === key ? (
                        LONG_TEXT_LEASE_FIELDS.has(key) ? (
                          <textarea
                            value={draftFieldValue}
                            onChange={(e) => setDraftFieldValue(e.target.value)}
                            className="mt-2 w-full min-h-[88px] rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                            placeholder={`Enter ${key.replace(/_/g, " ")}`}
                          />
                        ) : (
                          <input
                            autoFocus
                            value={draftFieldValue}
                            onChange={(e) => setDraftFieldValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") saveFieldEdit(key);
                              if (e.key === "Escape") cancelFieldEdit();
                            }}
                            className="mt-2 w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                            placeholder={`Enter ${key.replace(/_/g, " ")}`}
                          />
                        )
                      ) : (
                        <p className="text-sm font-medium text-slate-900 mt-1">
                          {value === true ? "Yes" : value === false ? "No" : String(value || "—")}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      {editingField === key ? (
                        <>
                          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => saveFieldEdit(key)}>
                            <Check className="w-3.5 h-3.5 text-emerald-600" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={cancelFieldEdit}>
                            <X className="w-3.5 h-3.5 text-slate-500" />
                          </Button>
                        </>
                      ) : (
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => beginFieldEdit(key, value)}>
                          <Pencil className="w-3.5 h-3.5" />
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
            <div className="flex gap-3 pt-4">
              <Button variant="outline" onClick={() => setStep(1)}>Re-upload Document</Button>
              <Button onClick={saveLease} className="flex-1 bg-[#1a2744] hover:bg-[#243b67]">
                Proceed to Validation <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            </div>
          </div>
        </div>
      )}

      {step === 4 && (
        <Card>
          <CardContent className="p-8 text-center">
            <CheckCircle2 className="w-16 h-16 text-emerald-500 mx-auto mb-4" />
            <h2 className="text-xl font-bold text-slate-900 mb-2">Lease Saved Successfully</h2>
            <p className="text-slate-500 text-sm mb-4">The lease has been extracted and saved. You can now review and validate it.</p>
            {extractedData?.confidence_scores && Object.values(extractedData.confidence_scores).some((score) => typeof score === "number" && score < 70) && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-6 flex items-center gap-3 text-left max-w-lg mx-auto">
                <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-red-800">Low Confidence Fields Detected</p>
                  <p className="text-xs text-red-600 mt-0.5">
                    Budget start is blocked until a human reviews and corrects the flagged fields. Open the Lease Review to resolve.
                  </p>
                </div>
              </div>
            )}
            <div className="flex gap-3 justify-center">
              <Link to={createPageUrl("Leases") + location.search}><Button variant="outline">Back to Leases</Button></Link>
              <Link to={createPageUrl("LeaseReview") + (savedLeaseId ? `?id=${savedLeaseId}` : "")}>
                <Button className="bg-[#1a2744]">Review & Validate</Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}


import React, { useState } from "react";
import { leaseService } from "@/services/leaseService";
import useOrgId from "@/hooks/useOrgId";
import { extractFromFile } from "@/services/documentExtractor";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Upload, FileText, CheckCircle2, Loader2, ArrowLeft, ArrowRight, Pencil, AlertTriangle } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
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

export default function LeaseUpload() {
  const { orgId } = useOrgId();
  const location = useLocation();
  const urlParams = new URLSearchParams(location.search);
  const [step, setStep] = useState(1);
  const [file, setFile] = useState(null);
  const [extractedData, setExtractedData] = useState(null);
  const [extracting, setExtracting] = useState(false);
  const [savedLeaseId, setSavedLeaseId] = useState(null);

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
        ...(urlParams.get("property") ? { property_id: urlParams.get("property") } : {}),
        ...(urlParams.get("unit") ? { unit_id: urlParams.get("unit") } : {}),
        ...(orgId && orgId !== "__none__" ? { org_id: orgId } : {}),
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
      <Link to={createPageUrl("Leases")} className="text-sm text-slate-500 hover:text-slate-700 flex items-center gap-1">
        <ArrowLeft className="w-4 h-4" /> Back to Leases
      </Link>

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
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-[10px] font-semibold text-slate-500 uppercase">{key.replace(/_/g, " ")}</p>
                        <Badge className={`text-[10px] ${confidenceColor(extractedData.confidence_scores?.[key] || 85)}`}>
                          {extractedData.confidence_scores?.[key] || 85}%
                        </Badge>
                      </div>
                      <p className="text-sm font-medium text-slate-900 mt-1">
                        {value === true ? "Yes" : value === false ? "No" : String(value || "—")}
                      </p>
                    </div>
                    <Button variant="ghost" size="icon" className="h-8 w-8">
                      <Pencil className="w-3.5 h-3.5" />
                    </Button>
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
              <Link to={createPageUrl("Leases")}><Button variant="outline">Back to Leases</Button></Link>
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

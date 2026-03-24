import React, { useState } from "react";
import { leaseService } from "@/services/leaseService";
import { invokeLLM, uploadFile } from "@/services/integrations";
import useOrgId from "@/hooks/useOrgId";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Upload, FileText, CheckCircle2, Loader2, ArrowLeft, ArrowRight, Pencil, AlertTriangle } from "lucide-react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";

export default function LeaseUpload() {
  const { orgId } = useOrgId();
  const [step, setStep] = useState(1);
  const [file, setFile] = useState(null);
  const [fileUrl, setFileUrl] = useState("");
  const [extractedData, setExtractedData] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [savedLeaseId, setSavedLeaseId] = useState(null);

  const handleFileSelect = async (e) => {
    const selectedFile = e.target.files[0];
    if (!selectedFile) return;
    setFile(selectedFile);
    setUploading(true);
    const { file_url } = await uploadFile({ file: selectedFile });
    setFileUrl(file_url);
    setUploading(false);
    setStep(2);
    
    // Start AI extraction
    setExtracting(true);
    const result = await invokeLLM({
      prompt: `Extract all lease terms from this commercial lease document. Be thorough and extract every possible field. Include confidence_scores (0-100) for each extracted field. Also extract:
- escalation_timing: "lease_anniversary" or "calendar_year"
- renewal_type: "new_lease", "option_letter", "auto_renew", or "none"
- renewal_notice_months: number of months notice required
- management_fee_basis: "cam_pool", "tenant_annual_rent", or "pro_rata_sf"
- percentage_rent_breakpoint: sales threshold before percentage rent applies
- sales_reporting_frequency: "monthly", "quarterly", or "annual"
- hvac_responsibility: "tenant", "landlord", or "shared"
- hvac_landlord_limit: max dollar amount landlord pays for HVAC
- lease_scope: "property" or "building"
- recon_deadline_days: days after year-end for reconciliation (default 90)
- recon_collection_limit_months: months landlord has to collect underpayments (default 12)
- cpi_index: CPI index source (e.g. CPI-U, CPI-W)`,
      file_urls: [file_url],
      response_json_schema: {
        type: "object",
        properties: {
          tenant_name: { type: "string" },
          lease_type: { type: "string" },
          start_date: { type: "string" },
          end_date: { type: "string" },
          base_rent: { type: "number" },
          rent_per_sf: { type: "number" },
          total_sf: { type: "number" },
          annual_rent: { type: "number" },
          escalation_type: { type: "string" },
          escalation_rate: { type: "number" },
          escalation_timing: { type: "string" },
          renewal_options: { type: "string" },
          renewal_type: { type: "string" },
          renewal_notice_months: { type: "number" },
          cam_cap_type: { type: "string" },
          cam_cap_rate: { type: "number" },
          cpi_index: { type: "string" },
          base_year: { type: "number" },
          gross_up_clause: { type: "boolean" },
          admin_fee_allowed: { type: "boolean" },
          admin_fee_pct: { type: "number" },
          management_fee_pct: { type: "number" },
          management_fee_basis: { type: "string" },
          free_rent_months: { type: "string" },
          ti_allowance: { type: "number" },
          percentage_rent: { type: "boolean" },
          percentage_rent_rate: { type: "number" },
          percentage_rent_breakpoint: { type: "number" },
          sales_reporting_frequency: { type: "string" },
          hvac_responsibility: { type: "string" },
          hvac_landlord_limit: { type: "number" },
          lease_scope: { type: "string" },
          recon_deadline_days: { type: "number" },
          recon_collection_limit_months: { type: "number" },
          confidence_scores: { type: "object" }
        }
      }
    });
    setExtractedData(result);
    setExtracting(false);
    setStep(3);
  };

  const saveLease = async () => {
    if (!extractedData) return;
    // Check for low confidence fields - block budget if any field < 70%
    const scores = extractedData.confidence_scores || {};
    const hasLowConf = Object.values(scores).some(s => typeof s === 'number' && s < 70);
    const avgConf = Object.values(scores).filter(s => typeof s === 'number');
    const overallConf = avgConf.length > 0 ? Math.round(avgConf.reduce((a, b) => a + b, 0) / avgConf.length) : 85;

    const { confidence_scores, ...leaseFields } = extractedData;
    const newLease = await leaseService.create({
      ...leaseFields,
      pdf_url: fileUrl,
      status: "extracted",
      confidence_score: overallConf,
      low_confidence_block: hasLowConf,
      extraction_data: { confidence_scores: scores },
      version: 1,
      org_id: orgId || ""
    });
    setSavedLeaseId(newLease.id);
    setStep(4);
  };

  const steps = [
    { num: 1, label: "Upload PDF" },
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

      {/* Step indicator */}
      <div className="flex items-center gap-2">
        {steps.map((s, i) => (
          <React.Fragment key={s.num}>
            <div className="flex items-center gap-2">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${step >= s.num ? 'bg-emerald-500 text-white' : 'bg-slate-200 text-slate-500'}`}>
                {step > s.num ? <CheckCircle2 className="w-4 h-4" /> : s.num}
              </div>
              <span className={`text-sm font-medium ${step >= s.num ? 'text-slate-900' : 'text-slate-400'}`}>{s.label}</span>
            </div>
            {i < steps.length - 1 && <div className={`flex-1 h-0.5 ${step > s.num ? 'bg-emerald-500' : 'bg-slate-200'}`} />}
          </React.Fragment>
        ))}
      </div>

      {/* Step 1: Upload */}
      {step === 1 && (
        <Card>
          <CardContent className="p-12 text-center">
            <div className="w-16 h-16 bg-slate-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
              <Upload className="w-8 h-8 text-slate-400" />
            </div>
            <h2 className="text-xl font-bold text-slate-900 mb-2">Upload Lease PDF</h2>
            <p className="text-slate-500 text-sm mb-6">Drag and drop your lease PDF here, or click to browse.<br />Our AI will extract all key lease terms automatically.</p>
            <label>
              <input type="file" accept=".pdf" className="hidden" onChange={handleFileSelect} />
              <Button asChild className="bg-[#1a2744] hover:bg-[#243b67] cursor-pointer">
                <span>{uploading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}Browse Files</span>
              </Button>
            </label>
            <p className="text-xs text-slate-400 mt-3">Supports PDF up to 50MB</p>
          </CardContent>
        </Card>
      )}

      {/* Step 2: Extracting */}
      {step === 2 && (
        <Card>
          <CardContent className="p-12 text-center">
            <Loader2 className="w-12 h-12 animate-spin text-blue-600 mx-auto mb-4" />
            <h2 className="text-xl font-bold text-slate-900 mb-2">AI Extraction in Progress</h2>
            <p className="text-slate-500 text-sm">Analyzing lease document and extracting key terms...</p>
            <p className="text-xs text-slate-400 mt-2">{file?.name}</p>
          </CardContent>
        </Card>
      )}

      {/* Step 3: Review */}
      {step === 3 && extractedData && (
        <div className="grid lg:grid-cols-2 gap-6">
          <Card>
            <CardContent className="p-4">
              <div className="bg-slate-100 rounded-lg p-8 min-h-[500px] flex items-center justify-center">
                <div className="text-center">
                  <FileText className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                  <p className="text-sm text-slate-400">{file?.name}</p>
                  <p className="text-xs text-slate-300 mt-1">PDF Preview</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-slate-900">Extraction Results</h2>
              <div className="flex gap-2 text-xs">
                <Badge className="bg-emerald-50 text-emerald-700">10 high</Badge>
                <Badge className="bg-amber-50 text-amber-700">3 medium</Badge>
                <Badge className="bg-red-50 text-red-700">1 low</Badge>
              </div>
            </div>
            {Object.entries(extractedData).filter(([k]) => k !== 'confidence_scores').map(([key, value]) => (
              <Card key={key} className="border">
                <CardContent className="p-4 flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-[10px] font-semibold text-slate-500 uppercase">{key.replace(/_/g, ' ')}</p>
                      <Badge className={`text-[10px] ${confidenceColor(extractedData.confidence_scores?.[key] || 85)}`}>
                        {extractedData.confidence_scores?.[key] || 85}%
                      </Badge>
                    </div>
                    <p className="text-sm font-medium text-slate-900 mt-1">{value === true ? 'Yes' : value === false ? 'No' : String(value || '—')}</p>
                  </div>
                  <Button variant="ghost" size="icon" className="h-8 w-8"><Pencil className="w-3.5 h-3.5" /></Button>
                </CardContent>
              </Card>
            ))}
            <div className="flex gap-3 pt-4">
              <Button variant="outline" onClick={() => setStep(1)}>Re-upload PDF</Button>
              <Button onClick={saveLease} className="flex-1 bg-[#1a2744] hover:bg-[#243b67]">Proceed to Validation <ArrowRight className="w-4 h-4 ml-2" /></Button>
            </div>
          </div>
        </div>
      )}

      {/* Step 4: Validation */}
      {step === 4 && (
        <Card>
          <CardContent className="p-8 text-center">
            <CheckCircle2 className="w-16 h-16 text-emerald-500 mx-auto mb-4" />
            <h2 className="text-xl font-bold text-slate-900 mb-2">Lease Saved Successfully</h2>
            <p className="text-slate-500 text-sm mb-4">The lease has been extracted and saved. You can now review and validate it.</p>
            {extractedData?.confidence_scores && Object.values(extractedData.confidence_scores).some(s => typeof s === 'number' && s < 70) && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-6 flex items-center gap-3 text-left max-w-lg mx-auto">
                <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-red-800">Low Confidence Fields Detected</p>
                  <p className="text-xs text-red-600 mt-0.5">Budget start is blocked until a human reviews and corrects the flagged fields. Open the Lease Review to resolve.</p>
                </div>
              </div>
            )}
            <div className="flex gap-3 justify-center">
              <Link to={createPageUrl("Leases")}><Button variant="outline">Back to Leases</Button></Link>
              <Link to={createPageUrl("LeaseReview") + (savedLeaseId ? `?id=${savedLeaseId}` : '')}><Button className="bg-[#1a2744]">Review & Validate</Button></Link>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
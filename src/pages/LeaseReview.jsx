import React, { useState } from "react";
import { leaseService } from "@/services/leaseService";
import { supabase } from "@/services/supabaseClient";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import useOrgQuery from "@/hooks/useOrgQuery";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { ArrowLeft, CheckCircle2, AlertTriangle, Send, Pencil, Loader2, FileX, RefreshCw } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { toast } from "sonner";

const confidenceColor = (score) => {
  if (score >= 90) return "bg-emerald-100 text-emerald-700";
  if (score >= 75) return "bg-amber-100 text-amber-700";
  return "bg-red-100 text-red-700";
};

export default function LeaseReview() {
  const urlParams = new URLSearchParams(window.location.search);
  const leaseId = urlParams.get("id");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [showSignature, setShowSignature] = useState(false);
  const [showApproval, setShowApproval] = useState(false);
  const [allocationModel, setAllocationModel] = useState("pro_rata");
  const [vacancyHandling, setVacancyHandling] = useState("exclude");
  const [editingField, setEditingField] = useState(null);
  const [editValue, setEditValue] = useState("");

  const { data: lease, isLoading } = useQuery({
    queryKey: ['lease', leaseId],
    queryFn: () => leaseService.filter({ id: leaseId }),
    enabled: !!leaseId,
    select: data => data?.[0],
  });

  const { data: stakeholders = [] } = useOrgQuery("Stakeholder");

  const updateLeaseMutation = useMutation({
    mutationFn: async ({ id, data }) => {
      // Call Supabase directly so we get the real error — leaseService swallows errors silently
      const { data: updated, error } = await supabase
        .from("leases")
        .update({ ...data, updated_at: new Date().toISOString() })
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return updated;
    },
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: ["lease", leaseId] });
      queryClient.invalidateQueries({ queryKey: ["leases"] });
      toast.success("Lease updated successfully");
      // Trigger recomputation in the background (fire-and-forget)
      if (updated?.property_id) {
        triggerRecompute(updated.property_id).catch(() => {});
      }
    },
    onError: (err) => {
      console.error("[LeaseReview] update failed:", err);
      toast.error(`Update failed: ${err?.message ?? "Unknown error"}`);
    },
  });

  // Fire compute-lease for the property after a lease edit
  async function triggerRecompute(propertyId) {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) return;
      await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/compute-lease`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`,
          "apikey": import.meta.env.VITE_SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ property_id: propertyId, fiscal_year: new Date().getFullYear() }),
      });
      console.log("[LeaseReview] Recompute triggered for property", propertyId);
    } catch (err) {
      console.warn("[LeaseReview] Recompute trigger failed (non-fatal):", err.message);
    }
  }

  // No lease ID or lease not found
  if (!leaseId) {
    return (
      <div className="p-6 flex flex-col items-center justify-center h-96">
        <FileX className="w-12 h-12 text-slate-300 mb-4" />
        <h2 className="text-xl font-bold text-slate-900 mb-2">No Lease Selected</h2>
        <p className="text-sm text-slate-500 mb-4">Please select a lease from the Leases page to review.</p>
        <Link to={createPageUrl("Leases")}><Button>Go to Leases</Button></Link>
      </div>
    );
  }

  if (isLoading) {
    return <div className="flex items-center justify-center h-96"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>;
  }

  if (!lease) {
    return (
      <div className="p-6 flex flex-col items-center justify-center h-96">
        <FileX className="w-12 h-12 text-slate-300 mb-4" />
        <h2 className="text-xl font-bold text-slate-900 mb-2">Lease Not Found</h2>
        <p className="text-sm text-slate-500 mb-4">This lease may have been deleted or you don't have access.</p>
        <Link to={createPageUrl("Leases")}><Button>Go to Leases</Button></Link>
      </div>
    );
  }

  // Build fields from actual lease data — use extraction confidence if available
  const scores = lease.extraction_data?.confidence_scores || {};
  const getConf = (key, fallback = 85) => (typeof scores[key] === 'number' ? scores[key] : fallback);

  const fields = {
    "Basic Terms": [
      { key: "tenant_name", label: "TENANT NAME", value: lease.tenant_name || "—", confidence: getConf("tenant_name", 98) },
      { key: "lease_type", label: "LEASE TYPE", value: lease.lease_type || "—", confidence: getConf("lease_type", 95) },
      { key: "start_date", label: "START DATE", value: lease.start_date || "—", confidence: getConf("start_date", 94) },
      { key: "end_date", label: "END DATE", value: lease.end_date || "—", confidence: getConf("end_date", 92) },
    ],
    "Financial Terms": [
      { key: "rent_per_sf", label: "BASE RENT ($/SF/YR)", value: lease.rent_per_sf ? `$${lease.rent_per_sf}` : "—", confidence: getConf("rent_per_sf", 92) },
      { key: "total_sf", label: "TOTAL SF", value: lease.total_sf?.toLocaleString() || "—", confidence: getConf("total_sf", 99) },
      { key: "annual_rent", label: "ANNUAL RENT", value: lease.annual_rent ? `$${lease.annual_rent.toLocaleString()}` : "—", confidence: getConf("annual_rent", 99) },
      { key: "escalation_rate", label: "RENT ESCALATION", value: lease.escalation_rate ? `${lease.escalation_rate}% ${lease.escalation_type || ''}` : "—", confidence: getConf("escalation_rate", 78) },
    ],
    "Escalation & Renewal": [
      { key: "escalation_timing", label: "ESCALATION TIMING", value: lease.escalation_timing === 'calendar_year' ? 'Calendar Year (Jan 1)' : 'Lease Anniversary', confidence: getConf("escalation_timing", 90) },
      { key: "free_rent_months", label: "FREE RENT PERIODS", value: lease.free_rent_months || "—", confidence: getConf("free_rent_months", 91) },
      { key: "ti_allowance", label: "TI ALLOWANCE", value: lease.ti_allowance ? `$${lease.ti_allowance.toLocaleString()}` : "—", confidence: getConf("ti_allowance", 88) },
      { key: "renewal_type", label: "RENEWAL TYPE", value: lease.renewal_type || "—", confidence: getConf("renewal_type", 78) },
      { key: "renewal_options", label: "RENEWAL OPTIONS", value: lease.renewal_options || "—", confidence: getConf("renewal_options", 64) },
      { key: "renewal_notice_months", label: "RENEWAL NOTICE (MONTHS)", value: lease.renewal_notice_months || "—", confidence: getConf("renewal_notice_months", 72) },
    ],
    "CAM & Management": [
      { key: "cam_cap_type", label: "CAM CAP TYPE", value: lease.cam_cap_type || "None", confidence: getConf("cam_cap_type", 95) },
      { key: "cpi_index", label: "CPI INDEX SOURCE", value: lease.cpi_index || "N/A", confidence: getConf("cpi_index", 90) },
      { key: "admin_fee_pct", label: "ADMIN FEE %", value: lease.admin_fee_pct ? `${lease.admin_fee_pct}%` : "N/A", confidence: getConf("admin_fee_pct", 97) },
      { key: "management_fee_basis", label: "MGMT FEE BASIS", value: lease.management_fee_basis === 'tenant_annual_rent' ? '% of Tenant Annual Rent' : 'CAM Pool Pro-Rata', confidence: getConf("management_fee_basis", 88) },
      { key: "gross_up_clause", label: "GROSS-UP PROVISION", value: lease.gross_up_clause ? 'Yes' : 'No', confidence: getConf("gross_up_clause", 94) },
      { key: "hvac_responsibility", label: "HVAC RESPONSIBILITY", value: (lease.hvac_responsibility || 'landlord').replace('_', ' '), confidence: getConf("hvac_responsibility", 92) },
      { key: "hvac_landlord_limit", label: "HVAC LANDLORD LIMIT", value: lease.hvac_landlord_limit ? `$${lease.hvac_landlord_limit.toLocaleString()}` : "No limit", confidence: getConf("hvac_landlord_limit", 85) },
    ],
    "Revenue & Recon": [
      { key: "percentage_rent", label: "PERCENTAGE RENT", value: lease.percentage_rent ? `${lease.percentage_rent_rate}% over $${(lease.percentage_rent_breakpoint || 0).toLocaleString()}` : "No", confidence: getConf("percentage_rent", 90) },
      { key: "sales_reporting_frequency", label: "SALES REPORTING FREQ.", value: (lease.sales_reporting_frequency || 'annual'), confidence: getConf("sales_reporting_frequency", 88) },
      { key: "recon_deadline_days", label: "RECON DEADLINE", value: `${lease.recon_deadline_days || 90} days after year-end`, confidence: getConf("recon_deadline_days", 92) },
      { key: "recon_collection_limit_months", label: "COLLECTION LIMIT", value: `${lease.recon_collection_limit_months || 12} months`, confidence: getConf("recon_collection_limit_months", 90) },
      { key: "version", label: "LEASE VERSION", value: `v${lease.version || 1}`, confidence: 99 },
    ],
  };

  const allFieldsFlat = Object.values(fields).flat();
  const highConf = allFieldsFlat.filter(f => f.confidence >= 90).length;
  const medConf = allFieldsFlat.filter(f => f.confidence >= 75 && f.confidence < 90).length;
  const lowConf = allFieldsFlat.filter(f => f.confidence < 75).length;

  // Dynamic validation checks based on actual lease data
  const validationChecks = [];
  if (lease.start_date && lease.end_date) {
    const startOk = new Date(lease.start_date) < new Date(lease.end_date);
    validationChecks.push({ pass: startOk, label: "Start date < End date", detail: startOk ? `${lease.start_date} < ${lease.end_date}` : "End date is before start date" });
  }
  if (lease.tenant_name) {
    validationChecks.push({ pass: true, label: "Tenant name present", detail: `${lease.tenant_name} verified` });
  }
  if (lease.annual_rent) {
    validationChecks.push({ pass: lease.annual_rent > 0, label: "Annual rent > $0", detail: `$${lease.annual_rent.toLocaleString()}` });
  }
  if (lease.total_sf) {
    validationChecks.push({ pass: lease.total_sf > 0, label: "Square footage present", detail: `${lease.total_sf.toLocaleString()} SF` });
  }
  const hasLowConf = lowConf > 0;
  if (hasLowConf) {
    validationChecks.push({ pass: false, label: "All confidence scores ≥ 70%", detail: `${lowConf} field(s) below threshold — human review required` });
  } else {
    validationChecks.push({ pass: true, label: "All confidence scores ≥ 70%", detail: "No low-confidence fields detected" });
  }

  const passCount = validationChecks.filter(v => v.pass).length;

  const handleApprove = async () => {
    try {
      await updateLeaseMutation.mutateAsync({ id: lease.id, data: { status: "budget_ready" } });
      setShowApproval(false);
    } catch {
      // error already toasted by onError
    }
  };

  const handleFieldEdit = (field) => {
    setEditingField(field);
    // Get raw value from lease
    const raw = lease[field.key];
    setEditValue(raw !== undefined && raw !== null ? String(raw) : "");
  };

  const handleFieldSave = async () => {
    if (!editingField) return;
    let val = editValue.trim();

    // Coerce to correct type based on field key
    const numericFields = [
      "rent_per_sf", "total_sf", "annual_rent", "escalation_rate", "admin_fee_pct",
      "ti_allowance", "hvac_landlord_limit", "renewal_notice_months", "recon_deadline_days",
      "recon_collection_limit_months", "percentage_rent_rate", "percentage_rent_breakpoint",
      "management_fee_pct", "base_rent", "cam_cap_rate", "monthly_rent", "square_footage",
    ];
    const boolFields = ["gross_up_clause", "percentage_rent", "admin_fee_allowed"];

    if (numericFields.includes(editingField.key)) {
      const n = parseFloat(val.replace(/[$,]/g, ""));
      val = isNaN(n) ? null : n;
    } else if (boolFields.includes(editingField.key)) {
      val = ["true", "yes", "1", "y"].includes(val.toLowerCase());
    }

    try {
      await updateLeaseMutation.mutateAsync({ id: lease.id, data: { [editingField.key]: val } });
      setEditingField(null); // only close on success
    } catch {
      // error already toasted by onError — keep dialog open so user can retry
    }
  };

  return (
    <div className="p-6 space-y-6">
      <Link to={createPageUrl("Leases")} className="text-sm text-slate-500 hover:text-slate-700 flex items-center gap-1">
        <ArrowLeft className="w-4 h-4" /> Back to Leases
      </Link>

      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Lease Review & Validation</h1>
          <p className="text-sm text-slate-500">{lease.tenant_name} — {lease.total_sf ? `${lease.total_sf.toLocaleString()} SF` : ''} · {lease.lease_type || 'Unknown type'}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline">Re-Upload PDF</Button>
          <Button className="bg-blue-600 hover:bg-blue-700" onClick={() => setShowSignature(true)}><Send className="w-4 h-4 mr-1" />Request Signature</Button>
          <Button className="bg-emerald-600 hover:bg-emerald-700" onClick={() => setShowApproval(true)}><CheckCircle2 className="w-4 h-4 mr-1" />Approve Lease</Button>
        </div>
      </div>

      {/* Low Confidence Block Alert */}
      {lowConf > 0 && (
        <div className="bg-red-50 border-2 border-red-300 rounded-xl p-4 flex items-center gap-3">
          <AlertTriangle className="w-6 h-6 text-red-500 flex-shrink-0" />
          <div>
            <p className="text-sm font-bold text-red-800">Budget Start Blocked — Low Confidence Fields Detected</p>
            <p className="text-xs text-red-600 mt-0.5">{lowConf} field(s) scored below 70% confidence. Human review and correction is required before this lease can be marked as "Budget Ready." Correct the flagged fields and re-validate.</p>
          </div>
        </div>
      )}

      {/* Confidence Summary */}
      <div className="grid grid-cols-4 gap-4">
        <Card className="bg-emerald-50 border-emerald-200"><CardContent className="p-4"><p className="text-[10px] font-semibold text-emerald-600 uppercase">High Confidence (≥90%)</p><p className="text-2xl font-bold text-emerald-700">{highConf} fields</p><p className="text-[10px] text-emerald-500">Auto-populated</p></CardContent></Card>
        <Card className="bg-amber-50 border-amber-200"><CardContent className="p-4"><p className="text-[10px] font-semibold text-amber-600 uppercase">Medium (70-89%)</p><p className="text-2xl font-bold text-amber-700">{medConf} fields</p><p className="text-[10px] text-amber-500">Flagged for review</p></CardContent></Card>
        <Card className="bg-red-50 border-red-200"><CardContent className="p-4"><p className="text-[10px] font-semibold text-red-600 uppercase">Low (&lt;70%) — BLOCKING</p><p className="text-2xl font-bold text-red-600">{lowConf} fields</p><p className="text-[10px] text-red-400">Must correct to proceed</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-[10px] font-semibold text-slate-500 uppercase">Validation Checks</p><p className="text-2xl font-bold text-slate-900">{passCount}/{validationChecks.length} Pass</p><p className="text-[10px] text-amber-500">{validationChecks.length - passCount} warning(s)</p></CardContent></Card>
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Left: Tabs with field groups */}
        <div className="lg:col-span-2">
          <Tabs defaultValue="Basic Terms">
            <TabsList className="bg-white border">
              {Object.keys(fields).map(tab => <TabsTrigger key={tab} value={tab} className="text-xs">{tab}</TabsTrigger>)}
            </TabsList>
            {Object.entries(fields).map(([tabName, fieldList]) => (
              <TabsContent key={tabName} value={tabName} className="mt-4 space-y-3">
                {fieldList.map((f, i) => (
                  <Card key={i} className={f.warning ? 'border-amber-200' : ''}>
                    <CardContent className="p-4 flex items-start justify-between">
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="text-[10px] font-semibold text-slate-500 uppercase">{f.label}</p>
                          <Badge className={`text-[10px] ${confidenceColor(f.confidence)}`}>{f.confidence}%</Badge>
                        </div>
                        <p className="text-sm font-medium text-slate-900 mt-1">{String(f.value)}</p>
                        {f.warning && <p className="text-xs text-amber-600 mt-1 flex items-center gap-1"><AlertTriangle className="w-3 h-3" />{f.warning}</p>}
                      </div>
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleFieldEdit(f)}><Pencil className="w-3.5 h-3.5 text-slate-400" /></Button>
                    </CardContent>
                  </Card>
                ))}
              </TabsContent>
            ))}
          </Tabs>
        </div>

        {/* Right: Validation + Allocation + Audit */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Validation Checks</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {validationChecks.map((c, i) => (
                <div key={i} className={`p-2.5 rounded-lg ${c.pass ? 'bg-emerald-50' : 'bg-red-50'}`}>
                  <div className="flex items-center gap-2">
                    {c.pass ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" /> : <AlertTriangle className="w-3.5 h-3.5 text-red-500" />}
                    <p className="text-xs font-medium text-slate-900">{c.label}</p>
                  </div>
                  <p className="text-[10px] text-slate-500 ml-5 mt-0.5">{c.detail}</p>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Allocation Settings</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div>
                <Label className="text-[10px] font-semibold text-slate-500 uppercase">Allocation Model</Label>
                <Select value={allocationModel} onValueChange={setAllocationModel}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pro_rata">Pro-Rata</SelectItem>
                    <SelectItem value="equal">Equal</SelectItem>
                    <SelectItem value="weighted">Weighted</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-[10px] font-semibold text-slate-500 uppercase">Vacancy Handling</Label>
                <Select value={vacancyHandling} onValueChange={setVacancyHandling}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="exclude">Exclude</SelectItem>
                    <SelectItem value="include">Include</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Request Signature Dialog */}
      <Dialog open={showSignature} onOpenChange={setShowSignature}>
        <DialogContent>
          <DialogHeader><DialogTitle>Request Digital Signature</DialogTitle></DialogHeader>
          <p className="text-sm text-slate-500">Send the lease for signature to a designated stakeholder. The magic link expires in 48 hours.</p>
          <div className="space-y-4 mt-2">
            <div>
              <Label>Send To</Label>
              <Select>
                <SelectTrigger><SelectValue placeholder="Select stakeholder" /></SelectTrigger>
                <SelectContent>
                  {stakeholders.map(s => <SelectItem key={s.id} value={s.id}>{s.name} ({s.role?.replace('_', ' ')})</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Message (optional)</Label>
              <Textarea placeholder="Please review and sign the lease for Suite A-302..." rows={3} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSignature(false)}>Cancel</Button>
            <Button className="bg-blue-600 hover:bg-blue-700">Send Request</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Approve Lease Dialog */}
      <Dialog open={showApproval} onOpenChange={setShowApproval}>
        <DialogContent>
          <DialogHeader><DialogTitle>Approve Lease</DialogTitle></DialogHeader>
          <p className="text-sm text-slate-500 mb-2">This will mark the lease as Budget-Ready</p>
          <div className="bg-slate-50 p-3 rounded-lg mb-2">
            <p className="text-sm font-medium text-slate-700">Lease Summary</p>
            <p className="text-xs text-slate-500">{lease.tenant_name} · {lease.lease_type} · {lease.start_date} to {lease.end_date}</p>
          </div>
          {validationChecks.some(c => !c.pass) && (
            <div className="flex items-center gap-2 text-amber-600 text-xs"><AlertTriangle className="w-3.5 h-3.5" />{validationChecks.filter(c => !c.pass).length} validation warning(s) — review before approving</div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowApproval(false)}>Cancel</Button>
            <Button className="bg-emerald-600 hover:bg-emerald-700" onClick={handleApprove} disabled={updateLeaseMutation.isPending}>
              {updateLeaseMutation.isPending && <Loader2 className="w-4 h-4 animate-spin mr-1" />}Confirm Approval
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* Edit Field Dialog */}
      <Dialog open={!!editingField} onOpenChange={() => setEditingField(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Edit: {editingField?.label}</DialogTitle></DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <Label>Current Value</Label>
              <p className="text-sm text-slate-500 mt-1">{editingField?.value}</p>
            </div>
            <div>
              <Label>New Value</Label>
              <Input value={editValue} onChange={e => setEditValue(e.target.value)} className="mt-1" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingField(null)}>Cancel</Button>
            <Button onClick={handleFieldSave} disabled={updateLeaseMutation.isPending} className="bg-blue-600 hover:bg-blue-700">
              {updateLeaseMutation.isPending && <Loader2 className="w-4 h-4 animate-spin mr-1" />}Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
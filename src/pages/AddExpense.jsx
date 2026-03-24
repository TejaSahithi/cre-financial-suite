import React, { useState } from "react";
import { expenseService } from "@/services/expenseService";
import { vendorService } from "@/services/vendorService";
import { uploadFile } from "@/services/integrations";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import useOrgQuery from "@/hooks/useOrgQuery";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Loader2, Paperclip, ArrowLeft, Plus } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { createPageUrl } from "@/utils";

const CATEGORIES = [
  "property_tax", "insurance", "utilities", "landscaping", "snow_removal",
  "parking_lot_maintenance", "elevator_maintenance", "security", "janitorial",
  "trash_removal", "fire_systems", "hvac_maintenance", "plumbing", "electrical",
  "roof_repairs", "pest_control", "management_fee", "administrative_fee",
  "general_repairs", "lobby_maintenance", "cleaning", "accounting", "legal_fees",
  "capital_improvements", "structural_repairs", "other"
];

const VENDOR_CATEGORIES = ["maintenance","utilities","insurance","janitorial","landscaping","security","legal","accounting","construction","technology","other"];

export default function AddExpense() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    date: "", amount: "", category: "", vendor: "", vendor_id: "", description: "", classification: "recoverable", property_id: ""
  });
  const [attachmentUrl, setAttachmentUrl] = useState("");
  const [uploading, setUploading] = useState(false);
  const [showNewVendor, setShowNewVendor] = useState(false);
  const [newVendorForm, setNewVendorForm] = useState({ name: "", company: "", contact_email: "", category: "other", payment_terms: "net_30" });

  const { data: vendors = [], orgId } = useOrgQuery("Vendor");
  const { data: properties = [] } = useOrgQuery("Property");

  const createMutation = useMutation({
    mutationFn: (data) => expenseService.create(data),
    onSuccess: () => navigate(createPageUrl("Expenses")),
  });

  const createVendorMutation = useMutation({
    mutationFn: (d) => vendorService.create(d),
    onSuccess: (newVendor) => {
      queryClient.invalidateQueries({ queryKey: ['vendors-add'] });
      setForm({ ...form, vendor: newVendorForm.name, vendor_id: newVendor.id });
      setShowNewVendor(false);
      setNewVendorForm({ name: "", company: "", contact_email: "", category: "other", payment_terms: "net_30" });
    },
  });

  const handleSubmit = (addAnother) => {
    createMutation.mutate({
      ...form,
      amount: parseFloat(form.amount),
      attachment_url: attachmentUrl,
      org_id: orgId || "",
      source: "manual",
      fiscal_year: new Date().getFullYear()
    }, {
      onSuccess: () => {
        if (addAnother) {
          setForm({ date: "", amount: "", category: "", vendor: form.vendor, vendor_id: form.vendor_id, description: "", classification: "recoverable", property_id: form.property_id });
          setAttachmentUrl("");
        }
      }
    });
  };

  const handleAttachment = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(true);
    const { file_url } = await uploadFile({ file });
    setAttachmentUrl(file_url);
    setUploading(false);
  };

  const handleVendorSelect = (vendorId) => {
    if (vendorId === "__new__") {
      setShowNewVendor(true);
      return;
    }
    const v = vendors.find(vn => vn.id === vendorId);
    setForm({ ...form, vendor: v?.name || "", vendor_id: vendorId });
  };

  const handleCreateVendor = () => {
    if (!newVendorForm.name) return;
    createVendorMutation.mutate({ ...newVendorForm, org_id: orgId || "", status: "active" });
  };

  const isValid = form.date && form.amount && form.category && form.vendor;

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      <Link to={createPageUrl("Expenses")} className="text-sm text-slate-500 hover:text-slate-700 flex items-center gap-1">
        <ArrowLeft className="w-4 h-4" /> Back to Expenses
      </Link>
      <h1 className="text-2xl font-bold text-slate-900">Add Expense</h1>

      <Card>
        <CardHeader><CardTitle className="text-base">Expense Details</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div><Label>Date *</Label><Input type="date" required value={form.date} onChange={e => setForm({...form, date: e.target.value})} /></div>
            <div><Label>Amount ($) *</Label><Input type="number" step="0.01" required placeholder="0.00" value={form.amount} onChange={e => setForm({...form, amount: e.target.value})} /></div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Category *</Label>
              <Select value={form.category} onValueChange={v => setForm({...form, category: v})}>
                <SelectTrigger><SelectValue placeholder="Select category..." /></SelectTrigger>
                <SelectContent>{CATEGORIES.map(c => <SelectItem key={c} value={c}>{c.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div>
              <Label>Property</Label>
              <Select value={form.property_id} onValueChange={v => setForm({...form, property_id: v})}>
                <SelectTrigger><SelectValue placeholder="Select property..." /></SelectTrigger>
                <SelectContent>
                  {properties.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label>Vendor *</Label>
            <Select value={form.vendor_id} onValueChange={handleVendorSelect}>
              <SelectTrigger className={!form.vendor_id ? "border-amber-300" : ""}>
                <SelectValue placeholder="Select vendor (required)..." />
              </SelectTrigger>
              <SelectContent>
                {vendors.map(v => (
                  <SelectItem key={v.id} value={v.id}>
                    <span className="flex items-center gap-2">
                      {v.name}{v.company ? <span className="text-slate-400 text-xs">({v.company})</span> : ''}
                    </span>
                  </SelectItem>
                ))}
                <SelectItem value="__new__">
                  <span className="flex items-center gap-1 text-violet-600 font-medium"><Plus className="w-3 h-3" />Create New Vendor</span>
                </SelectItem>
              </SelectContent>
            </Select>
            {form.vendor && (
              <Link to={`/VendorProfile?id=${form.vendor_id}`} className="text-[10px] text-blue-600 hover:underline mt-1 inline-block">
                View {form.vendor} profile →
              </Link>
            )}
          </div>
          <div><Label>Description</Label><Textarea value={form.description} onChange={e => setForm({...form, description: e.target.value})} placeholder="Optional notes..." rows={3} /></div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Recoverable Classification</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-3">
            {[
              { val: "recoverable", label: "Recoverable", desc: "Charged to tenants via CAM" },
              { val: "non_recoverable", label: "Non-Recoverable", desc: "Owner/landlord responsibility" },
              { val: "conditional", label: "Conditional", desc: "Depends on lease terms" },
            ].map(opt => (
              <button key={opt.val} type="button" onClick={() => setForm({...form, classification: opt.val})}
                className={`p-4 rounded-xl border-2 text-left transition-all ${form.classification === opt.val ? 'border-blue-600 bg-blue-50' : 'border-slate-200 hover:border-slate-300'}`}>
                <p className="text-sm font-semibold text-slate-900">{opt.label}</p>
                <p className="text-xs text-slate-500 mt-1">{opt.desc}</p>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Attachment (Optional)</CardTitle></CardHeader>
        <CardContent>
          <label className="flex items-center gap-3 cursor-pointer p-3 border border-dashed rounded-lg hover:bg-slate-50">
            <Paperclip className="w-5 h-5 text-slate-400" />
            <div>
              <p className="text-sm font-medium text-blue-600">{attachmentUrl ? "File attached ✓" : "Attach Receipt or Invoice"}</p>
              <p className="text-xs text-slate-400">PDF, PNG, JPG up to 10MB</p>
            </div>
            {uploading && <Loader2 className="w-4 h-4 animate-spin ml-auto" />}
            <input type="file" className="hidden" accept=".pdf,.png,.jpg,.jpeg" onChange={handleAttachment} />
          </label>
        </CardContent>
      </Card>

      <div className="flex gap-3 justify-end">
        <Link to={createPageUrl("Expenses")}><Button variant="outline" type="button">Cancel</Button></Link>
        <Button variant="outline" onClick={() => handleSubmit(true)} disabled={!isValid || createMutation.isPending}>
          <Plus className="w-4 h-4 mr-1" />Save & Add Another
        </Button>
        <Button onClick={() => handleSubmit(false)} disabled={!isValid || createMutation.isPending} className="bg-emerald-600 hover:bg-emerald-700">
          {createMutation.isPending && <Loader2 className="w-4 h-4 animate-spin mr-2" />}Save Expense
        </Button>
      </div>

      {/* Inline New Vendor Dialog */}
      <Dialog open={showNewVendor} onOpenChange={setShowNewVendor}>
        <DialogContent>
          <DialogHeader><DialogTitle>Create New Vendor</DialogTitle><DialogDescription>Add a new vendor to link to this expense</DialogDescription></DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div><Label className="text-xs">Vendor Name *</Label><Input value={newVendorForm.name} onChange={e => setNewVendorForm({...newVendorForm, name: e.target.value})} placeholder="e.g. ABC Maintenance" /></div>
              <div><Label className="text-xs">Company</Label><Input value={newVendorForm.company} onChange={e => setNewVendorForm({...newVendorForm, company: e.target.value})} /></div>
            </div>
            <div><Label className="text-xs">Email</Label><Input value={newVendorForm.contact_email} onChange={e => setNewVendorForm({...newVendorForm, contact_email: e.target.value})} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label className="text-xs">Category</Label>
                <Select value={newVendorForm.category} onValueChange={v => setNewVendorForm({...newVendorForm, category: v})}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{VENDOR_CATEGORIES.map(c => <SelectItem key={c} value={c}>{c.charAt(0).toUpperCase()+c.slice(1)}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div><Label className="text-xs">Payment Terms</Label>
                <Select value={newVendorForm.payment_terms} onValueChange={v => setNewVendorForm({...newVendorForm, payment_terms: v})}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{["net_15","net_30","net_45","net_60","immediate"].map(t => <SelectItem key={t} value={t}>{t.replace(/_/g,' ').toUpperCase()}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowNewVendor(false)}>Cancel</Button>
            <Button onClick={handleCreateVendor} disabled={!newVendorForm.name || createVendorMutation.isPending} className="bg-violet-600 hover:bg-violet-700">
              {createVendorMutation.isPending && <Loader2 className="w-4 h-4 animate-spin mr-1" />}Create Vendor
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
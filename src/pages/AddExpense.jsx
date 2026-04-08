import React, { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Paperclip, ArrowLeft, Plus } from "lucide-react";

import { expenseService } from "@/services/expenseService";
import { vendorService } from "@/services/vendorService";
import { supabase } from "@/services/supabaseClient";
import useOrgQuery from "@/hooks/useOrgQuery";
import { buildHierarchyScope } from "@/lib/hierarchyScope";
import { resolveWritableOrgId } from "@/lib/orgUtils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { createPageUrl } from "@/utils";

const CATEGORIES = [
  "property_tax",
  "insurance",
  "utilities",
  "landscaping",
  "snow_removal",
  "parking_lot_maintenance",
  "elevator_maintenance",
  "security",
  "janitorial",
  "trash_removal",
  "fire_systems",
  "hvac_maintenance",
  "plumbing",
  "electrical",
  "roof_repairs",
  "pest_control",
  "management_fee",
  "administrative_fee",
  "general_repairs",
  "lobby_maintenance",
  "cleaning",
  "accounting",
  "legal_fees",
  "capital_improvements",
  "structural_repairs",
  "other",
];

const VENDOR_CATEGORIES = ["maintenance", "utilities", "insurance", "janitorial", "landscaping", "security", "legal", "accounting", "construction", "technology", "other"];

function buildInitialForm(scope) {
  return {
    date: "",
    amount: "",
    category: "",
    vendor: "",
    vendor_id: "",
    description: "",
    classification: "recoverable",
    portfolio_id: scope.portfolioId || "",
    property_id: scope.propertyId || "",
    building_id: scope.buildingId || "",
    unit_id: scope.unitId || "",
  };
}

export default function AddExpense() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: vendors = [], orgId } = useOrgQuery("Vendor");
  const { data: properties = [] } = useOrgQuery("Property");
  const { data: buildings = [] } = useOrgQuery("Building");
  const { data: units = [] } = useOrgQuery("Unit");
  const { data: portfolios = [] } = useOrgQuery("Portfolio");

  const scope = useMemo(
    () =>
      buildHierarchyScope({
        search: location.search,
        portfolios,
        properties,
        buildings,
        units,
      }),
    [location.search, portfolios, properties, buildings, units]
  );

  const [form, setForm] = useState(() => buildInitialForm(scope));
  const [attachmentUrl, setAttachmentUrl] = useState("");
  const [uploading, setUploading] = useState(false);
  const [showNewVendor, setShowNewVendor] = useState(false);
  const [newVendorForm, setNewVendorForm] = useState({
    name: "",
    company: "",
    contact_email: "",
    category: "other",
    payment_terms: "net_30",
  });

  useEffect(() => {
    setForm((current) => ({
      ...current,
      portfolio_id: scope.portfolioId || current.portfolio_id || "",
      property_id: scope.propertyId || current.property_id || "",
      building_id: scope.buildingId || current.building_id || "",
      unit_id: scope.unitId || current.unit_id || "",
    }));
  }, [scope.portfolioId, scope.propertyId, scope.buildingId, scope.unitId]);

  const visibleProperties = scope.scopedProperties;
  const visibleBuildings = form.property_id
    ? scope.scopedBuildings.filter((building) => building.property_id === form.property_id)
    : scope.scopedBuildings;
  const visibleUnits = form.building_id
    ? scope.scopedUnits.filter((unit) => unit.building_id === form.building_id)
    : form.property_id
      ? scope.scopedUnits.filter((unit) => unit.property_id === form.property_id)
      : scope.scopedUnits;

  const createMutation = useMutation({
    mutationFn: (data) => expenseService.create(data),
    onSuccess: () => navigate(createPageUrl("Expenses") + location.search),
  });

  const createVendorMutation = useMutation({
    mutationFn: (data) => vendorService.create(data),
    onSuccess: (newVendor) => {
      queryClient.invalidateQueries({ queryKey: ["vendors-add"] });
      setForm((current) => ({ ...current, vendor: newVendorForm.name, vendor_id: newVendor.id }));
      setShowNewVendor(false);
      setNewVendorForm({ name: "", company: "", contact_email: "", category: "other", payment_terms: "net_30" });
    },
  });

  const handleSubmit = async (addAnother) => {
    const writableOrgId = await resolveWritableOrgId(orgId);
    const property = form.property_id ? scope.propertyById.get(form.property_id) ?? null : null;

    createMutation.mutate(
      {
        ...form,
        amount: parseFloat(form.amount),
        attachment_url: attachmentUrl,
        org_id: writableOrgId || "",
        portfolio_id: property?.portfolio_id || form.portfolio_id || null,
        property_id: form.property_id || null,
        building_id: form.building_id || null,
        unit_id: form.unit_id || null,
        source: "manual",
        fiscal_year: new Date().getFullYear(),
      },
      {
        onSuccess: () => {
          if (addAnother) {
            setForm({
              ...buildInitialForm(scope),
              vendor: form.vendor,
              vendor_id: form.vendor_id,
              portfolio_id: property?.portfolio_id || form.portfolio_id || "",
              property_id: form.property_id || "",
              building_id: form.building_id || "",
              unit_id: form.unit_id || "",
            });
            setAttachmentUrl("");
          }
        },
      }
    );
  };

  const handleAttachment = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setUploading(true);
    let fileUrl = "";
    try {
      const fileName = `expenses/${Date.now()}-${file.name}`;
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from("financial-uploads")
        .upload(fileName, file, { upsert: true });
      if (!uploadError && uploadData) {
        const { data: urlData } = supabase.storage.from("financial-uploads").getPublicUrl(fileName);
        fileUrl = urlData?.publicUrl || "";
      }
    } catch {
      fileUrl = URL.createObjectURL(file);
    }
    setAttachmentUrl(fileUrl);
    setUploading(false);
  };

  const handleVendorSelect = (vendorId) => {
    if (vendorId === "__new__") {
      setShowNewVendor(true);
      return;
    }

    const vendor = vendors.find((item) => item.id === vendorId);
    setForm((current) => ({ ...current, vendor: vendor?.name || "", vendor_id: vendorId }));
  };

  const handleCreateVendor = async () => {
    if (!newVendorForm.name) return;
    const writableOrgId = await resolveWritableOrgId(orgId);
    createVendorMutation.mutate({ ...newVendorForm, org_id: writableOrgId || "", status: "active" });
  };

  const isValid = form.date && form.amount && form.category && form.vendor && form.property_id;

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <Link to={createPageUrl("Expenses") + location.search} className="text-sm text-slate-500 hover:text-slate-700 flex items-center gap-1">
        <ArrowLeft className="w-4 h-4" />
        Back to Expenses
      </Link>
      <h1 className="text-2xl font-bold text-slate-900">Add Expense</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Expense Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Date *</Label>
              <Input type="date" required value={form.date} onChange={(event) => setForm((current) => ({ ...current, date: event.target.value }))} />
            </div>
            <div>
              <Label>Amount ($) *</Label>
              <Input type="number" step="0.01" required placeholder="0.00" value={form.amount} onChange={(event) => setForm((current) => ({ ...current, amount: event.target.value }))} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Category *</Label>
              <Select value={form.category} onValueChange={(value) => setForm((current) => ({ ...current, category: value }))}>
                <SelectTrigger>
                  <SelectValue placeholder="Select category..." />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((category) => (
                    <SelectItem key={category} value={category}>
                      {category.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase())}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Property *</Label>
              <Select
                value={form.property_id}
                onValueChange={(value) =>
                  setForm((current) => ({
                    ...current,
                    property_id: value,
                    portfolio_id: scope.propertyById.get(value)?.portfolio_id || current.portfolio_id || "",
                    building_id: "",
                    unit_id: "",
                  }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select property..." />
                </SelectTrigger>
                <SelectContent>
                  {visibleProperties.map((property) => (
                    <SelectItem key={property.id} value={property.id}>
                      {property.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Building</Label>
              <Select value={form.building_id || "__all__"} onValueChange={(value) => setForm((current) => ({ ...current, building_id: value === "__all__" ? "" : value, unit_id: "" }))}>
                <SelectTrigger>
                  <SelectValue placeholder="Select building..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">Property-Level Expense</SelectItem>
                  {visibleBuildings.map((building) => (
                    <SelectItem key={building.id} value={building.id}>
                      {building.name || building.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Unit</Label>
              <Select value={form.unit_id || "__all__"} onValueChange={(value) => setForm((current) => ({ ...current, unit_id: value === "__all__" ? "" : value }))}>
                <SelectTrigger>
                  <SelectValue placeholder="Select unit..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">Building-Level Expense</SelectItem>
                  {visibleUnits.map((unit) => (
                    <SelectItem key={unit.id} value={unit.id}>
                      {unit.unit_number || unit.unit_id_code || unit.id}
                    </SelectItem>
                  ))}
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
                {vendors.map((vendor) => (
                  <SelectItem key={vendor.id} value={vendor.id}>
                    <span className="flex items-center gap-2">
                      {vendor.name}
                      {vendor.company ? <span className="text-slate-400 text-xs">({vendor.company})</span> : ""}
                    </span>
                  </SelectItem>
                ))}
                <SelectItem value="__new__">
                  <span className="flex items-center gap-1 text-violet-600 font-medium">
                    <Plus className="w-3 h-3" />
                    Create New Vendor
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
            {form.vendor && form.vendor_id && (
              <Link to={`/VendorProfile?id=${form.vendor_id}`} className="text-[10px] text-blue-600 hover:underline mt-1 inline-block">
                View {form.vendor} profile →
              </Link>
            )}
          </div>

          <div>
            <Label>Description</Label>
            <Textarea value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} placeholder="Optional notes..." rows={3} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recoverable Classification</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-3">
            {[
              { value: "recoverable", label: "Recoverable", description: "Charged to tenants via CAM" },
              { value: "non_recoverable", label: "Non-Recoverable", description: "Owner/landlord responsibility" },
              { value: "conditional", label: "Conditional", description: "Depends on lease terms" },
            ].map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setForm((current) => ({ ...current, classification: option.value }))}
                className={`p-4 rounded-xl border-2 text-left transition-all ${form.classification === option.value ? "border-blue-600 bg-blue-50" : "border-slate-200 hover:border-slate-300"}`}
              >
                <p className="text-sm font-semibold text-slate-900">{option.label}</p>
                <p className="text-xs text-slate-500 mt-1">{option.description}</p>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Attachment (Optional)</CardTitle>
        </CardHeader>
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
        <Link to={createPageUrl("Expenses") + location.search}>
          <Button variant="outline" type="button">
            Cancel
          </Button>
        </Link>
        <Button variant="outline" onClick={() => handleSubmit(true)} disabled={!isValid || createMutation.isPending}>
          <Plus className="w-4 h-4 mr-1" />
          Save & Add Another
        </Button>
        <Button onClick={() => handleSubmit(false)} disabled={!isValid || createMutation.isPending} className="bg-emerald-600 hover:bg-emerald-700">
          {createMutation.isPending && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
          Save Expense
        </Button>
      </div>

      <Dialog open={showNewVendor} onOpenChange={setShowNewVendor}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create New Vendor</DialogTitle>
            <DialogDescription>Add a new vendor to link to this expense</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Vendor Name *</Label>
                <Input value={newVendorForm.name} onChange={(event) => setNewVendorForm((current) => ({ ...current, name: event.target.value }))} placeholder="e.g. ABC Maintenance" />
              </div>
              <div>
                <Label className="text-xs">Company</Label>
                <Input value={newVendorForm.company} onChange={(event) => setNewVendorForm((current) => ({ ...current, company: event.target.value }))} />
              </div>
            </div>
            <div>
              <Label className="text-xs">Email</Label>
              <Input value={newVendorForm.contact_email} onChange={(event) => setNewVendorForm((current) => ({ ...current, contact_email: event.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Category</Label>
                <Select value={newVendorForm.category} onValueChange={(value) => setNewVendorForm((current) => ({ ...current, category: value }))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {VENDOR_CATEGORIES.map((category) => (
                      <SelectItem key={category} value={category}>
                        {category.charAt(0).toUpperCase() + category.slice(1)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Payment Terms</Label>
                <Select value={newVendorForm.payment_terms} onValueChange={(value) => setNewVendorForm((current) => ({ ...current, payment_terms: value }))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {["net_15", "net_30", "net_45", "net_60", "immediate"].map((term) => (
                      <SelectItem key={term} value={term}>
                        {term.replace(/_/g, " ").toUpperCase()}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowNewVendor(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreateVendor} disabled={!newVendorForm.name || createVendorMutation.isPending} className="bg-violet-600 hover:bg-violet-700">
              {createVendorMutation.isPending && <Loader2 className="w-4 h-4 animate-spin mr-1" />}
              Create Vendor
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

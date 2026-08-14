import React, { useState } from "react";
import { vendorService } from "@/services/vendorService";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import useOrgQuery from "@/hooks/useOrgQuery";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Search, Plus, Truck, DollarSign, Users, Pencil, Trash2, Receipt, TrendingUp, ArrowUpDown, Download, Upload } from "lucide-react";
import { useNavigate } from "react-router-dom";
import PageHeader from "@/components/PageHeader";
import MetricCard from "@/components/MetricCard";
import ScopeSelector from "@/components/ScopeSelector";
import { downloadCSV } from "@/utils/index";
import BulkImportModal from "@/components/property/BulkImportModal";
import { toast } from "sonner";
import { expenseMatchesVendor } from "@/lib/vendorMatch";
import { checkVendorEligibility, listOperationalDomainRows, reviewVendorCredential, saveVendorCredential } from "@/services/leaseFinancialOperationsService";

const CATEGORIES = ["maintenance","utilities","insurance","janitorial","landscaping","security","legal","accounting","construction","technology","other"];
const statusColors = { active: "bg-emerald-100 text-emerald-700", verified: "bg-emerald-100 text-emerald-700", approved: "bg-emerald-100 text-emerald-700", inactive: "bg-slate-100 text-slate-600", pending: "bg-amber-100 text-amber-700", pending_review: "bg-amber-100 text-amber-700", needs_review: "bg-amber-100 text-amber-700", rejected: "bg-red-100 text-red-700", expired: "bg-red-100 text-red-700" };

export default function Vendors() {
  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState("all");
  const [showDialog, setShowDialog] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showCredentialDialog, setShowCredentialDialog] = useState(false);
  const [editCredential, setEditCredential] = useState(null);
  const [editItem, setEditItem] = useState(null);
  const [sortField, setSortField] = useState("totalSpend");
  const [sortDir, setSortDir] = useState("desc");
  const [scopePortfolio, setScopePortfolio] = useState("all");
  const [scopeProperty, setScopeProperty] = useState("all");
  const [scopeBuilding, setScopeBuilding] = useState("all");
  const [scopeUnit, setScopeUnit] = useState("all");
  const [form, setForm] = useState({ name: "", company: "", contact_name: "", contact_email: "", contact_phone: "", category: "other", payment_terms: "net_30", notes: "" });
  const [credentialForm, setCredentialForm] = useState({ vendor_id: "", service_type: "", jurisdiction: "", credential_type: "", credential_number: "", effective_date: "", expiration_date: "", verification_source: "", verification_url: "" });
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const { data: vendors = [], orgId } = useOrgQuery("Vendor");
  const { data: expenses = [] } = useOrgQuery("Expense");
  const { data: portfolios = [] } = useOrgQuery("Portfolio");
  const { data: properties = [] } = useOrgQuery("Property");
  const { data: buildings = [] } = useOrgQuery("Building");
<<<<<<< HEAD
  const { data: vendorCredentials = [] } = useQuery({
    queryKey: ["vendor-credentials", orgId],
    enabled: Boolean(orgId),
    queryFn: () => listOperationalDomainRows("vendor_credentials", { orgId, limit: 200 }),
  });
=======
  const { data: units = [] } = useOrgQuery("Unit");
>>>>>>> f93b73e626fefe8dd1c9ad2be66f1c8ee2fe259c

  const createMutation = useMutation({
    mutationFn: (d) => vendorService.create(d),
    onSuccess: (created) => {
      queryClient.setQueriesData({ queryKey: ["Vendor"] }, (current = []) => [...current, created]);
      queryClient.invalidateQueries({ queryKey: ["Vendor"] });
      setShowDialog(false);
      toast.success("Vendor created");
    },
    onError: (error) => toast.error(`Failed to create vendor: ${error?.message || "Unknown error"}`),
  });
  const updateMutation = useMutation({
    mutationFn: ({ id, d }) => vendorService.update(id, d),
    onSuccess: (updated) => {
      queryClient.setQueriesData({ queryKey: ["Vendor"] }, (current = []) =>
        current.map((vendor) => vendor.id === updated.id ? updated : vendor)
      );
      queryClient.invalidateQueries({ queryKey: ["Vendor"] });
      setShowDialog(false);
      toast.success("Vendor updated");
    },
    onError: (error) => toast.error(`Failed to update vendor: ${error?.message || "Unknown error"}`),
  });
  const deleteMutation = useMutation({
    mutationFn: (id) => vendorService.delete(id),
    onSuccess: (_, deletedId) => {
      queryClient.setQueriesData({ queryKey: ["Vendor"] }, (current = []) =>
        current.filter((vendor) => vendor.id !== deletedId)
      );
      queryClient.invalidateQueries({ queryKey: ["Vendor"] });
      toast.success("Vendor deleted");
    },
    onError: (error) => toast.error(`Failed to delete vendor: ${error?.message || "Unknown error"}`),
  });


  const credentialMutation = useMutation({
    mutationFn: (payload) => saveVendorCredential(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["vendor-credentials", orgId] });
      queryClient.invalidateQueries({ queryKey: ["automation-operational-rows", orgId] });
      setShowCredentialDialog(false);
      toast.success("Credential saved");
    },
    onError: (error) => toast.error(`Failed to save credential: ${error?.message || "Unknown error"}`),
  });

  const credentialReviewMutation = useMutation({
    mutationFn: (payload) => reviewVendorCredential(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["vendor-credentials", orgId] });
      queryClient.invalidateQueries({ queryKey: ["automation-operational-rows", orgId] });
      toast.success("Credential updated");
    },
    onError: (error) => toast.error(`Credential action failed: ${error?.message || "Unknown error"}`),
  });

  const eligibilityMutation = useMutation({
    mutationFn: (payload) => checkVendorEligibility(payload),
    onSuccess: (result) => {
      if (result?.eligible) toast.success(result.status === "not_required" ? "Credential not required for this service" : "Vendor eligible");
      else toast.error((result?.reasonCodes || ["Vendor blocked"]).join(", "));
    },
    onError: (error) => toast.error(`Eligibility check failed: ${error?.message || "Unknown error"}`),
  });
  const combinedVendors = React.useMemo(() => {
    const map = new Map();

    // 1. Existing DB Vendors
    (vendors || []).forEach((v) => {
      if (v.name && v.name.trim()) {
        map.set(v.name.trim().toLowerCase(), { ...v, isSynthetic: false });
      }
    });

    // 2. Derive vendors from actual expenses (bulk import, manual add, invoice upload)
    (expenses || []).forEach((e) => {
      const vName = (e.vendor || e.vendor_name || "").trim();
      if (!vName || vName === "-" || vName.toLowerCase() === "unassigned") return;
      const key = vName.toLowerCase();
      if (!map.has(key)) {
        map.set(key, {
          id: `exp_vendor_${key}`,
          name: vName,
          company: vName,
          contact_name: "",
          contact_email: "",
          contact_phone: "",
          category: e.category || "other",
          payment_terms: "net_30",
          status: "active",
          notes: "Derived from actual expense records",
          isSynthetic: true,
        });
      }
    });

    return Array.from(map.values());
  }, [vendors, expenses]);

  // Auto-persist missing vendor records to DB in background
  React.useEffect(() => {
    const missing = combinedVendors.filter((v) => v.isSynthetic);
    if (missing.length > 0 && orgId) {
      Promise.all(
        missing.map((v) =>
          vendorService.create({
            name: v.name,
            company: v.name,
            category: v.category || "other",
            status: "active",
            notes: "Auto-created from actual expense record",
            org_id: orgId,
          }).catch(() => null)
        )
      ).then(() => {
        queryClient.invalidateQueries({ queryKey: ["Vendor"] });
      });
    }
  }, [combinedVendors, orgId, queryClient]);

  const enriched = combinedVendors.map(v => {
    const vExpenses = expenses.filter(e => expenseMatchesVendor(e, v));
    const portfolioPropertyIds = new Set(properties.filter((property) => property.portfolio_id === scopePortfolio).map((property) => property.id));
    let scopedExpenses = vExpenses;
    if (scopePortfolio !== "all") {
      scopedExpenses = scopedExpenses.filter((e) => portfolioPropertyIds.has(e.property_id));
    }
    if (scopeProperty !== "all") {
      scopedExpenses = scopedExpenses.filter((e) => e.property_id === scopeProperty);
    }
    if (scopeBuilding !== "all") {
      scopedExpenses = scopedExpenses.filter((e) => e.building_id === scopeBuilding);
    }
    if (scopeUnit !== "all") {
      scopedExpenses = scopedExpenses.filter((e) => e.unit_id === scopeUnit);
    }
    const propExpenses = scopedExpenses;
    const propIds = [...new Set(propExpenses.map(e => e.property_id).filter(Boolean))];
    const lastExpense = propExpenses.sort((a, b) => (b.expense_date || b.date || '').localeCompare(a.expense_date || a.date || ''))[0];
    return {
      ...v,
      expenseCount: propExpenses.length,
      totalSpend: propExpenses.reduce((s, e) => s + (Number(e.amount) || 0), 0),
      propertiesServed: propIds.length,
      propertyNames: propIds.map(pid => properties.find(p => p.id === pid)?.name || "Unknown"),
      lastActivity: lastExpense?.expense_date || lastExpense?.date || lastExpense?.created_date || null,
    };
  });

  const filtered = enriched.filter(v => {
    const matchSearch = !search || v.name?.toLowerCase().includes(search.toLowerCase()) || v.company?.toLowerCase().includes(search.toLowerCase());
    const matchCat = catFilter === "all" || v.category === catFilter;
    return matchSearch && matchCat;
  }).sort((a, b) => {
    const dir = sortDir === "desc" ? -1 : 1;
    if (sortField === "totalSpend") return (a.totalSpend - b.totalSpend) * dir;
    if (sortField === "name") return a.name?.localeCompare(b.name) * dir;
    if (sortField === "lastActivity") return ((a.lastActivity || '').localeCompare(b.lastActivity || '')) * dir;
    return 0;
  });

  const totalSpend = enriched.reduce((s, v) => s + v.totalSpend, 0);
  const avgSpendPerVendor = enriched.length > 0 ? totalSpend / enriched.length : 0;
  const topVendor = [...enriched].sort((a, b) => b.totalSpend - a.totalSpend)[0];

  const openNew = () => { setEditItem(null); setForm({ name: "", company: "", contact_name: "", contact_email: "", contact_phone: "", category: "other", payment_terms: "net_30", notes: "" }); setShowDialog(true); };
  const openEdit = (v) => { setEditItem(v); setForm({ name: v.name, company: v.company || "", contact_name: v.contact_name || "", contact_email: v.contact_email || "", contact_phone: v.contact_phone || "", category: v.category || "other", payment_terms: v.payment_terms || "net_30", notes: v.notes || "" }); setShowDialog(true); };
  const openNewCredential = (vendor = null) => {
    setEditCredential(null);
    setCredentialForm({ vendor_id: vendor?.id || "", service_type: "", jurisdiction: "", credential_type: "", credential_number: "", effective_date: "", expiration_date: "", verification_source: "", verification_url: "" });
    setShowCredentialDialog(true);
  };
  const openEditCredential = (credential) => {
    setEditCredential(credential);
    setCredentialForm({
      vendor_id: credential.vendor_id || "",
      service_type: credential.service_type || "",
      jurisdiction: credential.jurisdiction || "",
      credential_type: credential.credential_type || "",
      credential_number: credential.credential_number || "",
      effective_date: credential.effective_date || "",
      expiration_date: credential.expiration_date || "",
      verification_source: credential.verification_source || "",
      verification_url: credential.verification_url || "",
    });
    setShowCredentialDialog(true);
  };
  const handleCredentialSave = () => credentialMutation.mutate({ ...credentialForm, id: editCredential?.id || undefined });
  const handleSave = () => {
    const payload = { ...form, org_id: orgId || "", status: "active" };
    if (editItem && !editItem.isSynthetic) updateMutation.mutate({ id: editItem.id, d: payload });
    else createMutation.mutate(payload);
  };

  const toggleSort = (field) => {
    if (sortField === field) setSortDir(d => d === "desc" ? "asc" : "desc");
    else { setSortField(field); setSortDir("desc"); }
  };

  const openProfile = (v) => {
    if (v.isSynthetic) {
      toast.info("Vendor is auto-created from expense records.");
      return;
    }
    navigate(`/VendorProfile?id=${v.id}`);
  };

  return (
    <div className="p-4 lg:p-6 space-y-5">
      <PageHeader icon={Truck} title="Vendor Management" subtitle={`${enriched.length} vendors - Linked to expense records`} iconColor="from-blue-700 to-blue-600">
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => downloadCSV(enriched, 'vendors.csv')}><Download className="w-3.5 h-3.5 mr-1 text-slate-500" />Export</Button>
          <Button variant="outline" size="sm" onClick={() => setShowImport(true)}><Upload className="w-3.5 h-3.5 mr-1" />Import</Button>
          <Button size="sm" onClick={openNew} className="bg-gradient-to-r from-blue-700 to-blue-600 hover:from-blue-700 hover:to-blue-800 shadow-sm">
            <Plus className="w-3.5 h-3.5 mr-1" />Add Vendor
          </Button>
        </div>
      </PageHeader>

      <ScopeSelector
        portfolios={portfolios}
        properties={properties}
        buildings={buildings}
        units={units}
        selectedPortfolio={scopePortfolio}
        selectedProperty={scopeProperty}
        selectedBuilding={scopeBuilding}
        selectedUnit={scopeUnit}
        onPortfolioChange={(value) => {
          setScopePortfolio(value);
          setScopeProperty("all");
          setScopeBuilding("all");
          setScopeUnit("all");
        }}
        onPropertyChange={(value) => {
          setScopeProperty(value);
          setScopeBuilding("all");
          setScopeUnit("all");
        }}
        onBuildingChange={(value) => {
          setScopeBuilding(value);
          setScopeUnit("all");
        }}
        onUnitChange={setScopeUnit}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <MetricCard label="Total Vendors" value={vendors.length} icon={Users} color="bg-blue-50 text-blue-600" />
        <MetricCard label="Total Spend" value={`$${(totalSpend / 1000).toFixed(0)}K`} icon={DollarSign} color="bg-emerald-50 text-emerald-600" sub="all linked expenses" />
        <MetricCard label="Avg. Spend/Vendor" value={`$${(avgSpendPerVendor / 1000).toFixed(1)}K`} icon={TrendingUp} color="bg-blue-50 text-blue-600" />
        <MetricCard label="Top Vendor" value={topVendor?.name || "-"} icon={Receipt} color="bg-amber-50 text-amber-600" sub={topVendor ? `$${(topVendor.totalSpend / 1000).toFixed(0)}K spend` : ""} />
      </div>

      <div className="flex gap-3 items-center flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input placeholder="Search vendors..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9 h-9 text-sm bg-white" />
        </div>
        <Select value={catFilter} onValueChange={setCatFilter}>
          <SelectTrigger className="w-40 h-9 text-xs"><SelectValue placeholder="All Categories" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Categories</SelectItem>
            {CATEGORIES.map(c => <SelectItem key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <Card className="overflow-hidden border-slate-200/80">
        <Table>
          <TableHeader>
            <TableRow className="bg-gradient-to-r from-slate-50 to-slate-100/50">
              <TableHead className="text-[10px] font-bold tracking-wider cursor-pointer" onClick={() => toggleSort("name")}>
                <span className="flex items-center gap-1">VENDOR NAME {sortField === "name" && <ArrowUpDown className="w-3 h-3" />}</span>
              </TableHead>
              <TableHead className="text-[10px] font-bold tracking-wider">CATEGORY</TableHead>
              <TableHead className="text-[10px] font-bold tracking-wider text-right cursor-pointer" onClick={() => toggleSort("totalSpend")}>
                <span className="flex items-center gap-1 justify-end">TOTAL SPEND {sortField === "totalSpend" && <ArrowUpDown className="w-3 h-3" />}</span>
              </TableHead>
              <TableHead className="text-[10px] font-bold tracking-wider text-center">PROPERTIES SERVED</TableHead>
              <TableHead className="text-[10px] font-bold tracking-wider cursor-pointer" onClick={() => toggleSort("lastActivity")}>
                <span className="flex items-center gap-1">LAST ACTIVITY {sortField === "lastActivity" && <ArrowUpDown className="w-3 h-3" />}</span>
              </TableHead>
              <TableHead className="text-[10px] font-bold tracking-wider">STATUS</TableHead>
              <TableHead className="text-[10px] font-bold tracking-wider w-20"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow><TableCell colSpan={7} className="text-center py-10 text-sm text-slate-400">No vendors found</TableCell></TableRow>
            ) : filtered.map(v => (
              <TableRow key={v.id} className="hover:bg-blue-50/30 transition-colors cursor-pointer" onClick={() => openProfile(v)}>
                <TableCell>
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-100 to-blue-200 flex items-center justify-center text-blue-600 font-bold text-xs">
                      {v.name?.charAt(0)?.toUpperCase()}
                    </div>
                    <div>
                      <p className="text-sm font-semibold">{v.name}</p>
                      {v.company && <p className="text-[10px] text-slate-400">{v.company}</p>}
                    </div>
                  </div>
                </TableCell>
                <TableCell><Badge variant="outline" className="text-[9px] capitalize">{v.category?.replace(/_/g, ' ')}</Badge></TableCell>
                <TableCell className="text-right text-sm font-bold tabular-nums text-slate-900">${v.totalSpend.toLocaleString()}</TableCell>
                <TableCell className="text-center">
                  <span className="text-xs font-semibold bg-slate-100 px-2 py-0.5 rounded-full">{v.propertiesServed}</span>
                </TableCell>
                <TableCell className="text-xs text-slate-500">
                  {v.lastActivity ? new Date(v.lastActivity).toLocaleDateString() : '-'}
                </TableCell>
                <TableCell><Badge className={`${statusColors[v.status] || statusColors.pending} text-[9px] uppercase`}>{v.status}</Badge></TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={(e) => { e.stopPropagation(); openEdit(v); }}><Pencil className="w-3 h-3" /></Button>
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-red-500" onClick={(e) => { e.stopPropagation(); deleteMutation.mutate(v.id); }}><Trash2 className="w-3 h-3" /></Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
      <p className="text-[10px] text-slate-400 text-right">{filtered.length} vendors</p>


      <Card className="overflow-hidden border-slate-200/80">
        <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Vendor Credentials</h2>
            <p className="text-xs text-slate-500">Regulated services such as HVAC, electrical, plumbing, fire, and life-safety require verified credentials.</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => openNewCredential()}><Plus className="w-3.5 h-3.5 mr-1" />Add Credential</Button>
        </div>
        <Table>
          <TableHeader>
            <TableRow className="bg-slate-50">
              <TableHead className="text-[10px] font-bold tracking-wider">VENDOR</TableHead>
              <TableHead className="text-[10px] font-bold tracking-wider">SERVICE</TableHead>
              <TableHead className="text-[10px] font-bold tracking-wider">CREDENTIAL</TableHead>
              <TableHead className="text-[10px] font-bold tracking-wider">EXPIRATION</TableHead>
              <TableHead className="text-[10px] font-bold tracking-wider">STATUS</TableHead>
              <TableHead className="text-[10px] font-bold tracking-wider text-right">ACTIONS</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {vendorCredentials.length === 0 ? (
              <TableRow><TableCell colSpan={6} className="text-center py-8 text-sm text-slate-400">No credentials recorded.</TableCell></TableRow>
            ) : vendorCredentials.map((credential) => {
              const vendor = combinedVendors.find((v) => v.id === credential.vendor_id);
              const status = String(credential.status || "needs_review").toLowerCase();
              return (
                <TableRow key={credential.id}>
                  <TableCell className="font-semibold text-sm">{vendor?.name || credential.vendor_id}</TableCell>
                  <TableCell className="text-sm capitalize">{credential.service_type}{credential.jurisdiction ? ` / ${credential.jurisdiction}` : ""}</TableCell>
                  <TableCell>
                    <div className="text-sm font-medium">{credential.credential_type}</div>
                    <div className="text-xs text-slate-500 font-mono">{credential.credential_number || "-"}</div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{credential.expiration_date || "-"}</TableCell>
                  <TableCell><Badge className={`${statusColors[status] || statusColors.pending} text-[9px] uppercase`}>{credential.status}</Badge></TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => openEditCredential(credential)}>Edit</Button>
                      {!(["verified", "approved", "active"].includes(status)) && <Button variant="outline" size="sm" className="h-7 px-2" onClick={() => credentialReviewMutation.mutate({ credentialId: credential.id, status: "verified" })}>Verify</Button>}
                      {["verified", "approved", "active"].includes(status) && <Button variant="outline" size="sm" className="h-7 px-2 text-red-600" onClick={() => credentialReviewMutation.mutate({ credentialId: credential.id, status: "rejected", reason: window.prompt("Reason") || "Revoked" })}>Revoke</Button>}
                      <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => eligibilityMutation.mutate({ vendorId: credential.vendor_id, serviceType: credential.service_type, jurisdiction: credential.jurisdiction })}>Check</Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>
      {/* Create/Edit Dialog */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editItem ? 'Edit' : 'New'} Vendor</DialogTitle><DialogDescription>Fill in vendor details below</DialogDescription></DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div><Label className="text-xs">Vendor Name *</Label><Input value={form.name} onChange={e => setForm({...form, name: e.target.value})} /></div>
              <div><Label className="text-xs">Company</Label><Input value={form.company} onChange={e => setForm({...form, company: e.target.value})} /></div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div><Label className="text-xs">Contact Name</Label><Input value={form.contact_name} onChange={e => setForm({...form, contact_name: e.target.value})} /></div>
              <div><Label className="text-xs">Email</Label><Input value={form.contact_email} onChange={e => setForm({...form, contact_email: e.target.value})} /></div>
              <div><Label className="text-xs">Phone</Label><Input value={form.contact_phone} onChange={e => setForm({...form, contact_phone: e.target.value})} /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label className="text-xs">Category</Label>
                <Select value={form.category} onValueChange={v => setForm({...form, category: v})}><SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{CATEGORIES.map(c => <SelectItem key={c} value={c}>{c.charAt(0).toUpperCase()+c.slice(1)}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div><Label className="text-xs">Payment Terms</Label>
                <Select value={form.payment_terms} onValueChange={v => setForm({...form, payment_terms: v})}><SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{["net_15","net_30","net_45","net_60","immediate"].map(t => <SelectItem key={t} value={t}>{t.replace(/_/g,' ').toUpperCase()}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter><Button onClick={handleSave} disabled={!form.name} className="bg-gradient-to-r from-blue-700 to-blue-600">{editItem ? 'Update' : 'Create'}</Button></DialogFooter>
        </DialogContent>
      </Dialog>


      <Dialog open={showCredentialDialog} onOpenChange={setShowCredentialDialog}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editCredential ? "Edit" : "New"} Credential</DialogTitle><DialogDescription>Credential facts are verified separately from vendor profile details.</DialogDescription></DialogHeader>
          <div className="space-y-3">
            <div><Label className="text-xs">Vendor *</Label>
              <Select value={credentialForm.vendor_id} onValueChange={v => setCredentialForm({...credentialForm, vendor_id: v})}>
                <SelectTrigger><SelectValue placeholder="Select vendor" /></SelectTrigger>
                <SelectContent>{combinedVendors.filter(v => !v.isSynthetic).map(v => <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label className="text-xs">Service *</Label><Input value={credentialForm.service_type} onChange={e => setCredentialForm({...credentialForm, service_type: e.target.value})} /></div>
              <div><Label className="text-xs">Jurisdiction</Label><Input value={credentialForm.jurisdiction} onChange={e => setCredentialForm({...credentialForm, jurisdiction: e.target.value})} /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label className="text-xs">Credential Type *</Label><Input value={credentialForm.credential_type} onChange={e => setCredentialForm({...credentialForm, credential_type: e.target.value})} /></div>
              <div><Label className="text-xs">Number</Label><Input value={credentialForm.credential_number} onChange={e => setCredentialForm({...credentialForm, credential_number: e.target.value})} /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label className="text-xs">Effective</Label><Input type="date" value={credentialForm.effective_date} onChange={e => setCredentialForm({...credentialForm, effective_date: e.target.value})} /></div>
              <div><Label className="text-xs">Expiration</Label><Input type="date" value={credentialForm.expiration_date} onChange={e => setCredentialForm({...credentialForm, expiration_date: e.target.value})} /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label className="text-xs">Verification Source</Label><Input value={credentialForm.verification_source} onChange={e => setCredentialForm({...credentialForm, verification_source: e.target.value})} /></div>
              <div><Label className="text-xs">Verification URL</Label><Input value={credentialForm.verification_url} onChange={e => setCredentialForm({...credentialForm, verification_url: e.target.value})} /></div>
            </div>
          </div>
          <DialogFooter><Button onClick={handleCredentialSave} disabled={!credentialForm.vendor_id || !credentialForm.service_type || !credentialForm.credential_type}>Save Credential</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <BulkImportModal 
        isOpen={showImport} 
        onClose={() => setShowImport(false)} 
        moduleType="vendor" 
      />
    </div>
  );
}

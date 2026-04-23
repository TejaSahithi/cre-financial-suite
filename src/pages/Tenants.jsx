import React, { useState } from "react";
import { tenantService } from "@/services/tenantService";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import useOrgQuery from "@/hooks/useOrgQuery";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Search, Plus, Users, FileText, DollarSign, Receipt, ChevronRight, Download, Upload } from "lucide-react";
import ModuleLink from "@/components/ModuleLink";
import { downloadCSV } from "@/utils/index";
import PageHeader from "@/components/PageHeader";
import BulkImportModal from "@/components/property/BulkImportModal";
import { resolveWritableOrgId } from "@/lib/orgUtils";

export default function Tenants() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [form, setForm] = useState({ name: "", contact_name: "", contact_email: "", contact_phone: "", industry: "", status: "active" });
  const queryClient = useQueryClient();

  const { data: tenantEntities = [], orgId } = useOrgQuery("Tenant");
  const { data: leases = [] } = useOrgQuery("Lease");
  const { data: units = [] } = useOrgQuery("Unit");
  const { data: properties = [] } = useOrgQuery("Property");
  const { data: invoices = [] } = useOrgQuery("Invoice");

  const createMutation = useMutation({
    mutationFn: async (d) => {
      const writableOrgId = await resolveWritableOrgId(orgId);
      return tenantService.create({
        name: d.name,
        contact_name: d.contact_name,
        email: d.contact_email,
        phone: d.contact_phone,
        industry: d.industry,
        status: d.status,
        ...(writableOrgId ? { org_id: writableOrgId } : {}),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['Tenant'] });
      setShowAdd(false);
      setForm({ name: "", contact_name: "", contact_email: "", contact_phone: "", industry: "", status: "active" });
    },
  });

  // Build enriched tenant list from Tenant entity + lease data
  const tenantMap = {};
  // Start with entity-based tenants
  tenantEntities.forEach(t => {
    tenantMap[t.name] = { ...t, entityId: t.id, leases: [], units: [], properties: new Set(), totalRent: 0, invoiceCount: 0, outstandingBalance: 0 };
  });
  const tenantNamesById = Object.fromEntries(tenantEntities.map(t => [t.id, t.name]));
  // Enrich from leases
  leases.forEach(l => {
    if (!l.tenant_name) return;
    if (!tenantMap[l.tenant_name]) {
      tenantMap[l.tenant_name] = { name: l.tenant_name, leases: [], units: [], properties: new Set(), totalRent: 0, invoiceCount: 0, outstandingBalance: 0 };
    }
    tenantMap[l.tenant_name].leases.push(l);
    tenantMap[l.tenant_name].totalRent += (l.annual_rent || (l.monthly_rent || 0) * 12 || 0);
    if (l.unit_id) tenantMap[l.tenant_name].units.push(l.unit_id);
    if (l.property_id) tenantMap[l.tenant_name].properties.add(l.property_id);
  });
  // Enrich from invoices
  invoices.forEach(inv => {
    const invoiceTenantName = inv.tenant_name || tenantNamesById[inv.tenant_id];
    if (invoiceTenantName && tenantMap[invoiceTenantName]) {
      tenantMap[invoiceTenantName].invoiceCount++;
      if (['sent', 'partial', 'overdue'].includes(inv.status)) {
        tenantMap[invoiceTenantName].outstandingBalance += (inv.total_amount || 0) - (inv.amount_paid || 0);
      }
    }
  });

  const tenants = Object.values(tenantMap).filter(t => {
    const matchSearch = !search || t.name?.toLowerCase().includes(search.toLowerCase());
    const hasActive = t.leases?.some(l => l.status !== 'expired');
    const matchStatus = statusFilter === "all" || (statusFilter === "active" && hasActive) || (statusFilter === "expired" && !hasActive);
    return matchSearch && matchStatus;
  });

  const activeTenants = Object.values(tenantMap).filter(t => t.leases?.some(l => l.status !== 'expired'));
  const totalOutstanding = Object.values(tenantMap).reduce((s, t) => s + (t.outstandingBalance || 0), 0);

  return (
    <div className="p-4 lg:p-6 space-y-4">
      <PageHeader icon={Users} title="Tenants" subtitle={`${Object.keys(tenantMap).length} tenants · Linked to leases, units, properties, and billing`} iconColor="from-blue-500 to-blue-700">
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => downloadCSV(tenants, 'tenants.csv')}><Download className="w-3.5 h-3.5 mr-1 text-slate-500" />Export</Button>
          <Button variant="outline" size="sm" onClick={() => setShowImport(true)}><Upload className="w-3.5 h-3.5 mr-1" />Import</Button>
          <ModuleLink page="Billing"><Button variant="outline" size="sm"><Receipt className="w-3.5 h-3.5 mr-1" />Billing</Button></ModuleLink>
          <Button size="sm" onClick={() => setShowAdd(true)} className="bg-blue-600 hover:bg-blue-700 shadow-sm"><Plus className="w-3.5 h-3.5 mr-1" />Add Tenant</Button>
        </div>
      </PageHeader>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Total Tenants", value: Object.keys(tenantMap).length, icon: Users, color: "bg-blue-50 text-blue-600" },
          { label: "Active Leases", value: activeTenants.length, icon: FileText, color: "bg-emerald-50 text-emerald-600" },
          { label: "Annual Rent", value: `$${(Object.values(tenantMap).reduce((s, t) => s + t.totalRent, 0) / 1000).toFixed(0)}K`, icon: DollarSign, color: "bg-amber-50 text-amber-600" },
          { label: "Outstanding", value: `$${(totalOutstanding / 1000).toFixed(0)}K`, icon: Receipt, color: "bg-red-50 text-red-600" },
        ].map((s, i) => (
          <Card key={i}><CardContent className="p-3 flex items-center gap-3">
            <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${s.color}`}><s.icon className="w-4 h-4" /></div>
            <div><p className="text-[10px] font-semibold text-slate-500 uppercase">{s.label}</p><p className="text-lg font-bold">{s.value}</p></div>
          </CardContent></Card>
        ))}
      </div>

      <div className="flex gap-3 items-center">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input placeholder="Search tenants..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9 h-8 text-sm" />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-32 h-8 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="all">All</SelectItem><SelectItem value="active">Active</SelectItem><SelectItem value="expired">Expired</SelectItem></SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow className="bg-slate-50">
              <TableHead className="text-[10px]">TENANT</TableHead>
              <TableHead className="text-[10px]">INDUSTRY</TableHead>
              <TableHead className="text-[10px]">PROPERTIES</TableHead>
              <TableHead className="text-[10px]">UNITS</TableHead>
              <TableHead className="text-[10px] text-right">ANNUAL RENT</TableHead>
              <TableHead className="text-[10px] text-right">OUTSTANDING</TableHead>
              <TableHead className="text-[10px]">STATUS</TableHead>
              <TableHead className="text-[10px]">NAVIGATE</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {tenants.length === 0 ? (
                <TableRow><TableCell colSpan={8} className="text-center py-8 text-sm text-slate-400">No tenants found</TableCell></TableRow>
              ) : tenants.map((t, i) => {
                const hasActive = t.leases?.some(l => l.status !== 'expired');
                return (
                  <TableRow key={i} className="hover:bg-slate-50">
                    <TableCell>
                      <div><p className="text-sm font-medium">{t.name}</p>{t.contact_email && <p className="text-[10px] text-slate-400">{t.contact_email}</p>}</div>
                    </TableCell>
                    <TableCell className="text-xs text-slate-500">{t.industry || '—'}</TableCell>
                    <TableCell className="text-xs">{t.properties?.size || 0}</TableCell>
                    <TableCell className="text-xs">{t.units?.length || 0}</TableCell>
                    <TableCell className="text-right text-xs font-bold tabular-nums">${(t.totalRent || 0).toLocaleString()}</TableCell>
                    <TableCell className={`text-right text-xs font-bold tabular-nums ${t.outstandingBalance > 0 ? 'text-red-600' : 'text-slate-400'}`}>${(t.outstandingBalance || 0).toLocaleString()}</TableCell>
                    <TableCell><Badge className={hasActive ? 'bg-emerald-100 text-emerald-700 text-[9px]' : 'bg-slate-100 text-slate-600 text-[9px]'}>{hasActive ? 'Active' : 'Expired'}</Badge></TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Link to={createPageUrl("TenantDetail") + `?name=${encodeURIComponent(t.name)}`}>
                          <Button variant="ghost" size="sm" className="h-6 text-[10px] px-2">Profile <ChevronRight className="w-3 h-3 ml-0.5" /></Button>
                        </Link>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add Tenant</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div><Label className="text-xs">Tenant Name</Label><Input value={form.name} onChange={e => setForm({...form, name: e.target.value})} /></div>
              <div><Label className="text-xs">Industry</Label><Input value={form.industry} onChange={e => setForm({...form, industry: e.target.value})} placeholder="e.g. Retail, Tech" /></div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div><Label className="text-xs">Contact Name</Label><Input value={form.contact_name} onChange={e => setForm({...form, contact_name: e.target.value})} /></div>
              <div><Label className="text-xs">Email</Label><Input value={form.contact_email} onChange={e => setForm({...form, contact_email: e.target.value})} /></div>
              <div><Label className="text-xs">Phone</Label><Input value={form.contact_phone} onChange={e => setForm({...form, contact_phone: e.target.value})} /></div>
            </div>
          </div>
          <DialogFooter><Button onClick={() => createMutation.mutate(form)} disabled={!form.name} className="bg-blue-600 hover:bg-blue-700">Create Tenant</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <BulkImportModal 
        isOpen={showImport} 
        onClose={() => setShowImport(false)} 
        moduleType="tenant" 
      />
    </div>
  );
}

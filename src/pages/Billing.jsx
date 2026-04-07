import React, { useState } from "react";
import { UnitService, BuildingService, InvoiceService, CAMCalculationService, PropertyService, LeaseService } from "@/services/api";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Search, Plus, Receipt, DollarSign, Clock, CheckCircle2, AlertTriangle, Loader2, Download, Home, Upload } from "lucide-react";
import ModuleLink from "@/components/ModuleLink";
import PageHeader from "@/components/PageHeader";
import { downloadCSV } from "@/utils/index";
import BulkImportModal from "@/components/property/BulkImportModal";

const statusColors = {
  draft: "bg-slate-100 text-slate-600", sent: "bg-blue-100 text-blue-700",
  paid: "bg-emerald-100 text-emerald-700", partial: "bg-amber-100 text-amber-700",
  overdue: "bg-red-100 text-red-700", void: "bg-slate-200 text-slate-500",
};

export default function Billing() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [showGenerate, setShowGenerate] = useState(false);
  const [showDetail, setShowDetail] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [genMonth, setGenMonth] = useState(new Date().toISOString().substring(0, 7));
  const queryClient = useQueryClient();

  const { data: invoices = [] } = useQuery({ queryKey: ['invoices'], queryFn: () => InvoiceService.list('-created_date') });
  const { data: leases = [] } = useQuery({ queryKey: ['leases-billing'], queryFn: () => LeaseService.list() });
  const { data: camCalcs = [] } = useQuery({ queryKey: ['cam-billing'], queryFn: () => CAMCalculationService.list() });
  const { data: properties = [] } = useQuery({ queryKey: ['bill-properties'], queryFn: () => PropertyService.list() });
  const { data: buildings = [] } = useQuery({ queryKey: ['bill-buildings'], queryFn: () => BuildingService.list() });
  const { data: units = [] } = useQuery({ queryKey: ['bill-units'], queryFn: () => UnitService.list() });

  const getPropertyName = (pid) => properties.find(p => p.id === pid)?.name || "—";
  const getLeaseInfo = (inv) => {
    const lease = leases.find(l => l.id === inv.lease_id);
    if (!lease) return {};
    const unit = lease.unit_id ? units.find(u => u.id === lease.unit_id) : null;
    const bld = unit?.building_id ? buildings.find(b => b.id === unit.building_id) : null;
    return { property: getPropertyName(lease.property_id), building: bld?.name, unit: unit?.unit_id_code };
  };

  const downloadInvoice = (inv) => {
    const info = getLeaseInfo(inv);
    const lines = [
      `INVOICE: ${inv.invoice_number || 'N/A'}`,
      `Date: ${new Date().toLocaleDateString()}`,
      ``,
      `BILL TO:`,
      `Tenant: ${inv.tenant_name}`,
      `Property: ${info.property || getPropertyName(inv.property_id)}`,
      info.building ? `Building: ${info.building}` : null,
      info.unit ? `Unit: ${info.unit}` : null,
      ``,
      `Billing Period: ${inv.billing_period}`,
      `Due Date: ${inv.due_date}`,
      ``,
      `CHARGES:`,
      `Base Rent:      $${(inv.base_rent || 0).toLocaleString()}`,
      `CAM Charges:    $${(inv.cam_charges || 0).toLocaleString()}`,
      `Other Charges:  $${(inv.other_charges || 0).toLocaleString()}`,
      `-------------------------------`,
      `TOTAL:          $${(inv.total_amount || 0).toLocaleString()}`,
      ``,
      inv.status === 'paid' ? `PAID on ${inv.payment_date} — $${(inv.amount_paid || 0).toLocaleString()}` : `Status: ${inv.status?.toUpperCase()}`,
    ].filter(Boolean).join('\n');
    const blob = new Blob([lines], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${inv.invoice_number || 'Invoice'}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const activeLeases = leases.filter(l => l.status !== 'expired');

  const handleGenerateInvoices = async () => {
    setGenerating(true);
    for (const lease of activeLeases) {
      const cam = camCalcs.find(c => c.lease_id === lease.id);
      const baseRent = lease.base_rent || 0;
      const camCharge = cam?.monthly_cam || 0;
      const total = baseRent + camCharge;
      await InvoiceService.create({
        org_id: lease.org_id || "default",
        property_id: lease.property_id,
        lease_id: lease.id,
        tenant_name: lease.tenant_name,
        invoice_number: `INV-${genMonth.replace('-', '')}-${lease.tenant_name?.substring(0, 3).toUpperCase() || 'XXX'}`,
        billing_period: genMonth,
        due_date: `${genMonth}-01`,
        base_rent: baseRent,
        cam_charges: camCharge,
        other_charges: 0,
        total_amount: total,
        status: "sent",
      });
    }
    queryClient.invalidateQueries({ queryKey: ['invoices'] });
    setGenerating(false);
    setShowGenerate(false);
  };

  const markPaid = useMutation({
    mutationFn: (inv) => InvoiceService.update(inv.id, { status: 'paid', amount_paid: inv.total_amount, payment_date: new Date().toISOString().substring(0, 10) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['invoices'] }),
  });

  const filtered = invoices.filter(inv => {
    const matchSearch = !search || inv.tenant_name?.toLowerCase().includes(search.toLowerCase()) || inv.invoice_number?.toLowerCase().includes(search.toLowerCase());
    const matchStatus = statusFilter === "all" || inv.status === statusFilter;
    return matchSearch && matchStatus;
  });

  const totalBilled = invoices.reduce((s, i) => s + (i.total_amount || 0), 0);
  const totalPaid = invoices.filter(i => i.status === 'paid').reduce((s, i) => s + (i.total_amount || 0), 0);
  const totalOverdue = invoices.filter(i => i.status === 'overdue').reduce((s, i) => s + (i.total_amount || 0), 0);
  const totalPending = invoices.filter(i => ['sent', 'partial'].includes(i.status)).reduce((s, i) => s + ((i.total_amount || 0) - (i.amount_paid || 0)), 0);

  return (
    <div className="p-4 lg:p-6 space-y-4">
      <PageHeader icon={Receipt} title="Billing & Invoicing" subtitle={`${invoices.length} invoices · Generate monthly tenant invoices from leases & CAM`} iconColor="from-emerald-500 to-emerald-700">
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => downloadCSV(invoices, 'invoices.csv')}><Download className="w-3.5 h-3.5 mr-1 text-slate-500" />Export</Button>
          <Button variant="outline" size="sm" onClick={() => setShowImport(true)}><Upload className="w-3.5 h-3.5 mr-1" />Import</Button>
          <Button size="sm" onClick={() => setShowGenerate(true)} className="bg-emerald-600 hover:bg-emerald-700 shadow-sm"><Plus className="w-3.5 h-3.5 mr-1" />Generate Invoices</Button>
        </div>
      </PageHeader>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: "Total Billed", value: `$${(totalBilled / 1000).toFixed(0)}K`, icon: DollarSign, color: "bg-blue-50 text-blue-600" },
          { label: "Collected", value: `$${(totalPaid / 1000).toFixed(0)}K`, icon: CheckCircle2, color: "bg-emerald-50 text-emerald-600" },
          { label: "Outstanding", value: `$${(totalPending / 1000).toFixed(0)}K`, icon: Clock, color: "bg-amber-50 text-amber-600" },
          { label: "Overdue", value: `$${(totalOverdue / 1000).toFixed(0)}K`, icon: AlertTriangle, color: "bg-red-50 text-red-600" },
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
          <Input placeholder="Search tenant or invoice..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9 h-8 text-sm" />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-32 h-8 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            {["draft","sent","paid","partial","overdue","void"].map(s => <SelectItem key={s} value={s}>{s.charAt(0).toUpperCase()+s.slice(1)}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow className="bg-slate-50">
              <TableHead className="text-[10px]">INVOICE #</TableHead>
              <TableHead className="text-[10px]">TENANT</TableHead>
              <TableHead className="text-[10px]">PROPERTY / LOCATION</TableHead>
              <TableHead className="text-[10px]">PERIOD</TableHead>
              <TableHead className="text-[10px] text-right">BASE RENT</TableHead>
              <TableHead className="text-[10px] text-right">CAM</TableHead>
              <TableHead className="text-[10px] text-right">TOTAL</TableHead>
              <TableHead className="text-[10px]">STATUS</TableHead>
              <TableHead className="text-[10px]">DUE DATE</TableHead>
              <TableHead className="text-[10px]">ACTIONS</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow><TableCell colSpan={10} className="text-center py-8 text-sm text-slate-400">No invoices yet. Generate from active leases.</TableCell></TableRow>
              ) : filtered.map(inv => {
                const info = getLeaseInfo(inv);
                const propName = info.property || getPropertyName(inv.property_id);
                return (
                <TableRow key={inv.id} className="hover:bg-slate-50">
                  <TableCell className="font-mono text-xs font-semibold">{inv.invoice_number || '—'}</TableCell>
                  <TableCell>
                    <ModuleLink page="TenantDetail" params={`name=${encodeURIComponent(inv.tenant_name)}`} className="text-sm font-medium text-blue-600 hover:underline" fallback={<span className="text-sm font-medium">{inv.tenant_name}</span>}>{inv.tenant_name}</ModuleLink>
                  </TableCell>
                  <TableCell>
                    <div className="text-xs">
                      <p className="font-medium text-slate-800">{propName}</p>
                      {(info.building || info.unit) && (
                        <p className="text-slate-400">{[info.building, info.unit].filter(Boolean).join(' · ')}</p>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-xs">{inv.billing_period}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums">${(inv.base_rent || 0).toLocaleString()}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums">${(inv.cam_charges || 0).toLocaleString()}</TableCell>
                  <TableCell className="text-right text-xs font-bold tabular-nums">${(inv.total_amount || 0).toLocaleString()}</TableCell>
                  <TableCell><Badge className={`${statusColors[inv.status] || statusColors.draft} text-[9px] uppercase`}>{inv.status}</Badge></TableCell>
                  <TableCell className="text-xs">{inv.due_date}</TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="sm" className="h-7 text-[10px] px-2" onClick={() => setShowDetail(inv)}>Detail</Button>
                      <Button variant="ghost" size="sm" className="h-7 text-[10px] px-2 text-blue-600" onClick={() => downloadInvoice(inv)}><Download className="w-3 h-3" /></Button>
                      {inv.status === 'sent' && <Button variant="ghost" size="sm" className="h-7 text-[10px] px-2 text-emerald-600" onClick={() => markPaid.mutate(inv)}>Mark Paid</Button>}
                    </div>
                  </TableCell>
                </TableRow>);
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Generate Dialog */}
      <Dialog open={showGenerate} onOpenChange={setShowGenerate}>
        <DialogContent>
          <DialogHeader><DialogTitle>Generate Monthly Invoices</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div><Label className="text-xs">Billing Period</Label><Input type="month" value={genMonth} onChange={e => setGenMonth(e.target.value)} /></div>
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
              <p className="text-sm font-medium text-blue-800">{activeLeases.length} active lease{activeLeases.length !== 1 ? 's' : ''} will generate invoices</p>
              <p className="text-xs text-blue-600 mt-1">Each invoice includes base rent + CAM charges from lease and CAM engine data.</p>
            </div>
            {activeLeases.length > 0 && (
              <div className="max-h-48 overflow-y-auto border rounded-lg divide-y">
                {activeLeases.map(l => {
                  const propName = getPropertyName(l.property_id);
                  const unit = l.unit_id ? units.find(u => u.id === l.unit_id) : null;
                  const bld = unit?.building_id ? buildings.find(b => b.id === unit.building_id) : null;
                  return (
                    <div key={l.id} className="flex items-center gap-3 px-3 py-2 text-xs">
                      <Home className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-slate-800 truncate">{l.tenant_name}</p>
                        <p className="text-slate-400 truncate">{propName}{bld ? ` · ${bld.name}` : ''}{unit ? ` · ${unit.unit_id_code}` : ''}</p>
                      </div>
                      <span className="text-slate-500 font-mono flex-shrink-0">${(l.base_rent || 0).toLocaleString()}/mo</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button onClick={handleGenerateInvoices} disabled={generating} className="bg-emerald-600 hover:bg-emerald-700">
              {generating ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Receipt className="w-4 h-4 mr-1" />}
              Generate {activeLeases.length} Invoices
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Invoice Detail Dialog */}
      <Dialog open={!!showDetail} onOpenChange={() => setShowDetail(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Invoice Detail</DialogTitle></DialogHeader>
          {showDetail && (() => {
            const detailInfo = getLeaseInfo(showDetail);
            const detailPropName = detailInfo.property || getPropertyName(showDetail.property_id);
            return (
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <span className="font-mono text-sm font-bold">{showDetail.invoice_number}</span>
                <Badge className={`${statusColors[showDetail.status]} uppercase text-[10px]`}>{showDetail.status}</Badge>
              </div>
              <div className="text-sm"><span className="text-slate-500">Tenant:</span> <span className="font-medium">{showDetail.tenant_name}</span></div>
              <div className="text-sm"><span className="text-slate-500">Property:</span> <span className="font-medium">{detailPropName}</span></div>
              {detailInfo.building && <div className="text-sm"><span className="text-slate-500">Building:</span> <span className="font-medium">{detailInfo.building}</span></div>}
              {detailInfo.unit && <div className="text-sm"><span className="text-slate-500">Unit:</span> <span className="font-medium">{detailInfo.unit}</span></div>}
              <div className="text-sm"><span className="text-slate-500">Period:</span> {showDetail.billing_period}</div>
              <div className="border rounded-lg divide-y text-sm">
                <div className="flex justify-between px-3 py-2"><span className="text-slate-500">Base Rent</span><span className="font-mono">${(showDetail.base_rent || 0).toLocaleString()}</span></div>
                <div className="flex justify-between px-3 py-2"><span className="text-slate-500">CAM Charges</span><span className="font-mono">${(showDetail.cam_charges || 0).toLocaleString()}</span></div>
                <div className="flex justify-between px-3 py-2"><span className="text-slate-500">Other Charges</span><span className="font-mono">${(showDetail.other_charges || 0).toLocaleString()}</span></div>
                <div className="flex justify-between px-3 py-2 bg-slate-50 font-bold"><span>Total</span><span className="font-mono">${(showDetail.total_amount || 0).toLocaleString()}</span></div>
              </div>
              {showDetail.status === 'paid' && <div className="text-xs text-emerald-600">Paid on {showDetail.payment_date} · ${(showDetail.amount_paid || 0).toLocaleString()} collected</div>}
              <Button variant="outline" size="sm" className="w-full" onClick={() => downloadInvoice(showDetail)}>
                <Download className="w-3.5 h-3.5 mr-2" />Download Invoice
              </Button>
            </div>);
          })()}
        </DialogContent>
      </Dialog>

      <BulkImportModal 
        isOpen={showImport} 
        onClose={() => setShowImport(false)} 
        moduleType="invoice" 
      />
    </div>
  );
}
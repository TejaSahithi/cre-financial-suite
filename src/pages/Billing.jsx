import React, { useState } from "react";
import {
  UnitService,
  BuildingService,
  InvoiceService,
  CAMCalculationService,
  PropertyService,
  LeaseService,
  TenantService,
} from "@/services/api";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Search,
  Plus,
  Receipt,
  DollarSign,
  Clock,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Download,
  Home,
  Upload,
} from "lucide-react";
import ModuleLink from "@/components/ModuleLink";
import PageHeader from "@/components/PageHeader";
import { downloadCSV } from "@/utils/index";
import BulkImportModal from "@/components/property/BulkImportModal";

const statusColors = {
  draft: "bg-slate-100 text-slate-600",
  pending: "bg-slate-100 text-slate-600",
  sent: "bg-blue-100 text-blue-700",
  paid: "bg-emerald-100 text-emerald-700",
  partial: "bg-amber-100 text-amber-700",
  overdue: "bg-red-100 text-red-700",
  void: "bg-slate-200 text-slate-500",
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

  const { data: invoices = [] } = useQuery({ queryKey: ["invoices"], queryFn: () => InvoiceService.list("-created_at") });
  const { data: leases = [] } = useQuery({ queryKey: ["leases-billing"], queryFn: () => LeaseService.list() });
  const { data: camCalcs = [] } = useQuery({ queryKey: ["cam-billing"], queryFn: () => CAMCalculationService.list() });
  const { data: properties = [] } = useQuery({ queryKey: ["bill-properties"], queryFn: () => PropertyService.list() });
  const { data: buildings = [] } = useQuery({ queryKey: ["bill-buildings"], queryFn: () => BuildingService.list() });
  const { data: units = [] } = useQuery({ queryKey: ["bill-units"], queryFn: () => UnitService.list() });
  const { data: tenants = [] } = useQuery({ queryKey: ["bill-tenants"], queryFn: () => TenantService.list() });

  const getPropertyName = (propertyId) => properties.find((property) => property.id === propertyId)?.name || "—";

  const getLeaseInfo = (lease) => {
    if (!lease) return {};
    const unit = lease.unit_id ? units.find((item) => item.id === lease.unit_id) : null;
    const building = unit?.building_id ? buildings.find((item) => item.id === unit.building_id) : null;
    return {
      property: getPropertyName(lease.property_id),
      building: building?.name,
      unit: unit?.unit_id_code || unit?.unit_number,
    };
  };

  const findLeaseForInvoice = (invoice) =>
    leases.find((lease) => {
      const propertyMatch = !invoice.property_id || lease.property_id === invoice.property_id;
      const tenantMatch = invoice.tenant_id ? lease.tenant_id === invoice.tenant_id : false;
      return propertyMatch && tenantMatch;
    }) || null;

  const invoiceRows = invoices.map((invoice) => {
    const lease = findLeaseForInvoice(invoice);
    const leaseInfo = getLeaseInfo(lease);
    const tenant = invoice.tenant_id ? tenants.find((item) => item.id === invoice.tenant_id) : null;
    const camCalc = lease ? camCalcs.find((item) => item.lease_id === lease.id) : null;
    const baseRent = Number(lease?.base_rent || lease?.monthly_rent || 0);
    const camCharges = Number(camCalc?.monthly_cam || (Number(lease?.cam_amount || 0) / 12) || 0);
    const totalAmount = Number(invoice.total_amount || invoice.amount || baseRent + camCharges || 0);
    const amountPaid = Number(invoice.amount_paid || (invoice.status === "paid" ? totalAmount : 0));

    return {
      id: invoice.id,
      raw: invoice,
      lease,
      invoiceNumber: invoice.invoice_number || `INV-${String(invoice.id).slice(0, 8).toUpperCase()}`,
      billingPeriod: invoice.billing_period || (invoice.issued_date ? String(invoice.issued_date).slice(0, 7) : "—"),
      tenantName: tenant?.name || lease?.tenant_name || "—",
      propertyName: leaseInfo.property || getPropertyName(invoice.property_id),
      buildingName: leaseInfo.building,
      unitNumber: leaseInfo.unit,
      baseRent,
      camCharges,
      totalAmount,
      amountPaid,
      dueDate: invoice.due_date || invoice.issued_date || "—",
      issuedDate: invoice.issued_date || "—",
      status: invoice.status || "pending",
    };
  });

  const downloadInvoice = (invoice) => {
    const lines = [
      `INVOICE: ${invoice.invoiceNumber || "N/A"}`,
      `Date: ${new Date().toLocaleDateString()}`,
      "",
      "BILL TO:",
      `Tenant: ${invoice.tenantName}`,
      `Property: ${invoice.propertyName}`,
      invoice.buildingName ? `Building: ${invoice.buildingName}` : null,
      invoice.unitNumber ? `Unit: ${invoice.unitNumber}` : null,
      "",
      `Billing Period: ${invoice.billingPeriod}`,
      `Due Date: ${invoice.dueDate}`,
      "",
      "CHARGES:",
      `Base Rent:      $${invoice.baseRent.toLocaleString()}`,
      `CAM Charges:    $${invoice.camCharges.toLocaleString()}`,
      "-------------------------------",
      `TOTAL:          $${invoice.totalAmount.toLocaleString()}`,
      "",
      invoice.status === "paid"
        ? `PAID - $${invoice.amountPaid.toLocaleString()}`
        : `Status: ${invoice.status?.toUpperCase()}`,
    ].filter(Boolean).join("\n");

    const blob = new Blob([lines], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${invoice.invoiceNumber || "Invoice"}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const activeLeases = leases.filter((lease) => lease.status !== "expired");
  const fallbackOrgId =
    leases.find((lease) => lease.org_id)?.org_id ||
    properties.find((property) => property.org_id)?.org_id ||
    tenants.find((tenant) => tenant.org_id)?.org_id ||
    null;

  const resolveTenantIdForLease = async (lease) => {
    if (lease.tenant_id) return lease.tenant_id;
    const tenantName = String(lease.tenant_name || "").trim();
    if (!tenantName) return null;

    const existing = tenants.find((tenant) => tenant.name?.trim().toLowerCase() === tenantName.toLowerCase());
    if (existing?.id) return existing.id;

    const orgId = lease.org_id || fallbackOrgId;
    if (!orgId) return null;

    const created = await TenantService.create({
      org_id: orgId,
      name: tenantName,
      status: "active",
    });

    return created?.id || null;
  };

  const handleGenerateInvoices = async () => {
    setGenerating(true);
    try {
      for (const lease of activeLeases) {
        const camCalc = camCalcs.find((item) => item.lease_id === lease.id);
        const baseRent = Number(lease.base_rent || lease.monthly_rent || 0);
        const camCharges = Number(camCalc?.monthly_cam || (Number(lease.cam_amount || 0) / 12) || 0);
        const tenantId = await resolveTenantIdForLease(lease);
        const issuedDate = `${genMonth}-01`;

        await InvoiceService.create({
          org_id: lease.org_id || fallbackOrgId,
          property_id: lease.property_id,
          tenant_id: tenantId,
          amount: baseRent + camCharges,
          status: "sent",
          issued_date: issuedDate,
          due_date: issuedDate,
        });
      }

      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      queryClient.invalidateQueries({ queryKey: ["bill-tenants"] });
      setShowGenerate(false);
    } finally {
      setGenerating(false);
    }
  };

  const markPaid = useMutation({
    mutationFn: (invoice) => InvoiceService.update(invoice.id, { status: "paid" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["invoices"] }),
  });

  const filtered = invoiceRows.filter((invoice) => {
    const matchSearch =
      !search ||
      invoice.tenantName?.toLowerCase().includes(search.toLowerCase()) ||
      invoice.invoiceNumber?.toLowerCase().includes(search.toLowerCase()) ||
      invoice.propertyName?.toLowerCase().includes(search.toLowerCase());
    const matchStatus = statusFilter === "all" || invoice.status === statusFilter;
    return matchSearch && matchStatus;
  });

  const totalBilled = invoiceRows.reduce((sum, invoice) => sum + invoice.totalAmount, 0);
  const totalPaid = invoiceRows.filter((invoice) => invoice.status === "paid").reduce((sum, invoice) => sum + invoice.totalAmount, 0);
  const totalOverdue = invoiceRows.filter((invoice) => invoice.status === "overdue").reduce((sum, invoice) => sum + invoice.totalAmount, 0);
  const totalPending = invoiceRows
    .filter((invoice) => ["sent", "partial", "pending"].includes(invoice.status))
    .reduce((sum, invoice) => sum + Math.max(invoice.totalAmount - invoice.amountPaid, 0), 0);

  return (
    <div className="p-4 lg:p-6 space-y-4">
      <PageHeader
        icon={Receipt}
        title="Billing & Invoicing"
        subtitle={`${invoiceRows.length} invoices · Generate monthly tenant invoices from leases and CAM`}
        iconColor="from-emerald-500 to-emerald-700"
      >
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => downloadCSV(invoiceRows, "invoices.csv")}>
            <Download className="w-3.5 h-3.5 mr-1 text-slate-500" />
            Export
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowImport(true)}>
            <Upload className="w-3.5 h-3.5 mr-1" />
            Import
          </Button>
          <Button size="sm" onClick={() => setShowGenerate(true)} className="bg-emerald-600 hover:bg-emerald-700 shadow-sm">
            <Plus className="w-3.5 h-3.5 mr-1" />
            Generate Invoices
          </Button>
        </div>
      </PageHeader>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: "Total Billed", value: `$${(totalBilled / 1000).toFixed(0)}K`, icon: DollarSign, color: "bg-blue-50 text-blue-600" },
          { label: "Collected", value: `$${(totalPaid / 1000).toFixed(0)}K`, icon: CheckCircle2, color: "bg-emerald-50 text-emerald-600" },
          { label: "Outstanding", value: `$${(totalPending / 1000).toFixed(0)}K`, icon: Clock, color: "bg-amber-50 text-amber-600" },
          { label: "Overdue", value: `$${(totalOverdue / 1000).toFixed(0)}K`, icon: AlertTriangle, color: "bg-red-50 text-red-600" },
        ].map((stat, index) => (
          <Card key={index}>
            <CardContent className="p-3 flex items-center gap-3">
              <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${stat.color}`}>
                <stat.icon className="w-4 h-4" />
              </div>
              <div>
                <p className="text-[10px] font-semibold text-slate-500 uppercase">{stat.label}</p>
                <p className="text-lg font-bold">{stat.value}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="flex gap-3 items-center">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input
            placeholder="Search tenant or invoice..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-8 text-sm"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-32 h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            {["draft", "pending", "sent", "paid", "partial", "overdue", "void"].map((status) => (
              <SelectItem key={status} value={status}>
                {status.charAt(0).toUpperCase() + status.slice(1)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="bg-slate-50">
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
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={10} className="text-center py-8 text-sm text-slate-400">
                    No invoices yet. Generate from active leases.
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((invoice) => (
                  <TableRow key={invoice.id} className="hover:bg-slate-50">
                    <TableCell className="font-mono text-xs font-semibold">{invoice.invoiceNumber}</TableCell>
                    <TableCell>
                      <ModuleLink
                        page="TenantDetail"
                        params={`name=${encodeURIComponent(invoice.tenantName)}`}
                        className="text-sm font-medium text-blue-600 hover:underline"
                        fallback={<span className="text-sm font-medium">{invoice.tenantName}</span>}
                      >
                        {invoice.tenantName}
                      </ModuleLink>
                    </TableCell>
                    <TableCell>
                      <div className="text-xs">
                        <p className="font-medium text-slate-800">{invoice.propertyName}</p>
                        {(invoice.buildingName || invoice.unitNumber) && (
                          <p className="text-slate-400">{[invoice.buildingName, invoice.unitNumber].filter(Boolean).join(" · ")}</p>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs">{invoice.billingPeriod}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums">${invoice.baseRent.toLocaleString()}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums">${invoice.camCharges.toLocaleString()}</TableCell>
                    <TableCell className="text-right text-xs font-bold tabular-nums">${invoice.totalAmount.toLocaleString()}</TableCell>
                    <TableCell>
                      <Badge className={`${statusColors[invoice.status] || statusColors.draft} text-[9px] uppercase`}>
                        {invoice.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">{invoice.dueDate}</TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button variant="ghost" size="sm" className="h-7 text-[10px] px-2" onClick={() => setShowDetail(invoice)}>
                          Detail
                        </Button>
                        <Button variant="ghost" size="sm" className="h-7 text-[10px] px-2 text-blue-600" onClick={() => downloadInvoice(invoice)}>
                          <Download className="w-3 h-3" />
                        </Button>
                        {["sent", "partial", "pending"].includes(invoice.status) && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-[10px] px-2 text-emerald-600"
                            onClick={() => markPaid.mutate(invoice.raw)}
                          >
                            Mark Paid
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={showGenerate} onOpenChange={setShowGenerate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Generate Monthly Invoices</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label className="text-xs">Billing Period</Label>
              <Input type="month" value={genMonth} onChange={(e) => setGenMonth(e.target.value)} />
            </div>
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
              <p className="text-sm font-medium text-blue-800">
                {activeLeases.length} active lease{activeLeases.length !== 1 ? "s" : ""} will generate invoices
              </p>
              <p className="text-xs text-blue-600 mt-1">Each invoice includes base rent and CAM charges from lease and CAM engine data.</p>
            </div>
            {activeLeases.length > 0 && (
              <div className="max-h-48 overflow-y-auto border rounded-lg divide-y">
                {activeLeases.map((lease) => {
                  const unit = lease.unit_id ? units.find((item) => item.id === lease.unit_id) : null;
                  const building = unit?.building_id ? buildings.find((item) => item.id === unit.building_id) : null;
                  return (
                    <div key={lease.id} className="flex items-center gap-3 px-3 py-2 text-xs">
                      <Home className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-slate-800 truncate">{lease.tenant_name || "—"}</p>
                        <p className="text-slate-400 truncate">
                          {getPropertyName(lease.property_id)}
                          {building ? ` · ${building.name}` : ""}
                          {unit ? ` · ${unit.unit_id_code || unit.unit_number}` : ""}
                        </p>
                      </div>
                      <span className="text-slate-500 font-mono flex-shrink-0">
                        ${Number(lease.base_rent || lease.monthly_rent || 0).toLocaleString()}/mo
                      </span>
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

      <Dialog open={!!showDetail} onOpenChange={() => setShowDetail(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Invoice Detail</DialogTitle>
          </DialogHeader>
          {showDetail && (
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <span className="font-mono text-sm font-bold">{showDetail.invoiceNumber}</span>
                <Badge className={`${statusColors[showDetail.status] || statusColors.draft} uppercase text-[10px]`}>
                  {showDetail.status}
                </Badge>
              </div>
              <div className="text-sm">
                <span className="text-slate-500">Tenant:</span> <span className="font-medium">{showDetail.tenantName}</span>
              </div>
              <div className="text-sm">
                <span className="text-slate-500">Property:</span> <span className="font-medium">{showDetail.propertyName}</span>
              </div>
              {showDetail.buildingName && (
                <div className="text-sm">
                  <span className="text-slate-500">Building:</span> <span className="font-medium">{showDetail.buildingName}</span>
                </div>
              )}
              {showDetail.unitNumber && (
                <div className="text-sm">
                  <span className="text-slate-500">Unit:</span> <span className="font-medium">{showDetail.unitNumber}</span>
                </div>
              )}
              <div className="text-sm">
                <span className="text-slate-500">Period:</span> {showDetail.billingPeriod}
              </div>
              <div className="border rounded-lg divide-y text-sm">
                <div className="flex justify-between px-3 py-2">
                  <span className="text-slate-500">Base Rent</span>
                  <span className="font-mono">${showDetail.baseRent.toLocaleString()}</span>
                </div>
                <div className="flex justify-between px-3 py-2">
                  <span className="text-slate-500">CAM Charges</span>
                  <span className="font-mono">${showDetail.camCharges.toLocaleString()}</span>
                </div>
                <div className="flex justify-between px-3 py-2 bg-slate-50 font-bold">
                  <span>Total</span>
                  <span className="font-mono">${showDetail.totalAmount.toLocaleString()}</span>
                </div>
              </div>
              {showDetail.status === "paid" && (
                <div className="text-xs text-emerald-600">${showDetail.amountPaid.toLocaleString()} collected</div>
              )}
              <Button variant="outline" size="sm" className="w-full" onClick={() => downloadInvoice(showDetail)}>
                <Download className="w-3.5 h-3.5 mr-2" />
                Download Invoice
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <BulkImportModal isOpen={showImport} onClose={() => setShowImport(false)} moduleType="invoice" />
    </div>
  );
}

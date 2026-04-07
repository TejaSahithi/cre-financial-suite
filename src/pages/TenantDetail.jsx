import React from "react";
import { CAMCalculationService, InvoiceService, LeaseService, TenantService } from "@/services/api";

import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ArrowLeft, Building2, FileText, DollarSign, Calculator, Receipt, ChevronRight } from "lucide-react";
import { useLocation, Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import AuditTrailPanel from "@/components/AuditTrailPanel";
import ModuleLink from "@/components/ModuleLink";

export default function TenantDetail() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const tenantName = params.get("name") || "";

  const { data: leases = [] } = useQuery({
    queryKey: ['tenant-leases', tenantName],
    queryFn: () => LeaseService.filter({ tenant_name: tenantName }),
    enabled: !!tenantName,
  });

  const { data: camCalcs = [] } = useQuery({
    queryKey: ['tenant-cam', tenantName],
    queryFn: () => CAMCalculationService.filter({ tenant_name: tenantName }),
    enabled: !!tenantName,
  });

  const { data: invoices = [] } = useQuery({
    queryKey: ['tenant-invoices', tenantName],
    queryFn: () => InvoiceService.filter({ tenant_name: tenantName }),
    enabled: !!tenantName,
  });

  const { data: tenantEntities = [] } = useQuery({
    queryKey: ['tenant-entity', tenantName],
    queryFn: () => TenantService.filter({ name: tenantName }),
    enabled: !!tenantName,
  });

  const tenantEntity = tenantEntities[0];

  const activeLeases = leases.filter(l => l.status !== 'expired');
  const totalRent = leases.reduce((s, l) => s + (l.annual_rent || 0), 0);
  const totalCAM = camCalcs.reduce((s, c) => s + (c.annual_cam || 0), 0);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link to={createPageUrl("Tenants")} className="text-slate-400 hover:text-slate-600"><ArrowLeft className="w-5 h-5" /></Link>
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{tenantName}</h1>
          <p className="text-sm text-slate-500">{activeLeases.length} active lease(s)</p>
        </div>
      </div>

      {/* Tenant Profile Info */}
      {tenantEntity && (
        <div className="bg-slate-50 rounded-lg p-3 flex flex-wrap gap-6 text-xs">
          {tenantEntity.industry && <div><span className="text-slate-500">Industry:</span> <span className="font-medium">{tenantEntity.industry}</span></div>}
          {tenantEntity.contact_name && <div><span className="text-slate-500">Contact:</span> <span className="font-medium">{tenantEntity.contact_name}</span></div>}
          {tenantEntity.contact_email && <div><span className="text-slate-500">Email:</span> <span className="font-medium">{tenantEntity.contact_email}</span></div>}
          {tenantEntity.contact_phone && <div><span className="text-slate-500">Phone:</span> <span className="font-medium">{tenantEntity.contact_phone}</span></div>}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[
          { label: "Active Leases", value: activeLeases.length, icon: FileText, color: "text-blue-600 bg-blue-50" },
          { label: "Annual Rent", value: `$${totalRent.toLocaleString()}`, icon: DollarSign, color: "text-emerald-600 bg-emerald-50" },
          { label: "Annual CAM", value: `$${totalCAM.toLocaleString()}`, icon: Calculator, color: "text-purple-600 bg-purple-50" },
          { label: "Properties", value: new Set(leases.map(l => l.property_id)).size, icon: Building2, color: "text-amber-600 bg-amber-50" },
          { label: "Invoices", value: invoices.length, icon: Receipt, color: "text-rose-600 bg-rose-50" },
        ].map((s, i) => (
          <Card key={i}><CardContent className="p-3 flex items-center gap-2.5">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${s.color}`}><s.icon className="w-4 h-4" /></div>
            <div><p className="text-[9px] font-semibold text-slate-500 uppercase">{s.label}</p><p className="text-lg font-bold">{s.value}</p></div>
          </CardContent></Card>
        ))}
      </div>

      {/* Navigation breadcrumb */}
      <div className="flex items-center gap-2 text-[10px] text-slate-400 flex-wrap">
        <Link to={createPageUrl("Tenants")} className="hover:text-blue-600">Tenants</Link> <ChevronRight className="w-3 h-3" />
        <span className="font-medium text-slate-600">{tenantName}</span>
        {leases[0]?.property_id && (<>
          <ChevronRight className="w-3 h-3" />
          <ModuleLink page="PropertyDetail" params={`id=${leases[0].property_id}`} className="hover:text-blue-600" fallback={<span className="text-slate-400">Property</span>}>Property</ModuleLink>
        </>)}
        <span className="ml-auto">
          <ModuleLink page="Billing" className="text-blue-600 font-semibold hover:underline flex items-center gap-0.5" fallback={null}>View Billing <ChevronRight className="w-3 h-3" /></ModuleLink>
        </span>
      </div>

      <Tabs defaultValue="leases">
        <TabsList>
          <TabsTrigger value="leases">Leases</TabsTrigger>
          <TabsTrigger value="rent">Rent Schedule</TabsTrigger>
          <TabsTrigger value="cam">CAM Charges</TabsTrigger>
          <TabsTrigger value="invoices">Invoices ({invoices.length})</TabsTrigger>
          <TabsTrigger value="audit">Audit Trail</TabsTrigger>
        </TabsList>

        <TabsContent value="leases" className="mt-4">
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader><TableRow className="bg-slate-50">
                  <TableHead className="text-[11px]">LEASE</TableHead>
                  <TableHead className="text-[11px]">TYPE</TableHead>
                  <TableHead className="text-[11px]">START</TableHead>
                  <TableHead className="text-[11px]">END</TableHead>
                  <TableHead className="text-[11px]">BASE RENT</TableHead>
                  <TableHead className="text-[11px]">STATUS</TableHead>
                </TableRow></TableHeader>
                <TableBody>
                  {leases.map(l => (
                    <TableRow key={l.id}>
                      <TableCell className="font-medium">{l.tenant_name}</TableCell>
                      <TableCell><Badge variant="outline" className="text-[10px]">{l.lease_type}</Badge></TableCell>
                      <TableCell className="text-sm">{l.start_date}</TableCell>
                      <TableCell className="text-sm">{l.end_date}</TableCell>
                      <TableCell className="font-mono">${(l.base_rent || 0).toLocaleString()}/mo</TableCell>
                      <TableCell><Badge className={l.status === 'expired' ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-700'}>{l.status}</Badge></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="rent" className="mt-4">
          <Card><CardContent className="p-6">
            <p className="text-sm text-slate-500">Monthly rent schedule based on active leases.</p>
            <Table className="mt-4">
              <TableHeader><TableRow className="bg-slate-50">
                <TableHead className="text-[11px]">MONTH</TableHead>
                <TableHead className="text-[11px]">BASE RENT</TableHead>
                <TableHead className="text-[11px]">CAM</TableHead>
                <TableHead className="text-[11px]">TOTAL</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"].map(m => {
                  const monthlyRent = activeLeases.reduce((s, l) => s + (l.base_rent || 0), 0);
                  const monthlyCam = camCalcs.reduce((s, c) => s + (c.monthly_cam || 0), 0);
                  return (
                    <TableRow key={m}>
                      <TableCell>{m}</TableCell>
                      <TableCell className="font-mono">${monthlyRent.toLocaleString()}</TableCell>
                      <TableCell className="font-mono">${monthlyCam.toLocaleString()}</TableCell>
                      <TableCell className="font-mono font-semibold">${(monthlyRent + monthlyCam).toLocaleString()}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="cam" className="mt-4">
          <Card><CardContent className="p-0">
            <Table>
              <TableHeader><TableRow className="bg-slate-50">
                <TableHead className="text-[11px]">FISCAL YEAR</TableHead>
                <TableHead className="text-[11px]">ANNUAL CAM</TableHead>
                <TableHead className="text-[11px]">MONTHLY CAM</TableHead>
                <TableHead className="text-[11px]">SHARE %</TableHead>
                <TableHead className="text-[11px]">CAP APPLIED</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {camCalcs.map(c => (
                  <TableRow key={c.id}>
                    <TableCell>{c.fiscal_year}</TableCell>
                    <TableCell className="font-mono">${(c.annual_cam || 0).toLocaleString()}</TableCell>
                    <TableCell className="font-mono">${(c.monthly_cam || 0).toLocaleString()}</TableCell>
                    <TableCell>{(c.tenant_share_pct || 0).toFixed(1)}%</TableCell>
                    <TableCell>{c.cap_applied ? <Badge className="bg-amber-100 text-amber-700">Yes</Badge> : 'No'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent></Card>
        </TabsContent>
        <TabsContent value="invoices" className="mt-4">
          <Card><CardContent className="p-0">
            <Table>
              <TableHeader><TableRow className="bg-slate-50">
                <TableHead className="text-[11px]">INVOICE #</TableHead>
                <TableHead className="text-[11px]">PERIOD</TableHead>
                <TableHead className="text-[11px]">TOTAL</TableHead>
                <TableHead className="text-[11px]">STATUS</TableHead>
                <TableHead className="text-[11px]">DUE DATE</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {invoices.length === 0 ? (
                  <TableRow><TableCell colSpan={5} className="text-center py-8 text-sm text-slate-400">No invoices for this tenant</TableCell></TableRow>
                ) : invoices.map(inv => (
                  <TableRow key={inv.id}>
                    <TableCell className="font-mono text-xs">{inv.invoice_number || '—'}</TableCell>
                    <TableCell className="text-xs">{inv.billing_period}</TableCell>
                    <TableCell className="font-mono text-xs font-bold">${(inv.total_amount || 0).toLocaleString()}</TableCell>
                    <TableCell><Badge className={`text-[9px] uppercase ${inv.status === 'paid' ? 'bg-emerald-100 text-emerald-700' : inv.status === 'overdue' ? 'bg-red-100 text-red-700' : 'bg-blue-100 text-blue-700'}`}>{inv.status}</Badge></TableCell>
                    <TableCell className="text-xs">{inv.due_date}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="audit" className="mt-4">
          <AuditTrailPanel entityType="Lease" />
        </TabsContent>
      </Tabs>
    </div>
  );
}
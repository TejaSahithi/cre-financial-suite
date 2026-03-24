import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowLeft, User, FileText } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from "recharts";
import RevenueSourcePopover from "./RevenueSourcePopover";

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function fmt(v) {
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toLocaleString()}`;
}

export default function TenantDrillDown({ tenant, leases, camCalcs, propertyName, onBack }) {
  const tenantLeases = leases.filter(l => l.tenant_name === tenant.name);
  const tenantCams = camCalcs.filter(c => tenantLeases.some(l => l.id === c.lease_id));

  const monthlyRent = tenantLeases.reduce((s, l) => s + (l.base_rent || 0), 0);
  const monthlyCam = tenantCams.reduce((s, c) => s + (c.monthly_cam || 0), 0);
  const annualRent = tenantLeases.reduce((s, l) => s + (l.annual_rent || l.base_rent * 12 || 0), 0);
  const annualCam = tenantCams.reduce((s, c) => s + (c.annual_cam || 0), 0);

  const monthlyData = MONTHS.map(m => ({ month: m, Rent: monthlyRent, CAM: monthlyCam }));

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack} className="text-slate-500 hover:text-slate-900">
          <ArrowLeft className="w-4 h-4 mr-1" /> Back to {propertyName}
        </Button>
        <div className="h-5 w-px bg-slate-200" />
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center">
            <User className="w-4 h-4 text-blue-600" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-slate-900">{tenant.name}</h2>
            <p className="text-xs text-slate-500">{propertyName}</p>
          </div>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[
          { label: "Annual Rent", value: fmt(annualRent) },
          { label: "Annual CAM", value: fmt(annualCam) },
          { label: "Total Revenue", value: fmt(annualRent + annualCam) },
          { label: "Monthly Rent", value: fmt(monthlyRent) },
          { label: "Monthly CAM", value: fmt(monthlyCam) },
        ].map((k, i) => (
          <Card key={i}><CardContent className="p-3">
            <p className="text-[10px] font-semibold text-slate-500 uppercase">{k.label}</p>
            <p className="text-lg font-bold text-slate-900 mt-0.5">{k.value}</p>
          </CardContent></Card>
        ))}
      </div>

      {/* Monthly chart */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Monthly Revenue</CardTitle></CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={monthlyData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="month" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `$${(v / 1000).toFixed(0)}K`} />
              <Tooltip formatter={v => `$${v.toLocaleString()}`} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="Rent" fill="#1a2744" radius={[3, 3, 0, 0]} barSize={14} />
              <Bar dataKey="CAM" fill="#3b82f6" radius={[3, 3, 0, 0]} barSize={14} />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Lease detail */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-slate-500" />
            <CardTitle className="text-sm">Lease Details</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="bg-slate-50/80">
                <TableHead className="text-[10px] font-semibold uppercase tracking-wider">Lease</TableHead>
                <TableHead className="text-[10px] font-semibold uppercase tracking-wider">Type</TableHead>
                <TableHead className="text-[10px] font-semibold uppercase tracking-wider">Term</TableHead>
                <TableHead className="text-[10px] font-semibold uppercase tracking-wider text-right">Base Rent</TableHead>
                <TableHead className="text-[10px] font-semibold uppercase tracking-wider text-right">Annual Rent</TableHead>
                <TableHead className="text-[10px] font-semibold uppercase tracking-wider text-right">CAM/Mo</TableHead>
                <TableHead className="text-[10px] font-semibold uppercase tracking-wider text-right">Total Annual</TableHead>
                <TableHead className="text-[10px] font-semibold uppercase tracking-wider">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tenantLeases.map(l => {
                const lCam = tenantCams.filter(c => c.lease_id === l.id).reduce((s, c) => s + (c.annual_cam || 0), 0);
                const lCamMo = tenantCams.filter(c => c.lease_id === l.id).reduce((s, c) => s + (c.monthly_cam || 0), 0);
                const total = (l.annual_rent || l.base_rent * 12 || 0) + lCam;
                return (
                  <TableRow key={l.id}>
                    <TableCell className="text-sm font-medium">{l.tenant_name}</TableCell>
                    <TableCell><Badge variant="outline" className="text-[9px] uppercase">{l.lease_type || '—'}</Badge></TableCell>
                    <TableCell className="text-xs text-slate-500">
                      {l.start_date && l.end_date ? `${new Date(l.start_date).toLocaleDateString('en-US', { month: 'short', year: '2-digit' })} – ${new Date(l.end_date).toLocaleDateString('en-US', { month: 'short', year: '2-digit' })}` : '—'}
                    </TableCell>
                    <TableCell className="text-right">
                      <RevenueSourcePopover sourceType="lease" sourceId={l.id} sourceName={l.tenant_name} amount={l.base_rent} lastUpdated={l.updated_date}>
                        <span className="text-sm font-mono">{fmt(l.base_rent || 0)}</span>
                      </RevenueSourcePopover>
                    </TableCell>
                    <TableCell className="text-right text-sm font-mono">{fmt(l.annual_rent || l.base_rent * 12 || 0)}</TableCell>
                    <TableCell className="text-right">
                      <RevenueSourcePopover sourceType="cam" sourceName={l.tenant_name} amount={lCamMo}>
                        <span className="text-sm font-mono">{fmt(lCamMo)}</span>
                      </RevenueSourcePopover>
                    </TableCell>
                    <TableCell className="text-right text-sm font-mono font-semibold">{fmt(total)}</TableCell>
                    <TableCell>
                      <Badge className={`text-[9px] ${l.status === 'budget_ready' || l.status === 'validated' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>
                        {l.status?.replace('_', ' ')}
                      </Badge>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
import React, { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Building2, Layers, Users, ChevronRight } from "lucide-react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";
import RevenueSourcePopover from "./RevenueSourcePopover";
import TenantDrillDown from "./TenantDrillDown";

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const COLORS = ["#1a2744","#2563eb","#10b981","#f59e0b","#8b5cf6","#ef4444","#06b6d4"];

function fmt(v) {
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toLocaleString()}`;
}

function MonthlyTrendChart({ leases, camCalcs }) {
  const rent = leases.reduce((s, l) => s + (l.base_rent || 0), 0);
  const cam = camCalcs.reduce((s, c) => s + (c.monthly_cam || 0), 0);
  const data = MONTHS.map(m => ({ month: m, "Base Rent": rent, "CAM Recovery": cam }));

  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-sm">Monthly Revenue Trend</CardTitle></CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
            <XAxis dataKey="month" tick={{ fontSize: 10 }} />
            <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `$${(v / 1000).toFixed(0)}K`} />
            <Tooltip formatter={v => `$${v.toLocaleString()}`} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Area type="monotone" dataKey="Base Rent" stackId="1" stroke="#1a2744" fill="#1a2744" fillOpacity={0.12} strokeWidth={2} />
            <Area type="monotone" dataKey="CAM Recovery" stackId="1" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.1} strokeWidth={2} />
          </AreaChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

function BreakdownSection({ icon: Icon, title, data, columns, onRowClick }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <Icon className="w-4 h-4 text-slate-500" />
          <CardTitle className="text-sm">{title}</CardTitle>
          <Badge variant="outline" className="text-[10px] ml-auto">{data.length}</Badge>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow className="bg-slate-50/80">
              {columns.map(c => (
                <TableHead key={c.key} className={`text-[10px] font-semibold uppercase tracking-wider ${c.align === 'right' ? 'text-right' : ''}`}>{c.label}</TableHead>
              ))}
              {onRowClick && <TableHead className="w-6"></TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.length === 0 ? (
              <TableRow><TableCell colSpan={columns.length + (onRowClick ? 1 : 0)} className="text-center py-8 text-sm text-slate-400">No data</TableCell></TableRow>
            ) : (
              data.map((row, i) => (
                <TableRow key={i} className={onRowClick ? "cursor-pointer hover:bg-blue-50/50 group" : ""} onClick={() => onRowClick?.(row)}>
                  {columns.map(c => (
                    <TableCell key={c.key} className={`text-sm ${c.align === 'right' ? 'text-right font-mono' : ''} ${c.bold ? 'font-semibold' : ''}`}>
                      {c.render ? c.render(row) : row[c.key]}
                    </TableCell>
                  ))}
                  {onRowClick && <TableCell><ChevronRight className="w-3.5 h-3.5 text-slate-300 group-hover:text-blue-600" /></TableCell>}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export default function PropertyDrillDown({ property, leases, camCalcs, buildings, units, onBack }) {
  const [selectedTenant, setSelectedTenant] = useState(null);

  const propLeases = leases.filter(l => l.property_id === property.id && l.status !== 'expired');
  const propCams = camCalcs.filter(c => c.property_id === property.id);

  const totalRent = propLeases.reduce((s, l) => s + (l.annual_rent || l.base_rent * 12 || 0), 0);
  const totalCam = propCams.reduce((s, c) => s + (c.annual_cam || 0), 0);
  const totalRevenue = totalRent + totalCam;

  // Building breakdown
  const propBuildings = buildings.filter(b => b.property_id === property.id);
  const buildingData = propBuildings.map(b => {
    const bUnits = units.filter(u => u.building_id === b.id);
    const bLeases = propLeases.filter(l => bUnits.some(u => u.id === l.unit_id));
    const rent = bLeases.reduce((s, l) => s + (l.annual_rent || l.base_rent * 12 || 0), 0);
    return { name: b.name, sf: b.total_sf || 0, units: bUnits.length, revenue: rent };
  });

  // Unit breakdown
  const propUnits = units.filter(u => propBuildings.some(b => b.id === u.building_id));
  const unitData = propUnits.map(u => {
    const uLease = propLeases.find(l => l.unit_id === u.id);
    return { name: u.unit_id_code, tenant: uLease?.tenant_name || '(Vacant)', sf: u.square_feet || 0, rent: uLease ? (uLease.annual_rent || uLease.base_rent * 12 || 0) : 0, status: u.occupancy_status };
  });

  // Tenant breakdown
  const tenantMap = {};
  propLeases.forEach(l => {
    const key = l.tenant_name || 'Unknown';
    if (!tenantMap[key]) tenantMap[key] = { name: key, rent: 0, cam: 0, total: 0, leaseType: l.lease_type, leaseId: l.id, updatedDate: l.updated_date };
    tenantMap[key].rent += (l.annual_rent || l.base_rent * 12 || 0);
    const tc = propCams.filter(c => c.lease_id === l.id).reduce((s, c) => s + (c.annual_cam || 0), 0);
    tenantMap[key].cam += tc;
    tenantMap[key].total = tenantMap[key].rent + tenantMap[key].cam;
  });
  const tenantData = Object.values(tenantMap).sort((a, b) => b.total - a.total);

  if (selectedTenant) {
    return <TenantDrillDown tenant={selectedTenant} leases={propLeases} camCalcs={propCams} propertyName={property.name} onBack={() => setSelectedTenant(null)} />;
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack} className="text-slate-500 hover:text-slate-900">
          <ArrowLeft className="w-4 h-4 mr-1" /> Back
        </Button>
        <div className="h-5 w-px bg-slate-200" />
        <div>
          <h2 className="text-lg font-bold text-slate-900">{property.name}</h2>
          <p className="text-xs text-slate-500">{property.city}{property.state ? `, ${property.state}` : ''} • {property.property_type?.replace('_', ' ')}</p>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Total Revenue", value: fmt(totalRevenue), color: "text-slate-900" },
          { label: "Base Rent", value: fmt(totalRent), color: "text-blue-700" },
          { label: "CAM Recovery", value: fmt(totalCam), color: "text-emerald-700" },
          { label: "Revenue / SF", value: property.total_sf > 0 ? `$${(totalRevenue / property.total_sf).toFixed(2)}` : '—', color: "text-purple-700" },
        ].map((k, i) => (
          <Card key={i}>
            <CardContent className="p-3">
              <p className="text-[10px] font-semibold text-slate-500 uppercase">{k.label}</p>
              <p className={`text-xl font-bold mt-0.5 ${k.color}`}>{k.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Monthly trend */}
      <MonthlyTrendChart leases={propLeases} camCalcs={propCams} />

      {/* Breakdowns */}
      <div className="grid lg:grid-cols-2 gap-5">
        <BreakdownSection
          icon={Building2}
          title="Revenue by Building"
          data={buildingData}
          columns={[
            { key: 'name', label: 'Building', bold: true },
            { key: 'units', label: 'Units' },
            { key: 'sf', label: 'SF', align: 'right', render: r => r.sf.toLocaleString() },
            { key: 'revenue', label: 'Revenue', align: 'right', bold: true, render: r => fmt(r.revenue) },
          ]}
        />
        <BreakdownSection
          icon={Layers}
          title="Revenue by Unit"
          data={unitData}
          columns={[
            { key: 'name', label: 'Unit', bold: true },
            { key: 'tenant', label: 'Tenant' },
            { key: 'sf', label: 'SF', align: 'right', render: r => r.sf.toLocaleString() },
            { key: 'rent', label: 'Revenue', align: 'right', bold: true, render: r => fmt(r.rent) },
            { key: 'status', label: 'Status', render: r => (
              <Badge variant="outline" className={`text-[9px] ${r.status === 'leased' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-slate-50 text-slate-500'}`}>
                {r.status}
              </Badge>
            )},
          ]}
        />
      </div>

      {/* Tenant deep drill */}
      <BreakdownSection
        icon={Users}
        title="Revenue by Tenant"
        data={tenantData}
        columns={[
          { key: 'name', label: 'Tenant', bold: true },
          { key: 'rent', label: 'Rent', align: 'right', render: r => (
            <RevenueSourcePopover sourceType="lease" sourceId={r.leaseId} sourceName={r.name} amount={r.rent} lastUpdated={r.updatedDate}>
              {fmt(r.rent)}
            </RevenueSourcePopover>
          )},
          { key: 'cam', label: 'CAM', align: 'right', render: r => (
            <RevenueSourcePopover sourceType="cam" sourceName={r.name} amount={r.cam}>
              {fmt(r.cam)}
            </RevenueSourcePopover>
          )},
          { key: 'total', label: 'Total', align: 'right', bold: true, render: r => fmt(r.total) },
          { key: 'leaseType', label: 'Lease Type', render: r => (
            <Badge variant="outline" className="text-[9px] uppercase">{r.leaseType || '—'}</Badge>
          )},
        ]}
        onRowClick={(row) => setSelectedTenant(row)}
      />
    </div>
  );
}
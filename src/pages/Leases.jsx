import React, { useState } from "react";
import PipelineActions, { LEASE_ACTIONS } from "@/components/PipelineActions";
import useOrgQuery from "@/hooks/useOrgQuery";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Upload, Search, Loader2, Download, Plus, FileText } from "lucide-react";
import { Link } from "react-router-dom";
import { createPageUrl, downloadCSV } from "@/utils";
import PageHeader from "@/components/PageHeader";
import BulkImportModal from "@/components/property/BulkImportModal";
import { differenceInDays } from "date-fns";

export default function Leases() {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [selectedPropertyId] = useState(null);
  const [showImport, setShowImport] = useState(false);

  const { data: leases = [], isLoading } = useOrgQuery("Lease");

  const statusColors = {
    draft: "bg-slate-100 text-slate-600",
    extracted: "bg-blue-100 text-blue-700",
    validated: "bg-amber-100 text-amber-700",
    budget_ready: "bg-emerald-100 text-emerald-700",
    expired: "bg-red-100 text-red-700"
  };

  const filtered = leases.filter(l => {
    const matchSearch = l.tenant_name?.toLowerCase().includes(search.toLowerCase());
    const matchFilter = filter === "all" || l.status === filter;
    return matchSearch && matchFilter;
  });

  const statusCounts = {
    budget_ready: leases.filter(l => l.status === 'budget_ready').length,
    validated: leases.filter(l => l.status === 'validated').length,
    draft: leases.filter(l => l.status === 'draft').length,
    expiring: leases.filter(l => l.end_date && differenceInDays(new Date(l.end_date), new Date()) < 180 && differenceInDays(new Date(l.end_date), new Date()) > 0).length,
  };

  return (
    <div className="p-6 space-y-6">
      <PageHeader icon={FileText} title="Leases" subtitle={`${leases.length} lease records · OCR extraction and abstraction pipeline`} iconColor="from-blue-600 to-indigo-700">
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => downloadCSV(leases, 'leases.csv')}><Download className="w-4 h-4 mr-1 text-slate-500" />Export</Button>
          <Button variant="outline" size="sm" onClick={() => setShowImport(true)}><Upload className="w-4 h-4 mr-1" />Bulk Import</Button>
          <Link to={createPageUrl("LeaseUpload")}>
            <Button size="sm" className="bg-[#1a2744] hover:bg-[#243b67] shadow-sm"><Plus className="w-4 h-4 mr-2" />Upload Lease</Button>
          </Link>
        </div>
      </PageHeader>

      <PipelineActions propertyId={selectedPropertyId} fiscalYear={new Date().getFullYear()} actions={LEASE_ACTIONS} />

      {/* Status summary cards */}
      <div className="grid grid-cols-4 gap-4">
        {[
          { label: "Budget-Ready", count: statusCounts.budget_ready, color: "border-l-emerald-500 bg-emerald-50" },
          { label: "Validated", count: statusCounts.validated, color: "border-l-amber-500 bg-amber-50" },
          { label: "Draft", count: statusCounts.draft, color: "border-l-slate-400 bg-slate-50" },
          { label: "Expiring < 6mo", count: statusCounts.expiring, color: "border-l-red-500 bg-red-50" },
        ].map((s, i) => (
          <Card key={i} className={`border-l-4 ${s.color}`}>
            <CardContent className="p-4">
              <p className="text-2xl font-bold text-slate-900">{s.count}</p>
              <p className="text-xs font-medium text-slate-500">{s.label}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Filters */}
      <div className="flex gap-3 items-center">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input placeholder="Search tenant..." className="pl-9" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="flex gap-1">
          {["all", "budget_ready", "validated", "draft", "expired"].map(f => (
            <Button key={f} variant={filter === f ? "default" : "outline"} size="sm" onClick={() => setFilter(f)} className={`text-xs capitalize ${filter === f ? 'bg-blue-600' : ''}`}>
              {f === 'all' ? 'All' : f.replace('_', '-')}
            </Button>
          ))}
        </div>
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow className="bg-slate-50">
              <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Tenant</TableHead>
              <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Unit</TableHead>
              <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Lease Type</TableHead>
              <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Start Date</TableHead>
              <TableHead className="text-[11px] font-semibold uppercase text-slate-500">End Date</TableHead>
              <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Rent/SF</TableHead>
              <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Annual Rent</TableHead>
              <TableHead className="text-[11px] font-semibold uppercase text-slate-500">CAM/Mo</TableHead>
              <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Status</TableHead>
              <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Confidence</TableHead>
              <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={11} className="text-center py-12"><Loader2 className="w-5 h-5 animate-spin mx-auto text-slate-400" /></TableCell></TableRow>
            ) : filtered.length === 0 ? (
              <TableRow><TableCell colSpan={11} className="text-center py-12 text-sm text-slate-400">No leases found</TableCell></TableRow>
            ) : (
              filtered.map(l => {
                const daysLeft = l.end_date ? differenceInDays(new Date(l.end_date), new Date()) : null;
                return (
                  <TableRow key={l.id} className="hover:bg-slate-50">
                    <TableCell className="text-sm font-medium text-slate-900">{l.tenant_name}</TableCell>
                    <TableCell className="text-sm text-slate-600">{l.unit_number || l.unit_id?.substring(0, 8) || '—'}</TableCell>
                    <TableCell><Badge variant="outline" className="text-[10px]">{l.lease_type}</Badge></TableCell>
                    <TableCell className="text-sm">{l.start_date || '—'}</TableCell>
                    <TableCell className="text-sm">
                      <span className={daysLeft && daysLeft < 180 ? 'text-red-600 font-medium' : ''}>
                        {l.end_date || '—'}
                      </span>
                      {daysLeft && daysLeft < 365 && daysLeft > 0 && (
                        <span className="block text-[10px] text-red-500">{daysLeft}d remaining</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm font-mono">${l.rent_per_sf?.toFixed(2) || '—'}</TableCell>
                    <TableCell className="text-sm font-mono">${l.annual_rent?.toLocaleString() || '—'}</TableCell>
                    <TableCell className="text-sm font-mono">${l.cam_per_month?.toLocaleString() || '—'}</TableCell>
                    <TableCell><Badge className={`${statusColors[l.status]} text-[10px] uppercase`}>{l.status?.replace('_', '-')}</Badge></TableCell>
                    <TableCell>
                      {l.confidence_score ? (
                        <div className="flex items-center gap-1.5">
                          <div className={`w-2 h-2 rounded-full ${l.confidence_score >= 90 ? 'bg-emerald-500' : l.confidence_score >= 75 ? 'bg-amber-500' : 'bg-red-500'}`} />
                          <span className="text-xs">{l.confidence_score}%</span>
                        </div>
                      ) : '—'}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Link to={createPageUrl("LeaseReview") + `?id=${l.id}`}>
                          <Button variant="ghost" size="sm" className="text-xs h-7 px-2">View</Button>
                        </Link>
                        <Link to={createPageUrl("LeaseReview") + `?id=${l.id}`}>
                          <Button variant="ghost" size="sm" className="text-xs h-7 px-2">Edit</Button>
                        </Link>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </Card>

      <BulkImportModal 
        isOpen={showImport} 
        onClose={() => setShowImport(false)} 
        moduleType="lease" 
      />
    </div>
  );
}
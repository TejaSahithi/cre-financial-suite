import React, { useState } from "react";
import { AuditLogService, PropertyService } from "@/services/api";
import { useQuery } from "@tanstack/react-query";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Download, Search, Shield, Loader2, Home, Building2, DoorOpen } from "lucide-react";
import moment from "moment";

const actionColors = {
  create: "bg-emerald-100 text-emerald-700",
  update: "bg-blue-100 text-blue-700",
  override: "bg-amber-100 text-amber-700",
  approve: "bg-green-100 text-green-700",
  delete: "bg-red-100 text-red-700",
  upload: "bg-violet-100 text-violet-700",
  sign: "bg-indigo-100 text-indigo-700",
  lock: "bg-slate-200 text-slate-700",
  reject: "bg-red-100 text-red-700",
  login: "bg-sky-100 text-sky-700",
  export: "bg-cyan-100 text-cyan-700",
};

const actionLabels = {
  create: "+ CREATE", update: "✎ UPDATE", override: "⚠ OVERRIDE",
  approve: "✓ APPROVE", delete: "🗑 DELETE", upload: "⬆ UPLOAD",
  sign: "✍ SIGN", lock: "🔒 LOCK", reject: "✕ REJECT",
  login: "→ LOGIN", export: "↓ EXPORT",
};

export default function AuditLog() {
  const [search, setSearch] = useState("");
  const [entityFilter, setEntityFilter] = useState("all");
  const [actionFilter, setActionFilter] = useState("all");
  const [propertyFilter, setPropertyFilter] = useState("all");

  const { data: logs = [], isLoading } = useQuery({
    queryKey: ['audit-logs'],
    queryFn: () => AuditLogService.list('-created_date', 100),
  });

  const { data: properties = [] } = useQuery({
    queryKey: ['props-audit'],
    queryFn: () => PropertyService.list(),
  });

  const filtered = (logs || []).filter(log => {
    const matchSearch = !search ||
      log.user_name?.toLowerCase().includes(search.toLowerCase()) ||
      log.user_email?.toLowerCase().includes(search.toLowerCase()) ||
      log.entity_type?.toLowerCase().includes(search.toLowerCase()) ||
      log.property_name?.toLowerCase().includes(search.toLowerCase()) ||
      log.building_name?.toLowerCase().includes(search.toLowerCase()) ||
      log.unit_number?.toLowerCase().includes(search.toLowerCase()) ||
      log.field_changed?.toLowerCase().includes(search.toLowerCase());
    const matchEntity = entityFilter === "all" || log.entity_type === entityFilter;
    const matchAction = actionFilter === "all" || log.action === actionFilter;
    const matchProperty = propertyFilter === "all" || log.property_id === propertyFilter;
    return matchSearch && matchEntity && matchAction && matchProperty;
  });

  const counts = {};
  logs.forEach(l => { counts[l.action] = (counts[l.action] || 0) + 1; });

  const entityTypes = [...new Set(logs.map(l => l.entity_type).filter(Boolean))];

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1"><Shield className="w-5 h-5 text-slate-500" /><h1 className="text-2xl font-bold text-slate-900">Audit Log</h1></div>
          <p className="text-sm text-slate-500">Immutable activity log · {logs.length} records</p>
        </div>
        <Button variant="outline"><Download className="w-4 h-4 mr-2" />Export Log</Button>
      </div>

      {/* Action counts */}
      <div className="flex flex-wrap gap-3">
        {Object.entries(counts).sort(([, a], [, b]) => b - a).map(([action, count]) => (
          <Card key={action} className={`cursor-pointer ${actionFilter === action ? 'ring-2 ring-blue-500' : ''}`} onClick={() => setActionFilter(actionFilter === action ? "all" : action)}>
            <CardContent className="p-3 text-center min-w-[80px]">
              <p className="text-lg font-bold text-slate-900">{count}</p>
              <p className="text-[10px] font-semibold text-slate-500 capitalize">{action}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Filters */}
      <div className="flex gap-3 items-center flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input placeholder="Search user, entity, property..." className="pl-9" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <Select value={entityFilter} onValueChange={setEntityFilter}>
          <SelectTrigger className="w-40"><SelectValue placeholder="All Entities" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Entities</SelectItem>
            {entityTypes.map(e => <SelectItem key={e} value={e}>{e}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={propertyFilter} onValueChange={setPropertyFilter}>
          <SelectTrigger className="w-48"><SelectValue placeholder="All Properties" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Properties</SelectItem>
            {properties.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow className="bg-slate-50">
              <TableHead className="text-[11px]">TIMESTAMP</TableHead>
              <TableHead className="text-[11px]">USER</TableHead>
              <TableHead className="text-[11px]">ACTION</TableHead>
              <TableHead className="text-[11px]">ENTITY</TableHead>
              <TableHead className="text-[11px]">PROPERTY / BUILDING / UNIT</TableHead>
              <TableHead className="text-[11px]">FIELD</TableHead>
              <TableHead className="text-[11px]">OLD VALUE</TableHead>
              <TableHead className="text-[11px]">NEW VALUE</TableHead>
              <TableHead className="text-[11px]">IP</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={9} className="text-center py-12"><Loader2 className="w-5 h-5 animate-spin mx-auto text-slate-400" /></TableCell></TableRow>
            ) : filtered.length === 0 ? (
              <TableRow><TableCell colSpan={9} className="text-center py-12 text-sm text-slate-400">No audit records found</TableCell></TableRow>
            ) : (
              filtered.map(log => (
                <TableRow key={log.id} className="hover:bg-slate-50">
                  <TableCell className="text-xs font-mono text-slate-500">{log.timestamp ? moment(log.timestamp).format("YYYY-MM-DD HH:mm") : moment(log.created_date).format("YYYY-MM-DD HH:mm")}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-full bg-slate-200 flex items-center justify-center text-[10px] font-bold text-slate-600">
                        {(log.user_name || log.user_email || "?").charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <span className="text-sm">{log.user_name || log.user_email || "System"}</span>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge className={`${actionColors[log.action] || 'bg-slate-100 text-slate-600'} text-[10px] uppercase`}>
                      {actionLabels[log.action] || log.action}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div>
                      <span className="text-sm">{log.entity_type}</span>
                      {log.entity_id && <p className="text-[10px] text-slate-400 font-mono">{log.entity_id.substring(0, 12)}</p>}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="space-y-0.5">
                      {log.property_name && (
                        <div className="flex items-center gap-1">
                          <Home className="w-3 h-3 text-blue-500" />
                          <span className="text-xs text-slate-700">{log.property_name}</span>
                        </div>
                      )}
                      {log.building_name && (
                        <div className="flex items-center gap-1">
                          <Building2 className="w-3 h-3 text-purple-500" />
                          <span className="text-xs text-slate-500">{log.building_name}</span>
                        </div>
                      )}
                      {log.unit_number && (
                        <div className="flex items-center gap-1">
                          <DoorOpen className="w-3 h-3 text-amber-500" />
                          <span className="text-xs text-slate-500">{log.unit_number}</span>
                        </div>
                      )}
                      {!log.property_name && !log.building_name && !log.unit_number && (
                        <span className="text-[10px] text-slate-300">—</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-slate-600">{log.field_changed || "—"}</TableCell>
                  <TableCell className="text-xs font-mono text-slate-400 max-w-[120px] truncate">{log.old_value || "—"}</TableCell>
                  <TableCell className="text-xs font-mono text-slate-700 max-w-[120px] truncate">{log.new_value || "—"}</TableCell>
                  <TableCell className="text-xs font-mono text-slate-400">{log.ip_address || "—"}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
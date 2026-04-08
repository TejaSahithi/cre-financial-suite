import React, { useState } from "react";
import { UnitService, BuildingService, PropertyService } from "@/services/api";

import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Building2, Search, Loader2, Home, Users, Layers, ChevronRight, DoorOpen, Plus, Download, Upload } from "lucide-react";
import { Link } from "react-router-dom";
import { createPageUrl, downloadCSV } from "@/utils";
import PageHeader from "@/components/PageHeader";
import MetricCard from "@/components/MetricCard";
import ViewModeToggle from "@/components/ViewModeToggle";
import CreateBuildingModal from "@/components/property/CreateBuildingModal";
import CreateUnitModal from "@/components/property/CreateUnitModal";
import BulkImportModal from "@/components/property/BulkImportModal";

export default function BuildingsUnits() {
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState("grid");
  const [propertyFilter, setPropertyFilter] = useState("all");
  const [showCreateBuilding, setShowCreateBuilding] = useState(false);
  const [showCreateUnit, setShowCreateUnit] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importType, setImportType] = useState("building");

  const { data: properties = [] } = useQuery({ queryKey: ['bu-properties'], queryFn: () => PropertyService.list() });
  const { data: buildings = [], isLoading } = useQuery({ queryKey: ['bu-buildings'], queryFn: () => BuildingService.list() });
  const { data: units = [] } = useQuery({ queryKey: ['bu-units'], queryFn: () => UnitService.list() });

  const getPropertyName = (pid) => properties.find(p => p.id === pid)?.name || "—";
  const getBuildingUnits = (bid) => units.filter(u => u.building_id === bid);

  const filtered = buildings.filter(b => {
    const matchSearch = b.name?.toLowerCase().includes(search.toLowerCase()) || getPropertyName(b.property_id).toLowerCase().includes(search.toLowerCase());
    const matchProperty = propertyFilter === "all" || b.property_id === propertyFilter;
    return matchSearch && matchProperty;
  });

  const totalUnits = units.length;
  const leasedUnits = units.filter(u => u.occupancy_status === "leased").length;
  const vacantUnits = units.filter(u => u.occupancy_status === "vacant").length;
  const totalSF = buildings.reduce((s, b) => s + (b.total_sqft || 0), 0);

  return (
    <div className="p-4 lg:p-6 space-y-5">
      <PageHeader icon={Building2} title="Buildings & Units" subtitle={`${buildings.length} buildings · ${totalUnits} units across ${properties.length} properties`} iconColor="from-purple-500 to-purple-700">
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => downloadCSV(buildings, 'buildings.csv')}><Download className="w-4 h-4 mr-1 text-slate-500" />Export</Button>
          <Button variant="outline" size="sm" onClick={() => { setImportType("building"); setShowImport(true); }}><Upload className="w-4 h-4 mr-1" />Import</Button>
          <Button variant="outline" size="sm" onClick={() => setShowCreateBuilding(true)} className="border-purple-200 text-purple-700 hover:bg-purple-50"><Plus className="w-4 h-4 mr-1" />Add Building</Button>
          <Button size="sm" onClick={() => setShowCreateUnit(true)} className="bg-gradient-to-r from-purple-600 to-purple-700 shadow-sm"><Plus className="w-4 h-4 mr-1" />Add Unit</Button>
        </div>
      </PageHeader>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <MetricCard label="Buildings" value={buildings.length} icon={Building2} color="bg-purple-50 text-purple-600" />
        <MetricCard label="Total Units" value={totalUnits} icon={DoorOpen} color="bg-blue-50 text-blue-600" />
        <MetricCard label="Leased" value={leasedUnits} icon={Users} color="bg-emerald-50 text-emerald-600" />
        <MetricCard label="Vacant" value={vacantUnits} icon={Layers} color="bg-amber-50 text-amber-600" />
        <MetricCard label="Total SF" value={`${(totalSF / 1000).toFixed(0)}K`} icon={Home} color="bg-slate-100 text-slate-600" />
      </div>

      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div className="relative max-w-sm flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <Input placeholder="Search buildings..." className="pl-9" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <Select value={propertyFilter} onValueChange={setPropertyFilter}>
            <SelectTrigger className="w-48"><SelectValue placeholder="All Properties" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Properties</SelectItem>
              {properties.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <ViewModeToggle viewMode={viewMode} onViewModeChange={setViewMode} />
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>
      ) : filtered.length === 0 ? (
        <Card><CardContent className="p-16 text-center text-sm text-slate-400">No buildings found</CardContent></Card>
      ) : viewMode === "grid" ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map(b => {
            const bUnits = getBuildingUnits(b.id);
            const leased = bUnits.filter(u => u.occupancy_status === "leased").length;
            const vacant = bUnits.filter(u => u.occupancy_status === "vacant").length;
            return (
              <Card key={b.id} className="overflow-hidden hover:shadow-lg transition-all border-slate-200/80">
                <CardContent className="p-5">
                  <div className="flex items-start gap-3 mb-3">
                    <div className="w-12 h-12 bg-purple-100 rounded-xl flex items-center justify-center flex-shrink-0">
                      <Building2 className="w-6 h-6 text-purple-500" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <h3 className="text-base font-bold text-slate-900">{b.name}</h3>
                      <p className="text-xs text-slate-400">{getPropertyName(b.property_id)}</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-4 gap-2 mb-3">
                    {[
                      { label: "SF", value: `${((b.total_sqft || 0) / 1000).toFixed(0)}K` },
                      { label: "Floors", value: b.floors || 1 },
                      { label: "Leased", value: leased },
                      { label: "Vacant", value: vacant },
                    ].map((m, i) => (
                      <div key={i} className="bg-slate-50 rounded px-2 py-1.5 text-center">
                        <p className="text-[9px] font-bold text-slate-400 uppercase">{m.label}</p>
                        <p className="text-sm font-bold text-slate-900">{m.value}</p>
                      </div>
                    ))}
                  </div>
                  {bUnits.length > 0 && (
                    <div className="space-y-1 max-h-32 overflow-y-auto">
                      {bUnits.map(u => (
                        <div key={u.id} className="flex items-center justify-between bg-slate-50 rounded-md px-2.5 py-1.5">
                          <div className="flex items-center gap-2">
                            <DoorOpen className="w-3 h-3 text-slate-400" />
                            <span className="text-xs font-medium text-slate-700">{u.unit_number || u.unit_id_code || u.id?.substring(0, 8)}</span>
                            <span className="text-[10px] text-slate-400">{u.square_footage?.toLocaleString()} SF</span>
                          </div>
                          <Badge className={`text-[10px] ${u.occupancy_status === 'leased' ? 'bg-emerald-100 text-emerald-700' : u.occupancy_status === 'vacant' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600'}`}>
                            {u.occupancy_status}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  )}
                  {b.year_built && <p className="text-[10px] text-slate-400 mt-2">Built {b.year_built}</p>}
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : viewMode === "list" ? (
        <div className="space-y-2">
          {filtered.map(b => {
            const bUnits = getBuildingUnits(b.id);
            const leased = bUnits.filter(u => u.occupancy_status === "leased").length;
            return (
              <Card key={b.id} className="hover:shadow-md transition-all border-slate-200/80">
                <CardContent className="p-3 flex items-center gap-4">
                  <div className="w-10 h-10 bg-purple-100 rounded-lg flex items-center justify-center flex-shrink-0">
                    <Building2 className="w-5 h-5 text-purple-500" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-bold text-slate-900 truncate">{b.name}</h3>
                    <p className="text-xs text-slate-400 truncate">{getPropertyName(b.property_id)}</p>
                  </div>
                  <div className="hidden md:flex items-center gap-6 text-xs text-slate-600 flex-shrink-0">
                    <div className="text-center"><p className="font-bold text-sm">{((b.total_sqft || 0) / 1000).toFixed(0)}K</p><p className="text-slate-400">SF</p></div>
                    <div className="text-center"><p className="font-bold text-sm">{b.floors || 1}</p><p className="text-slate-400">Floors</p></div>
                    <div className="text-center"><p className="font-bold text-sm">{bUnits.length}</p><p className="text-slate-400">Units</p></div>
                    <div className="text-center"><p className="font-bold text-sm">{leased}</p><p className="text-slate-400">Leased</p></div>
                  </div>
                  {b.year_built && <span className="text-xs text-slate-400 flex-shrink-0">{b.year_built}</span>}
                  <Link to={createPageUrl("PropertyDetail") + `?id=${b.property_id}`}>
                    <Button variant="outline" size="sm" className="flex-shrink-0 text-xs">Property <ChevronRight className="w-3 h-3 ml-1" /></Button>
                  </Link>
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : (
        <Card className="overflow-hidden border-slate-200/80">
          <Table>
            <TableHeader>
              <TableRow className="bg-gradient-to-r from-slate-50 to-slate-100/50">
                <TableHead className="text-xs font-bold tracking-wider">BUILDING</TableHead>
                <TableHead className="text-xs font-bold tracking-wider">PROPERTY</TableHead>
                <TableHead className="text-xs font-bold tracking-wider">SQ FT</TableHead>
                <TableHead className="text-xs font-bold tracking-wider">FLOORS</TableHead>
                <TableHead className="text-xs font-bold tracking-wider">YEAR BUILT</TableHead>
                <TableHead className="text-xs font-bold tracking-wider">UNITS</TableHead>
                <TableHead className="text-xs font-bold tracking-wider">LEASED</TableHead>
                <TableHead className="text-xs font-bold tracking-wider">VACANT</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map(b => {
                const bUnits = getBuildingUnits(b.id);
                const leased = bUnits.filter(u => u.occupancy_status === "leased").length;
                const vacant = bUnits.filter(u => u.occupancy_status === "vacant").length;
                return (
                  <TableRow key={b.id} className="hover:bg-slate-50">
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 bg-purple-100 rounded-lg flex items-center justify-center">
                          <Building2 className="w-4 h-4 text-purple-500" />
                        </div>
                        <span className="text-sm font-semibold text-slate-900">{b.name}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-slate-600">{getPropertyName(b.property_id)}</TableCell>
                    <TableCell className="text-sm font-mono">{(b.total_sqft || 0).toLocaleString()}</TableCell>
                    <TableCell className="text-sm">{b.floors || 1}</TableCell>
                    <TableCell className="text-sm">{b.year_built || "—"}</TableCell>
                    <TableCell className="text-sm font-medium">{bUnits.length}</TableCell>
                    <TableCell><Badge className="bg-emerald-100 text-emerald-700 text-xs">{leased}</Badge></TableCell>
                    <TableCell><Badge className="bg-amber-100 text-amber-700 text-xs">{vacant}</Badge></TableCell>
                    <TableCell>
                      <Link to={createPageUrl("PropertyDetail") + `?id=${b.property_id}`}>
                        <Button variant="outline" size="sm">View</Button>
                      </Link>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}

      {/* Modals */}
      <CreateBuildingModal 
        isOpen={showCreateBuilding} 
        onClose={() => setShowCreateBuilding(false)} 
        properties={properties} 
      />

      <CreateUnitModal 
        isOpen={showCreateUnit} 
        onClose={() => setShowCreateUnit(false)} 
        buildings={buildings} 
      />

      <BulkImportModal 
        isOpen={showImport} 
        onClose={() => setShowImport(false)} 
        moduleType={importType} 
      />
    </div>
  );
}
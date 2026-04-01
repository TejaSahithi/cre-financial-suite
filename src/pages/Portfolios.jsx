import React, { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PortfolioService } from "@/services/api";
import useOrgQuery from "@/hooks/useOrgQuery";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Search, Briefcase, Loader2, Home, Building2, Users, MapPin, ChevronRight } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { createPageUrl } from "@/utils";
import PageHeader from "@/components/PageHeader";
import MetricCard from "@/components/MetricCard";
import ViewModeToggle from "@/components/ViewModeToggle";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export default function Portfolios() {
  const [showCreate, setShowCreate] = useState(false);
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState("grid");
  const defaultForm = { name: "", description: "", owner_entity: "", type: "commercial", geography: "", fiscal_year: "jan_dec", intent: "asset_management", notes: "" };
  const [form, setForm] = useState(defaultForm);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const { data: portfolios = [], isLoading, orgId } = useOrgQuery("Portfolio");
  const { data: properties = [] } = useOrgQuery("Property");
  const { data: buildings = [] } = useOrgQuery("Building");
  const { data: units = [] } = useOrgQuery("Unit");
  const { data: leases = [] } = useOrgQuery("Lease");

  const createMutation = useMutation({
    mutationFn: (data) => PortfolioService.create(data),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['Portfolio'] });
      setShowCreate(false);
      setForm(defaultForm);
      toast.success("Portfolio created successfully");
      if (data && data.id) {
        navigate(createPageUrl("Properties") + "?portfolio=" + data.id);
      }
    },
    onError: (err) => {
      toast.error("Failed to create portfolio: " + (err?.message || "Unknown error"));
    },
  });

  // Enrich portfolios with real-time aggregated data
  const enriched = portfolios.map(p => {
    const portProperties = properties.filter(pr => pr.portfolio_id === p.id);
    const propIds = portProperties.map(pr => pr.id);
    const portBuildings = buildings.filter(b => propIds.includes(b.property_id));
    const portUnits = units.filter(u => propIds.includes(u.property_id));
    const portLeases = leases.filter(l => propIds.includes(l.property_id));
    const totalSF = portProperties.reduce((s, pr) => s + (pr.total_sqft || 0), 0);
    const leasedUnits = portUnits.filter(u => u.status === 'leased');
    const leasedSF = leasedUnits.reduce((s, u) => s + (u.square_footage || 0), 0);
    const occupancy = totalSF > 0 ? ((leasedSF / totalSF) * 100) : 0;
    const annualRent = portLeases.filter(l => l.status !== 'expired').reduce((s, l) => s + ((l.monthly_rent || 0) * 12), 0);
    const verifiedCount = 0; // address_verified not in DB schema

    return {
      ...p,
      _propCount: portProperties.length,
      _buildingCount: portBuildings.length,
      _unitCount: portUnits.length,
      _leaseCount: portLeases.length,
      _totalSF: totalSF,
      _occupancy: occupancy,
      _annualRent: annualRent,
      _verifiedCount: verifiedCount,
      _properties: portProperties,
    };
  });

  const filtered = enriched.filter(p => p.name?.toLowerCase().includes(search.toLowerCase()));
  const totals = {
    properties: properties.length,
    buildings: buildings.length,
    units: units.length,
    totalSF: properties.reduce((s, p) => s + (p.total_sqft || 0), 0),
  };

  return (
    <div className="p-4 lg:p-6 space-y-5">
      <PageHeader icon={Briefcase} title="Portfolio Overview" subtitle={`${portfolios.length} portfolios · ${totals.properties} properties across all portfolios`} iconColor="from-blue-500 to-indigo-600">
        <Button onClick={() => setShowCreate(true)} className="bg-gradient-to-r from-blue-600 to-indigo-700 hover:from-blue-700 hover:to-indigo-800 shadow-sm">
          <Plus className="w-4 h-4 mr-2" />Create Portfolio
        </Button>
      </PageHeader>

      {/* Global Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <MetricCard label="Portfolios" value={portfolios.length} icon={Briefcase} color="bg-blue-50 text-blue-600" />
        <MetricCard label="Properties" value={totals.properties} icon={Home} color="bg-emerald-50 text-emerald-600" />
        <MetricCard label="Buildings" value={totals.buildings} icon={Building2} color="bg-purple-50 text-purple-600" />
        <MetricCard label="Total Units" value={totals.units} icon={Users} color="bg-amber-50 text-amber-600" />
        <MetricCard label="Total SF" value={`${(totals.totalSF / 1000000).toFixed(1)}M`} icon={MapPin} color="bg-slate-100 text-slate-600" />
      </div>

      <div className="flex items-center justify-between gap-4">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input placeholder="Search portfolios..." className="pl-9 h-9 bg-white" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <ViewModeToggle viewMode={viewMode} onViewModeChange={setViewMode} />
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>
      ) : filtered.length === 0 ? (
        <Card><CardContent className="p-16 text-center"><p className="text-slate-400 text-sm mb-3">No portfolios found</p><Button onClick={() => setShowCreate(true)}>Create Your First Portfolio</Button></CardContent></Card>
      ) : viewMode === "grid" ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map(p => (
            <Card key={p.id} className="overflow-hidden hover:shadow-lg transition-all border-slate-200/80 group">
              <CardContent className="p-5">
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-xl flex items-center justify-center shadow-sm">
                      <Briefcase className="w-6 h-6 text-white" />
                    </div>
                    <div>
                      <h3 className="text-base font-bold text-slate-900">{p.name}</h3>
                      <Badge className="text-[10px] mt-1 bg-emerald-100 text-emerald-700">Active</Badge>
                    </div>
                  </div>
                </div>
                {p.description && <p className="text-xs text-slate-400 mb-3 line-clamp-2">{p.description}</p>}
                <div className="grid grid-cols-3 gap-2 mb-3">
                  {[
                    { label: "Properties", value: p._propCount },
                    { label: "Total SF", value: `${(p._totalSF / 1000).toFixed(0)}K` },
                    { label: "Occupancy", value: `${p._occupancy.toFixed(0)}%` },
                  ].map((m, i) => (
                    <div key={i} className="bg-slate-50 rounded-lg px-2 py-1.5 text-center">
                      <p className="text-[9px] font-bold text-slate-400 uppercase">{m.label}</p>
                      <p className="text-sm font-bold text-slate-900">{m.value}</p>
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-2 mb-3">
                  <div className="h-1.5 flex-1 bg-slate-100 rounded-full overflow-hidden">
                    <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${p._propCount > 0 ? (p._verifiedCount / p._propCount * 100) : 0}%` }} />
                  </div>
                  <span className="text-[10px] text-slate-400 font-medium">{p._verifiedCount}/{p._propCount} verified</span>
                </div>
                <div className="space-y-1 max-h-24 overflow-y-auto">
                  {p._properties.slice(0, 3).map(pr => (
                    <Link key={pr.id} to={createPageUrl("PropertyDetail") + `?id=${pr.id}`} className="flex items-center justify-between bg-slate-50 rounded-md px-2 py-1 hover:bg-blue-50 transition-colors">
                      <div className="flex items-center gap-1.5">
                        {pr.structure_type === 'multi' ? <Building2 className="w-3 h-3 text-purple-500" /> : <Home className="w-3 h-3 text-blue-500" />}
                        <span className="text-xs font-medium text-slate-700 truncate">{pr.name}</span>
                      </div>
                      <ChevronRight className="w-3 h-3 text-slate-300" />
                    </Link>
                  ))}
                </div>
                <Link to={createPageUrl("Properties") + `?portfolio=${p.id}`}>
                  <Button variant="outline" size="sm" className="w-full mt-3 text-xs h-7">View All Properties</Button>
                </Link>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : viewMode === "list" ? (
        <div className="space-y-2">
          {filtered.map(p => (
            <Card key={p.id} className="hover:shadow-md transition-all border-slate-200/80">
              <CardContent className="p-4 flex items-center gap-4">
                <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-lg flex items-center justify-center flex-shrink-0">
                  <Briefcase className="w-5 h-5 text-white" />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-bold text-slate-900 truncate">{p.name}</h3>
                  {p.description && <p className="text-xs text-slate-400 truncate">{p.description}</p>}
                </div>
                <div className="hidden md:flex items-center gap-6 text-xs text-slate-600">
                  <div className="text-center"><p className="font-bold text-sm">{p._propCount}</p><p className="text-slate-400">Properties</p></div>
                  <div className="text-center"><p className="font-bold text-sm">{`${(p._totalSF / 1000).toFixed(0)}K`}</p><p className="text-slate-400">SF</p></div>
                  <div className="text-center"><p className="font-bold text-sm">{p._occupancy.toFixed(0)}%</p><p className="text-slate-400">Occ.</p></div>
                  <div className="text-center"><p className="font-bold text-sm">${(p._annualRent / 1000).toFixed(0)}K</p><p className="text-slate-400">Rent/yr</p></div>
                </div>
                <Badge className="flex-shrink-0 bg-emerald-100 text-emerald-700">Active</Badge>
                <Link to={createPageUrl("Properties") + `?portfolio=${p.id}`}>
                  <Button variant="outline" size="sm" className="text-xs flex-shrink-0">View <ChevronRight className="w-3 h-3 ml-1" /></Button>
                </Link>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        /* Details / Table view */
        <Card className="overflow-hidden border-slate-200/80">
          <Table>
            <TableHeader>
              <TableRow className="bg-gradient-to-r from-slate-50 to-slate-100/50">
                <TableHead className="text-xs font-bold tracking-wider">PORTFOLIO</TableHead>
                <TableHead className="text-xs font-bold tracking-wider">STATUS</TableHead>
                <TableHead className="text-xs font-bold tracking-wider">PROPERTIES</TableHead>
                <TableHead className="text-xs font-bold tracking-wider">BUILDINGS</TableHead>
                <TableHead className="text-xs font-bold tracking-wider">UNITS</TableHead>
                <TableHead className="text-xs font-bold tracking-wider">TOTAL SF</TableHead>
                <TableHead className="text-xs font-bold tracking-wider">OCCUPANCY</TableHead>
                <TableHead className="text-xs font-bold tracking-wider">ANNUAL RENT</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map(p => (
                <TableRow key={p.id} className="hover:bg-slate-50">
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-lg flex items-center justify-center">
                        <Briefcase className="w-4 h-4 text-white" />
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-slate-900">{p.name}</p>
                        {p.description && <p className="text-xs text-slate-400 truncate max-w-[200px]">{p.description}</p>}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell><Badge className="bg-emerald-100 text-emerald-700">Active</Badge></TableCell>
                  <TableCell className="text-sm font-medium">{p._propCount}</TableCell>
                  <TableCell className="text-sm">{p._buildingCount}</TableCell>
                  <TableCell className="text-sm">{p._unitCount}</TableCell>
                  <TableCell className="text-sm font-mono">{p._totalSF.toLocaleString()}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{p._occupancy.toFixed(0)}%</span>
                      <div className="w-14 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                        <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${p._occupancy}%` }} />
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-sm font-medium">${(p._annualRent / 1000).toFixed(0)}K</TableCell>
                  <TableCell>
                    <Link to={createPageUrl("Properties") + `?portfolio=${p.id}`}>
                      <Button variant="outline" size="sm">View</Button>
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Create Portfolio</DialogTitle><DialogDescription>Group properties into a portfolio for unified management</DialogDescription></DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2"><Label>Portfolio Name *</Label><Input value={form.name} onChange={e => setForm({...form, name: e.target.value})} placeholder="e.g. Southwest Commercial Portfolio" /></div>
              <div className="col-span-2"><Label>Description</Label><Input value={form.description} onChange={e => setForm({...form, description: e.target.value})} placeholder="e.g. Mixed-use assets across the Southwest" /></div>
              <div className="col-span-2"><Label>Owner / Legal Entity</Label><Input value={form.owner_entity} onChange={e => setForm({...form, owner_entity: e.target.value})} placeholder="e.g. MCG Capital Holdings LLC" /></div>
              
              <div>
                <Label>Portfolio Type</Label>
                <Select value={form.type} onValueChange={v => setForm({...form, type: v})}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="commercial">Commercial / Office</SelectItem>
                    <SelectItem value="retail">Retail Center</SelectItem>
                    <SelectItem value="industrial">Industrial / Warehouse</SelectItem>
                    <SelectItem value="mixed_use">Mixed Use</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              
              <div>
                <Label>Primary Intent</Label>
                <Select value={form.intent} onValueChange={v => setForm({...form, intent: v})}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="asset_management">General Asset Management</SelectItem>
                    <SelectItem value="budgeting_cam">Budgeting & CAM Recovery</SelectItem>
                    <SelectItem value="leasing">Leasing & Rent Roll Focus</SelectItem>
                    <SelectItem value="acquisition">Acquisition Modeling</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div><Label>Geography / Region</Label><Input value={form.geography} onChange={e => setForm({...form, geography: e.target.value})} placeholder="e.g. Southwest US, New York" /></div>
              
              <div>
                <Label>Fiscal Year</Label>
                <Select value={form.fiscal_year} onValueChange={v => setForm({...form, fiscal_year: v})}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="jan_dec">Jan 1 - Dec 31</SelectItem>
                    <SelectItem value="jul_jun">Jul 1 - Jun 30</SelectItem>
                    <SelectItem value="oct_sep">Oct 1 - Sep 30</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={() => {
              // Only send columns that exist in the portfolios table.
              // Extra form fields (type, geography, fiscal_year, intent, owner_entity)
              // are folded into the description so no schema error is thrown.
              const extras = [
                form.owner_entity && `Entity: ${form.owner_entity}`,
                form.type && `Type: ${form.type}`,
                form.geography && `Region: ${form.geography}`,
                form.fiscal_year && `FY: ${form.fiscal_year}`,
                form.intent && `Intent: ${form.intent}`,
              ].filter(Boolean).join(' | ');
              const description = [form.description, extras].filter(Boolean).join(' — ') || undefined;
              createMutation.mutate({
                name: form.name,
                ...(description ? { description } : {}),
                ...(orgId && orgId !== '__none__' ? { org_id: orgId } : {}),
              });
            }} disabled={!form.name || createMutation.isPending || !orgId || orgId === '__none__'} className="bg-gradient-to-r from-blue-600 to-indigo-700">
              {createMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
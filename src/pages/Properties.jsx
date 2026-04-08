import React, { useEffect, useState } from "react";
import { propertyService } from "@/services/propertyService";
import { validateAddress } from "@/services/integrations";
import { supabase } from "@/services/supabaseClient";
import useOrgId from "@/hooks/useOrgId";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import useOrgQuery from "@/hooks/useOrgQuery";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Plus, Search, Download, Upload, Loader2, Home, Building2, CheckCircle2, XCircle, MapPin, ChevronRight, ArrowRight, ArrowLeft } from "lucide-react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { createPageUrl, downloadCSV } from "@/utils";
import PageHeader from "@/components/PageHeader";
import MetricCard from "@/components/MetricCard";
import ViewModeToggle from "@/components/ViewModeToggle";
import BulkImportModal from "@/components/property/BulkImportModal";

export default function Properties() {
  const navigate = useNavigate();
  const location = useLocation();
  const portfolioId = new URLSearchParams(location.search).get("portfolio");
  const [showCreate, setShowCreate] = useState(false);
  const [currentStep, setCurrentStep] = useState(1);
  const [showImport, setShowImport] = useState(false);
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState("details");
  const [structureFilter, setStructureFilter] = useState("all");
  const [verifyingAddress, setVerifyingAddress] = useState(false);
  const queryClient = useQueryClient();

  const buildDefaultForm = () => ({
    name: "", address: "", city: "", state: "", zip: "",
    property_type: "office", structure_type: "single",
    total_sf: "", total_buildings: 1, total_units: 0, year_built: "",
    portfolio_id: portfolioId || ""
  });
  const defaultForm = buildDefaultForm();
  const [form, setForm] = useState(defaultForm);

  const { data: properties = [], isLoading, orgId } = useOrgQuery("Property");
  const { orgId: currentOrgId } = useOrgId();
  const { data: buildings = [] } = useOrgQuery("Building");
  const { data: units = [] } = useOrgQuery("Unit");
  const { data: portfolios = [] } = useOrgQuery("Portfolio");
  const activePortfolio = portfolioId ? portfolios.find((portfolio) => portfolio.id === portfolioId) : null;

  useEffect(() => {
    setForm((prev) => ({ ...prev, portfolio_id: portfolioId || "" }));
  }, [portfolioId]);

  const createMutation = useMutation({
    mutationFn: (data) => propertyService.create(data),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['Property'] });
      setShowCreate(false);
      setForm(buildDefaultForm());
      setCurrentStep(1);
      toast.success("Property created successfully");
      if (data && data.id) {
        navigate(createPageUrl("PropertyDetail") + "?id=" + data.id);
      }
    },
    onError: (err) => {
      toast.error("Failed to create property: " + (err?.message || "Unknown error"));
    },
  });

  const scopedProperties = portfolioId
    ? properties.filter((property) => property.portfolio_id === portfolioId)
    : properties;

  const filtered = scopedProperties.filter(p => {
    const matchSearch = p.name?.toLowerCase().includes(search.toLowerCase()) || p.address?.toLowerCase().includes(search.toLowerCase());
    const matchStructure = structureFilter === "all" || p.structure_type === structureFilter;
    return matchSearch && matchStructure;
  });

  const singleTenantProps = scopedProperties.filter(p => p.structure_type === 'single');
  const multiTenantProps = scopedProperties.filter(p => p.structure_type === 'multi');

  const generatePropertyId = () => {
    const prefix = form.state ? form.state.substring(0, 2).toUpperCase() : "XX";
      const num = String(scopedProperties.length + 1).padStart(3, "0");
    return `MCG-${prefix}-${num}`;
  };

  const verifyAddress = async () => {
    if (!form.address) return;
    setVerifyingAddress(true);
    try {
      const data = await validateAddress({
        addressLine1: form.address,
        city: form.city,
        state: form.state,
        postalCode: form.zip,
        countryCode: "US",
      });

      if (data.valid && data.candidates?.length > 0) {
        const best = data.candidates[0];
        setForm(f => ({
          ...f,
          address: best.addressLine1 || best.address || f.address,
          city: best.city || f.city,
          state: best.state || f.state,
          zip: best.postalCode || best.zip || f.zip,
          address_verified: true,
          address_verification_note: ""
        }));
      } else {
        setForm(f => ({
          ...f,
          address_verified: false,
          address_verification_note: data.message || "Address could not be verified. Manual override available."
        }));
      }
    } catch {
      setForm(f => ({
        ...f,
        address_verified: false,
        address_verification_note: "Address verification service unavailable. Manual override available."
      }));
    }
    setVerifyingAddress(false);
  };


  // Get building/unit counts per property
  const getPropBuildings = (pid) => buildings.filter(b => b.property_id === pid);
  const getPropUnits = (pid) => units.filter(u => u.property_id === pid);

  return (
    <div className="p-4 lg:p-6 space-y-5">
      <PageHeader icon={Home} title="Properties" subtitle={`${properties.length} properties · ${singleTenantProps.length} single · ${multiTenantProps.length} multi-building`} iconColor="from-blue-500 to-blue-700">
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => downloadCSV(scopedProperties, 'properties.csv')}><Download className="w-4 h-4 mr-1 text-slate-500" />Export</Button>
          <Button variant="outline" size="sm" onClick={() => setShowImport(true)}><Upload className="w-4 h-4 mr-1" />Bulk Upload</Button>
          <Button size="sm" onClick={() => setShowCreate(true)} className="bg-gradient-to-r from-blue-600 to-blue-700 shadow-sm"><Plus className="w-4 h-4 mr-1" />Add Property</Button>
        </div>
      </PageHeader>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <div onClick={() => setStructureFilter("all")} className={`cursor-pointer`}>
          <MetricCard label="All Properties" value={scopedProperties.length} icon={Home} color="bg-slate-100 text-slate-600" className={structureFilter === 'all' ? 'ring-2 ring-blue-500' : ''} />
        </div>
        <div onClick={() => setStructureFilter("single")} className={`cursor-pointer`}>
          <MetricCard label="Single Building" value={singleTenantProps.length} icon={Home} color="bg-blue-50 text-blue-600" className={structureFilter === 'single' ? 'ring-2 ring-blue-500' : ''} />
        </div>
        <div onClick={() => setStructureFilter("multi")} className={`cursor-pointer`}>
          <MetricCard label="Multi Building" value={multiTenantProps.length} icon={Building2} color="bg-purple-50 text-purple-600" className={structureFilter === 'multi' ? 'ring-2 ring-purple-500' : ''} />
        </div>
        <MetricCard label="Total SF" value={scopedProperties.reduce((s, p) => s + (p.total_sf || p.total_sqft || 0), 0).toLocaleString()} icon={MapPin} color="bg-emerald-50 text-emerald-600" />
        <MetricCard label="Verified" value={`${scopedProperties.filter(p => p.address_verified).length}/${scopedProperties.length}`} icon={CheckCircle2} color="bg-green-50 text-green-600" sub="addresses verified" />
      </div>

      <div className="flex items-center justify-between gap-4">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input placeholder="Search properties..." className="pl-9" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <ViewModeToggle viewMode={viewMode} onViewModeChange={setViewMode} />
      </div>

      {viewMode === "grid" ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {isLoading ? (
            <div className="col-span-full flex items-center justify-center py-20"><Loader2 className="w-5 h-5 animate-spin text-slate-400" /></div>
          ) : filtered.length === 0 ? (
            <div className="col-span-full text-center py-12 text-sm text-slate-400">No properties found</div>
          ) : filtered.map(p => {
            const propBuildings = getPropBuildings(p.id);
            const propUnits = getPropUnits(p.id);
            return (
              <Card key={p.id} className="overflow-hidden hover:shadow-lg transition-all border-slate-200/80 group">
                <CardContent className="p-5">
                  <div className="flex items-start gap-3 mb-3">
                    <div className={`w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 ${p.structure_type === 'multi' ? 'bg-purple-100' : 'bg-blue-100'}`}>
                      {p.structure_type === 'multi' ? <Building2 className="w-6 h-6 text-purple-500" /> : <Home className="w-6 h-6 text-blue-500" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <h3 className="text-base font-bold text-slate-900 truncate">{p.name}</h3>
                      <p className="text-xs text-slate-400 truncate">{p.address}{p.city ? `, ${p.city}` : ''}{p.state ? `, ${p.state}` : ''}</p>
                      <div className="flex gap-1.5 mt-1.5">
                        <Badge variant="outline" className="text-[10px] capitalize">{p.property_type?.replace('_', ' ')}</Badge>
                        <Badge className={`text-[10px] ${p.structure_type === 'multi' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}`}>
                          {p.structure_type === 'multi' ? 'Multi' : 'Single'}
                        </Badge>
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-4 gap-2 mb-3">
                    {[
                      { label: "Bldgs", value: propBuildings.length || p.total_buildings || 1 },
                      { label: "Units", value: propUnits.length || p.total_units || 0 },
                      { label: "SF", value: `${(((p.total_sf || p.total_sqft || 0) / 1000).toFixed(0))}K` },
                      { label: "Occ.", value: `${p.occupancy_pct || 0}%` },
                    ].map((m, i) => (
                      <div key={i} className="bg-slate-50 rounded px-2 py-1.5 text-center">
                        <p className="text-[9px] font-bold text-slate-400 uppercase">{m.label}</p>
                        <p className="text-sm font-bold text-slate-900">{m.value}</p>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center justify-between">
                    {p.address_verified ? (
                      <span className="text-[10px] text-emerald-600 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" />Verified</span>
                    ) : (
                      <span className="text-[10px] text-slate-400 flex items-center gap-1"><XCircle className="w-3 h-3" />Unverified</span>
                    )}
                    <Link to={createPageUrl("PropertyDetail") + `?id=${p.id}`}>
                      <Button variant="outline" size="sm" className="text-xs h-7">View <ChevronRight className="w-3 h-3 ml-1" /></Button>
                    </Link>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : viewMode === "list" ? (
        <div className="space-y-2">
          {isLoading ? (
            <div className="flex items-center justify-center py-20"><Loader2 className="w-5 h-5 animate-spin text-slate-400" /></div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-12 text-sm text-slate-400">No properties found</div>
          ) : filtered.map(p => {
            const propBuildings = getPropBuildings(p.id);
            const propUnits = getPropUnits(p.id);
            return (
              <Card key={p.id} className="hover:shadow-md transition-all border-slate-200/80">
                <CardContent className="p-3 flex items-center gap-4">
                  <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${p.structure_type === 'multi' ? 'bg-purple-100' : 'bg-blue-100'}`}>
                    {p.structure_type === 'multi' ? <Building2 className="w-5 h-5 text-purple-500" /> : <Home className="w-5 h-5 text-blue-500" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-bold text-slate-900 truncate">{p.name}</h3>
                    <p className="text-xs text-slate-400 truncate">{p.address}{p.city ? `, ${p.city}` : ''}{p.state ? `, ${p.state}` : ''}</p>
                  </div>
                  <div className="hidden md:flex items-center gap-6 text-xs text-slate-600 flex-shrink-0">
                    <div className="text-center"><p className="font-bold text-sm">{propBuildings.length || p.total_buildings || 1}</p><p className="text-slate-400">Bldgs</p></div>
                    <div className="text-center"><p className="font-bold text-sm">{propUnits.length || p.total_units || 0}</p><p className="text-slate-400">Units</p></div>
                    <div className="text-center"><p className="font-bold text-sm">{(p.total_sf || p.total_sqft || 0).toLocaleString()}</p><p className="text-slate-400">Total SF</p></div>
                    <div className="text-center"><p className="font-bold text-sm">{p.occupancy_pct || 0}%</p><p className="text-slate-400">Occ.</p></div>
                  </div>
                  <Badge className={`flex-shrink-0 text-[10px] ${p.structure_type === 'multi' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}`}>
                    {p.structure_type === 'multi' ? 'Multi' : 'Single'}
                  </Badge>
                  {p.address_verified ? <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" /> : <XCircle className="w-4 h-4 text-slate-300 flex-shrink-0" />}
                  <Link to={createPageUrl("PropertyDetail") + `?id=${p.id}`}>
                    <Button variant="outline" size="sm" className="flex-shrink-0">View</Button>
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
                <TableHead className="text-xs font-bold tracking-wider">PROPERTY</TableHead>
                <TableHead className="text-xs font-bold tracking-wider">ADDRESS</TableHead>
                <TableHead className="text-xs font-bold tracking-wider">TYPE</TableHead>
                <TableHead className="text-xs font-bold tracking-wider">STRUCTURE</TableHead>
                <TableHead className="text-xs font-bold tracking-wider">BUILDINGS</TableHead>
                <TableHead className="text-xs font-bold tracking-wider">UNITS</TableHead>
                <TableHead className="text-xs font-bold tracking-wider">TOTAL SF</TableHead>
                <TableHead className="text-xs font-bold tracking-wider">OCCUPANCY</TableHead>
                <TableHead className="text-xs font-bold tracking-wider">VERIFIED</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={10} className="text-center py-12"><Loader2 className="w-5 h-5 animate-spin mx-auto text-slate-400" /></TableCell></TableRow>
              ) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={10} className="text-center py-12 text-sm text-slate-400">No properties found</TableCell></TableRow>
              ) : (
                filtered.map(p => {
                  const propBuildings = getPropBuildings(p.id);
                  const propUnits = getPropUnits(p.id);
                  return (
                    <TableRow key={p.id} className="hover:bg-slate-50">
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${p.structure_type === 'multi' ? 'bg-purple-100' : 'bg-blue-100'}`}>
                            {p.structure_type === 'multi' ? <Building2 className="w-4 h-4 text-purple-500" /> : <Home className="w-4 h-4 text-blue-500" />}
                          </div>
                          <div>
                            <p className="text-sm font-semibold text-slate-900">{p.name}</p>
                            <p className="text-xs text-slate-400">ID: {p.property_id_code}</p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-slate-600">{p.address}{p.city ? `, ${p.city}` : ''}{p.state ? `, ${p.state}` : ''}</TableCell>
                      <TableCell><Badge variant="outline" className="text-xs capitalize">{p.property_type?.replace('_', ' ')}</Badge></TableCell>
                      <TableCell>
                        <Badge className={`text-[10px] uppercase ${p.structure_type === 'multi' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}`}>
                          {p.structure_type === 'multi' ? 'Multi Building' : 'Single Building'}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm">{propBuildings.length || p.total_buildings || 1}</TableCell>
                      <TableCell className="text-sm">{propUnits.length || p.total_units || 0}</TableCell>
                      <TableCell className="text-sm font-mono">{(p.total_sf || p.total_sqft || 0).toLocaleString()}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">{p.occupancy_pct || 0}%</span>
                          <div className="w-16 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                            <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${p.occupancy_pct || 0}%` }} />
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        {p.address_verified ? (
                          <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                        ) : (
                          <XCircle className="w-4 h-4 text-slate-300" />
                        )}
                      </TableCell>
                      <TableCell>
                        <Link to={createPageUrl("PropertyDetail") + `?id=${p.id}`}>
                          <Button variant="outline" size="sm">View</Button>
                        </Link>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </Card>
      )}

      {/* Add Property Multi-Step Wizard Dialog */}
      <Dialog open={showCreate} onOpenChange={v => { setShowCreate(v); if(!v) setCurrentStep(1); }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto overflow-x-hidden">
          <DialogHeader>
            <DialogTitle>Add New Property</DialogTitle>
            <DialogDescription>
              Step {currentStep} of 4: {['Basic Info', 'Location & Verification', 'Structure', 'Metrics'][currentStep - 1]}
            </DialogDescription>
          </DialogHeader>

          {/* Stepper visualization */}
          <div className="flex items-center justify-between mb-4 mt-2">
            {[1,2,3,4].map(step => (
              <div key={step} className={`flex items-center ${step < 4 ? 'w-full' : ''}`}>
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${currentStep >= step ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-400'}`}>
                  {step}
                </div>
                {step < 4 && <div className={`h-1 mx-2 flex-1 rounded-full transition-colors ${currentStep > step ? 'bg-blue-600' : 'bg-slate-100'}`} />}
              </div>
            ))}
          </div>

          <div className="space-y-4 py-2 min-h-[300px]">
            {currentStep === 1 && (
              <div className="space-y-5 animate-in fade-in slide-in-from-right-4 duration-300 fill-mode-both">
                <div>
                  <Label>Property Name *</Label>
                  <Input value={form.name} onChange={e => setForm({...form, name: e.target.value})} placeholder="e.g. Camelback Commerce Center" className="mt-1.5" />
                </div>
                <div>
                  <Label>Primary Property Type</Label>
                  <div className="mt-1.5">
                    <Select value={form.property_type} onValueChange={v => setForm({...form, property_type: v})}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="office">Office</SelectItem>
                        <SelectItem value="retail">Retail</SelectItem>
                        <SelectItem value="industrial">Industrial</SelectItem>
                        <SelectItem value="mixed_use">Mixed-Use</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            )}

            {currentStep === 2 && (
              <div className="space-y-5 animate-in fade-in slide-in-from-right-4 duration-300 fill-mode-both">
                <div>
                  <Label>Street Address *</Label>
                  <div className="flex gap-2 mt-1.5">
                    <Input value={form.address} onChange={e => setForm({...form, address: e.target.value, address_verified: false})} placeholder="123 Main St" className="flex-1" />
                    <Button variant="outline" className="shrink-0" onClick={verifyAddress} disabled={verifyingAddress || !form.address}>
                      {verifyingAddress ? <Loader2 className="w-4 h-4 animate-spin md:mr-1" /> : <MapPin className="w-4 h-4 md:mr-1" />}
                      <span className="hidden md:inline">Verify Using AI</span>
                    </Button>
                  </div>
                  {form.address_verified && (
                    <p className="text-[12px] font-medium text-emerald-600 mt-2 flex items-center gap-1.5 bg-emerald-50 w-fit px-2 py-1 rounded-md"><CheckCircle2 className="w-3.5 h-3.5" />Address verified & standardized</p>
                  )}
                  {!form.address_verified && form.address_verification_note && (
                    <div className="mt-3 bg-amber-50 border border-amber-200 rounded-lg p-3">
                      <p className="text-xs text-amber-800 font-medium flex items-center gap-1.5 mb-2"><XCircle className="w-4 h-4 text-amber-500" />{form.address_verification_note}</p>
                      <button type="button" onClick={() => setForm(f => ({ ...f, address_verified: true, address_verification_note: "Manually overridden" }))} className="text-xs font-semibold text-amber-700 hover:text-amber-900 underline transition-colors">I accept the risk, override verification</button>
                    </div>
                  )}
                </div>
                <div className="grid grid-cols-6 gap-3 pt-2">
                  <div className="col-span-3 sm:col-span-2"><Label>City</Label><Input className="mt-1.5" value={form.city} onChange={e => setForm({...form, city: e.target.value})} /></div>
                  <div className="col-span-3 sm:col-span-2"><Label>State (2-let)</Label><Input className="mt-1.5" value={form.state} onChange={e => setForm({...form, state: e.target.value})} maxLength={2} placeholder="AZ" /></div>
                  <div className="col-span-6 sm:col-span-2"><Label>ZIP / Postal</Label><Input className="mt-1.5" value={form.zip} onChange={e => setForm({...form, zip: e.target.value})} /></div>
                </div>
              </div>
            )}

            {currentStep === 3 && (
              <div className="space-y-5 animate-in fade-in slide-in-from-right-4 duration-300 fill-mode-both">
                <div>
                  <Label className="mb-3 block text-base font-semibold text-slate-800">How is this property structured? *</Label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <button type="button" onClick={() => setForm({...form, structure_type: 'single', total_buildings: 1})}
                      className={`p-5 rounded-xl border-2 text-left transition-all relative ${form.structure_type === 'single' ? 'border-blue-600 bg-blue-50 shadow-sm' : 'border-slate-200 hover:border-blue-300 bg-white'}`}>
                      {form.structure_type === 'single' && <div className="absolute top-3 right-3 text-blue-600"><CheckCircle2 className="w-5 h-5"/></div>}
                      <div className="flex items-center gap-2 mb-2"><Home className={`w-6 h-6 ${form.structure_type === 'single' ? 'text-blue-600' : 'text-slate-400'}`} /><span className={`text-base font-bold ${form.structure_type === 'single' ? 'text-blue-900' : 'text-slate-700'}`}>Single Building</span></div>
                      <p className="text-xs text-slate-500 leading-relaxed">Property consists of exactly one physical building. Can have one or many tenants (suites).</p>
                    </button>
                    <button type="button" onClick={() => setForm({...form, structure_type: 'multi'})}
                      className={`p-5 rounded-xl border-2 text-left transition-all relative ${form.structure_type === 'multi' ? 'border-purple-600 bg-purple-50 shadow-sm' : 'border-slate-200 hover:border-purple-300 bg-white'}`}>
                      {form.structure_type === 'multi' && <div className="absolute top-3 right-3 text-purple-600"><CheckCircle2 className="w-5 h-5"/></div>}
                      <div className="flex items-center gap-2 mb-2"><Building2 className={`w-6 h-6 ${form.structure_type === 'multi' ? 'text-purple-600' : 'text-slate-400'}`} /><span className={`text-base font-bold ${form.structure_type === 'multi' ? 'text-purple-900' : 'text-slate-700'}`}>Multi-Building Complex</span></div>
                      <p className="text-xs text-slate-500 leading-relaxed">A campus or retail center with multiple standalone physical buildings sharing the same address.</p>
                    </button>
                  </div>
                </div>
                {form.structure_type === 'multi' && (
                  <div className="animate-in fade-in slide-in-from-top-2 pt-2 border-t border-slate-100">
                    <Label className="text-sm">How many distinct buildings exist? *</Label>
                    <Input className="mt-1.5 max-w-[200px]" type="number" min="2" value={form.total_buildings} onChange={e => setForm({...form, total_buildings: parseInt(e.target.value) || 2})} />
                  </div>
                )}
              </div>
            )}

            {currentStep === 4 && (
              <div className="space-y-5 animate-in fade-in slide-in-from-right-4 duration-300 fill-mode-both">
                <div className="bg-slate-50 rounded-lg p-4 border border-slate-100 mb-2">
                  <h4 className="text-sm font-bold text-slate-800 mb-1">Almost done!</h4>
                  <p className="text-xs text-slate-500">Add key metrics. You can always update these later or let them calculate automatically from the rent roll.</p>
                </div>
                <div>
                  <Label>Total Rentable Square Feet (RSF)</Label>
                  <Input className="mt-1.5 font-mono" type="number" value={form.total_sf} onChange={e => setForm({...form, total_sf: e.target.value})} placeholder="e.g. 150000" />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>Expected Total Units/Suites</Label>
                    <Input className="mt-1.5 font-mono" type="number" value={form.total_units} onChange={e => setForm({...form, total_units: parseInt(e.target.value) || 0})} placeholder="e.g. 1" />
                  </div>
                  <div>
                    <Label>Year Built</Label>
                    <Input className="mt-1.5 font-mono" type="number" value={form.year_built} onChange={e => setForm({...form, year_built: e.target.value})} placeholder="e.g. 2023" />
                  </div>
                </div>
              </div>
            )}
          </div>

          <DialogFooter className="flex justify-between items-center sm:justify-between mt-6 pt-4 border-t border-slate-100 w-full">
            {currentStep > 1 ? (
              <Button variant="outline" onClick={() => setCurrentStep(prev => prev - 1)}><ArrowLeft className="w-4 h-4 mr-1" />Back</Button>
            ) : (
              <Button variant="ghost" className="text-slate-500 hover:text-slate-700" onClick={() => { setShowCreate(false); setCurrentStep(1); }}>Cancel</Button>
            )}

            {currentStep < 4 ? (
              <Button 
                onClick={() => setCurrentStep(prev => prev + 1)} 
                disabled={(currentStep === 1 && !form.name) || (currentStep === 2 && !form.address)} 
                className="bg-slate-900 hover:bg-slate-800 text-white min-w-[100px]"
              >
                Next Step<ArrowRight className="w-4 h-4 ml-1.5" />
              </Button>
            ) : (
              <Button onClick={() => createMutation.mutate({
                name: form.name,
                address: form.address,
                city: form.city,
                state: form.state,
                zip: form.zip,
                property_type: form.property_type,
                structure_type: form.structure_type || "single",
                total_sf: parseInt(form.total_sf) || 0,
                total_buildings: parseInt(form.total_buildings) || 1,
                total_units: parseInt(form.total_units) || 0,
                year_built: parseInt(form.year_built) || null,
                address_verified: form.address_verified || false,
                ...(form.portfolio_id ? { portfolio_id: form.portfolio_id } : {}),
                ...(orgId && orgId !== '__none__' ? { org_id: orgId } : {}),
                status: "active",
              })} disabled={!form.name || createMutation.isPending} className="bg-blue-600 hover:bg-blue-700 min-w-[140px] shadow-sm">
                {createMutation.isPending && <Loader2 className="w-4 h-4 animate-spin mr-2" />}Create Property
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <BulkImportModal 
        isOpen={showImport} 
        onClose={() => setShowImport(false)} 
        moduleType="property" 
      />
    </div>
  );
}

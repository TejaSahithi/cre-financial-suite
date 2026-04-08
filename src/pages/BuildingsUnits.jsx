import React, { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "react-router-dom";
import {
  Building2,
  Search,
  Loader2,
  Home,
  Users,
  Layers,
  ChevronRight,
  DoorOpen,
  Plus,
  Download,
  Upload,
  Trash2,
} from "lucide-react";
import { UnitService, BuildingService, PropertyService, PortfolioService } from "@/services/api";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { createPageUrl, downloadCSV } from "@/utils";
import PageHeader from "@/components/PageHeader";
import MetricCard from "@/components/MetricCard";
import ViewModeToggle from "@/components/ViewModeToggle";
import CreateBuildingModal from "@/components/property/CreateBuildingModal";
import CreateUnitModal from "@/components/property/CreateUnitModal";
import BulkImportModal from "@/components/property/BulkImportModal";
import DeleteConfirmDialog from "@/components/DeleteConfirmDialog";
import { toast } from "sonner";

export default function BuildingsUnits() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const portfolioId = params.get("portfolio");
  const propertyId = params.get("property");

  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState("grid");
  const [propertyFilter, setPropertyFilter] = useState(propertyId || "all");
  const [showCreateBuilding, setShowCreateBuilding] = useState(false);
  const [showCreateUnit, setShowCreateUnit] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importType, setImportType] = useState("building");
  const [selectedBuildingIds, setSelectedBuildingIds] = useState([]);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [showBulkDelete, setShowBulkDelete] = useState(false);
  const queryClient = useQueryClient();

  const { data: properties = [] } = useQuery({
    queryKey: ["bu-properties"],
    queryFn: () => PropertyService.list(),
  });
  const { data: portfolios = [] } = useQuery({
    queryKey: ["bu-portfolios"],
    queryFn: () => PortfolioService.list(),
  });
  const { data: buildings = [], isLoading } = useQuery({
    queryKey: ["bu-buildings"],
    queryFn: () => BuildingService.list(),
  });
  const { data: units = [] } = useQuery({
    queryKey: ["bu-units"],
    queryFn: () => UnitService.list(),
  });

  useEffect(() => {
    setPropertyFilter(propertyId || "all");
  }, [propertyId]);

  const scopedProperties = useMemo(() => {
    if (propertyId) {
      return properties.filter((property) => property.id === propertyId);
    }
    if (portfolioId) {
      return properties.filter((property) => property.portfolio_id === portfolioId);
    }
    return properties;
  }, [properties, portfolioId, propertyId]);

  const scopedPropertyIds = useMemo(
    () => new Set(scopedProperties.map((property) => property.id)),
    [scopedProperties]
  );

  const scopedBuildings = useMemo(
    () => buildings.filter((building) => scopedPropertyIds.has(building.property_id)),
    [buildings, scopedPropertyIds]
  );

  const scopedBuildingIds = useMemo(
    () => new Set(scopedBuildings.map((building) => building.id)),
    [scopedBuildings]
  );

  const scopedUnits = useMemo(
    () =>
      units.filter((unit) => {
        if (unit.building_id && scopedBuildingIds.has(unit.building_id)) return true;
        return scopedPropertyIds.has(unit.property_id);
      }),
    [units, scopedBuildingIds, scopedPropertyIds]
  );

  const activeProperty = propertyId ? scopedProperties[0] : null;
  const activePortfolio = portfolioId ? portfolios.find((portfolio) => portfolio.id === portfolioId) : null;

  const getPropertyName = (id) => properties.find((property) => property.id === id)?.name || "—";
  const getBuildingUnits = (buildingId) => scopedUnits.filter((unit) => unit.building_id === buildingId);

  const filteredBuildings = scopedBuildings.filter((building) => {
    const matchSearch =
      building.name?.toLowerCase().includes(search.toLowerCase()) ||
      getPropertyName(building.property_id).toLowerCase().includes(search.toLowerCase());
    const matchProperty = propertyFilter === "all" || building.property_id === propertyFilter;
    return matchSearch && matchProperty;
  });

  const totalUnits = scopedUnits.length;
  const leasedUnits = scopedUnits.filter((unit) => unit.occupancy_status === "leased").length;
  const vacantUnits = scopedUnits.filter((unit) => unit.occupancy_status === "vacant").length;
  const totalSF = scopedBuildings.reduce((sum, building) => sum + (building.total_sf || building.total_sqft || 0), 0);

  const deleteMutation = useMutation({
    mutationFn: async ({ type, id }) => {
      const ok = type === "unit" ? await UnitService.delete(id) : await BuildingService.delete(id);
      if (!ok) throw new Error("Delete failed");
      return { type, id };
    },
    onSuccess: ({ type, id }) => {
      queryClient.invalidateQueries({ queryKey: ["bu-buildings"] });
      queryClient.invalidateQueries({ queryKey: ["bu-units"] });
      queryClient.invalidateQueries({ queryKey: ["Building"] });
      queryClient.invalidateQueries({ queryKey: ["Unit"] });
      setDeleteTarget(null);
      if (type === "building") {
        setSelectedBuildingIds((prev) => prev.filter((selectedId) => selectedId !== id));
      }
      toast.success(`${type === "unit" ? "Unit" : "Building"} deleted successfully`);
    },
    onError: (err) => {
      toast.error(`Failed to delete: ${err?.message || "Unknown error"}`);
    },
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: async (ids) => {
      await Promise.all(
        ids.map(async (id) => {
          const ok = await BuildingService.delete(id);
          if (!ok) throw new Error("Delete failed");
        })
      );
      return ids.length;
    },
    onSuccess: (count) => {
      queryClient.invalidateQueries({ queryKey: ["bu-buildings"] });
      queryClient.invalidateQueries({ queryKey: ["bu-units"] });
      queryClient.invalidateQueries({ queryKey: ["Building"] });
      queryClient.invalidateQueries({ queryKey: ["Unit"] });
      setSelectedBuildingIds([]);
      setShowBulkDelete(false);
      toast.success(`${count} building${count === 1 ? "" : "s"} deleted successfully`);
    },
    onError: (err) => {
      toast.error(`Failed to delete selected buildings: ${err?.message || "Unknown error"}`);
    },
  });

  const subtitleParts = [
    `${scopedBuildings.length} buildings`,
    `${totalUnits} units`,
    propertyId && activeProperty ? `for ${activeProperty.name}` : null,
    !propertyId && portfolioId && activePortfolio ? `in ${activePortfolio.name}` : null,
    !propertyId && !portfolioId ? `across ${scopedProperties.length} properties` : null,
  ].filter(Boolean);

  const allFilteredSelected = filteredBuildings.length > 0 && filteredBuildings.every((building) => selectedBuildingIds.includes(building.id));

  const toggleBuildingSelection = (buildingId) => {
    setSelectedBuildingIds((prev) =>
      prev.includes(buildingId)
        ? prev.filter((id) => id !== buildingId)
        : [...prev, buildingId]
    );
  };

  const toggleSelectAllFiltered = (checked) => {
    if (checked) {
      setSelectedBuildingIds((prev) => [...new Set([...prev, ...filteredBuildings.map((building) => building.id)])]);
      return;
    }
    const filteredIds = new Set(filteredBuildings.map((building) => building.id));
    setSelectedBuildingIds((prev) => prev.filter((id) => !filteredIds.has(id)));
  };

  return (
    <div className="p-4 lg:p-6 space-y-5">
      <PageHeader
        icon={Building2}
        title="Buildings & Units"
        subtitle={subtitleParts.join(" · ")}
        iconColor="from-purple-500 to-purple-700"
      >
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => downloadCSV(scopedBuildings, "buildings.csv")}>
            <Download className="w-4 h-4 mr-1 text-slate-500" />
            Export
          </Button>
          <Button variant="outline" size="sm" onClick={() => { setImportType("building"); setShowImport(true); }}>
            <Upload className="w-4 h-4 mr-1" />
            Import
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowCreateBuilding(true)}
            className="border-purple-200 text-purple-700 hover:bg-purple-50"
          >
            <Plus className="w-4 h-4 mr-1" />
            Add Building
          </Button>
          <Button size="sm" onClick={() => setShowCreateUnit(true)} className="bg-gradient-to-r from-purple-600 to-purple-700 shadow-sm">
            <Plus className="w-4 h-4 mr-1" />
            Add Unit
          </Button>
        </div>
      </PageHeader>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <MetricCard label="Buildings" value={scopedBuildings.length} icon={Building2} color="bg-purple-50 text-purple-600" />
        <MetricCard label="Total Units" value={totalUnits} icon={DoorOpen} color="bg-blue-50 text-blue-600" />
        <MetricCard label="Leased" value={leasedUnits} icon={Users} color="bg-emerald-50 text-emerald-600" />
        <MetricCard label="Vacant" value={vacantUnits} icon={Layers} color="bg-amber-50 text-amber-600" />
        <MetricCard label="Total SF" value={`${(totalSF / 1000).toFixed(0)}K`} icon={Home} color="bg-slate-100 text-slate-600" />
      </div>

      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div className="relative max-w-sm flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <Input placeholder="Search buildings..." className="pl-9" value={search} onChange={(event) => setSearch(event.target.value)} />
          </div>
          <Select value={propertyFilter} onValueChange={setPropertyFilter}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="All Properties" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Properties</SelectItem>
              {scopedProperties.map((property) => (
                <SelectItem key={property.id} value={property.id}>
                  {property.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {selectedBuildingIds.length > 0 && (
            <>
              <span className="text-xs font-medium text-slate-500">
                {selectedBuildingIds.length} selected
              </span>
              <Button variant="outline" size="sm" onClick={() => setSelectedBuildingIds([])}>
                Clear
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="border-red-200 text-red-600 hover:bg-red-50"
                onClick={() => setShowBulkDelete(true)}
              >
                <Trash2 className="w-4 h-4 mr-1" />
                Delete Selected
              </Button>
            </>
          )}
          <ViewModeToggle viewMode={viewMode} onViewModeChange={setViewMode} />
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
        </div>
      ) : filteredBuildings.length === 0 ? (
        <Card>
          <CardContent className="p-16 text-center text-sm text-slate-400">No buildings found</CardContent>
        </Card>
      ) : viewMode === "grid" ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filteredBuildings.map((building) => {
            const buildingUnits = getBuildingUnits(building.id);
            const leased = buildingUnits.filter((unit) => unit.occupancy_status === "leased").length;
            const vacant = buildingUnits.filter((unit) => unit.occupancy_status === "vacant").length;

            return (
              <Card key={building.id} className="overflow-hidden hover:shadow-lg transition-all border-slate-200/80">
                <CardContent className="p-5">
                  <div className="flex items-start gap-3 mb-3">
                    <Checkbox
                      checked={selectedBuildingIds.includes(building.id)}
                      onCheckedChange={() => toggleBuildingSelection(building.id)}
                      className="mt-1"
                    />
                    <div className="w-12 h-12 bg-purple-100 rounded-xl flex items-center justify-center flex-shrink-0">
                      <Building2 className="w-6 h-6 text-purple-500" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <h3 className="text-base font-bold text-slate-900">{building.name}</h3>
                      <p className="text-xs text-slate-400">{getPropertyName(building.property_id)}</p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0 text-red-500 hover:text-red-600"
                      onClick={() => setDeleteTarget({ type: "building", record: building })}
                      title="Delete building"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                  <div className="grid grid-cols-4 gap-2 mb-3">
                    {[
                      { label: "SF", value: `${(((building.total_sf || building.total_sqft || 0) / 1000).toFixed(0))}K` },
                      { label: "Floors", value: building.floors || 1 },
                      { label: "Leased", value: leased },
                      { label: "Vacant", value: vacant },
                    ].map((metric, index) => (
                      <div key={index} className="bg-slate-50 rounded px-2 py-1.5 text-center">
                        <p className="text-[9px] font-bold text-slate-400 uppercase">{metric.label}</p>
                        <p className="text-sm font-bold text-slate-900">{metric.value}</p>
                      </div>
                    ))}
                  </div>
                  {buildingUnits.length > 0 && (
                    <div className="space-y-1 max-h-32 overflow-y-auto">
                      {buildingUnits.map((unit) => (
                        <div key={unit.id} className="flex items-center justify-between bg-slate-50 rounded-md px-2.5 py-1.5 gap-2">
                          <div className="flex items-center gap-2">
                            <DoorOpen className="w-3 h-3 text-slate-400" />
                            <span className="text-xs font-medium text-slate-700">
                              {unit.unit_number || unit.unit_id_code || unit.id?.substring(0, 8)}
                            </span>
                            <span className="text-[10px] text-slate-400">{unit.square_footage?.toLocaleString()} SF</span>
                          </div>
                          <div className="flex items-center gap-1">
                            <Badge
                              className={`text-[10px] ${
                                unit.occupancy_status === "leased"
                                  ? "bg-emerald-100 text-emerald-700"
                                  : unit.occupancy_status === "vacant"
                                    ? "bg-amber-100 text-amber-700"
                                    : "bg-slate-100 text-slate-600"
                              }`}
                            >
                              {unit.occupancy_status}
                            </Badge>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 w-6 p-0 text-red-500 hover:text-red-600"
                              onClick={() => setDeleteTarget({ type: "unit", record: unit })}
                              title="Delete unit"
                            >
                              <Trash2 className="w-3 h-3" />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {building.year_built && <p className="text-[10px] text-slate-400 mt-2">Built {building.year_built}</p>}
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : viewMode === "list" ? (
        <div className="space-y-2">
          {filteredBuildings.map((building) => {
            const buildingUnits = getBuildingUnits(building.id);
            const leased = buildingUnits.filter((unit) => unit.occupancy_status === "leased").length;

            return (
              <Card key={building.id} className="hover:shadow-md transition-all border-slate-200/80">
                <CardContent className="p-3 flex items-center gap-4">
                  <Checkbox
                    checked={selectedBuildingIds.includes(building.id)}
                    onCheckedChange={() => toggleBuildingSelection(building.id)}
                  />
                  <div className="w-10 h-10 bg-purple-100 rounded-lg flex items-center justify-center flex-shrink-0">
                    <Building2 className="w-5 h-5 text-purple-500" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-bold text-slate-900 truncate">{building.name}</h3>
                    <p className="text-xs text-slate-400 truncate">{getPropertyName(building.property_id)}</p>
                  </div>
                  <div className="hidden md:flex items-center gap-6 text-xs text-slate-600 flex-shrink-0">
                    <div className="text-center"><p className="font-bold text-sm">{(((building.total_sf || building.total_sqft || 0) / 1000).toFixed(0))}K</p><p className="text-slate-400">SF</p></div>
                    <div className="text-center"><p className="font-bold text-sm">{building.floors || 1}</p><p className="text-slate-400">Floors</p></div>
                    <div className="text-center"><p className="font-bold text-sm">{buildingUnits.length}</p><p className="text-slate-400">Units</p></div>
                    <div className="text-center"><p className="font-bold text-sm">{leased}</p><p className="text-slate-400">Leased</p></div>
                  </div>
                  {building.year_built && <span className="text-xs text-slate-400 flex-shrink-0">{building.year_built}</span>}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0 text-red-500 hover:text-red-600 flex-shrink-0"
                    onClick={() => setDeleteTarget({ type: "building", record: building })}
                    title="Delete building"
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                  <Link to={createPageUrl("PropertyDetail") + `?id=${building.property_id}`}>
                    <Button variant="outline" size="sm" className="flex-shrink-0 text-xs">
                      Property
                      <ChevronRight className="w-3 h-3 ml-1" />
                    </Button>
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
                <TableHead className="w-10">
                  <Checkbox
                    checked={allFilteredSelected}
                    onCheckedChange={toggleSelectAllFiltered}
                    aria-label="Select all filtered buildings"
                  />
                </TableHead>
                <TableHead className="text-xs font-bold tracking-wider">BUILDING</TableHead>
                <TableHead className="text-xs font-bold tracking-wider">PROPERTY</TableHead>
                <TableHead className="text-xs font-bold tracking-wider">SQ FT</TableHead>
                <TableHead className="text-xs font-bold tracking-wider">FLOORS</TableHead>
                <TableHead className="text-xs font-bold tracking-wider">YEAR BUILT</TableHead>
                <TableHead className="text-xs font-bold tracking-wider">UNITS</TableHead>
                <TableHead className="text-xs font-bold tracking-wider">LEASED</TableHead>
                <TableHead className="text-xs font-bold tracking-wider">VACANT</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredBuildings.map((building) => {
                const buildingUnits = getBuildingUnits(building.id);
                const leased = buildingUnits.filter((unit) => unit.occupancy_status === "leased").length;
                const vacant = buildingUnits.filter((unit) => unit.occupancy_status === "vacant").length;

                return (
                  <TableRow key={building.id} className="hover:bg-slate-50">
                    <TableCell>
                      <Checkbox
                        checked={selectedBuildingIds.includes(building.id)}
                        onCheckedChange={() => toggleBuildingSelection(building.id)}
                        aria-label={`Select ${building.name}`}
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 bg-purple-100 rounded-lg flex items-center justify-center">
                          <Building2 className="w-4 h-4 text-purple-500" />
                        </div>
                        <span className="text-sm font-semibold text-slate-900">{building.name}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-slate-600">{getPropertyName(building.property_id)}</TableCell>
                    <TableCell className="text-sm font-mono">{(building.total_sf || building.total_sqft || 0).toLocaleString()}</TableCell>
                    <TableCell className="text-sm">{building.floors || 1}</TableCell>
                    <TableCell className="text-sm">{building.year_built || "—"}</TableCell>
                    <TableCell className="text-sm font-medium">{buildingUnits.length}</TableCell>
                    <TableCell><Badge className="bg-emerald-100 text-emerald-700 text-xs">{leased}</Badge></TableCell>
                    <TableCell><Badge className="bg-amber-100 text-amber-700 text-xs">{vacant}</Badge></TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Link to={createPageUrl("PropertyDetail") + `?id=${building.property_id}`}>
                          <Button variant="outline" size="sm">View</Button>
                        </Link>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 text-red-500 hover:text-red-600"
                          onClick={() => setDeleteTarget({ type: "building", record: building })}
                          title="Delete building"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}

      <CreateBuildingModal
        isOpen={showCreateBuilding}
        onClose={() => setShowCreateBuilding(false)}
        properties={scopedProperties}
      />

      <CreateUnitModal
        isOpen={showCreateUnit}
        onClose={() => setShowCreateUnit(false)}
        buildings={scopedBuildings}
      />

      <BulkImportModal
        isOpen={showImport}
        onClose={() => setShowImport(false)}
        moduleType={importType}
      />

      <DeleteConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={`Delete ${deleteTarget?.type || "item"} "${deleteTarget?.record?.name || deleteTarget?.record?.unit_number || deleteTarget?.record?.unit_id_code || ""}"?`}
        description={
          deleteTarget?.type === "unit"
            ? "This will permanently remove the selected unit."
            : "This will permanently remove the selected building and may affect related units and reports."
        }
        loading={deleteMutation.isPending}
        onConfirm={() =>
          deleteTarget?.record?.id &&
          deleteMutation.mutate({ type: deleteTarget.type, id: deleteTarget.record.id })
        }
      />

      <DeleteConfirmDialog
        open={showBulkDelete}
        onOpenChange={setShowBulkDelete}
        title={`Delete ${selectedBuildingIds.length} selected building${selectedBuildingIds.length === 1 ? "" : "s"}?`}
        description="This will permanently remove all selected buildings and may affect related units and reports."
        confirmLabel="Delete Selected"
        loading={bulkDeleteMutation.isPending}
        onConfirm={() => bulkDeleteMutation.mutate(selectedBuildingIds)}
      />
    </div>
  );
}

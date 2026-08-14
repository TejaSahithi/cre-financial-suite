import React from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Building2, Home, Layers } from "lucide-react";

export default function ScopeSelector({
  portfolios = [],
  properties = [],
  buildings = [],
  units = [],
  selectedPortfolio,
  selectedProperty,
  selectedBuilding,
  selectedUnit,
  onPortfolioChange,
  onPropertyChange,
  onBuildingChange,
  onUnitChange,
  showUnit = true,
  syncToUrl = false,
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const urlScope = new URLSearchParams(location.search);
  const selectedPropertyRecord = selectedProperty && selectedProperty !== "all"
    ? properties.find((property) => property.id === selectedProperty)
    : null;
  const activePortfolio = selectedPortfolio || urlScope.get("portfolio") || selectedPropertyRecord?.portfolio_id || "all";
  const filteredProperties = activePortfolio && activePortfolio !== "all"
    ? properties.filter((p) => p.portfolio_id === activePortfolio)
    : properties;
  const filteredPropertyIds = new Set(filteredProperties.map((p) => p.id));
  const filteredBuildings = selectedProperty && selectedProperty !== "all"
    ? buildings.filter((b) => b.property_id === selectedProperty)
    : activePortfolio && activePortfolio !== "all"
    ? buildings.filter((b) => filteredPropertyIds.has(b.property_id))
    : buildings;
  
  const filteredUnits = selectedBuilding && selectedBuilding !== "all"
    ? units.filter(u => u.building_id === selectedBuilding)
    : selectedProperty && selectedProperty !== "all"
    ? units.filter(u => u.property_id === selectedProperty)
    : activePortfolio && activePortfolio !== "all"
    ? units.filter((u) => filteredPropertyIds.has(u.property_id))
    : units;

  const visibleUnits = filteredUnits;

  const getUnitLabel = (unit) =>
    unit.unit_number ||
    unit.unit_id_code ||
    unit.name ||
    unit.suite ||
    (unit.id ? `Unit ${String(unit.id).slice(0, 8)}` : "Unnamed Unit");

  const showPortfolioSelector = portfolios.length > 0;
  const showBuildingSelector = Boolean(onBuildingChange);
  const showUnitSelector = showUnit && Boolean(onUnitChange);
  const propertyPlaceholder = filteredProperties.length > 0 ? "All Properties" : "No Properties Available";
  const buildingPlaceholder = filteredBuildings.length > 0 ? "All Buildings" : "No Buildings Available";
  const unitPlaceholder = visibleUnits.length > 0 ? "All Units" : "No Units Available";
  const updateUrlScope = ({ portfolio = activePortfolio, property = selectedProperty, building = selectedBuilding, unit = selectedUnit }) => {
    if (!syncToUrl) return;
    const params = new URLSearchParams(location.search);
    if (portfolio && portfolio !== "all") params.set("portfolio", portfolio);
    else params.delete("portfolio");
    if (property && property !== "all") params.set("property", property);
    else params.delete("property");
    if (building && building !== "all") params.set("building", building);
    else params.delete("building");
    if (unit && unit !== "all") params.set("unit", unit);
    else params.delete("unit");
    navigate({ pathname: location.pathname, search: params.toString() ? `?${params.toString()}` : "" }, { replace: true });
  };

  return (
    <div className="flex items-center gap-2 flex-wrap bg-white border border-slate-200 rounded-xl p-2">
      <div className="flex items-center gap-1.5 text-xs font-bold text-slate-400 uppercase tracking-wider px-2">
        <Layers className="w-4 h-4" /> Scope
      </div>

      {showPortfolioSelector && (
        <Select
          value={activePortfolio}
          onValueChange={(v) => {
            if (onPortfolioChange) onPortfolioChange(v);
            if (onPropertyChange) onPropertyChange("all");
            if (onBuildingChange) onBuildingChange("all");
            if (onUnitChange) onUnitChange("all");
            updateUrlScope({ portfolio: v, property: "all", building: "all", unit: "all" });
          }}
        >
          <SelectTrigger className="w-48 h-9 text-sm border-slate-200 bg-slate-50">
            <Layers className="w-3 h-3 mr-1.5 text-blue-500 flex-shrink-0" />
            <SelectValue placeholder="All Portfolios" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Portfolios</SelectItem>
            {portfolios.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
          </SelectContent>
        </Select>
      )}
      
      <Select
        value={selectedProperty || "all"}
        disabled={filteredProperties.length === 0}
        onValueChange={(v) => {
          onPropertyChange(v);
          if (onBuildingChange) onBuildingChange("all");
          if (onUnitChange) onUnitChange("all");
          updateUrlScope({ property: v, building: "all", unit: "all" });
        }}
      >
        <SelectTrigger className="w-48 h-9 text-sm border-slate-200 bg-slate-50">
          <Home className="w-3 h-3 mr-1.5 text-blue-500 flex-shrink-0" />
          <SelectValue placeholder={propertyPlaceholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Properties</SelectItem>
          {filteredProperties.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
        </SelectContent>
      </Select>

      {showBuildingSelector && (
        <Select
          value={selectedBuilding || "all"}
          disabled={filteredBuildings.length === 0}
          onValueChange={(v) => {
            if (onBuildingChange) onBuildingChange(v);
            if (onUnitChange) onUnitChange("all");
            updateUrlScope({ building: v, unit: "all" });
          }}
        >
          <SelectTrigger className="w-44 h-9 text-sm border-slate-200 bg-slate-50">
            <Building2 className="w-3.5 h-3.5 mr-1.5 text-blue-500 flex-shrink-0" />
            <SelectValue placeholder={buildingPlaceholder} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Buildings</SelectItem>
            {filteredBuildings.map(b => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
          </SelectContent>
        </Select>
      )}

      {showUnitSelector && (
        <Select
          value={selectedUnit || "all"}
          disabled={visibleUnits.length === 0}
          onValueChange={(v) => {
            if (onUnitChange) onUnitChange(v);
            updateUrlScope({ unit: v });
          }}
        >
          <SelectTrigger className="w-40 h-9 text-sm border-slate-200 bg-slate-50">
            <SelectValue placeholder={unitPlaceholder} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Units</SelectItem>
            {visibleUnits.map(u => <SelectItem key={u.id} value={u.id}>{getUnitLabel(u)}</SelectItem>)}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

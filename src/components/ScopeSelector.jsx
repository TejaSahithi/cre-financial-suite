import React from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Building2, Home, Layers } from "lucide-react";

export default function ScopeSelector({ properties, buildings, units, selectedProperty, selectedBuilding, selectedUnit, onPropertyChange, onBuildingChange, onUnitChange, showUnit = true }) {
  const filteredBuildings = selectedProperty && selectedProperty !== "all" 
    ? buildings.filter(b => b.property_id === selectedProperty)
    : buildings;
  
  const filteredUnits = selectedBuilding && selectedBuilding !== "all"
    ? units.filter(u => u.building_id === selectedBuilding)
    : selectedProperty && selectedProperty !== "all"
    ? units.filter(u => u.property_id === selectedProperty)
    : units;

  return (
    <div className="flex items-center gap-2 flex-wrap bg-white border border-slate-200 rounded-xl p-2">
      <div className="flex items-center gap-1.5 text-xs font-bold text-slate-400 uppercase tracking-wider px-2">
        <Layers className="w-4 h-4" /> Scope
      </div>
      
      <Select value={selectedProperty || "all"} onValueChange={(v) => { onPropertyChange(v); if (onBuildingChange) onBuildingChange("all"); if (onUnitChange) onUnitChange("all"); }}>
        <SelectTrigger className="w-48 h-9 text-sm border-slate-200 bg-slate-50">
          <Home className="w-3 h-3 mr-1.5 text-blue-500 flex-shrink-0" />
          <SelectValue placeholder="All Properties" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Properties</SelectItem>
          {properties.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
        </SelectContent>
      </Select>

      {selectedProperty && selectedProperty !== "all" && filteredBuildings.length > 0 && (
        <Select value={selectedBuilding || "all"} onValueChange={(v) => { if (onBuildingChange) onBuildingChange(v); if (onUnitChange) onUnitChange("all"); }}>
          <SelectTrigger className="w-44 h-9 text-sm border-slate-200 bg-slate-50">
            <Building2 className="w-3.5 h-3.5 mr-1.5 text-purple-500 flex-shrink-0" />
            <SelectValue placeholder="All Buildings" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Buildings</SelectItem>
            {filteredBuildings.map(b => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
          </SelectContent>
        </Select>
      )}

      {showUnit && selectedBuilding && selectedBuilding !== "all" && filteredUnits.length > 0 && (
        <Select value={selectedUnit || "all"} onValueChange={(v) => { if (onUnitChange) onUnitChange(v); }}>
          <SelectTrigger className="w-40 h-9 text-sm border-slate-200 bg-slate-50">
            <SelectValue placeholder="All Units" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Units</SelectItem>
            {filteredUnits.map(u => <SelectItem key={u.id} value={u.id}>{u.unit_id_code}</SelectItem>)}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}
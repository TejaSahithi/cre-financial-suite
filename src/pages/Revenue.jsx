import React, { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "react-router-dom";
import { Loader2, TrendingUp, Plus, Download, Upload } from "lucide-react";

import PipelineActions, { REVENUE_ACTIONS } from "@/components/PipelineActions";
import PageHeader from "@/components/PageHeader";
import BulkImportModal from "@/components/property/BulkImportModal";
import ScopeSelector from "@/components/ScopeSelector";
import RevenueKPIStrip from "@/components/revenue/RevenueKPIStrip";
import MonthlyRevenueTrend from "@/components/revenue/MonthlyRevenueTrend";
import PropertyRevenueTable from "@/components/revenue/PropertyRevenueTable";
import PropertyContributionChart from "@/components/revenue/PropertyContributionChart";
import TenantRevenueDistribution from "@/components/revenue/TenantRevenueDistribution";
import PropertyDrillDown from "@/components/revenue/PropertyDrillDown";
import TenantDrillDown from "@/components/revenue/TenantDrillDown";
import { PropertyService, LeaseService, CAMCalculationService, UnitService, BuildingService } from "@/services/api";
import { buildHierarchyScope, getScopeSubtitle, matchesHierarchyScope } from "@/lib/hierarchyScope";
import { Button } from "@/components/ui/button";
import { downloadCSV, createPageUrl } from "@/utils";

export default function Revenue() {
  const location = useLocation();
  const [selectedProperty, setSelectedProperty] = useState(null);
  const [selectedTenant, setSelectedTenant] = useState(null);
  const [showImport, setShowImport] = useState(false);
  const [scopeProperty, setScopeProperty] = useState("all");
  const [scopeBuilding, setScopeBuilding] = useState("all");
  const [scopeUnit, setScopeUnit] = useState("all");

  const { data: properties = [], isLoading: loadingProps } = useQuery({
    queryKey: ["revenue-properties"],
    queryFn: () => PropertyService.list(),
  });
  const { data: leases = [], isLoading: loadingLeases } = useQuery({
    queryKey: ["revenue-leases"],
    queryFn: () => LeaseService.list(),
  });
  const { data: camCalcs = [] } = useQuery({
    queryKey: ["revenue-cam"],
    queryFn: () => CAMCalculationService.list(),
  });
  const { data: buildings = [] } = useQuery({
    queryKey: ["revenue-buildings"],
    queryFn: () => BuildingService.list(),
  });
  const { data: units = [] } = useQuery({
    queryKey: ["revenue-units"],
    queryFn: () => UnitService.list(),
  });
  const { data: portfolios = [] } = useQuery({
    queryKey: ["revenue-portfolios"],
    queryFn: () => PropertyService.list().then(() => []),
    initialData: [],
  });

  const scope = useMemo(
    () =>
      buildHierarchyScope({
        search: location.search,
        portfolios,
        properties,
        buildings,
        units,
      }),
    [location.search, portfolios, properties, buildings, units]
  );

  useEffect(() => {
    setScopeProperty(scope.propertyId || "all");
    setScopeBuilding(scope.buildingId || "all");
    setScopeUnit(scope.unitId || "all");
  }, [scope.propertyId, scope.buildingId, scope.unitId]);

  const isLoading = loadingProps || loadingLeases;

  const activeLeases = leases.filter((lease) => {
    if (lease.status === "expired") return false;
    if (!matchesHierarchyScope(lease, scope, { propertyKey: "property_id", unitKey: "unit_id" })) return false;

    const unit = lease.unit_id ? scope.unitById.get(lease.unit_id) ?? null : null;
    const buildingId = unit?.building_id || null;
    if (scopeProperty !== "all" && lease.property_id !== scopeProperty) return false;
    if (scopeBuilding !== "all" && buildingId !== scopeBuilding) return false;
    if (scopeUnit !== "all" && lease.unit_id !== scopeUnit) return false;
    return true;
  });

  const scopedCamCalcs = camCalcs.filter((calc) => {
    if (!matchesHierarchyScope(calc, scope, { propertyKey: "property_id" })) return false;
    if (scopeProperty !== "all" && calc.property_id !== scopeProperty) return false;
    return true;
  });

  const visibleProperties = scope.scopedProperties.filter((property) => (scopeProperty === "all" ? true : property.id === scopeProperty));
  const visibleBuildings = scope.scopedBuildings.filter((building) => {
    if (scopeProperty !== "all" && building.property_id !== scopeProperty) return false;
    return scopeBuilding === "all" ? true : building.id === scopeBuilding;
  });
  const visibleUnits = scope.scopedUnits.filter((unit) => {
    if (scopeProperty !== "all" && unit.property_id !== scopeProperty) return false;
    if (scopeBuilding !== "all" && unit.building_id !== scopeBuilding) return false;
    return scopeUnit === "all" ? true : unit.id === scopeUnit;
  });

  const totalBaseRent = activeLeases.reduce((sum, lease) => sum + (lease.annual_rent || lease.base_rent * 12 || 0), 0);
  const totalCamRecovery = scopedCamCalcs.reduce((sum, calc) => sum + (calc.annual_cam || 0), 0);
  const otherIncome = 0;
  const totalRevenue = totalBaseRent + totalCamRecovery + otherIncome;
  const priorYearRevenue = totalRevenue * 0.92;
  const yoyGrowth = priorYearRevenue > 0 ? ((totalRevenue - priorYearRevenue) / priorYearRevenue) * 100 : 0;

  const propertyData = visibleProperties
    .map((property) => {
      const propertyLeases = activeLeases.filter((lease) => lease.property_id === property.id);
      const propertyCamCalcs = scopedCamCalcs.filter((calc) => calc.property_id === property.id);
      const baseRent = propertyLeases.reduce((sum, lease) => sum + (lease.annual_rent || lease.base_rent * 12 || 0), 0);
      const camRevenue = propertyCamCalcs.reduce((sum, calc) => sum + (calc.annual_cam || 0), 0);
      const totalPropertyRevenue = baseRent + camRevenue;
      const priorRevenue = totalPropertyRevenue * 0.92;

      return {
        ...property,
        baseRent,
        camRevenue,
        otherIncome: 0,
        totalRevenue: totalPropertyRevenue,
        yoyChange: priorRevenue > 0 ? ((totalPropertyRevenue - priorRevenue) / priorRevenue) * 100 : null,
      };
    })
    .filter((property) => property.totalRevenue > 0 || activeLeases.some((lease) => lease.property_id === property.id));

  const tenantMap = {};
  activeLeases.forEach((lease) => {
    const key = lease.tenant_name || "Unknown";
    if (!tenantMap[key]) {
      tenantMap[key] = { name: key, rent: 0, cam: 0, totalRevenue: 0, leaseType: lease.lease_type };
    }
    tenantMap[key].rent += lease.annual_rent || lease.base_rent * 12 || 0;
    const tenantCam = scopedCamCalcs.filter((calc) => calc.lease_id === lease.id).reduce((sum, calc) => sum + (calc.annual_cam || 0), 0);
    tenantMap[key].cam += tenantCam;
    tenantMap[key].totalRevenue = tenantMap[key].rent + tenantMap[key].cam;
  });
  const tenantData = Object.values(tenantMap);

  const selectedPropertyId = scopeProperty !== "all" ? scopeProperty : scope.propertyId || null;

  const subtitleScope = getScopeSubtitle(scope, {
    default: "Portfolio revenue breakdown, property drill-down, and tenant analysis",
    portfolio: (portfolio) => `Revenue analytics for ${portfolio.name}`,
    property: (property) => `Revenue analytics for ${property.name}`,
    building: (building) => `Revenue analytics for ${building.name}`,
    unit: (unit) => `Revenue analytics for ${unit.unit_number || unit.unit_id_code || "selected unit"}`,
    org: () => "Revenue analytics for selected organization",
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
      </div>
    );
  }

  if (selectedProperty) {
    return (
      <div className="p-6">
        <PropertyDrillDown
          property={selectedProperty}
          leases={activeLeases}
          camCalcs={scopedCamCalcs}
          buildings={visibleBuildings}
          units={visibleUnits}
          onBack={() => setSelectedProperty(null)}
        />
      </div>
    );
  }

  if (selectedTenant) {
    return (
      <div className="p-6">
        <TenantDrillDown
          tenant={selectedTenant}
          leases={activeLeases}
          camCalcs={scopedCamCalcs}
          propertyName={scope.activeProperty?.name || scope.activePortfolio?.name || "Revenue"}
          onBack={() => setSelectedTenant(null)}
        />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <BulkImportModal isOpen={showImport} onClose={() => setShowImport(false)} moduleType="revenue" propertyId={selectedPropertyId || undefined} buildingId={scopeBuilding !== "all" ? scopeBuilding : undefined} />

      <PageHeader icon={TrendingUp} title="Revenue Analytics" subtitle={subtitleScope} iconColor="from-emerald-500 to-emerald-700">
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => downloadCSV(propertyData, "revenue.csv")}>
            <Download className="w-4 h-4 mr-1 text-slate-500" />
            Export
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowImport(true)}>
            <Upload className="w-4 h-4 mr-1" />
            Import
          </Button>
          <Link to={createPageUrl("BulkImport") + location.search}>
            <Button size="sm" className="bg-gradient-to-r from-emerald-600 to-emerald-700 shadow-sm">
              <Plus className="w-4 h-4 mr-1" />
              Add Revenue
            </Button>
          </Link>
        </div>
      </PageHeader>

      {selectedPropertyId ? (
        <PipelineActions propertyId={selectedPropertyId} fiscalYear={new Date().getFullYear()} actions={REVENUE_ACTIONS} />
      ) : (
        <div className="text-xs text-slate-500">Select a property scope to run revenue compute/export actions.</div>
      )}

      <ScopeSelector
        properties={scope.scopedProperties}
        buildings={scope.scopedBuildings}
        units={scope.scopedUnits}
        selectedProperty={scopeProperty}
        selectedBuilding={scopeBuilding}
        selectedUnit={scopeUnit}
        onPropertyChange={setScopeProperty}
        onBuildingChange={setScopeBuilding}
        onUnitChange={setScopeUnit}
      />

      <RevenueKPIStrip totalRevenue={totalRevenue} baseRent={totalBaseRent} camRecovery={totalCamRecovery} otherIncome={otherIncome} yoyGrowth={yoyGrowth} />

      <div className="grid lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2">
          <MonthlyRevenueTrend leases={activeLeases} camCalcs={scopedCamCalcs} />
        </div>
        <TenantRevenueDistribution tenantData={tenantData} onSelectTenant={setSelectedTenant} />
      </div>

      <div className="grid lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2">
          <PropertyRevenueTable propertyData={propertyData} onSelectProperty={setSelectedProperty} />
        </div>
        <PropertyContributionChart propertyData={propertyData} onSelectProperty={setSelectedProperty} />
      </div>
    </div>
  );
}

import React, { useState } from "react";
import { PropertyService, LeaseService, CAMCalculationService, UnitService, BuildingService } from "@/services/api";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import RevenueKPIStrip from "@/components/revenue/RevenueKPIStrip";
import MonthlyRevenueTrend from "@/components/revenue/MonthlyRevenueTrend";
import PropertyRevenueTable from "@/components/revenue/PropertyRevenueTable";
import PropertyContributionChart from "@/components/revenue/PropertyContributionChart";
import TenantRevenueDistribution from "@/components/revenue/TenantRevenueDistribution";
import PropertyDrillDown from "@/components/revenue/PropertyDrillDown";
import TenantDrillDown from "@/components/revenue/TenantDrillDown";

export default function Revenue() {
  const [selectedProperty, setSelectedProperty] = useState(null);
  const [selectedTenant, setSelectedTenant] = useState(null);

  const { data: properties = [], isLoading: loadingProps } = useQuery({
    queryKey: ['revenue-properties'],
    queryFn: () => PropertyService.list(),
  });
  const { data: leases = [], isLoading: loadingLeases } = useQuery({
    queryKey: ['revenue-leases'],
    queryFn: () => LeaseService.list(),
  });
  const { data: camCalcs = [] } = useQuery({
    queryKey: ['revenue-cam'],
    queryFn: () => CAMCalculationService.list(),
  });
  const { data: buildings = [] } = useQuery({
    queryKey: ['revenue-buildings'],
    queryFn: () => BuildingService.list(),
  });
  const { data: units = [] } = useQuery({
    queryKey: ['revenue-units'],
    queryFn: () => UnitService.list(),
  });

  const isLoading = loadingProps || loadingLeases;

  // Compute portfolio-level metrics
  const activeLeases = leases.filter(l => l.status !== 'expired');
  const totalBaseRent = activeLeases.reduce((s, l) => s + (l.annual_rent || l.base_rent * 12 || 0), 0);
  const totalCamRecovery = camCalcs.reduce((s, c) => s + (c.annual_cam || 0), 0);
  const otherIncome = 0;
  const totalRevenue = totalBaseRent + totalCamRecovery + otherIncome;

  // Simulate YoY (prior year = ~92% of current as baseline)
  const priorYearRevenue = totalRevenue * 0.92;
  const yoyGrowth = priorYearRevenue > 0 ? ((totalRevenue - priorYearRevenue) / priorYearRevenue) * 100 : 0;

  // Build property-level data
  const propertyData = properties.map(p => {
    const pLeases = activeLeases.filter(l => l.property_id === p.id);
    const pCams = camCalcs.filter(c => c.property_id === p.id);
    const baseRent = pLeases.reduce((s, l) => s + (l.annual_rent || l.base_rent * 12 || 0), 0);
    const camRevenue = pCams.reduce((s, c) => s + (c.annual_cam || 0), 0);
    const totalRev = baseRent + camRevenue;
    const priorRev = totalRev * (0.85 + Math.random() * 0.2); // simulated prior year
    return {
      ...p,
      baseRent,
      camRevenue,
      otherIncome: 0,
      totalRevenue: totalRev,
      yoyChange: priorRev > 0 ? ((totalRev - priorRev) / priorRev) * 100 : null,
    };
  }).filter(p => p.totalRevenue > 0 || activeLeases.some(l => l.property_id === p.id));

  // Build tenant-level data for global view
  const tenantMap = {};
  activeLeases.forEach(l => {
    const key = l.tenant_name || 'Unknown';
    if (!tenantMap[key]) tenantMap[key] = { name: key, rent: 0, cam: 0, totalRevenue: 0, leaseType: l.lease_type };
    tenantMap[key].rent += (l.annual_rent || l.base_rent * 12 || 0);
    const tc = camCalcs.filter(c => c.lease_id === l.id).reduce((s, c) => s + (c.annual_cam || 0), 0);
    tenantMap[key].cam += tc;
    tenantMap[key].totalRevenue = tenantMap[key].rent + tenantMap[key].cam;
  });
  const tenantData = Object.values(tenantMap);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
      </div>
    );
  }

  // Property drill-down view
  if (selectedProperty) {
    return (
      <div className="p-6">
        <PropertyDrillDown
          property={selectedProperty}
          leases={leases}
          camCalcs={camCalcs}
          buildings={buildings}
          units={units}
          onBack={() => setSelectedProperty(null)}
        />
      </div>
    );
  }

  // Tenant drill-down from global view
  if (selectedTenant) {
    return (
      <div className="p-6">
        <TenantDrillDown
          tenant={selectedTenant}
          leases={activeLeases}
          camCalcs={camCalcs}
          propertyName="Portfolio"
          onBack={() => setSelectedTenant(null)}
        />
      </div>
    );
  }

  // Global portfolio view
  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Revenue Analytics</h1>
        <p className="text-sm text-slate-500">Portfolio revenue breakdown, property drill-down, and tenant analysis</p>
      </div>

      {/* KPI Strip */}
      <RevenueKPIStrip
        totalRevenue={totalRevenue}
        baseRent={totalBaseRent}
        camRecovery={totalCamRecovery}
        otherIncome={otherIncome}
        yoyGrowth={yoyGrowth}
      />

      {/* Charts row */}
      <div className="grid lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2">
          <MonthlyRevenueTrend leases={activeLeases} camCalcs={camCalcs} />
        </div>
        <TenantRevenueDistribution tenantData={tenantData} onSelectTenant={setSelectedTenant} />
      </div>

      {/* Property table + contribution chart */}
      <div className="grid lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2">
          <PropertyRevenueTable propertyData={propertyData} onSelectProperty={setSelectedProperty} />
        </div>
        <PropertyContributionChart propertyData={propertyData} onSelectProperty={setSelectedProperty} />
      </div>
    </div>
  );
}
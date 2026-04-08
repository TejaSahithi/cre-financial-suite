import React, { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { differenceInDays } from "date-fns";
import { Upload, Search, Loader2, Download, Plus, FileText } from "lucide-react";

import PipelineActions, { LEASE_ACTIONS } from "@/components/PipelineActions";
import PageHeader from "@/components/PageHeader";
import BulkImportModal from "@/components/property/BulkImportModal";
import ScopeSelector from "@/components/ScopeSelector";
import useOrgQuery from "@/hooks/useOrgQuery";
import { buildHierarchyScope, getScopeSubtitle, matchesHierarchyScope } from "@/lib/hierarchyScope";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { createPageUrl, downloadCSV } from "@/utils";

export default function Leases() {
  const location = useLocation();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [showImport, setShowImport] = useState(false);
  const [scopeProperty, setScopeProperty] = useState("all");
  const [scopeBuilding, setScopeBuilding] = useState("all");
  const [scopeUnit, setScopeUnit] = useState("all");

  const { data: leases = [], isLoading } = useOrgQuery("Lease");
  const { data: units = [] } = useOrgQuery("Unit");
  const { data: buildings = [] } = useOrgQuery("Building");
  const { data: properties = [] } = useOrgQuery("Property");
  const { data: portfolios = [] } = useOrgQuery("Portfolio");

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

  const statusColors = {
    expired: "bg-red-100 text-red-700",
    new: "bg-slate-100 text-slate-600",
  };

  const getStatusColor = (status) => statusColors[status] || "bg-slate-100 text-slate-600";

  const scopedLeases = leases.filter((lease) =>
    matchesHierarchyScope(lease, scope, {
      propertyKey: "property_id",
      unitKey: "unit_id",
    })
  );

  const selectorFilteredLeases = scopedLeases.filter((lease) => {
    const unit = lease.unit_id ? scope.unitById.get(lease.unit_id) ?? null : null;
    const buildingId = unit?.building_id || null;

    if (scopeProperty !== "all" && lease.property_id !== scopeProperty) return false;
    if (scopeBuilding !== "all" && buildingId !== scopeBuilding) return false;
    if (scopeUnit !== "all" && lease.unit_id !== scopeUnit) return false;
    return true;
  });

  const filtered = selectorFilteredLeases.filter((lease) => {
    const unit = lease.unit_id ? scope.unitById.get(lease.unit_id) ?? null : null;
    const building = unit?.building_id ? scope.buildingById.get(unit.building_id) ?? null : null;
    const property = lease.property_id ? scope.propertyById.get(lease.property_id) ?? null : null;

    const matchSearch =
      !search ||
      [
        lease.tenant_name,
        lease.lease_type,
        lease.unit_number,
        lease.unit_id_code,
        unit?.unit_number,
        building?.name,
        property?.name,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(search.toLowerCase()));

    const matchFilter = filter === "all" || lease.status === filter;
    return matchSearch && matchFilter;
  });

  const selectedPropertyId = scopeProperty !== "all" ? scopeProperty : scope.propertyId || null;

  const statusCounts = {
    budget_ready: selectorFilteredLeases.filter((lease) => lease.status === "budget_ready").length,
    validated: selectorFilteredLeases.filter((lease) => lease.status === "validated").length,
    draft: selectorFilteredLeases.filter((lease) => lease.status === "draft").length,
    expiring: selectorFilteredLeases.filter((lease) => {
      if (!lease.end_date) return false;
      const days = differenceInDays(new Date(lease.end_date), new Date());
      return days < 180 && days > 0;
    }).length,
  };

  const subtitleScope = getScopeSubtitle(scope, {
    default: `${filtered.length} lease records · OCR extraction and abstraction pipeline`,
    portfolio: (portfolio) => `${filtered.length} lease records in ${portfolio.name}`,
    property: (property) => `${filtered.length} lease records for ${property.name}`,
    building: (building) => `${filtered.length} lease records for ${building.name}`,
    unit: (unit) => `${filtered.length} lease records for ${unit.unit_number || unit.unit_id_code || "selected unit"}`,
    org: () => `${filtered.length} lease records in selected organization`,
  });

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        icon={FileText}
        title="Leases"
        subtitle={subtitleScope}
        iconColor="from-blue-600 to-indigo-700"
      >
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => downloadCSV(filtered, "leases.csv")}>
            <Download className="w-4 h-4 mr-1 text-slate-500" />
            Export
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowImport(true)}>
            <Upload className="w-4 h-4 mr-1" />
            Bulk Import
          </Button>
          <Link
            to={
              createPageUrl("LeaseUpload") +
              location.search
            }
          >
            <Button size="sm" className="bg-[#1a2744] hover:bg-[#243b67] shadow-sm">
              <Plus className="w-4 h-4 mr-2" />
              Upload Lease
            </Button>
          </Link>
        </div>
      </PageHeader>

      {selectedPropertyId ? (
        <PipelineActions propertyId={selectedPropertyId} fiscalYear={new Date().getFullYear()} actions={LEASE_ACTIONS} />
      ) : (
        <div className="text-xs text-slate-500">Select a property scope to run lease compute/export actions.</div>
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

      <div className="grid grid-cols-4 gap-4">
        {[
          { label: "Budget-Ready", count: statusCounts.budget_ready, color: "border-l-emerald-500 bg-emerald-50" },
          { label: "Validated", count: statusCounts.validated, color: "border-l-amber-500 bg-amber-50" },
          { label: "Draft", count: statusCounts.draft, color: "border-l-slate-400 bg-slate-50" },
          { label: "Expiring < 6mo", count: statusCounts.expiring, color: "border-l-red-500 bg-red-50" },
        ].map((statusCard) => (
          <Card key={statusCard.label} className={`border-l-4 ${statusCard.color}`}>
            <CardContent className="p-4">
              <p className="text-2xl font-bold text-slate-900">{statusCard.count}</p>
              <p className="text-xs font-medium text-slate-500">{statusCard.label}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="flex gap-3 items-center">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input placeholder="Search tenant..." className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="flex gap-1">
          {["all", "budget_ready", "validated", "draft", "expired"].map((value) => (
            <Button
              key={value}
              variant={filter === value ? "default" : "outline"}
              size="sm"
              onClick={() => setFilter(value)}
              className={`text-xs capitalize ${filter === value ? "bg-blue-600" : ""}`}
            >
              {value === "all" ? "All" : value.replace("_", "-")}
            </Button>
          ))}
        </div>
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow className="bg-slate-50">
              <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Tenant</TableHead>
              <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Property</TableHead>
              <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Building</TableHead>
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
              <TableRow>
                <TableCell colSpan={13} className="text-center py-12">
                  <Loader2 className="w-5 h-5 animate-spin mx-auto text-slate-400" />
                </TableCell>
              </TableRow>
            ) : filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={13} className="text-center py-12 text-sm text-slate-400">
                  No leases found
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((lease) => {
                const daysLeft = lease.end_date ? differenceInDays(new Date(lease.end_date), new Date()) : null;
                const unit = lease.unit_id ? scope.unitById.get(lease.unit_id) ?? null : null;
                const building = unit?.building_id ? scope.buildingById.get(unit.building_id) ?? null : null;
                const property = lease.property_id ? scope.propertyById.get(lease.property_id) ?? null : null;
                const annualRent = Number(lease.annual_rent || Number(lease.monthly_rent || 0) * 12 || 0);
                const leasedSf = Number(lease.total_sf || lease.square_footage || 0);
                const rentPerSf = Number(lease.rent_per_sf || (annualRent > 0 && leasedSf > 0 ? annualRent / leasedSf : 0));
                const unitLabel =
                  lease.unit_number ||
                  unit?.unit_number ||
                  lease.unit_id_code ||
                  unit?.unit_id_code ||
                  (lease.unit_id && lease.unit_id.length > 8 ? lease.unit_id.substring(0, 8) : lease.unit_id) ||
                  "—";

                return (
                  <TableRow key={lease.id} className="hover:bg-slate-50">
                    <TableCell className="text-sm font-medium text-slate-900">{lease.tenant_name || "—"}</TableCell>
                    <TableCell className="text-sm text-slate-600">{property?.name || "—"}</TableCell>
                    <TableCell className="text-sm text-slate-600">{building?.name || "—"}</TableCell>
                    <TableCell className="text-sm text-slate-600">{unitLabel}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-[10px]">
                        {lease.lease_type || "—"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm">{lease.start_date || "—"}</TableCell>
                    <TableCell className="text-sm">
                      <span className={daysLeft && daysLeft < 180 ? "text-red-600 font-medium" : ""}>
                        {lease.end_date || "—"}
                      </span>
                      {daysLeft && daysLeft < 365 && daysLeft > 0 && (
                        <span className="block text-[10px] text-red-500">{daysLeft}d remaining</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm font-mono">{rentPerSf > 0 ? `$${rentPerSf.toFixed(2)}` : "—"}</TableCell>
                    <TableCell className="text-sm font-mono">{annualRent > 0 ? `$${annualRent.toLocaleString()}` : "—"}</TableCell>
                    <TableCell className="text-sm font-mono">
                      ${Number(lease.cam_amount || lease.cam_per_month || 0).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <Badge className={`${getStatusColor(lease.status)} text-[10px] uppercase whitespace-nowrap`}>
                        {lease.status?.replace("_", "-") || "NEW"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {lease.confidence_score ? (
                        <div className="flex items-center gap-1.5">
                          <div
                            className={`w-2 h-2 rounded-full ${
                              lease.confidence_score >= 90
                                ? "bg-emerald-500"
                                : lease.confidence_score >= 75
                                  ? "bg-amber-500"
                                  : "bg-red-500"
                            }`}
                          />
                          <span className="text-xs">{lease.confidence_score}%</span>
                        </div>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Link to={createPageUrl("LeaseReview") + `?id=${lease.id}`}>
                          <Button variant="ghost" size="sm" className="text-xs h-7 px-2">
                            View
                          </Button>
                        </Link>
                        <Link to={createPageUrl("LeaseReview") + `?id=${lease.id}`}>
                          <Button variant="ghost" size="sm" className="text-xs h-7 px-2">
                            Edit
                          </Button>
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

      <BulkImportModal isOpen={showImport} onClose={() => setShowImport(false)} moduleType="lease" propertyId={selectedPropertyId || undefined} buildingId={scopeBuilding !== "all" ? scopeBuilding : undefined} />
    </div>
  );
}

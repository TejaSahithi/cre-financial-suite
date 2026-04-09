function asNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function unitSqft(unit) {
  return asNumber(unit?.square_footage ?? unit?.square_feet);
}

function leaseSqft(lease) {
  return asNumber(lease?.leased_sqft ?? lease?.square_footage ?? lease?.total_sf);
}

function leaseOverlapsFiscalYear(lease, fiscalYear) {
  const status = String(lease?.status || "active").toLowerCase();
  if (status === "expired") return false;

  const yearStart = new Date(Date.UTC(fiscalYear, 0, 1));
  const yearEnd = new Date(Date.UTC(fiscalYear, 11, 31));
  const start = lease?.start_date ? new Date(`${lease.start_date}T00:00:00Z`) : null;
  const end = lease?.end_date ? new Date(`${lease.end_date}T00:00:00Z`) : null;

  if (start && Number.isNaN(start.getTime())) return false;
  if (end && Number.isNaN(end.getTime())) return false;

  const effectiveStart = start && start > yearStart ? start : yearStart;
  const effectiveEnd = end && end < yearEnd ? end : yearEnd;
  return effectiveEnd >= effectiveStart;
}

export function getCamScopeContext({
  properties = [],
  buildings = [],
  units = [],
  leases = [],
  expenses = [],
  scopeProperty = "all",
  scopeBuilding = "all",
  scopeUnit = "all",
  fiscalYear,
}) {
  const selectedProperty = scopeProperty !== "all"
    ? properties.find((item) => item.id === scopeProperty) ?? null
    : null;
  const selectedBuilding = scopeBuilding !== "all"
    ? buildings.find((item) => item.id === scopeBuilding) ?? null
    : null;
  const selectedUnit = scopeUnit !== "all"
    ? units.find((item) => item.id === scopeUnit) ?? null
    : null;

  const targetPropertyId = selectedProperty?.id ?? selectedBuilding?.property_id ?? selectedUnit?.property_id ?? null;
  const targetScopeLevel = selectedUnit
    ? "unit"
    : selectedBuilding
    ? "building"
    : selectedProperty
    ? "property"
    : null;
  const targetScopeId = selectedUnit?.id ?? selectedBuilding?.id ?? selectedProperty?.id ?? null;

  const buildingUnits = selectedBuilding
    ? units.filter((unit) => unit.building_id === selectedBuilding.id)
    : [];
  const unitBuilding = selectedUnit?.building_id
    ? buildings.find((item) => item.id === selectedUnit.building_id) ?? null
    : null;
  const unitBuildingUnits = unitBuilding
    ? units.filter((unit) => unit.building_id === unitBuilding.id)
    : [];

  const scopedLeases = leases.filter((lease) => {
    if (!targetPropertyId || lease.property_id !== targetPropertyId) return false;
    if (selectedBuilding) {
      return lease.building_id === selectedBuilding.id ||
        buildingUnits.some((unit) => unit.id === lease.unit_id);
    }
    if (selectedUnit) {
      return lease.unit_id === selectedUnit.id;
    }
    return true;
  });

  const activeLeases = scopedLeases.filter((lease) => leaseOverlapsFiscalYear(lease, fiscalYear));
  const activeLeaseIds = new Set(activeLeases.map((lease) => lease.id));

  const scopedExpenses = expenses.filter((expense) => {
    if (!targetPropertyId || expense.property_id !== targetPropertyId) return false;
    if (Number(expense.fiscal_year) !== Number(fiscalYear)) return false;

    if (selectedUnit) {
      return !expense.building_id ||
        expense.building_id === unitBuilding?.id ||
        expense.unit_id === selectedUnit.id ||
        (expense.lease_id && activeLeaseIds.has(expense.lease_id));
    }

    if (selectedBuilding) {
      return !expense.building_id ||
        expense.building_id === selectedBuilding.id ||
        buildingUnits.some((unit) => unit.id === expense.unit_id) ||
        (expense.lease_id && activeLeaseIds.has(expense.lease_id));
    }

    return true;
  });

  const recoverableExpenses = scopedExpenses.filter(
    (expense) => String(expense.classification || "").toLowerCase() === "recoverable",
  );

  const relevantUnits = selectedUnit
    ? unitBuildingUnits
    : selectedBuilding
    ? buildingUnits
    : units.filter((unit) => unit.property_id === targetPropertyId);

  const totalSqft = selectedBuilding
    ? asNumber(selectedBuilding.total_sqft) || relevantUnits.reduce((sum, unit) => sum + unitSqft(unit), 0)
    : selectedUnit
    ? asNumber(unitBuilding?.total_sqft) || relevantUnits.reduce((sum, unit) => sum + unitSqft(unit), 0) || asNumber(selectedProperty?.total_sqft)
    : asNumber(selectedProperty?.total_sqft) ||
      buildings.filter((building) => building.property_id === targetPropertyId).reduce((sum, building) => sum + asNumber(building.total_sqft), 0) ||
      relevantUnits.reduce((sum, unit) => sum + unitSqft(unit), 0);

  const occupiedSqft = activeLeases.reduce((sum, lease) => sum + leaseSqft(lease), 0);

  const directExpenses = recoverableExpenses.filter((expense) =>
    String(expense.allocation_type || "").toLowerCase() === "direct" || !!expense.lease_id || !!expense.unit_id,
  );
  const poolExpenses = recoverableExpenses.filter((expense) => !directExpenses.includes(expense));

  const targetScopeLabel = selectedUnit
    ? `Unit ${selectedUnit.unit_number || selectedUnit.unit_id_code || selectedUnit.id}`
    : selectedBuilding
    ? selectedBuilding.name || "Selected building"
    : selectedProperty?.name || null;

  return {
    targetPropertyId,
    targetScopeLevel,
    targetScopeId,
    targetScopeLabel,
    selectedProperty,
    selectedBuilding,
    selectedUnit,
    activeLeases,
    scopedExpenses,
    recoverableExpenses,
    poolExpenses,
    directExpenses,
    totalSqft,
    occupiedSqft,
  };
}

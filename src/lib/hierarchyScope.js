export function getScopeParams(search = "") {
  const params = new URLSearchParams(search);
  return {
    orgId: params.get("org") || params.get("orgId") || null,
    portfolioId: params.get("portfolio") || null,
    propertyId: params.get("property") || null,
    buildingId: params.get("building") || null,
    unitId: params.get("unit") || null,
  };
}

export function buildHierarchyScope({
  search = "",
  portfolios = [],
  properties = [],
  buildings = [],
  units = [],
}) {
  const requested = getScopeParams(search);

  const orgScopedPortfolios = requested.orgId
    ? portfolios.filter((portfolio) => portfolio.org_id === requested.orgId)
    : portfolios;
  const orgScopedProperties = requested.orgId
    ? properties.filter((property) => property.org_id === requested.orgId)
    : properties;
  const orgScopedBuildings = requested.orgId
    ? buildings.filter((building) => building.org_id === requested.orgId)
    : buildings;
  const orgScopedUnits = requested.orgId
    ? units.filter((unit) => unit.org_id === requested.orgId)
    : units;

  const portfolioById = new Map(orgScopedPortfolios.map((portfolio) => [portfolio.id, portfolio]));
  const propertyById = new Map(orgScopedProperties.map((property) => [property.id, property]));
  const buildingById = new Map(orgScopedBuildings.map((building) => [building.id, building]));
  const unitById = new Map(orgScopedUnits.map((unit) => [unit.id, unit]));

  const activeUnit = requested.unitId ? unitById.get(requested.unitId) ?? null : null;
  const activeBuilding =
    (requested.buildingId ? buildingById.get(requested.buildingId) : null) ??
    (activeUnit?.building_id ? buildingById.get(activeUnit.building_id) ?? null : null);
  const activeProperty =
    (requested.propertyId ? propertyById.get(requested.propertyId) : null) ??
    (activeBuilding?.property_id ? propertyById.get(activeBuilding.property_id) ?? null : null) ??
    (activeUnit?.property_id ? propertyById.get(activeUnit.property_id) ?? null : null);
  const activePortfolio =
    (requested.portfolioId ? portfolioById.get(requested.portfolioId) : null) ??
    (activeProperty?.portfolio_id ? portfolioById.get(activeProperty.portfolio_id) ?? null : null);

  const portfolioId = activePortfolio?.id || requested.portfolioId || null;
  const propertyId = activeProperty?.id || requested.propertyId || null;
  const buildingId = activeBuilding?.id || requested.buildingId || null;
  const unitId = activeUnit?.id || requested.unitId || null;

  let scopedPortfolios = [...orgScopedPortfolios];
  if (portfolioId) {
    scopedPortfolios = scopedPortfolios.filter((portfolio) => portfolio.id === portfolioId);
  }

  let scopedProperties = [...orgScopedProperties];
  if (portfolioId) {
    scopedProperties = scopedProperties.filter((property) => property.portfolio_id === portfolioId);
  }
  if (propertyId) {
    scopedProperties = scopedProperties.filter((property) => property.id === propertyId);
  }

  const scopedPropertyIds = new Set(scopedProperties.map((property) => property.id));

  let scopedBuildings = orgScopedBuildings.filter((building) => scopedPropertyIds.has(building.property_id));
  if (buildingId) {
    scopedBuildings = scopedBuildings.filter((building) => building.id === buildingId);
  }

  const scopedBuildingIds = new Set(scopedBuildings.map((building) => building.id));

  let scopedUnits = orgScopedUnits.filter((unit) => scopedPropertyIds.has(unit.property_id));
  if (buildingId) {
    scopedUnits = scopedUnits.filter((unit) => unit.building_id === buildingId);
  }
  if (unitId) {
    scopedUnits = scopedUnits.filter((unit) => unit.id === unitId);
  }

  const scopedUnitIds = new Set(scopedUnits.map((unit) => unit.id));

  return {
    requested,
    orgScopedPortfolios,
    orgScopedProperties,
    orgScopedBuildings,
    orgScopedUnits,
    scopedPortfolios,
    scopedProperties,
    scopedBuildings,
    scopedUnits,
    scopedPropertyIds,
    scopedBuildingIds,
    scopedUnitIds,
    portfolioById,
    propertyById,
    buildingById,
    unitById,
    activePortfolio,
    activeProperty,
    activeBuilding,
    activeUnit,
    portfolioId,
    propertyId,
    buildingId,
    unitId,
  };
}

export function matchesHierarchyScope(record, scope, options = {}) {
  if (!record) return false;

  const {
    orgKey = "org_id",
    portfolioKey = "portfolio_id",
    propertyKey = "property_id",
    buildingKey = "building_id",
    unitKey = "unit_id",
    deriveBuildingFromUnit = true,
    derivePropertyFromBuilding = true,
    derivePropertyFromUnit = true,
    derivePortfolioFromProperty = true,
  } = options;

  const recordUnit = record[unitKey] ? scope.unitById.get(record[unitKey]) ?? null : null;
  const recordBuilding =
    (record[buildingKey] ? scope.buildingById.get(record[buildingKey]) ?? null : null) ??
    (deriveBuildingFromUnit && recordUnit?.building_id ? scope.buildingById.get(recordUnit.building_id) ?? null : null);
  const recordProperty =
    (record[propertyKey] ? scope.propertyById.get(record[propertyKey]) ?? null : null) ??
    (derivePropertyFromBuilding && recordBuilding?.property_id ? scope.propertyById.get(recordBuilding.property_id) ?? null : null) ??
    (derivePropertyFromUnit && recordUnit?.property_id ? scope.propertyById.get(recordUnit.property_id) ?? null : null);
  const recordPortfolio =
    (record[portfolioKey] ? scope.portfolioById.get(record[portfolioKey]) ?? null : null) ??
    (derivePortfolioFromProperty && recordProperty?.portfolio_id
      ? scope.portfolioById.get(recordProperty.portfolio_id) ?? null
      : null);

  const resolvedOrgId = record[orgKey] || recordProperty?.org_id || recordBuilding?.org_id || recordUnit?.org_id || null;
  const resolvedPortfolioId = record[portfolioKey] || recordPortfolio?.id || recordProperty?.portfolio_id || null;
  const resolvedPropertyId = record[propertyKey] || recordProperty?.id || null;
  const resolvedBuildingId = record[buildingKey] || recordBuilding?.id || null;
  const resolvedUnitId = record[unitKey] || recordUnit?.id || null;

  if (scope.requested.orgId && resolvedOrgId !== scope.requested.orgId) return false;
  if (scope.portfolioId && resolvedPortfolioId !== scope.portfolioId) return false;
  if (scope.propertyId && resolvedPropertyId !== scope.propertyId) return false;
  if (scope.buildingId && resolvedBuildingId !== scope.buildingId) return false;
  if (scope.unitId && resolvedUnitId !== scope.unitId) return false;

  return true;
}

export function getScopeSubtitle(scope, labels = {}) {
  if (scope.activeUnit) {
    return labels.unit?.(scope.activeUnit) || `Scoped to unit ${scope.activeUnit.unit_number || scope.activeUnit.unit_id_code || scope.activeUnit.id}`;
  }
  if (scope.activeBuilding) {
    return labels.building?.(scope.activeBuilding) || `Scoped to building ${scope.activeBuilding.name || scope.activeBuilding.id}`;
  }
  if (scope.activeProperty) {
    return labels.property?.(scope.activeProperty) || `Scoped to property ${scope.activeProperty.name || scope.activeProperty.id}`;
  }
  if (scope.activePortfolio) {
    return labels.portfolio?.(scope.activePortfolio) || `Scoped to portfolio ${scope.activePortfolio.name || scope.activePortfolio.id}`;
  }
  if (scope.requested.orgId) {
    return labels.org?.(scope.requested.orgId) || "Scoped to selected organization";
  }
  return labels.default || "";
}

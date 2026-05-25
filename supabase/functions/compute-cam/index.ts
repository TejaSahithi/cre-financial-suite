// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId, assertPageAccess, assertPropertyAccess } from "../_shared/supabase.ts";
import { saveSnapshot, findMatchingCompletedSnapshot } from "../_shared/snapshot.ts";
import { calculateCam } from "../_shared/cam-calculator.ts";

type ScopeLevel = "property" | "building" | "unit";

function asNumber(value: unknown) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function normalizeText(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function normalizeDecision(value: unknown) {
  const normalized = normalizeText(value);
  if (["yes", "true", "recoverable", "approved"].includes(normalized)) return "yes";
  if (["conditional"].includes(normalized)) return "conditional";
  if (["no", "false", "excluded", "non_recoverable"].includes(normalized)) return "no";
  return normalized || "no";
}

function leaseOverlapsFiscalYear(lease: any, fiscalYear: number) {
  const status = String(lease?.status || "active").toLowerCase();
  if (status === "expired") return false;

  const yearStart = new Date(Date.UTC(fiscalYear, 0, 1));
  const yearEnd = new Date(Date.UTC(fiscalYear, 11, 31));
  const start = lease?.start_date ? new Date(`${lease.start_date}T00:00:00Z`) : null;
  const end = lease?.end_date ? new Date(`${lease.end_date}T00:00:00Z`) : null;

  const effectiveStart = start && start > yearStart ? start : yearStart;
  const effectiveEnd = end && end < yearEnd ? end : yearEnd;
  return effectiveEnd >= effectiveStart;
}

function scopedLeaseMatches(lease: any, units: any[], scopeLevel: ScopeLevel, scopeId: string, propertyId: string) {
  if (lease.property_id !== propertyId) return false;
  if (scopeLevel === "property") return true;
  if (scopeLevel === "building") {
    return lease.building_id === scopeId || units.some((unit) => unit.id === lease.unit_id && unit.building_id === scopeId);
  }
  return lease.unit_id === scopeId;
}

function resolveScopeTotals(
  property: any,
  buildings: any[],
  units: any[],
  scopeLevel: ScopeLevel,
  scopeId: string,
) {
  if (scopeLevel === "building") {
    const building = buildings.find((item) => item.id === scopeId);
    const buildingUnits = units.filter((unit) => unit.building_id === scopeId);
    const totalSqft = asNumber(building?.total_sqft) || buildingUnits.reduce((sum, unit) => sum + asNumber(unit.square_footage ?? unit.square_feet), 0);
    return { totalSqft, selectedBuilding: building ?? null, selectedUnit: null };
  }

  if (scopeLevel === "unit") {
    const unit = units.find((item) => item.id === scopeId);
    const building = unit?.building_id ? buildings.find((item) => item.id === unit.building_id) : null;
    const buildingUnits = unit?.building_id ? units.filter((item) => item.building_id === unit.building_id) : [];
    const totalSqft =
      asNumber(building?.total_sqft) ||
      buildingUnits.reduce((sum, item) => sum + asNumber(item.square_footage ?? item.square_feet), 0) ||
      asNumber(property?.total_sqft);
    return { totalSqft, selectedBuilding: building ?? null, selectedUnit: unit ?? null };
  }

  const propertyBuildings = buildings.filter((item) => item.property_id === property.id);
  const totalSqft =
    asNumber(property?.total_sqft) ||
    propertyBuildings.reduce((sum, building) => sum + asNumber(building.total_sqft), 0) ||
    units.reduce((sum, unit) => sum + asNumber(unit.square_footage ?? unit.square_feet), 0);

  return { totalSqft, selectedBuilding: null, selectedUnit: null };
}

function mergePropertyConfig(propertyConfig: any, body: Record<string, unknown>) {
  const overrideValues = {
    ...(propertyConfig?.config_values ?? {}),
    ...(body?.override_values ?? {}),
  };

  const topLevelKeys = [
    "allocation_method",
    "admin_fee_pct",
    "management_fee_pct",
    "management_fee_basis",
    "gross_up_enabled",
    "gross_up_target_occupancy_pct",
    "gross_up_apply_to",
    "cam_cap_rate",
    "vacancy_handling",
    "property_pool_denominator_mode",
    "building_pool_denominator_mode",
  ];

  for (const key of topLevelKeys) {
    if (body?.[key] !== undefined) {
      overrideValues[key] = body[key];
    }
  }

  return {
    ...(propertyConfig ?? {}),
    cam_calculation_method: propertyConfig?.cam_calculation_method ?? "pro_rata",
    expense_recovery_method: propertyConfig?.expense_recovery_method ?? "base_year",
    fiscal_year_start: propertyConfig?.fiscal_year_start ?? 1,
    config_values: overrideValues,
  };
}

function emptyCalculation(propertyId: string, fiscalYear: number, scopeLevel: ScopeLevel, scopeId: string, assumptions: string[]) {
  return {
    fiscal_year: fiscalYear,
    property_id: propertyId,
    scope_level: scopeLevel,
    scope_id: scopeId,
    assumptions,
    summary: {
      total_recoverable: 0,
      property_pool: 0,
      building_pools: 0,
      direct_allocations: 0,
      total_shared_before_fees: 0,
      total_billed: 0,
      gross_up_adjustment: 0,
      admin_fees: 0,
      management_fees: 0,
    },
    pools: {
      property_pool: null,
      building_pools: [],
    },
    tenant_charges: [],
  };
}

function isApprovedLeaseStatus(status: unknown) {
  return ["approved", "budget_ready", "active", "executed"].includes(String(status || "").toLowerCase());
}

async function fetchPropertyContext(supabaseAdmin: any, orgId: string, propertyId: string) {
  const { data: property, error: propertyError } = await supabaseAdmin
    .from("properties")
    .select("*")
    .eq("id", propertyId)
    .eq("org_id", orgId)
    .single();

  if (propertyError || !property) {
    throw new Error(`Property not found: ${propertyError?.message ?? propertyId}`);
  }

  const [{ data: buildings, error: buildingError }, { data: units, error: unitError }] = await Promise.all([
    supabaseAdmin
      .from("buildings")
      .select("*")
      .eq("property_id", propertyId)
      .eq("org_id", orgId),
    supabaseAdmin
      .from("units")
      .select("*")
      .eq("property_id", propertyId)
      .eq("org_id", orgId),
  ]);

  if (buildingError) throw new Error(`Failed to fetch buildings: ${buildingError.message}`);
  if (unitError) throw new Error(`Failed to fetch units: ${unitError.message}`);

  return { property, buildings: buildings ?? [], units: units ?? [] };
}

async function fetchExpenses(supabaseAdmin: any, orgId: string, propertyId: string, fiscalYear: number) {
  const { data, error } = await supabaseAdmin
    .from("expenses")
    .select("*")
    .eq("org_id", orgId)
    .eq("property_id", propertyId)
    .eq("fiscal_year", fiscalYear);

  if (error) throw new Error(`Failed to fetch expenses: ${error.message}`);
  return data ?? [];
}

async function fetchCamReadyClassifications(supabaseAdmin: any, orgId: string, propertyId: string, fiscalYear: number) {
  const { data, error } = await supabaseAdmin
    .from("expense_classifications")
    .select("*")
    .eq("org_id", orgId)
    .eq("property_id", propertyId)
    .eq("cam_status", "cam_ready")
    .eq("cam_eligible", "yes");

  if (error) {
    console.warn("[compute-cam] expense_classifications CAM-ready fetch warning:", error.message);
    return [];
  }

  return (data ?? []).filter((row: any) => rowMatchesFiscalYear(row, fiscalYear));
}

async function fetchCamReadyInputs(supabaseAdmin: any, orgId: string, propertyId: string, fiscalYear: number) {
  const { data, error } = await supabaseAdmin
    .from("cam_expense_inputs")
    .select("*")
    .eq("org_id", orgId)
    .eq("property_id", propertyId)
    .eq("status", "cam_ready");

  if (error) {
    console.warn("[compute-cam] cam_expense_inputs fetch warning:", error.message);
    return [];
  }

  return (data ?? []).filter((row: any) => rowMatchesFiscalYear(row, fiscalYear));
}

async function fetchLeases(supabaseAdmin: any, orgId: string, propertyId: string) {
  const { data, error } = await supabaseAdmin
    .from("leases")
    .select("*")
    .eq("org_id", orgId)
    .eq("property_id", propertyId);

  if (error) throw new Error(`Failed to fetch leases: ${error.message}`);
  return data ?? [];
}

function rowMatchesFiscalYear(row: any, fiscalYear: number) {
  if (!fiscalYear) return true;
  if (Number(row?.fiscal_year) === fiscalYear) return true;
  if (row?.fiscal_year && Number(row.fiscal_year) !== fiscalYear) return false;

  const dateValue =
    row?.service_period_start ||
    row?.service_period_end ||
    row?.expense_date ||
    row?.date ||
    row?.sent_to_cam_at;
  if (!dateValue) return true;
  const year = new Date(dateValue).getUTCFullYear();
  return !Number.isFinite(year) || year === fiscalYear;
}

function camReadyRowMatchesScope(row: any, units: any[], leases: any[], scopeLevel: ScopeLevel, scopeId: string, propertyId: string) {
  if (row?.property_id && row.property_id !== propertyId) return false;
  if (scopeLevel === "property") return true;
  if (scopeLevel === "building") {
    if (row?.building_id === scopeId) return true;
    if (row?.unit_id && units.some((unit) => unit.id === row.unit_id && unit.building_id === scopeId)) return true;
    if (row?.lease_id) {
      return leases.some((lease) =>
        lease.id === row.lease_id &&
        (lease.building_id === scopeId || units.some((unit) => unit.id === lease.unit_id && unit.building_id === scopeId))
      );
    }
    return false;
  }
  if (row?.unit_id === scopeId) return true;
  if (row?.lease_id) {
    return leases.some((lease) => lease.id === row.lease_id && lease.unit_id === scopeId);
  }
  return false;
}

function camReadyExpenseFromRow(row: any, sourceLabel: string) {
  const camInputType = normalizeText(row?.cam_input_type || row?.source || sourceLabel);
  const allocationBasis = normalizeText(row?.allocation_basis || row?.allocation_method || row?.recovery_method);
  const isDirectAllocation =
    camInputType === "lease_rule_amount" ||
    allocationBasis === "direct" ||
    allocationBasis === "direct_allocation" ||
    allocationBasis === "tenant_specific";
  const classification =
    normalizeText(row?.recoverability_result || row?.recovery_status || row?.classification) === "recoverable" ||
    normalizeText(row?.cam_eligible) === "yes"
      ? "recoverable"
      : "needs_review";

  return {
    id: String(row?.id || row?.classification_result_id || row?.actual_expense_id || row?.lease_expense_rule_id),
    property_id: row?.property_id,
    building_id: row?.building_id ?? null,
    unit_id: row?.unit_id ?? null,
    lease_id: isDirectAllocation ? row?.lease_id ?? null : null,
    tenant_id: row?.tenant_id ?? null,
    fiscal_year: row?.fiscal_year ? Number(row.fiscal_year) : null,
    date: row?.service_period_start || row?.sent_to_cam_at || null,
    category: row?.category,
    amount: asNumber(row?.amount),
    classification,
    allocation_type: isDirectAllocation ? "direct" : null,
    allocation_meta: {
      cam_source: row?.cam_source || row?.source || sourceLabel,
      cam_input_type: camInputType,
      classification_result_id: row?.classification_result_id || row?.id || null,
      lease_expense_rule_id: row?.lease_expense_rule_id || null,
    },
  };
}

function buildCamReadyExpenses({
  classifications,
  inputs,
  units,
  leases,
  scopeLevel,
  scopeId,
  propertyId,
}: {
  classifications: any[];
  inputs: any[];
  units: any[];
  leases: any[];
  scopeLevel: ScopeLevel;
  scopeId: string;
  propertyId: string;
}) {
  const rows: any[] = [];
  const seen = new Set<string>();

  const addRow = (row: any, sourceLabel: string) => {
    const camStatus = normalizeText(row?.cam_status || row?.status);
    const camEligible = normalizeDecision(row?.cam_eligible || "yes");
    const inputType = normalizeText(row?.cam_input_type || row?.source || sourceLabel);
    if (camStatus !== "cam_ready" && normalizeText(row?.status) !== "cam_ready") return;
    if (camEligible !== "yes") return;
    if (!["actual_expense", "manual_review", "lease_rule", "lease_rule_amount"].includes(inputType)) return;
    if (!camReadyRowMatchesScope(row, units, leases, scopeLevel, scopeId, propertyId)) return;

    const dedupeKey =
      row?.classification_result_id
        ? `classification:${row.classification_result_id}`
        : row?.actual_expense_id
          ? `actual:${row.actual_expense_id}`
          : row?.lease_expense_rule_id && inputType === "lease_rule_amount"
            ? `rule_amount:${row.lease_expense_rule_id}:${row.fiscal_year || ""}`
            : `row:${row.id}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    rows.push(camReadyExpenseFromRow(row, sourceLabel));
  };

  for (const input of inputs) addRow(input, normalizeText(input?.source || "cam_expense_input"));
  for (const classification of classifications) addRow(classification, normalizeText(classification?.cam_source || "expense_classification"));

  return rows.filter((row) => row.amount > 0 && row.category);
}

async function fetchConfigs(supabaseAdmin: any, orgId: string, propertyId: string, leaseIds: string[]) {
  // Gracefully handle missing/empty property_config — returns null if no row exists
  const { data: propertyConfig, error: propertyConfigError } = await supabaseAdmin
    .from("property_config")
    .select("*")
    .eq("property_id", propertyId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (propertyConfigError) {
    console.warn("[compute-cam] property_config fetch warning (non-fatal):", propertyConfigError.message);
  }

  let leaseConfigMap: Record<string, Record<string, unknown>> = {};
  const appliedRuleSetIds: string[] = [];
  const appliedRuleIds: string[] = [];
  if (leaseIds.length) {
    const { data: leaseConfigs, error: leaseConfigError } = await supabaseAdmin
      .from("lease_config")
      .select("*")
      .eq("org_id", orgId)
      .in("lease_id", leaseIds);

    if (leaseConfigError) {
      console.warn("[compute-cam] lease_config fetch warning (non-fatal):", leaseConfigError.message);
    } else {
      leaseConfigMap = Object.fromEntries((leaseConfigs ?? []).map((row: any) => [row.lease_id, row]));
    }

    // Fetch approved expense rules for these leases
    const { data: approvedRuleSets, error: rulesError } = await supabaseAdmin
      .from("lease_expense_rule_sets")
      .select(`
        *,
        lease_expense_rules (
          *,
          expense_categories ( category_name )
        )
      `)
      .eq("org_id", orgId)
      .eq("status", "approved")
      .in("lease_id", leaseIds)
      .order("version", { ascending: false });

    if (rulesError) {
      console.warn("[compute-cam] lease_expense_rules fetch warning:", rulesError.message);
    } else if (approvedRuleSets && approvedRuleSets.length > 0) {
      // Group by lease_id (taking the first one because of order by version desc)
      const latestRulesByLease = new Map();
      for (const rs of approvedRuleSets) {
        if (!latestRulesByLease.has(rs.lease_id)) {
          latestRulesByLease.set(rs.lease_id, rs);
        }
      }

      // Merge into leaseConfigMap
      for (const [leaseId, rs] of latestRulesByLease.entries()) {
        if (rs?.id) appliedRuleSetIds.push(String(rs.id));
        for (const rule of rs?.lease_expense_rules || []) {
          if (rule?.id) appliedRuleIds.push(String(rule.id));
        }
        const config = leaseConfigMap[leaseId] || { lease_id: leaseId, config_values: {} };
        const configValues = (config.config_values as Record<string, any>) || {};
        
        const excludedCategories = asStringArray(configValues.excluded_expenses);
        
        // Apply rules
        for (const rule of rs.lease_expense_rules || []) {
          const catName = rule.expense_categories?.category_name;
          if (!catName) continue;

          const reviewStatus = normalizeText(rule.review_status) === "reviewed" ? "approved" : normalizeText(rule.review_status);
          const approvalStatus = normalizeText(rule.approval_status);
          const recoverableDecision = normalizeDecision(rule.recoverable_from_tenant);
          const camEligibleDecision = normalizeDecision(rule.cam_eligible);
          const paymentTreatment = normalizeText(rule.payment_treatment);

          if (
            reviewStatus !== "approved" ||
            approvalStatus !== "approved" ||
            rule.published_to_cam !== true ||
            recoverableDecision === "no" ||
            camEligibleDecision === "no" ||
            paymentTreatment === "included_in_base_rent" ||
            rule.is_excluded ||
            rule.row_status === "unmapped"
          ) {
            if (!excludedCategories.includes(catName)) {
              excludedCategories.push(catName);
            }
          }
          
          // If a base year is found on any rule, and no global base year exists, use it as a fallback hint
          if (rule.has_base_year && !configValues.base_year) {
             // We ideally need the values table here, but for now we note it.
             console.log(`[compute-cam] Lease ${leaseId} has base year for ${catName} but global base_year not set.`);
          }
        }

        configValues.excluded_expenses = excludedCategories;
        config.config_values = configValues;
        leaseConfigMap[leaseId] = config;
      }
    }
  }

  return {
    propertyConfig: propertyConfig ?? null,
    leaseConfigMap,
    appliedRuleSetIds: Array.from(new Set(appliedRuleSetIds)).sort(),
    appliedRuleIds: Array.from(new Set(appliedRuleIds)).sort(),
  };
}

function collectHistoricalYears(
  fiscalYear: number,
  leaseConfigMap: Record<string, Record<string, unknown>>,
) {
  const years = new Set<number>([fiscalYear - 1]);

  for (const config of Object.values(leaseConfigMap)) {
    const values = config?.config_values ?? {};
    const baseYear = Number(config?.base_year ?? values.base_year ?? 0);
    const nonCumulativeYear = Number(values.non_cumulative_cap_base_year ?? 0);

    if (baseYear > 1900) years.add(baseYear);
    if (nonCumulativeYear > 1900) years.add(nonCumulativeYear);
  }

  return Array.from(years).sort((a, b) => a - b);
}

function buildHistoricalIndex(snapshotRows: any[]) {
  const byYear: Record<string, Record<string, any>> = {};
  const latestByYear = new Map<number, any>();

  for (const row of snapshotRows ?? []) {
    const year = Number(row.fiscal_year);
    if (!latestByYear.has(year)) {
      latestByYear.set(year, row);
    }
  }

  for (const [year, row] of latestByYear.entries()) {
    const index: Record<string, any> = {};
    for (const tenantCharge of row?.outputs?.tenant_charges ?? []) {
      if (tenantCharge?.lease_id) {
        index[tenantCharge.lease_id] = tenantCharge;
      }
    }
    byYear[String(year)] = index;
  }

  return byYear;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);

    const body = await req.json();
    const propertyId = body?.property_id;
    const fiscalYear = Number(body?.fiscal_year);
    const scopeLevel = (body?.scope_level ?? "property") as ScopeLevel;
    const scopeId = scopeLevel === "property" ? propertyId : body?.scope_id;

    if (!propertyId || !Number.isFinite(fiscalYear)) {
      throw new Error("property_id and fiscal_year are required");
    }

    if ((scopeLevel === "building" || scopeLevel === "unit") && !scopeId) {
      throw new Error(`scope_id is required when scope_level is ${scopeLevel}`);
    }

    await assertPageAccess(req, orgId, ["CAMCalculation", "CAMDashboard"], "write");
    await assertPropertyAccess(req, propertyId);

    const { property, buildings, units } = await fetchPropertyContext(supabaseAdmin, orgId, propertyId);
    const [expenses, leases, camReadyClassifications, camReadyInputs] = await Promise.all([
      fetchExpenses(supabaseAdmin, orgId, propertyId, fiscalYear),
      fetchLeases(supabaseAdmin, orgId, propertyId),
      fetchCamReadyClassifications(supabaseAdmin, orgId, propertyId, fiscalYear),
      fetchCamReadyInputs(supabaseAdmin, orgId, propertyId, fiscalYear),
    ]);

    const leaseIds = leases.map((lease: any) => lease.id);
    const { propertyConfig, leaseConfigMap, appliedRuleSetIds, appliedRuleIds } = await fetchConfigs(
      supabaseAdmin,
      orgId,
      propertyId,
      leaseIds,
    );
    const mergedPropertyConfig = mergePropertyConfig(propertyConfig, body);

    const approvedScopedLeases = leases.filter((lease: any) =>
      scopedLeaseMatches(lease, units, scopeLevel, scopeId, propertyId) &&
      leaseOverlapsFiscalYear(lease, fiscalYear) &&
      isApprovedLeaseStatus(lease.status)
    );

    if (approvedScopedLeases.length === 0) {
      throw new Error("No approved or budget-ready leases found for this scope");
    }

    const { data: approvedRuleSets, error: approvedRuleSetsError } = await supabaseAdmin
      .from("lease_expense_rule_sets")
      .select("lease_id")
      .eq("org_id", orgId)
      .eq("status", "approved")
      .in("lease_id", approvedScopedLeases.map((lease: any) => lease.id));

    if (approvedRuleSetsError) {
      throw new Error(`Failed to validate approved lease expense rules: ${approvedRuleSetsError.message}`);
    }

    if (!approvedRuleSets || approvedRuleSets.length === 0) {
      throw new Error("Lease expense/CAM rules must be approved before CAM calculation");
    }

    // Filter recoverable expenses. Per spec: "conditional expenses block
    // CAM until reviewed" — so 'conditional' is rejected upstream (the
    // reviewBlockingExpenses throw above). Anything reaching this filter
    // must be a clean recoverable + cam_eligible=yes row. We do NOT
    // accept camEligible="conditional" here for the same reason: the
    // earlier guard already rejected them. Previous code included
    // "conditional" on both axes, but the upstream throw made it dead
    // code that mis-represented the contract.
    const recoverableExpenses = buildCamReadyExpenses({
      classifications: camReadyClassifications,
      inputs: camReadyInputs,
      units,
      leases,
      scopeLevel,
      scopeId,
      propertyId,
    });

    const activeScopedLeases = leases.filter((lease: any) =>
      scopedLeaseMatches(lease, units, scopeLevel, scopeId, propertyId) &&
      leaseOverlapsFiscalYear(lease, fiscalYear),
    );

    const { totalSqft } = resolveScopeTotals(property, buildings, units, scopeLevel, scopeId);
    if (totalSqft <= 0) {
      throw new Error(`Total square footage for ${scopeLevel} scope ${scopeId} must be greater than 0`);
    }

    console.log("[compute-cam] Scope validation:", {
      property_id: propertyId,
      fiscal_year: fiscalYear,
      scope_level: scopeLevel,
      scope_id: scopeId,
      expense_count: expenses.length,
      recoverable_expense_count: recoverableExpenses.length,
      active_lease_count: activeScopedLeases.length,
    });

    const historicalYears = collectHistoricalYears(fiscalYear, leaseConfigMap);
    const { data: historicalSnapshots, error: historicalError } = await supabaseAdmin
      .from("computation_snapshots")
      .select("fiscal_year, outputs, computed_at")
      .eq("org_id", orgId)
      .eq("property_id", propertyId)
      .eq("engine_type", "cam")
      .in("fiscal_year", historicalYears)
      .order("computed_at", { ascending: false });

    if (historicalError) {
      console.warn("[compute-cam] Historical snapshots warning:", historicalError.message);
    }

    const shouldSkip = activeScopedLeases.length === 0 || recoverableExpenses.length === 0;
    const skipReason = activeScopedLeases.length === 0
      ? `No active leases found for ${scopeLevel} scope ${scopeId}; CAM allocation skipped`
      : `No recoverable expenses found for FY ${fiscalYear}; CAM allocation skipped`;

    const calculation = shouldSkip
      ? emptyCalculation(propertyId, fiscalYear, scopeLevel, scopeId, [skipReason])
      : calculateCam({
          fiscal_year: fiscalYear,
          scope_level: scopeLevel,
          scope_id: scopeId,
          property: {
            id: property.id,
            name: property.name,
            total_sqft: property.total_sqft,
          },
          buildings,
          units,
          expenses: recoverableExpenses,
          leases,
          property_config: mergedPropertyConfig,
          lease_configs: leaseConfigMap,
          historical_by_year: buildHistoricalIndex(historicalSnapshots ?? []),
        });

    const { data: budgetSnapshot } = await supabaseAdmin
      .from("computation_snapshots")
      .select("id, outputs")
      .eq("org_id", orgId)
      .eq("property_id", propertyId)
      .eq("engine_type", "budget")
      .eq("fiscal_year", fiscalYear)
      .order("computed_at", { ascending: false })
      .limit(1);

    const { data: priorCamSnapshot } = await supabaseAdmin
      .from("computation_snapshots")
      .select("id, outputs")
      .eq("org_id", orgId)
      .eq("property_id", propertyId)
      .eq("engine_type", "cam")
      .eq("fiscal_year", fiscalYear - 1)
      .order("computed_at", { ascending: false })
      .limit(1);

    const totalCam = calculation.tenant_charges.reduce(
      (sum: number, row: any) => sum + (Number(row.annual_cam) || 0),
      0,
    );
    const denominatorSqft = calculation.pools?.property_pool?.metrics?.occupied_area || totalSqft || 0;
    const camPerSf = denominatorSqft > 0 ? totalCam / Number(denominatorSqft) : 0;

    const camPayload = {
      org_id: orgId,
      property_id: propertyId,
      fiscal_year: fiscalYear,
      annual_cam: round2(totalCam),
      cam_per_sf: round2(camPerSf),
      method: mergedPropertyConfig?.cam_calculation_method ?? "pro_rata",
      status: "computed",
      admin_fee_pct: Number(mergedPropertyConfig?.config_values?.admin_fee_pct ?? 0),
      gross_up_pct: Number(mergedPropertyConfig?.config_values?.gross_up_target_occupancy_pct ?? 0),
      cap_pct: Number(mergedPropertyConfig?.config_values?.cam_cap_rate ?? 0),
      total_recoverable: calculation.summary.total_recoverable,
      total_building_sf: Number(denominatorSqft) || 0,
      notes: calculation.assumptions.join(" | "),
    };

    const { error: camCalculationError } = await supabaseAdmin
      .from("cam_calculations")
      .upsert(camPayload, { onConflict: "org_id,property_id,fiscal_year" });


    if (camCalculationError) {
      console.error("[compute-cam] cam_calculations upsert failed:", camCalculationError.message);
    }


    const outputs = {
      ...calculation.summary,
      total_cam: round2(totalCam),
      cam_per_sf: round2(camPerSf),
      prev_year_total: round2(Number(priorCamSnapshot?.[0]?.outputs?.total_cam ?? 0)),
      budgeted_cam: round2(
        Number(budgetSnapshot?.[0]?.outputs?.line_items?.revenue?.cam_recovery ?? 0),
      ),
      tenant_charges: calculation.tenant_charges,
      assumptions: calculation.assumptions,
      scope_level: scopeLevel,
      scope_id: scopeId,
    };

    const inputs = {
      property_id: propertyId,
      fiscal_year: fiscalYear,
      scope_level: scopeLevel,
      scope_id: scopeId,
      lease_count: leases.length,
      expense_count: expenses.length,
      recoverable_expense_count: recoverableExpenses.length,
      building_count: buildings.length,
      unit_count: units.length,
      property_config: mergedPropertyConfig,
      override_values: body?.override_values ?? null,
      _compute: {
        page_scope: ["CAMCalculation", "CAMDashboard"],
        source_tables: ["properties", "buildings", "units", "expenses", "expense_classifications", "cam_expense_inputs", "leases", "property_config", "lease_config", "lease_expense_rule_sets", "computation_snapshots"],
        source_row_ids: {
          buildings: buildings.map((building: any) => building.id).sort(),
          units: units.map((unit: any) => unit.id).sort(),
          expenses: expenses.map((expense: any) => expense.id).sort(),
          expense_classifications: camReadyClassifications.map((row: any) => row.id).sort(),
          cam_expense_inputs: camReadyInputs.map((row: any) => row.id).sort(),
          leases: leases.map((lease: any) => lease.id).sort(),
          lease_expense_rule_sets: appliedRuleSetIds,
          lease_expense_rules: appliedRuleIds,
        },
        source_counts: {
          buildings: buildings.length,
          units: units.length,
          expenses: expenses.length,
          expense_classifications: camReadyClassifications.length,
          cam_expense_inputs: camReadyInputs.length,
          leases: leases.length,
          lease_expense_rule_sets: appliedRuleSetIds.length,
          lease_expense_rules: appliedRuleIds.length,
        },
        source_snapshot_ids: {
          budget: budgetSnapshot?.[0]?.id ?? null,
          prior_cam: priorCamSnapshot?.[0]?.id ?? null,
        },
        trigger_type: req.headers.get("x-compute-trigger") ?? "manual",
        source_file_id: req.headers.get("x-source-file-id") ?? null,
      },
    };

    const existingSnapshot = await findMatchingCompletedSnapshot(supabaseAdmin, {
      org_id: orgId,
      property_id: propertyId,
      engine_type: "cam",
      fiscal_year: fiscalYear,
      inputs,
      outputs,
      computed_by: user.email ?? user.id,
    });

    if (existingSnapshot?.outputs) {
      return new Response(
        JSON.stringify({
          error: false,
          property_id: propertyId,
          fiscal_year: fiscalYear,
          scope_level: scopeLevel,
          scope_id: scopeId,
          ...existingSnapshot.outputs,
          snapshot_id: existingSnapshot.id,
          reused_snapshot: true,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    await saveSnapshot(supabaseAdmin, {
      org_id: orgId,
      property_id: propertyId,
      engine_type: "cam",
      fiscal_year: fiscalYear,
      computed_by: user.email ?? user.id,
      inputs,
      outputs,
    });

    return new Response(
      JSON.stringify({
        error: false,
        property_id: propertyId,
        fiscal_year: fiscalYear,
        scope_level: scopeLevel,
        scope_id: scopeId,
        ...outputs,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("[compute-cam] Error:", err?.message || err);
    return new Response(
      JSON.stringify({ error: true, message: err?.message || "Unexpected error" }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});

function round2(value: number) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

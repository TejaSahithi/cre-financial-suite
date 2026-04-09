// @ts-nocheck

export type CamScopeLevel = "property" | "building" | "unit";

export interface CamPropertyInput {
  id: string;
  name?: string | null;
  total_sqft?: number | null;
}

export interface CamBuildingInput {
  id: string;
  property_id: string;
  name?: string | null;
  total_sqft?: number | null;
  status?: string | null;
}

export interface CamUnitInput {
  id: string;
  property_id: string;
  building_id?: string | null;
  unit_number?: string | null;
  square_footage?: number | null;
  occupancy_status?: string | null;
  status?: string | null;
  lease_id?: string | null;
}

export interface CamExpenseInput {
  id: string;
  property_id: string;
  building_id?: string | null;
  unit_id?: string | null;
  lease_id?: string | null;
  direct_tenant_ids?: string[] | null;
  fiscal_year?: number | null;
  month?: number | null;
  date?: string | null;
  category?: string | null;
  description?: string | null;
  amount?: number | null;
  classification?: string | null;
  is_controllable?: boolean | null;
  allocation_type?: string | null;
  allocation_meta?: Record<string, unknown> | null;
}

export interface CamLeaseInput {
  id: string;
  property_id: string;
  unit_id?: string | null;
  building_id?: string | null;
  tenant_name?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  status?: string | null;
  square_footage?: number | null;
  annual_rent?: number | null;
  monthly_rent?: number | null;
  lease_type?: string | null;
  cam_applicable?: boolean | null;
  cam_cap?: number | null;
  cam_cap_type?: string | null;
  cam_cap_rate?: number | null;
  admin_fee_pct?: number | null;
  management_fee_pct?: number | null;
  management_fee_basis?: string | null;
  gross_up_clause?: boolean | null;
  allocation_method?: string | null;
  weight_factor?: number | null;
  base_year_amount?: number | null;
  expense_stop_amount?: number | null;
}

export interface HistoricalLeaseCharge {
  annual_cam?: number | null;
  raw_share_before_caps?: number | null;
  controllable_amount?: number | null;
}

export interface CamCalculatorInput {
  fiscal_year: number;
  scope_level?: CamScopeLevel | null;
  scope_id?: string | null;
  property: CamPropertyInput;
  buildings?: CamBuildingInput[];
  units?: CamUnitInput[];
  expenses?: CamExpenseInput[];
  leases?: CamLeaseInput[];
  property_config?: Record<string, unknown> | null;
  lease_configs?: Record<string, Record<string, unknown>>;
  historical_by_year?: Record<string, Record<string, HistoricalLeaseCharge>>;
}

interface PoolExpense {
  expense_id: string;
  category: string;
  amount: number;
  controllable: boolean;
  scope: "property" | "building";
}

interface DirectAllocation {
  expense_id: string;
  category: string;
  amount: number;
  lease_id: string;
  unit_id: string | null;
  note?: string;
}

interface LeaseState {
  lease_id: string;
  property_id: string;
  building_id: string | null;
  unit_id: string | null;
  tenant_name: string;
  leased_sqft: number;
  annual_rent: number;
  start_date: string | null;
  end_date: string | null;
  occupancy_days: number;
  occupancy_ratio: number;
  occupancy_months: number;
  is_active_in_year: boolean;
  cam_applicable: boolean;
  allocation_method: string;
  weight_factor: number;
  admin_fee_pct: number;
  admin_fee_basis: string;
  management_fee_pct: number;
  management_fee_basis: string;
  base_year: number | null;
  base_year_amount: number | null;
  expense_stop_amount: number | null;
  excluded_expenses: string[];
  cam_cap_amount: number | null;
  cam_cap_rate: number | null;
  cam_cap_type: string;
  non_cumulative_cap_base_year: number | null;
  non_cumulative_cap_base_amount: number | null;
  controllable_cap_rate: number | null;
  gross_up_enabled: boolean;
  notes: string[];
  breakdown: any[];
  shared_before_fees: number;
  controllable_amount: number;
  non_controllable_amount: number;
  gross_up_adjustment: number;
  management_fee_applied: number;
  admin_fee_applied: number;
  direct_expense_total: number;
  base_year_adjustment: number;
  cap_adjustment: number;
  raw_share_before_caps: number;
  final_shared_charge: number;
}

interface PoolMetrics {
  eligible_area: number;
  occupied_area: number;
  leases: LeaseState[];
}

interface PoolDefinition {
  id: string;
  scope: "property" | "building";
  scope_id: string;
  label: string;
  expenses: PoolExpense[];
  metrics: PoolMetrics;
  base_recoverable: number;
  controllable_total: number;
  non_controllable_total: number;
  gross_up_factor: number;
  gross_up_adjustment: number;
  final_shared_pool: number;
}

const DEFAULTS = {
  recoverable_classifications: ["recoverable"],
  allocation_method: "pro_rata_total_sqft",
  equal_split_label: "equal_split",
  weighted_allocation_label: "weighted_allocation",
  vacancy_handling: "occupied_tenants",
  owner_occupied_handling: "exclude",
  under_construction_handling: "exclude",
  gross_up_enabled: false,
  gross_up_target_occupancy_pct: 95,
  gross_up_apply_to: "controllable",
  admin_fee_pct: 0,
  admin_fee_basis: "shared_pool_plus_management",
  management_fee_pct: 0,
  management_fee_basis: "shared_pool",
  building_pool_denominator_mode: "building_total_sqft",
  property_pool_denominator_mode: "property_total_sqft",
  direct_expense_cap_exempt: true,
};

function round2(value: number): number {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function round4(value: number): number {
  return Math.round((Number(value) || 0) * 10000) / 10000;
}

function asNumber(value: unknown, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function asOptionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function asBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (["true", "1", "yes", "y"].includes(lowered)) return true;
    if (["false", "0", "no", "n"].includes(lowered)) return false;
  }
  return fallback;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item ?? "").trim())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function pushNote(target: string[], note: string) {
  if (note && !target.includes(note)) {
    target.push(note);
  }
}

function startOfYear(fiscalYear: number): Date {
  return new Date(Date.UTC(fiscalYear, 0, 1));
}

function endOfYear(fiscalYear: number): Date {
  return new Date(Date.UTC(fiscalYear, 11, 31));
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function overlapDays(
  start: Date | null,
  end: Date | null,
  periodStart: Date,
  periodEnd: Date,
): number {
  const effectiveStart = start && start > periodStart ? start : periodStart;
  const effectiveEnd = end && end < periodEnd ? end : periodEnd;
  if (effectiveEnd < effectiveStart) return 0;
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.floor((effectiveEnd.getTime() - effectiveStart.getTime()) / msPerDay) + 1;
}

function overlapMonths(
  start: Date | null,
  end: Date | null,
  fiscalYear: number,
): number {
  const periodStart = startOfYear(fiscalYear);
  const periodEnd = endOfYear(fiscalYear);
  const effectiveStart = start && start > periodStart ? start : periodStart;
  const effectiveEnd = end && end < periodEnd ? end : periodEnd;
  if (effectiveEnd < effectiveStart) return 0;

  let cursor = new Date(Date.UTC(effectiveStart.getUTCFullYear(), effectiveStart.getUTCMonth(), 1));
  const last = new Date(Date.UTC(effectiveEnd.getUTCFullYear(), effectiveEnd.getUTCMonth(), 1));
  let months = 0;

  while (cursor <= last) {
    months += 1;
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  return months;
}

function historicalCharge(
  historicalByYear: Record<string, Record<string, HistoricalLeaseCharge>>,
  year: number | null,
  leaseId: string,
): HistoricalLeaseCharge | null {
  if (!year) return null;
  return historicalByYear?.[String(year)]?.[leaseId] ?? null;
}

function baseCategory(category: string | null | undefined): string {
  return String(category || "uncategorized").trim().toLowerCase();
}

function mergeRuleValue<T>(...values: T[]): T | null {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return null;
}

function normalizePropertyRules(propertyConfig: Record<string, unknown> | null | undefined) {
  const values = propertyConfig?.config_values ?? {};

  const rules = {
    recoverable_classifications: asStringArray(
      mergeRuleValue(values.recoverable_classifications, DEFAULTS.recoverable_classifications),
    ),
    recoverable_categories: asStringArray(values.recoverable_categories),
    allocation_method: String(
      mergeRuleValue(
        values.allocation_method,
        values.default_allocation_method,
        propertyConfig?.cam_calculation_method,
        DEFAULTS.allocation_method,
      ),
    ),
    vacancy_handling: String(
      mergeRuleValue(values.vacancy_handling, DEFAULTS.vacancy_handling),
    ),
    owner_occupied_handling: String(
      mergeRuleValue(values.owner_occupied_handling, DEFAULTS.owner_occupied_handling),
    ),
    under_construction_handling: String(
      mergeRuleValue(values.under_construction_handling, DEFAULTS.under_construction_handling),
    ),
    gross_up_enabled: asBoolean(
      mergeRuleValue(values.gross_up_enabled, values.gross_up_pct > 0, DEFAULTS.gross_up_enabled),
    ),
    gross_up_target_occupancy_pct: asNumber(
      mergeRuleValue(values.gross_up_target_occupancy_pct, values.gross_up_pct, DEFAULTS.gross_up_target_occupancy_pct),
      DEFAULTS.gross_up_target_occupancy_pct,
    ),
    gross_up_apply_to: String(
      mergeRuleValue(values.gross_up_apply_to, DEFAULTS.gross_up_apply_to),
    ),
    admin_fee_pct: asNumber(
      mergeRuleValue(values.admin_fee_pct, DEFAULTS.admin_fee_pct),
      DEFAULTS.admin_fee_pct,
    ),
    admin_fee_basis: String(
      mergeRuleValue(values.admin_fee_basis, DEFAULTS.admin_fee_basis),
    ),
    management_fee_pct: asNumber(
      mergeRuleValue(values.management_fee_pct, DEFAULTS.management_fee_pct),
      DEFAULTS.management_fee_pct,
    ),
    management_fee_basis: String(
      mergeRuleValue(values.management_fee_basis, DEFAULTS.management_fee_basis),
    ),
    property_pool_denominator_mode: String(
      mergeRuleValue(values.property_pool_denominator_mode, DEFAULTS.property_pool_denominator_mode),
    ),
    building_pool_denominator_mode: String(
      mergeRuleValue(values.building_pool_denominator_mode, DEFAULTS.building_pool_denominator_mode),
    ),
    excluded_expenses: asStringArray(values.excluded_expenses),
    direct_expense_cap_exempt: asBoolean(
      mergeRuleValue(values.direct_expense_cap_exempt, DEFAULTS.direct_expense_cap_exempt),
      DEFAULTS.direct_expense_cap_exempt,
    ),
    assumptions: [] as string[],
  };

  if (!rules.recoverable_classifications.length) {
    rules.recoverable_classifications = [...DEFAULTS.recoverable_classifications];
    pushNote(
      rules.assumptions,
      "Missing recoverable_classifications config; defaulted to ['recoverable']",
    );
  }

  if (!propertyConfig) {
    pushNote(
      rules.assumptions,
      "No property_config row found; all CAM defaults came from the shared system defaults",
    );
  }

  return rules;
}

function isUnitEligible(unit: CamUnitInput, propertyRules: ReturnType<typeof normalizePropertyRules>): boolean {
  const occupancy = String(unit.occupancy_status || unit.status || "vacant").toLowerCase();

  if (occupancy === "under_construction") {
    return propertyRules.under_construction_handling !== "exclude";
  }

  if (occupancy === "owner_occupied") {
    return propertyRules.owner_occupied_handling === "include";
  }

  return true;
}

function normalizeLeaseState(
  lease: CamLeaseInput,
  unit: CamUnitInput | null,
  leaseConfig: Record<string, unknown> | null,
  propertyRules: ReturnType<typeof normalizePropertyRules>,
  fiscalYear: number,
): LeaseState {
  const configValues = leaseConfig?.config_values ?? {};
  const notes: string[] = [];

  const leasedSqft = asNumber(
    mergeRuleValue(lease.square_footage, configValues.leased_sqft, unit?.square_footage, 0),
  );
  if (leasedSqft <= 0) {
    pushNote(notes, "Lease square footage resolved to 0; allocations default to zero");
  }

  const startDate = String(mergeRuleValue(lease.start_date, configValues.start_date) ?? "") || null;
  const endDate = String(mergeRuleValue(lease.end_date, configValues.end_date) ?? "") || null;
  const start = parseDate(startDate);
  const end = parseDate(endDate);
  const activeDays = overlapDays(start, end, startOfYear(fiscalYear), endOfYear(fiscalYear));
  const activeMonths = overlapMonths(start, end, fiscalYear);
  const occupancyRatio = round4(activeDays / 365);

  if (!startDate || !endDate) {
    pushNote(
      notes,
      "Lease start/end dates were incomplete; occupancy proration fell back to full-year overlap assumptions where needed",
    );
  }

  const managementFeePct = asNumber(
    mergeRuleValue(
      lease.management_fee_pct,
      configValues.management_fee_pct,
      propertyRules.management_fee_pct,
    ),
    propertyRules.management_fee_pct,
  );

  const adminFeePct = asNumber(
    mergeRuleValue(
      lease.admin_fee_pct,
      configValues.admin_fee_pct,
      propertyRules.admin_fee_pct,
    ),
    propertyRules.admin_fee_pct,
  );

  return {
    lease_id: lease.id,
    property_id: lease.property_id,
    building_id: String(mergeRuleValue(lease.building_id, unit?.building_id) ?? "") || null,
    unit_id: String(mergeRuleValue(lease.unit_id, unit?.id) ?? "") || null,
    tenant_name: String(lease.tenant_name || "Unknown Tenant"),
    leased_sqft: leasedSqft,
    annual_rent: asNumber(
      mergeRuleValue(
        lease.annual_rent,
        configValues.annual_rent,
        lease.monthly_rent ? asNumber(lease.monthly_rent) * 12 : null,
      ),
      0,
    ),
    start_date: startDate,
    end_date: endDate,
    occupancy_days: activeDays,
    occupancy_ratio: activeDays > 0 ? occupancyRatio : 0,
    occupancy_months: activeMonths,
    is_active_in_year: activeDays > 0 && String(lease.status || "active").toLowerCase() !== "expired",
    cam_applicable: asBoolean(
      mergeRuleValue(lease.cam_applicable, configValues.cam_applicable, true),
      true,
    ),
    allocation_method: String(
      mergeRuleValue(
        lease.allocation_method,
        configValues.allocation_method,
      ) ?? "",
    ),
    weight_factor: asNumber(
      mergeRuleValue(lease.weight_factor, configValues.weight_factor, leasedSqft),
      leasedSqft,
    ),
    admin_fee_pct: adminFeePct,
    admin_fee_basis: String(
      mergeRuleValue(configValues.admin_fee_basis, propertyRules.admin_fee_basis),
    ),
    management_fee_pct: managementFeePct,
    management_fee_basis: String(
      mergeRuleValue(
        lease.management_fee_basis,
        configValues.management_fee_basis,
        propertyRules.management_fee_basis,
      ),
    ),
    base_year: asOptionalNumber(mergeRuleValue(leaseConfig?.base_year, configValues.base_year)),
    base_year_amount: asOptionalNumber(
      mergeRuleValue(lease.base_year_amount, configValues.base_year_amount),
    ),
    expense_stop_amount: asOptionalNumber(
      mergeRuleValue(lease.expense_stop_amount, configValues.expense_stop_amount),
    ),
    excluded_expenses: Array.from(
      new Set([
        ...propertyRules.excluded_expenses,
        ...asStringArray(leaseConfig?.excluded_expenses),
        ...asStringArray(configValues.excluded_expenses),
      ]),
    ),
    cam_cap_amount: asOptionalNumber(
      mergeRuleValue(lease.cam_cap, leaseConfig?.cam_cap, configValues.cam_cap),
    ),
    cam_cap_rate: asOptionalNumber(
      mergeRuleValue(lease.cam_cap_rate, configValues.cam_cap_rate),
    ),
    cam_cap_type: String(
      mergeRuleValue(lease.cam_cap_type, configValues.cam_cap_type, "none"),
    ),
    non_cumulative_cap_base_year: asOptionalNumber(configValues.non_cumulative_cap_base_year),
    non_cumulative_cap_base_amount: asOptionalNumber(configValues.non_cumulative_cap_base_amount),
    controllable_cap_rate: asOptionalNumber(configValues.controllable_cap_rate),
    gross_up_enabled: asBoolean(
      mergeRuleValue(lease.gross_up_clause, configValues.gross_up_enabled, propertyRules.gross_up_enabled),
      propertyRules.gross_up_enabled,
    ),
    notes,
    breakdown: [],
    shared_before_fees: 0,
    controllable_amount: 0,
    non_controllable_amount: 0,
    gross_up_adjustment: 0,
    management_fee_applied: 0,
    admin_fee_applied: 0,
    direct_expense_total: 0,
    base_year_adjustment: 0,
    cap_adjustment: 0,
    raw_share_before_caps: 0,
    final_shared_charge: 0,
  };
}

function isRecoverableExpense(
  expense: CamExpenseInput,
  propertyRules: ReturnType<typeof normalizePropertyRules>,
): boolean {
  const classification = String(expense.classification || "").toLowerCase();
  if (propertyRules.recoverable_classifications.includes(classification)) {
    return true;
  }

  return propertyRules.recoverable_categories.includes(baseCategory(expense.category));
}

function buildPoolMetrics(
  scope: "property" | "building",
  scopeId: string,
  property: CamPropertyInput,
  buildingsById: Map<string, CamBuildingInput>,
  allUnits: CamUnitInput[],
  leases: LeaseState[],
  propertyRules: ReturnType<typeof normalizePropertyRules>,
): PoolMetrics {
  const scopedUnits = allUnits.filter((unit) =>
    scope === "property" ? unit.property_id === scopeId : unit.building_id === scopeId,
  );

  const eligibleUnits = scopedUnits.filter((unit) => isUnitEligible(unit, propertyRules));
  const eligibleUnitArea = eligibleUnits.reduce((sum, unit) => sum + asNumber(unit.square_footage), 0);

  const candidateLeases = leases.filter((lease) => {
    if (!lease.cam_applicable || !lease.is_active_in_year) return false;
    return scope === "property" ? lease.property_id === scopeId : lease.building_id === scopeId;
  });

  const occupiedArea = candidateLeases.reduce((sum, lease) => sum + lease.leased_sqft, 0);

  let fallbackArea = 0;
  if (scope === "property") {
    fallbackArea = asNumber(property.total_sqft);
  } else {
    fallbackArea = asNumber(buildingsById.get(scopeId)?.total_sqft);
  }

  return {
    eligible_area: eligibleUnitArea > 0 ? eligibleUnitArea : fallbackArea,
    occupied_area: occupiedArea,
    leases: candidateLeases,
  };
}

function buildPools(
  property: CamPropertyInput,
  buildings: CamBuildingInput[],
  units: CamUnitInput[],
  expenses: CamExpenseInput[],
  leases: LeaseState[],
  propertyRules: ReturnType<typeof normalizePropertyRules>,
): {
  propertyPool: PoolDefinition | null;
  buildingPools: PoolDefinition[];
  directAllocations: DirectAllocation[];
  assumptions: string[];
} {
  const assumptions: string[] = [];
  const buildingsById = new Map(buildings.map((building) => [building.id, building]));
  const leaseByUnitId = new Map(
    leases
      .filter((lease) => lease.unit_id)
      .map((lease) => [lease.unit_id as string, lease]),
  );

  const propertyPoolExpenses: PoolExpense[] = [];
  const buildingPoolExpenses = new Map<string, PoolExpense[]>();
  const directAllocations: DirectAllocation[] = [];

  for (const expense of expenses) {
    if (!isRecoverableExpense(expense, propertyRules)) continue;

    const amount = asNumber(expense.amount);
    if (amount === 0) continue;

    const category = baseCategory(expense.category);
    const allocationMeta =
      expense.allocation_meta && typeof expense.allocation_meta === "object"
        ? expense.allocation_meta
        : {};
    const directLeaseIds = Array.from(
      new Set([
        ...asStringArray(expense.direct_tenant_ids),
        ...asStringArray((allocationMeta as Record<string, unknown>).direct_tenant_ids),
        ...asStringArray((allocationMeta as Record<string, unknown>).lease_ids),
        ...asStringArray((allocationMeta as Record<string, unknown>).tenant_ids),
      ]),
    );
    const isDirect =
      String(expense.allocation_type || "").toLowerCase() === "direct" ||
      !!expense.lease_id ||
      !!expense.unit_id ||
      directLeaseIds.length > 0;

    if (isDirect) {
      if (directLeaseIds.length > 0) {
        const explicitAmounts =
          allocationMeta.lease_amounts && typeof allocationMeta.lease_amounts === "object"
            ? allocationMeta.lease_amounts as Record<string, unknown>
            : {};
        const hasExplicitAmounts = Object.keys(explicitAmounts).length > 0;
        const equalSplitAmount = round2(amount / directLeaseIds.length);

        for (const directLeaseId of directLeaseIds) {
          const explicitAmount = asOptionalNumber(explicitAmounts[directLeaseId]);
          directAllocations.push({
            expense_id: expense.id,
            category,
            amount: round2(explicitAmount ?? equalSplitAmount),
            lease_id: directLeaseId,
            unit_id: expense.unit_id ? String(expense.unit_id) : null,
          });
        }

        if (!hasExplicitAmounts && directLeaseIds.length > 1) {
          pushNote(
            assumptions,
            `Direct expense ${expense.id} targeted multiple leases without explicit amounts; split evenly across ${directLeaseIds.length} leases`,
          );
        }
        continue;
      }

      const resolvedLeaseId =
        String(expense.lease_id || "") ||
        String(leaseByUnitId.get(String(expense.unit_id || ""))?.lease_id || "");

      if (resolvedLeaseId) {
        directAllocations.push({
          expense_id: expense.id,
          category,
          amount,
          lease_id: resolvedLeaseId,
          unit_id: expense.unit_id ? String(expense.unit_id) : null,
        });
      } else {
        pushNote(
          assumptions,
          `Direct expense ${expense.id} could not be matched to an active lease and was excluded from tenant billing`,
        );
      }
      continue;
    }

    const poolExpense: PoolExpense = {
      expense_id: expense.id,
      category,
      amount,
      controllable: expense.is_controllable !== false,
      scope: expense.building_id ? "building" : "property",
    };

    if (expense.building_id) {
      const bucket = buildingPoolExpenses.get(String(expense.building_id)) ?? [];
      bucket.push(poolExpense);
      buildingPoolExpenses.set(String(expense.building_id), bucket);
    } else {
      propertyPoolExpenses.push(poolExpense);
    }
  }

  const propertyPool: PoolDefinition | null = propertyPoolExpenses.length
    ? {
        id: `property:${property.id}`,
        scope: "property",
        scope_id: property.id,
        label: property.name || "Property",
        expenses: propertyPoolExpenses,
        metrics: buildPoolMetrics(
          "property",
          property.id,
          property,
          buildingsById,
          units,
          leases,
          propertyRules,
        ),
        base_recoverable: 0,
        controllable_total: 0,
        non_controllable_total: 0,
        gross_up_factor: 0,
        gross_up_adjustment: 0,
        final_shared_pool: 0,
      }
    : null;

  const buildingPools = Array.from(buildingPoolExpenses.entries()).map(([buildingId, poolExpenses]) => ({
    id: `building:${buildingId}`,
    scope: "building" as const,
    scope_id: buildingId,
    label: buildingsById.get(buildingId)?.name || "Building",
    expenses: poolExpenses,
    metrics: buildPoolMetrics(
      "building",
      buildingId,
      property,
      buildingsById,
      units,
      leases,
      propertyRules,
    ),
    base_recoverable: 0,
    controllable_total: 0,
    non_controllable_total: 0,
    gross_up_factor: 0,
    gross_up_adjustment: 0,
    final_shared_pool: 0,
  }));

  return { propertyPool, buildingPools, directAllocations, assumptions };
}

function calculatePool(
  pool: PoolDefinition,
  propertyRules: ReturnType<typeof normalizePropertyRules>,
): PoolDefinition {
  const baseRecoverable = pool.expenses.reduce((sum, expense) => sum + expense.amount, 0);
  const controllable = pool.expenses
    .filter((expense) => expense.controllable)
    .reduce((sum, expense) => sum + expense.amount, 0);
  const nonControllable = baseRecoverable - controllable;

  let grossUpAdjustment = 0;
  let grossUpFactor = 0;
  if (propertyRules.gross_up_enabled && pool.metrics.occupied_area > 0 && pool.metrics.eligible_area > 0) {
    const occupiedRatio = pool.metrics.occupied_area / pool.metrics.eligible_area;
    const targetRatio = Math.min(
      1,
      Math.max(0, propertyRules.gross_up_target_occupancy_pct / 100),
    );

    if (occupiedRatio < targetRatio && targetRatio > 0) {
      const grossUpBase =
        propertyRules.gross_up_apply_to === "all" ? baseRecoverable : controllable;
      grossUpFactor = (targetRatio / occupiedRatio) - 1;
      grossUpAdjustment = grossUpBase * grossUpFactor;
    }
  }

  return {
    ...pool,
    base_recoverable: round2(baseRecoverable),
    controllable_total: round2(controllable),
    non_controllable_total: round2(nonControllable),
    gross_up_factor: round4(grossUpFactor),
    gross_up_adjustment: round2(grossUpAdjustment),
    final_shared_pool: round2(baseRecoverable + grossUpAdjustment),
  };
}

function resolvedAllocationMethod(
  lease: LeaseState,
  pool: PoolDefinition,
  propertyRules: ReturnType<typeof normalizePropertyRules>,
): string {
  const configured = String(lease.allocation_method || "").toLowerCase();
  const propertyDefault = String(propertyRules.allocation_method || "").toLowerCase();
  const denominatorMode = String(
    pool.scope === "building"
      ? propertyRules.building_pool_denominator_mode
      : propertyRules.property_pool_denominator_mode,
  ).toLowerCase();

  if (configured === "equal_split" || configured === DEFAULTS.equal_split_label) {
    return DEFAULTS.equal_split_label;
  }

  if (configured === "weighted_allocation" || configured === DEFAULTS.weighted_allocation_label) {
    return DEFAULTS.weighted_allocation_label;
  }

  if ([
    "pro_rata_total_sqft",
    "property_total_sqft",
    "building_total_sqft",
    "building_only_denominator",
  ].includes(configured)) {
    return "pro_rata_total_sqft";
  }

  if (["pro_rata_occupied_sqft", "occupied_sqft"].includes(configured)) {
    return "pro_rata_occupied_sqft";
  }

  if (configured === "pro_rata") {
    return String(propertyRules.vacancy_handling || "").toLowerCase().includes("occupied")
      ? "pro_rata_occupied_sqft"
      : "pro_rata_total_sqft";
  }

  if (["equal_split", DEFAULTS.equal_split_label].includes(denominatorMode)) {
    return DEFAULTS.equal_split_label;
  }

  if (["weighted_allocation", DEFAULTS.weighted_allocation_label].includes(denominatorMode)) {
    return DEFAULTS.weighted_allocation_label;
  }

  if ([
    "property_total_sqft",
    "building_total_sqft",
    "pro_rata_total_sqft",
    "building_only_denominator",
  ].includes(denominatorMode)) {
    return "pro_rata_total_sqft";
  }

  if (["occupied_sqft", "pro_rata_occupied_sqft"].includes(denominatorMode)) {
    return "pro_rata_occupied_sqft";
  }

  if (propertyDefault === "equal_split" || propertyDefault === DEFAULTS.equal_split_label) {
    return DEFAULTS.equal_split_label;
  }

  if (propertyDefault === "weighted_allocation" || propertyDefault === DEFAULTS.weighted_allocation_label) {
    return DEFAULTS.weighted_allocation_label;
  }

  if ([
    "pro_rata_total_sqft",
    "property_total_sqft",
    "building_total_sqft",
    "building_only_denominator",
  ].includes(propertyDefault)) {
    return "pro_rata_total_sqft";
  }

  if (["pro_rata_occupied_sqft", "occupied_sqft"].includes(propertyDefault)) {
    return "pro_rata_occupied_sqft";
  }

  return DEFAULTS.allocation_method;
}

function denominatorForLease(
  lease: LeaseState,
  candidateLeases: LeaseState[],
  pool: PoolDefinition,
  propertyRules: ReturnType<typeof normalizePropertyRules>,
): number {
  const method = resolvedAllocationMethod(lease, pool, propertyRules);

  if (method === "equal_split" || method === DEFAULTS.equal_split_label) {
    return candidateLeases.length;
  }

  if (method === "weighted_allocation" || method === DEFAULTS.weighted_allocation_label) {
    return candidateLeases.reduce((sum, item) => sum + Math.max(0, item.weight_factor || 0), 0);
  }

  if (method === "pro_rata_total_sqft") {
    return Math.max(0, pool.metrics.eligible_area || 0);
  }

  if (method === "pro_rata_occupied_sqft") {
    return Math.max(
      0,
      pool.metrics.occupied_area ||
        candidateLeases.reduce((sum, item) => sum + Math.max(0, item.leased_sqft || 0), 0),
    );
  }

  return candidateLeases.reduce((sum, item) => sum + Math.max(0, item.leased_sqft || 0), 0);
}

function leaseShare(
  lease: LeaseState,
  candidateLeases: LeaseState[],
  pool: PoolDefinition,
  propertyRules: ReturnType<typeof normalizePropertyRules>,
): number {
  const method = resolvedAllocationMethod(lease, pool, propertyRules);
  const denominator = denominatorForLease(lease, candidateLeases, pool, propertyRules);

  if (denominator <= 0) return 0;

  if (method === "equal_split" || method === DEFAULTS.equal_split_label) {
    return round4(1 / denominator);
  }

  if (method === "weighted_allocation" || method === DEFAULTS.weighted_allocation_label) {
    return round4(Math.max(0, lease.weight_factor || 0) / denominator);
  }

  return round4(Math.max(0, lease.leased_sqft || 0) / denominator);
}

function isExcludedForLease(lease: LeaseState, category: string): boolean {
  const normalized = baseCategory(category);
  return lease.excluded_expenses.some((value) => baseCategory(value) === normalized);
}

function shouldGrossUpExpense(
  expense: PoolExpense,
  propertyRules: ReturnType<typeof normalizePropertyRules>,
): boolean {
  const applyTo = String(propertyRules.gross_up_apply_to || "").toLowerCase();
  if (applyTo === "all") return true;
  return expense.controllable;
}

function feeAmount(basis: string, pct: number, lease: LeaseState): number {
  if (pct <= 0) return 0;

  const normalizedBasis = String(basis || "").toLowerCase();
  let baseAmount = lease.shared_before_fees;

  if (normalizedBasis === "tenant_annual_rent") {
    baseAmount = lease.annual_rent;
  } else if (normalizedBasis === "direct_expenses") {
    baseAmount = lease.direct_expense_total;
  } else if (normalizedBasis === "controllable_only") {
    baseAmount = lease.controllable_amount;
  } else if (normalizedBasis === "shared_pool_plus_management") {
    baseAmount = lease.shared_before_fees + lease.management_fee_applied;
  }

  return round2(baseAmount * (pct / 100));
}

function applyBaseYearAndStops(
  lease: LeaseState,
  historicalByYear: Record<string, Record<string, HistoricalLeaseCharge>>,
): number {
  const notes = lease.notes;
  let adjustment = 0;

  if (lease.base_year_amount != null) {
    adjustment += lease.base_year_amount;
  } else if (lease.base_year != null) {
    const historical = historicalCharge(historicalByYear, lease.base_year, lease.lease_id);
    if (historical?.annual_cam != null) {
      adjustment += asNumber(historical.annual_cam);
    } else {
      pushNote(
        notes,
        `Base year ${lease.base_year} charge was missing for lease ${lease.lease_id}; base year adjustment skipped`,
      );
    }
  }

  if (lease.expense_stop_amount != null) {
    adjustment += lease.expense_stop_amount;
  }

  return round2(
    Math.min(
      adjustment,
      lease.shared_before_fees + lease.management_fee_applied + lease.admin_fee_applied,
    ),
  );
}

function capBaseline(
  lease: LeaseState,
  historicalByYear: Record<string, Record<string, HistoricalLeaseCharge>>,
  fiscalYear: number,
): number | null {
  if (lease.cam_cap_type === "non_cumulative") {
    if (lease.non_cumulative_cap_base_amount != null) {
      return lease.non_cumulative_cap_base_amount;
    }

    if (lease.non_cumulative_cap_base_year != null) {
      const historical = historicalCharge(
        historicalByYear,
        lease.non_cumulative_cap_base_year,
        lease.lease_id,
      );
      if (historical?.annual_cam != null) {
        return asNumber(historical.annual_cam);
      }
      pushNote(
        lease.notes,
        `Non-cumulative cap base year ${lease.non_cumulative_cap_base_year} was missing; falling back to prior-year CAM`,
      );
    }
  }

  const priorYear = historicalCharge(historicalByYear, fiscalYear - 1, lease.lease_id);
  if (priorYear?.annual_cam != null) {
    return asNumber(priorYear.annual_cam);
  }

  return null;
}

function applyCaps(
  lease: LeaseState,
  historicalByYear: Record<string, Record<string, HistoricalLeaseCharge>>,
  fiscalYear: number,
): number {
  let sharedAfterCaps =
    lease.shared_before_fees +
    lease.management_fee_applied +
    lease.admin_fee_applied -
    lease.base_year_adjustment;
  sharedAfterCaps = Math.max(0, round2(sharedAfterCaps));

  if (lease.controllable_cap_rate != null) {
    const prior = historicalCharge(historicalByYear, fiscalYear - 1, lease.lease_id);
    if (prior?.controllable_amount != null) {
      const priorControllable = asNumber(prior.controllable_amount);
      const currentControllable = lease.controllable_amount;
      const maxIncrease = priorControllable * (lease.controllable_cap_rate / 100);
      const allowedControllable = Math.min(currentControllable, priorControllable + maxIncrease);
      const reduction = Math.max(0, currentControllable - allowedControllable);
      sharedAfterCaps = round2(sharedAfterCaps - reduction);
      lease.cap_adjustment = round2(lease.cap_adjustment + reduction);
    } else {
      pushNote(
        lease.notes,
        `Controllable cap was configured but prior-year controllable baseline was unavailable for lease ${lease.lease_id}`,
      );
    }
  }

  if (lease.cam_cap_rate != null) {
    const baseline = capBaseline(lease, historicalByYear, fiscalYear);
    if (baseline != null) {
      const maxAllowed = round2(baseline * (1 + lease.cam_cap_rate / 100));
      if (sharedAfterCaps > maxAllowed) {
        const reduction = sharedAfterCaps - maxAllowed;
        sharedAfterCaps = maxAllowed;
        lease.cap_adjustment = round2(lease.cap_adjustment + reduction);
      }
    } else {
      pushNote(
        lease.notes,
        `CAM cap rate was configured but no historical baseline was available for lease ${lease.lease_id}`,
      );
    }
  }

  if (lease.cam_cap_amount != null && sharedAfterCaps > lease.cam_cap_amount) {
    const reduction = sharedAfterCaps - lease.cam_cap_amount;
    sharedAfterCaps = lease.cam_cap_amount;
    lease.cap_adjustment = round2(lease.cap_adjustment + reduction);
  }

  return round2(Math.max(0, sharedAfterCaps));
}

function directAllocationsForLease(leaseId: string, directAllocations: DirectAllocation[]) {
  return directAllocations.filter((allocation) => allocation.lease_id === leaseId);
}

export function calculateCam(input: CamCalculatorInput) {
  const fiscalYear = asNumber(input.fiscal_year);
  const scopeLevel = (input.scope_level || "property") as CamScopeLevel;
  const scopeId = input.scope_id || input.property.id;
  const propertyRules = normalizePropertyRules(input.property_config);
  const buildings = input.buildings ?? [];
  const units = input.units ?? [];
  const historicalByYear = input.historical_by_year ?? {};
  const assumptions = [...propertyRules.assumptions];

  const unitsById = new Map(units.map((unit) => [unit.id, unit]));
  const normalizedLeases = (input.leases ?? [])
    .map((lease) =>
      normalizeLeaseState(
        lease,
        lease.unit_id ? unitsById.get(String(lease.unit_id)) ?? null : null,
        input.lease_configs?.[lease.id] ?? null,
        propertyRules,
        fiscalYear,
      ),
    )
    .filter((lease) => lease.is_active_in_year);

  if (!normalizedLeases.length) {
    throw new Error(`No active leases overlap fiscal year ${fiscalYear}`);
  }

  const { propertyPool, buildingPools, directAllocations, assumptions: poolAssumptions } = buildPools(
    input.property,
    buildings,
    units,
    input.expenses ?? [],
    normalizedLeases,
    propertyRules,
  );
  assumptions.push(...poolAssumptions);

  const calculatedPropertyPool = propertyPool ? calculatePool(propertyPool, propertyRules) : null;
  const calculatedBuildingPools = buildingPools.map((pool) => calculatePool(pool, propertyRules));

  const targetLeases = normalizedLeases.filter((lease) => {
    if (scopeLevel === "property") return lease.property_id === input.property.id;
    if (scopeLevel === "building") return lease.building_id === scopeId;
    return lease.unit_id === scopeId;
  });

  if (!targetLeases.length) {
    throw new Error(`No active leases found for ${scopeLevel} scope ${scopeId}`);
  }

  const allPools = [
    ...(calculatedPropertyPool ? [calculatedPropertyPool] : []),
    ...calculatedBuildingPools,
  ];

  for (const pool of allPools) {
    const candidateLeases = pool.metrics.leases.filter((lease) => lease.cam_applicable);
    if (!candidateLeases.length) continue;

    console.log("CAM Pool:", {
      pool_id: pool.id,
      scope: pool.scope,
      scope_id: pool.scope_id,
      totalSqft: pool.metrics.eligible_area,
      occupiedSqft: pool.metrics.occupied_area,
      camPool: pool.final_shared_pool,
    });

    for (const lease of candidateLeases) {
      const share = leaseShare(lease, candidateLeases, pool, propertyRules);
      if (share <= 0) continue;

      console.log("Tenant Share:", {
        lease_id: lease.lease_id,
        tenant_name: lease.tenant_name,
        scope_id: pool.scope_id,
        share,
      });

      for (const expense of pool.expenses) {
        if (isExcludedForLease(lease, expense.category)) {
          pushNote(
            lease.notes,
            `Excluded category '${expense.category}' was removed from lease ${lease.lease_id}`,
          );
          continue;
        }

        const allocatedBase = round2(expense.amount * share);
        const allocatedGrossUp = lease.gross_up_enabled && shouldGrossUpExpense(expense, propertyRules)
          ? round2(allocatedBase * pool.gross_up_factor)
          : 0;
        const allocatedAmount = round2(allocatedBase + allocatedGrossUp);

        lease.shared_before_fees = round2(lease.shared_before_fees + allocatedAmount);
        if (expense.controllable) {
          lease.controllable_amount = round2(
            lease.controllable_amount + allocatedBase + allocatedGrossUp,
          );
        } else {
          lease.non_controllable_amount = round2(lease.non_controllable_amount + allocatedBase);
        }
        lease.gross_up_adjustment = round2(lease.gross_up_adjustment + allocatedGrossUp);

        lease.breakdown.push({
          type: pool.scope === "property" ? "property_pool" : "building_pool",
          scope_id: pool.scope_id,
          scope_label: pool.label,
          expense_id: expense.expense_id,
          category: expense.category,
          controllable: expense.controllable,
          share_pct: round4(share * 100),
          base_amount: allocatedBase,
          gross_up_amount: allocatedGrossUp,
          amount: allocatedAmount,
        });
      }
    }
  }

  const results = targetLeases.map((lease) => {
    const directItems = directAllocationsForLease(lease.lease_id, directAllocations);
    lease.direct_expense_total = round2(
      directItems.reduce((sum, allocation) => sum + allocation.amount, 0),
    );

    if (directItems.length) {
      for (const directItem of directItems) {
        lease.breakdown.push({
          type: "direct_allocation",
          expense_id: directItem.expense_id,
          category: directItem.category,
          amount: round2(directItem.amount),
        });
      }
    }

    lease.management_fee_applied = feeAmount(
      lease.management_fee_basis,
      lease.management_fee_pct,
      lease,
    );
    lease.admin_fee_applied = feeAmount(
      lease.admin_fee_basis,
      lease.admin_fee_pct,
      lease,
    );

    lease.base_year_adjustment = applyBaseYearAndStops(lease, historicalByYear);
    const sharedAfterCaps = applyCaps(lease, historicalByYear, fiscalYear);

    lease.final_shared_charge = round2(sharedAfterCaps);
    lease.raw_share_before_caps = round2(
      lease.shared_before_fees +
      lease.management_fee_applied +
      lease.admin_fee_applied +
      lease.direct_expense_total
    );

    const proratedShared = round2(sharedAfterCaps * lease.occupancy_ratio);
    const proratedDirect = round2(lease.direct_expense_total * lease.occupancy_ratio);
    const annualCam = round2(proratedShared + proratedDirect);
    const billedMonths = lease.occupancy_months || 12;
    const monthlyCam = billedMonths > 0 ? round2(annualCam / billedMonths) : 0;

    const expenseBreakdown = lease.breakdown.map((item) => ({
      ...item,
      base_amount: item.base_amount != null ? round2(item.base_amount) : undefined,
      gross_up_amount: item.gross_up_amount != null ? round2(item.gross_up_amount) : undefined,
      amount: round2(item.amount),
    }));

    const relevantPoolTotal = allPools
      .filter((pool) => {
        if (pool.scope === "property") return pool.scope_id === lease.property_id;
        return pool.scope_id === lease.building_id;
      })
      .reduce((sum, pool) => sum + pool.final_shared_pool, 0);
    const tenantSharePct = relevantPoolTotal > 0
      ? round4((lease.shared_before_fees / relevantPoolTotal) * 100)
      : 0;

    return {
      lease_id: lease.lease_id,
      property_id: lease.property_id,
      building_id: lease.building_id,
      unit_id: lease.unit_id,
      tenant_name: lease.tenant_name,
      annual_cam: annualCam,
      monthly_cam: monthlyCam,
      cam_charge: annualCam,
      raw_share_before_caps: round2(lease.raw_share_before_caps * lease.occupancy_ratio),
      cap_adjustment: round2(lease.cap_adjustment * lease.occupancy_ratio),
      base_year_adjustment: round2(lease.base_year_adjustment * lease.occupancy_ratio),
      base_year_deduction: round2(lease.base_year_adjustment * lease.occupancy_ratio),
      gross_up_applied: lease.gross_up_adjustment > 0,
      gross_up_adjustment: round2(lease.gross_up_adjustment * lease.occupancy_ratio),
      admin_fee_applied: round2(lease.admin_fee_applied * lease.occupancy_ratio),
      admin_fee: round2(lease.admin_fee_applied * lease.occupancy_ratio),
      management_fee_applied: round2(lease.management_fee_applied * lease.occupancy_ratio),
      management_fee_amount: round2(lease.management_fee_applied * lease.occupancy_ratio),
      expense_breakdown: expenseBreakdown,
      breakdown: expenseBreakdown,
      calculation_notes: lease.notes,
      total_cam_pool: round2(lease.shared_before_fees * lease.occupancy_ratio),
      controllable_total: round2(lease.controllable_amount * lease.occupancy_ratio),
      non_controllable_total: round2(lease.non_controllable_amount * lease.occupancy_ratio),
      direct_expense_total: proratedDirect,
      proration_months: billedMonths,
      occupancy_ratio: lease.occupancy_ratio,
      vacancy_handling: propertyRules.vacancy_handling,
      allocation_model: resolvedAllocationMethod(lease, allPools.find((pool) =>
        pool.scope === "building" ? pool.scope_id === lease.building_id : pool.scope_id === lease.property_id
      ) ?? allPools[0], propertyRules),
      tenant_share_pct: tenantSharePct,
      cap_applied: lease.cap_adjustment > 0,
      cap_amount: lease.cam_cap_amount,
    };
  });

  const propertyPoolFinal = calculatedPropertyPool?.final_shared_pool ?? 0;
  const buildingPoolFinal = calculatedBuildingPools.reduce(
    (sum, pool) => sum + pool.final_shared_pool,
    0,
  );
  const totalDirect = directAllocations.reduce((sum, allocation) => sum + allocation.amount, 0);
  const totalBilled = results.reduce((sum, result) => sum + result.annual_cam, 0);

  return {
    fiscal_year: fiscalYear,
    property_id: input.property.id,
    scope_level: scopeLevel,
    scope_id: scopeId,
    assumptions,
    summary: {
      total_recoverable: round2(
        (calculatedPropertyPool?.base_recoverable ?? 0) +
        calculatedBuildingPools.reduce((sum, pool) => sum + pool.base_recoverable, 0),
      ),
      property_pool: round2(propertyPoolFinal),
      building_pools: round2(buildingPoolFinal),
      direct_allocations: round2(totalDirect),
      total_shared_before_fees: round2(propertyPoolFinal + buildingPoolFinal),
      total_billed: round2(totalBilled),
      gross_up_adjustment: round2(
        (calculatedPropertyPool?.gross_up_adjustment ?? 0) +
        calculatedBuildingPools.reduce((sum, pool) => sum + pool.gross_up_adjustment, 0),
      ),
      admin_fees: round2(results.reduce((sum, result) => sum + result.admin_fee_applied, 0)),
      management_fees: round2(
        results.reduce((sum, result) => sum + result.management_fee_applied, 0),
      ),
    },
    pools: {
      property_pool: calculatedPropertyPool,
      building_pools: calculatedBuildingPools,
    },
    tenant_charges: results,
  };
}

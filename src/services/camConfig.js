import { supabase } from "@/services/supabaseClient";
import { getCurrentOrgId } from "@/services/api";
import { resolveWritableOrgId } from "@/lib/orgUtils";

export const DEFAULT_CAM_CONFIG = {
  allocation_method: "pro_rata_total_sqft",
  admin_fee_pct: 0,
  management_fee_pct: 0,
  management_fee_basis: "shared_pool",
  gross_up_enabled: false,
  gross_up_target_occupancy_pct: 95,
  gross_up_apply_to: "controllable",
  cam_cap_rate: 0,
  vacancy_handling: "include_vacant",
  property_pool_denominator_mode: "property_total_sqft",
  building_pool_denominator_mode: "building_total_sqft",
};

function normalizeConfig(row) {
  const configValues = row?.config_values ?? {};
  return {
    ...DEFAULT_CAM_CONFIG,
    ...configValues,
    cam_calculation_method: row?.cam_calculation_method ?? "pro_rata",
    expense_recovery_method: row?.expense_recovery_method ?? "base_year",
    fiscal_year_start: row?.fiscal_year_start ?? 1,
  };
}

export async function fetchPropertyCamConfig(propertyId) {
  if (!supabase || !propertyId || propertyId === "all") {
    return {
      row: null,
      values: { ...DEFAULT_CAM_CONFIG, cam_calculation_method: "pro_rata", expense_recovery_method: "base_year", fiscal_year_start: 1 },
    };
  }

  const orgId = await getCurrentOrgId();
  let query = supabase
    .from("property_config")
    .select("*")
    .eq("property_id", propertyId)
    .maybeSingle();

  if (orgId && orgId !== "__none__") {
    query = query.eq("org_id", orgId);
  }

  const { data, error } = await query;
  if (error) throw error;

  return { row: data ?? null, values: normalizeConfig(data) };
}

export async function savePropertyCamConfig(propertyId, values) {
  if (!supabase || !propertyId || propertyId === "all") {
    throw new Error("Select a property before saving CAM configuration");
  }

  const orgId = await resolveWritableOrgId(await getCurrentOrgId());
  if (!orgId) {
    throw new Error("Unable to resolve organization for CAM configuration");
  }

  const payload = {
    property_id: propertyId,
    org_id: orgId,
    cam_calculation_method: values.cam_calculation_method ?? "pro_rata",
    expense_recovery_method: values.expense_recovery_method ?? "base_year",
    fiscal_year_start: values.fiscal_year_start ?? 1,
    config_values: {
      allocation_method: values.allocation_method,
      admin_fee_pct: Number(values.admin_fee_pct ?? 0),
      management_fee_pct: Number(values.management_fee_pct ?? 0),
      management_fee_basis: values.management_fee_basis ?? "shared_pool",
      gross_up_enabled: Boolean(values.gross_up_enabled),
      gross_up_target_occupancy_pct: Number(values.gross_up_target_occupancy_pct ?? 95),
      gross_up_apply_to: values.gross_up_apply_to ?? "controllable",
      cam_cap_rate: Number(values.cam_cap_rate ?? 0),
      vacancy_handling: values.vacancy_handling ?? "include_vacant",
      property_pool_denominator_mode: values.property_pool_denominator_mode ?? "property_total_sqft",
      building_pool_denominator_mode: values.building_pool_denominator_mode ?? "building_total_sqft",
    },
  };

  const { data, error } = await supabase
    .from("property_config")
    .upsert(payload, { onConflict: "org_id,property_id" })
    .select("*")
    .single();

  if (error) throw error;
  return { row: data, values: normalizeConfig(data) };
}

// ─── Per-Lease CAM Rules ──────────────────────────────────────────────────────

export const DEFAULT_LEASE_CAM_CONFIG = {
  cam_applicable: true,
  cam_cap_type: "none",
  cam_cap_rate: null,
  cam_cap: null,
  base_year: null,
  base_year_amount: null,
  expense_stop_amount: null,
  gross_up_clause: false,
  allocation_method: "",
  weight_factor: null,
  excluded_expenses: [],
  management_fee_pct: null,
  controllable_cap_rate: null,
  non_cumulative_cap_base_year: null,
};

function normalizeLeaseConfig(row) {
  const cv = row?.config_values ?? {};
  return {
    ...DEFAULT_LEASE_CAM_CONFIG,
    ...cv,
    base_year: row?.base_year ?? cv.base_year ?? null,
    excluded_expenses: row?.excluded_expenses ?? cv.excluded_expenses ?? [],
  };
}

export async function fetchLeaseConfig(leaseId) {
  if (!supabase || !leaseId) return { row: null, values: { ...DEFAULT_LEASE_CAM_CONFIG } };
  const orgId = await getCurrentOrgId();
  const { data, error } = await supabase
    .from("lease_config")
    .select("*")
    .eq("lease_id", leaseId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) throw error;
  return { row: data ?? null, values: normalizeLeaseConfig(data) };
}

export async function saveLeaseConfig(leaseId, values) {
  if (!supabase || !leaseId) throw new Error("Lease ID is required");
  const orgId = await resolveWritableOrgId(await getCurrentOrgId());
  if (!orgId) throw new Error("Unable to resolve organization");

  const payload = {
    lease_id: leaseId,
    org_id: orgId,
    base_year: values.base_year ? Number(values.base_year) : null,
    excluded_expenses: Array.isArray(values.excluded_expenses) ? values.excluded_expenses : [],
    config_values: {
      cam_applicable: values.cam_applicable !== false,
      cam_cap_type: values.cam_cap_type ?? "none",
      cam_cap_rate: values.cam_cap_rate != null ? Number(values.cam_cap_rate) : null,
      cam_cap: values.cam_cap != null ? Number(values.cam_cap) : null,
      base_year_amount: values.base_year_amount != null ? Number(values.base_year_amount) : null,
      expense_stop_amount: values.expense_stop_amount != null ? Number(values.expense_stop_amount) : null,
      gross_up_clause: Boolean(values.gross_up_clause),
      allocation_method: values.allocation_method ?? "",
      weight_factor: values.weight_factor != null ? Number(values.weight_factor) : null,
      management_fee_pct: values.management_fee_pct != null ? Number(values.management_fee_pct) : null,
      controllable_cap_rate: values.controllable_cap_rate != null ? Number(values.controllable_cap_rate) : null,
      non_cumulative_cap_base_year: values.non_cumulative_cap_base_year != null ? Number(values.non_cumulative_cap_base_year) : null,
    },
  };

  const { data, error } = await supabase
    .from("lease_config")
    .upsert(payload, { onConflict: "org_id,lease_id" })
    .select("*")
    .single();
  if (error) throw error;
  return { row: data, values: normalizeLeaseConfig(data) };
}

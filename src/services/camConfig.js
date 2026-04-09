import { supabase } from "@/services/supabaseClient";
import { getCurrentOrgId } from "@/services/api";

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

  const orgId = await getCurrentOrgId();
  if (!orgId || orgId === "__none__") {
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
    .upsert(payload, { onConflict: "property_id" })
    .select("*")
    .single();

  if (error) throw error;
  return { row: data, values: normalizeConfig(data) };
}

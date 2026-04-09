// @ts-nocheck

import { calculateCam } from "../_shared/cam-calculator.ts";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}. Expected ${expected}, received ${actual}`);
  }
}

function assertAlmostEquals(actual: number, expected: number, epsilon: number, message: string) {
  if (Math.abs((Number(actual) || 0) - (Number(expected) || 0)) > epsilon) {
    throw new Error(`${message}. Expected ${expected}, received ${actual}`);
  }
}

function tenant(result: any, leaseId: string) {
  const match = result.tenant_charges.find((row: any) => row.lease_id === leaseId);
  assert(!!match, `Missing tenant result for ${leaseId}`);
  return match;
}

Deno.test("CAM engine allocates property/building pools, honours exclusions, and preserves direct charges", () => {
  const result = calculateCam({
    fiscal_year: 2026,
    property: { id: "prop-1", name: "Sunset Plaza", total_sqft: 10000 },
    buildings: [
      { id: "bldg-1", property_id: "prop-1", name: "Tower A", total_sqft: 6000 },
      { id: "bldg-2", property_id: "prop-1", name: "Tower B", total_sqft: 4000 },
    ],
    units: [
      { id: "u-1", property_id: "prop-1", building_id: "bldg-1", square_footage: 3000, occupancy_status: "leased" },
      { id: "u-2", property_id: "prop-1", building_id: "bldg-1", square_footage: 3000, occupancy_status: "leased" },
      { id: "u-3", property_id: "prop-1", building_id: "bldg-2", square_footage: 4000, occupancy_status: "vacant" },
    ],
    expenses: [
      { id: "exp-1", property_id: "prop-1", fiscal_year: 2026, category: "taxes", amount: 1000, classification: "recoverable", is_controllable: false },
      { id: "exp-2", property_id: "prop-1", fiscal_year: 2026, category: "maintenance", amount: 4000, classification: "recoverable", is_controllable: true },
      { id: "exp-3", property_id: "prop-1", building_id: "bldg-1", fiscal_year: 2026, category: "utilities", amount: 1200, classification: "recoverable", is_controllable: true },
      { id: "exp-4", property_id: "prop-1", unit_id: "u-1", lease_id: "lease-1", fiscal_year: 2026, category: "hvac", amount: 300, classification: "recoverable", allocation_type: "direct", is_controllable: true },
    ],
    leases: [
      { id: "lease-1", property_id: "prop-1", building_id: "bldg-1", unit_id: "u-1", tenant_name: "Alpha", start_date: "2026-01-01", end_date: "2026-12-31", square_footage: 3000, cam_applicable: true },
      { id: "lease-2", property_id: "prop-1", building_id: "bldg-1", unit_id: "u-2", tenant_name: "Beta", start_date: "2026-01-01", end_date: "2026-12-31", square_footage: 3000, cam_applicable: true },
    ],
    property_config: {
      config_values: {
        recoverable_classifications: ["recoverable"],
        property_pool_denominator_mode: "property_total_sqft",
        building_pool_denominator_mode: "occupied_sqft",
        admin_fee_pct: 0,
        management_fee_pct: 0,
        gross_up_enabled: false,
      },
    },
    lease_configs: {
      "lease-1": {
        lease_id: "lease-1",
        excluded_expenses: ["taxes"],
        config_values: {},
      },
    },
  });

  const alpha = tenant(result, "lease-1");
  const beta = tenant(result, "lease-2");

  assertAlmostEquals(alpha.annual_cam, 2100, 0.01, "Alpha should receive pooled plus direct CAM");
  assertAlmostEquals(alpha.monthly_cam, 175, 0.01, "Alpha monthly CAM should be annual/12");
  assertAlmostEquals(alpha.total_cam_pool, 1800, 0.01, "Alpha pooled CAM should exclude taxes");
  assertAlmostEquals(alpha.direct_expense_total, 300, 0.01, "Alpha direct expense should remain separately allocated");
  assert(
    !alpha.expense_breakdown.some((row: any) => row.category === "taxes"),
    "Alpha should not receive excluded taxes category",
  );

  assertAlmostEquals(beta.annual_cam, 2100, 0.01, "Beta should receive property and building pool CAM");
  assertAlmostEquals(beta.direct_expense_total, 0, 0.01, "Beta should not receive direct expenses");
  assertAlmostEquals(result.summary.total_billed, 4200, 0.01, "Total billed should reflect exclusion and vacancy leakage");
});

Deno.test("CAM engine applies base-year deductions, annual caps, and partial-year proration deterministically", () => {
  const result = calculateCam({
    fiscal_year: 2026,
    property: { id: "prop-2", name: "Commerce Center", total_sqft: 2000 },
    units: [
      { id: "u-21", property_id: "prop-2", square_footage: 1000, occupancy_status: "leased" },
      { id: "u-22", property_id: "prop-2", square_footage: 1000, occupancy_status: "leased" },
    ],
    expenses: [
      { id: "exp-21", property_id: "prop-2", fiscal_year: 2026, category: "maintenance", amount: 6000, classification: "recoverable", is_controllable: true },
    ],
    leases: [
      { id: "lease-21", property_id: "prop-2", unit_id: "u-21", tenant_name: "Northwind", start_date: "2026-07-01", end_date: "2026-12-31", square_footage: 1000, cam_applicable: true, cam_cap_rate: 10 },
      { id: "lease-22", property_id: "prop-2", unit_id: "u-22", tenant_name: "Southwind", start_date: "2026-01-01", end_date: "2026-12-31", square_footage: 1000, cam_applicable: true },
    ],
    property_config: {
      config_values: {
        recoverable_classifications: ["recoverable"],
        property_pool_denominator_mode: "occupied_sqft",
        gross_up_enabled: false,
        admin_fee_pct: 0,
        management_fee_pct: 0,
      },
    },
    lease_configs: {
      "lease-21": {
        lease_id: "lease-21",
        base_year: 2025,
        config_values: {},
      },
    },
    historical_by_year: {
      "2025": {
        "lease-21": {
          annual_cam: 1000,
          controllable_amount: 1000,
        },
      },
    },
  });

  const northwind = tenant(result, "lease-21");
  const southwind = tenant(result, "lease-22");

  assertAlmostEquals(northwind.raw_share_before_caps, 1512.33, 0.02, "Northwind raw share should prorate from 3000 annual share");
  assertAlmostEquals(northwind.base_year_adjustment, 504.11, 0.02, "Northwind base-year deduction should prorate from 1000");
  assertAlmostEquals(northwind.cap_adjustment, 453.7, 0.02, "Northwind cap reduction should prorate from 900");
  assertAlmostEquals(northwind.annual_cam, 554.52, 0.02, "Northwind annual CAM should reflect base year, cap, and proration");
  assertAlmostEquals(northwind.monthly_cam, 92.42, 0.02, "Northwind monthly CAM should be spread over occupied months");
  assertEquals(northwind.cap_applied, true, "Northwind cap flag should be true");

  assertAlmostEquals(southwind.annual_cam, 3000, 0.01, "Southwind should receive uncapped full-year CAM");
  assertAlmostEquals(result.summary.total_billed, 3554.52, 0.02, "Summary total billed should match tenant totals");
});

Deno.test("CAM engine applies gross-up, management fee, and admin fee in the configured order", () => {
  const result = calculateCam({
    fiscal_year: 2026,
    property: { id: "prop-3", name: "Lakeside", total_sqft: 10000 },
    units: [
      { id: "u-31", property_id: "prop-3", square_footage: 3000, occupancy_status: "leased" },
      { id: "u-32", property_id: "prop-3", square_footage: 2000, occupancy_status: "leased" },
      { id: "u-33", property_id: "prop-3", square_footage: 5000, occupancy_status: "vacant" },
    ],
    expenses: [
      { id: "exp-31", property_id: "prop-3", fiscal_year: 2026, category: "maintenance", amount: 5000, classification: "recoverable", is_controllable: true },
      { id: "exp-32", property_id: "prop-3", fiscal_year: 2026, category: "taxes", amount: 2000, classification: "recoverable", is_controllable: false },
    ],
    leases: [
      { id: "lease-31", property_id: "prop-3", unit_id: "u-31", tenant_name: "Atlas", start_date: "2026-01-01", end_date: "2026-12-31", square_footage: 3000, cam_applicable: true },
      { id: "lease-32", property_id: "prop-3", unit_id: "u-32", tenant_name: "Beacon", start_date: "2026-01-01", end_date: "2026-12-31", square_footage: 2000, cam_applicable: true },
    ],
    property_config: {
      config_values: {
        recoverable_classifications: ["recoverable"],
        property_pool_denominator_mode: "occupied_sqft",
        gross_up_enabled: true,
        gross_up_target_occupancy_pct: 95,
        gross_up_apply_to: "controllable",
        management_fee_pct: 5,
        management_fee_basis: "shared_pool",
        admin_fee_pct: 10,
        admin_fee_basis: "shared_pool_plus_management",
      },
    },
  });

  const atlas = tenant(result, "lease-31");
  const beacon = tenant(result, "lease-32");

  assertAlmostEquals(result.summary.gross_up_adjustment, 4500, 0.01, "Gross-up should add 4500 to controllable expenses");
  assertAlmostEquals(atlas.total_cam_pool, 6900, 0.01, "Atlas pooled share should include gross-up");
  assertAlmostEquals(atlas.management_fee_applied, 345, 0.01, "Atlas management fee should be 5% of shared pool");
  assertAlmostEquals(atlas.admin_fee_applied, 724.5, 0.01, "Atlas admin fee should be 10% of pool plus management fee");
  assertAlmostEquals(atlas.annual_cam, 7969.5, 0.01, "Atlas annual CAM should include pool, management, and admin fees");

  assertAlmostEquals(beacon.annual_cam, 5313, 0.01, "Beacon annual CAM should reflect its 40% share");
  assertAlmostEquals(result.summary.management_fees, 575, 0.01, "Total management fees should sum by tenant");
  assertAlmostEquals(result.summary.admin_fees, 1207.5, 0.01, "Total admin fees should sum by tenant");
  assertAlmostEquals(result.summary.total_billed, 13282.5, 0.01, "Total billed should include shared pool and fees");
});

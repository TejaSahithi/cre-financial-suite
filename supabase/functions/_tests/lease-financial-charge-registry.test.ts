import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  FINANCIAL_CHARGE_REGISTRY,
  computeFinancialChargeRegistryHash,
  getFinancialChargeRegistryEntry,
} from "../_shared/extraction/lease-financial-schedule/charges/financial-charge-registry.ts";
import {
  LEASE_FINANCIAL_CHARGE_REGISTRY_HASH,
  LEASE_FINANCIAL_CHARGE_REGISTRY_VERSION,
} from "../_shared/extraction/lease-financial-schedule/charges/financial-charge-registry-version.ts";
import { FINANCIAL_CHARGE_TYPES } from "../_shared/extraction/lease-financial-schedule/charges/financial-charge-types.ts";
import { normalizeFinancialChargeType } from "../_shared/extraction/lease-financial-schedule/charges/financial-charge-normalization.ts";
import { buildFinancialChargeRegistrySnapshotSql } from "../../../scripts/generate-financial-charge-registry.ts";

Deno.test("P4.4 financial charge registry: canonical charge vocabulary is complete and hashed", async () => {
  assertEquals(LEASE_FINANCIAL_CHARGE_REGISTRY_VERSION, "lease-financial-charges-v1");
  assertEquals(new Set(FINANCIAL_CHARGE_TYPES).size, FINANCIAL_CHARGE_TYPES.length);
  assertEquals(new Set(FINANCIAL_CHARGE_REGISTRY.map((entry) => entry.chargeType)).size, FINANCIAL_CHARGE_TYPES.length);
  for (const type of FINANCIAL_CHARGE_TYPES) assert(getFinancialChargeRegistryEntry(type));
  assertEquals(await computeFinancialChargeRegistryHash(), LEASE_FINANCIAL_CHARGE_REGISTRY_HASH);
  assertEquals(LEASE_FINANCIAL_CHARGE_REGISTRY_HASH, "9339d825b1656e60d311535e3a124218c961d5cb2af2509132f6d04c4550699c");
});

Deno.test("P4.4 financial charge registry: selected roles prevent base-rent conflation", () => {
  assertEquals(getFinancialChargeRegistryEntry("security_deposit")?.financialRole, "escrow_or_deposit");
  assertEquals(getFinancialChargeRegistryEntry("tenant_improvement_allowance")?.financialRole, "landlord_payable");
  assertEquals(getFinancialChargeRegistryEntry("cam_estimate")?.representsEstimate, true);
  assertEquals(FINANCIAL_CHARGE_REGISTRY.some((entry) => entry.belongsToBaseRentSchedules), false);
});

Deno.test("P4.4 normalization: aliases map but unknowns do not default to additional rent", () => {
  assertEquals(normalizeFinancialChargeType("CAM"), "cam_estimate");
  assertEquals(normalizeFinancialChargeType("TI Allowance"), "tenant_improvement_allowance");
  assertEquals(normalizeFinancialChargeType("mystery fee not in registry"), null);
});

Deno.test("P4.4 registry generator: SQL snapshot is deterministic and stamped", async () => {
  const sql = await buildFinancialChargeRegistrySnapshotSql();
  assert(sql.includes("lease_financial_charge_registry_snapshots"));
  assert(sql.includes(LEASE_FINANCIAL_CHARGE_REGISTRY_HASH));
  assert(sql.includes("security_deposit"));
  assert(sql.includes("percentage_rent"));
  assertEquals(sql, await buildFinancialChargeRegistrySnapshotSql());
});

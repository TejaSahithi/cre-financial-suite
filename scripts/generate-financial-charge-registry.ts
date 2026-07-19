// @ts-nocheck
import {
  canonicalFinancialChargeRegistryPayload,
  computeFinancialChargeRegistryHash,
} from "../supabase/functions/_shared/extraction/lease-financial-schedule/charges/financial-charge-registry.ts";
import { LEASE_FINANCIAL_CHARGE_REGISTRY_VERSION } from "../supabase/functions/_shared/extraction/lease-financial-schedule/charges/financial-charge-registry-version.ts";

function sqlString(value: unknown): string {
  return `'${String(value ?? "").replaceAll("'", "''")}'`;
}

export async function buildFinancialChargeRegistrySnapshotSql(): Promise<string> {
  const hash = await computeFinancialChargeRegistryHash();
  const rows = canonicalFinancialChargeRegistryPayload().map((entry) => [
    sqlString(entry.registryVersion),
    sqlString(hash),
    sqlString(entry.chargeType),
    sqlString(entry.displayName),
    sqlString(entry.chargeDomain),
    sqlString(entry.financialRole),
    `ARRAY[${entry.permittedAmountRoles.map(sqlString).join(", ")}]::TEXT[]`,
    `ARRAY[${entry.permittedFrequencies.map(sqlString).join(", ")}]::TEXT[]`,
    entry.periodAllowed,
    entry.formulaAllowed,
    entry.amortizationAllowed,
    entry.tenantPayable,
    entry.landlordPayable,
    entry.representsEstimate,
    entry.belongsToBaseRentSchedules,
    entry.p5ProcessingRequired,
  ].join(", "));

  return [
    `INSERT INTO public.lease_financial_charge_registry_snapshots (registry_version, registry_hash) VALUES (${sqlString(LEASE_FINANCIAL_CHARGE_REGISTRY_VERSION)}, ${sqlString(hash)}) ON CONFLICT (registry_version) DO NOTHING;`,
    "INSERT INTO public.lease_financial_charge_registry_entries (registry_version, registry_hash, charge_type, display_name, charge_domain, financial_role, permitted_amount_roles, permitted_frequencies, period_allowed, formula_allowed, amortization_allowed, tenant_payable, landlord_payable, represents_estimate, belongs_to_base_rent_schedules, p5_processing_required) VALUES",
    rows.map((row) => `  (${row})`).join(",\n"),
    "ON CONFLICT (registry_version, charge_type) DO NOTHING;",
  ].join("\n");
}

if (import.meta.main) {
  console.log(await buildFinancialChargeRegistrySnapshotSql());
}

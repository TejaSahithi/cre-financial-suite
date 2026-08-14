import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { calculateAdditionalRentReconciliation, deterministicChargeKey } from "../_shared/additional-rent-reconciliation/additional-rent-reconciliation.ts";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function line(overrides: Record<string, unknown> = {}) {
  const sourceRecordId = String(overrides.source_record_id || uuid(1));
  const role = String(overrides.role || "actual");
  const base = {
    role,
    charge_type: "cam",
    authoritative_table: "cam_run_lease_results",
    source_record_id: sourceRecordId,
    source_period: "2026-01-01:2026-12-31",
    period_start: "2026-01-01",
    period_end: "2026-12-31",
    amount: 10000,
    status: "posted",
    explanation: "test source",
  };
  const row = { ...base, ...overrides };
  return { ...row, charge_key: overrides.charge_key || deterministicChargeKey(row) };
}

Deno.test("additional rent reconciliation returns tenant owes", () => {
  const result = calculateAdditionalRentReconciliation({
    period_start: "2026-01-01",
    period_end: "2026-12-31",
    lines: [
      line({ role: "actual", amount: 12000, source_record_id: uuid(1) }),
      line({ role: "billed", amount: 10000, source_record_id: uuid(1) }),
    ],
  });
  assertEquals(result.status, "calculated");
  assertEquals(result.final_balance, 2000);
  assertEquals(result.balance_disposition, "tenant_due");
});

Deno.test("additional rent reconciliation returns tenant credit and zero balance", () => {
  const credit = calculateAdditionalRentReconciliation({ lines: [
    line({ role: "actual", amount: 9000, source_record_id: uuid(2) }),
    line({ role: "billed", amount: 10000, source_record_id: uuid(2) }),
  ] });
  assertEquals(credit.final_balance, -1000);
  assertEquals(credit.balance_disposition, "tenant_credit");

  const settled = calculateAdditionalRentReconciliation({ lines: [
    line({ role: "actual", amount: 10000, source_record_id: uuid(3) }),
    line({ role: "billed", amount: 10000, source_record_id: uuid(3) }),
  ] });
  assertEquals(settled.final_balance, 0);
  assertEquals(settled.balance_disposition, "settled");
});

Deno.test("additional rent reconciliation consumes CAM, management fee, percentage rent and explicit adjustment", () => {
  const result = calculateAdditionalRentReconciliation({ lines: [
    line({ role: "actual", charge_type: "cam", amount: 12000, source_record_id: uuid(4), authoritative_table: "cam_run_lease_results", status: "posted" }),
    line({ role: "billed", charge_type: "cam", amount: 11000, source_record_id: uuid(4), authoritative_table: "cam_run_lease_results", status: "posted" }),
    line({ role: "actual", charge_type: "management_fee", amount: 5040, source_record_id: uuid(5), authoritative_table: "lease_charge_calculations", status: "approved" }),
    line({ role: "billed", charge_type: "management_fee", amount: 5000, source_record_id: uuid(6), authoritative_table: "billing_adjustments", status: "approved" }),
    line({ role: "actual", charge_type: "percentage_rent", amount: 1500, source_record_id: uuid(7), authoritative_table: "percentage_rent_calculations", status: "approved" }),
    line({ role: "billed", charge_type: "percentage_rent", amount: 1000, source_record_id: uuid(8), authoritative_table: "billing_adjustments", status: "approved" }),
    line({ role: "adjustment", charge_type: "reconciliation_adjustment", amount: 250, source_record_id: uuid(9), authoritative_table: "approved_adjustments", status: "approved" }),
    line({ role: "credit", charge_type: "reconciliation_credit", amount: 100, source_record_id: uuid(10), authoritative_table: "approved_credits", status: "approved" }),
  ] });
  assertEquals(result.status, "calculated");
  assertEquals(result.totals.actual_responsibility, 18540);
  assertEquals(result.final_balance, 1690);
});

Deno.test("additional rent reconciliation blocks duplicate charge keys and duplicate authoritative source usage", () => {
  const duplicateKey = "actual:cam:cam_run_lease_results:duplicate:2026";
  const result = calculateAdditionalRentReconciliation({ lines: [
    line({ role: "actual", amount: 1000, source_record_id: uuid(11), charge_key: duplicateKey }),
    line({ role: "actual", amount: 1000, source_record_id: uuid(11), charge_key: duplicateKey }),
    line({ role: "billed", amount: 1000, source_record_id: uuid(12) }),
  ] });
  assertEquals(result.status, "blocked");
  assert(result.reason_codes.some((code: string) => code.startsWith("DUPLICATE_CHARGE_KEY")));
  assert(result.reason_codes.some((code: string) => code.startsWith("DUPLICATE_SOURCE")));
});

Deno.test("additional rent reconciliation blocks taxes and insurance when CAM recovery is already present", () => {
  const result = calculateAdditionalRentReconciliation({ lines: [
    line({ role: "actual", charge_type: "cam", amount: 12000, source_record_id: uuid(13), authoritative_table: "cam_run_lease_results" }),
    line({ role: "billed", charge_type: "cam", amount: 10000, source_record_id: uuid(13), authoritative_table: "cam_run_lease_results" }),
    line({ role: "actual", charge_type: "real_estate_taxes", amount: 3000, source_record_id: uuid(14), authoritative_table: "lease_charge_calculations" }),
    line({ role: "billed", charge_type: "real_estate_taxes", amount: 3000, source_record_id: uuid(15), authoritative_table: "billing_adjustments" }),
    line({ role: "actual", charge_type: "property_insurance", amount: 2000, source_record_id: uuid(16), authoritative_table: "lease_charge_calculations" }),
    line({ role: "billed", charge_type: "property_insurance", amount: 2000, source_record_id: uuid(17), authoritative_table: "billing_adjustments" }),
  ] });
  assertEquals(result.status, "blocked");
  assert(result.reason_codes.includes("DOUBLE_COUNT_CAM_COMPONENT:real_estate_taxes"));
  assert(result.reason_codes.includes("DOUBLE_COUNT_CAM_COMPONENT:property_insurance"));
  assertEquals(result.totals.actual_responsibility, 12000);
});

Deno.test("additional rent reconciliation blocks missing billed and unapproved charge inputs", () => {
  const result = calculateAdditionalRentReconciliation({ lines: [
    line({ role: "actual", charge_type: "management_fee", amount: 5040, source_record_id: uuid(18), authoritative_table: "lease_charge_calculations", status: "calculated" }),
  ] });
  assertEquals(result.status, "blocked");
  assert(result.reason_codes.includes("BILLED_AMOUNT_MISSING:management_fee"));
  assert(result.reason_codes.includes("UNAPPROVED_CHARGE:management_fee"));
});

Deno.test("additional rent reconciliation freezes historical source evidence", () => {
  const source: any = line({ role: "actual", amount: 12000, source_record_id: uuid(19), source_snapshot: { amount: 12000 } });
  const billed = line({ role: "billed", amount: 10000, source_record_id: uuid(19), source_snapshot: { amount: 10000 } });
  const result = calculateAdditionalRentReconciliation({ lines: [source, billed] });
  source.amount = 999999;
  source.source_snapshot.amount = 999999;
  assertEquals(result.input_snapshot.lines[0].amount, 12000);
  assertEquals(result.input_snapshot.lines[0].source_snapshot.amount, 12000);
});


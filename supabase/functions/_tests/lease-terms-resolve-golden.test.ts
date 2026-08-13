import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveLeaseTerms } from "../_shared/lease-terms/resolve.ts";
import type {
  LeaseTermsSnapshot,
  RentScheduleRow,
} from "../_shared/lease-terms/contracts/resolved-lease-terms.ts";

function rentRow(overrides: Partial<RentScheduleRow> = {}): RentScheduleRow {
  return {
    id: "rent-row-1",
    row_type: "base_rent",
    phase: "contracted",
    period_start: "2026-01-01",
    period_end: "2026-12-31",
    monthly_amount: 1000,
    annual_amount: 12000,
    rsf: 1000,
    status: "approved",
    is_abatement: false,
    abatement_percent: null,
    building_id: "building-1",
    unit_id: "unit-1",
    approved_at: "2025-12-15T00:00:00Z",
    approved_by: "reviewer-1",
    ...overrides,
  };
}

function snapshot(overrides: Partial<LeaseTermsSnapshot> = {}): LeaseTermsSnapshot {
  return {
    leaseId: "lease-1",
    orgId: "org-1",
    propertyId: "property-1",
    unitId: "unit-1",
    abstractVersion: 2,
    approvedAt: "2025-12-15T00:00:00Z",
    sourceDocumentId: "document-1",
    approvedFields: {
      management_fee_basis: {
        value: "tenant_annualized_rent",
        source_page: 5,
        source_text: "Management fee is five percent of annual rent.",
        reviewer: "reviewer-1",
        reviewed_at: "2025-12-15T00:00:00Z",
      },
    },
    rentScheduleRows: [rentRow()],
    expenseRuleSet: { id: "rule-set-1", status: "approved", approvedAt: "2025-12-15T00:00:00Z" },
    ...overrides,
  };
}

Deno.test("resolveLeaseTerms resolves a single approved base rent row", () => {
  const result = resolveLeaseTerms(snapshot(), "2026-06-15");
  assertEquals(result.rent?.monthlyAmount, 1000);
  assertEquals(result.rent?.annualAmount, 12000);
  assertEquals(result.premises?.rsf, 1000);
  assertEquals(result.expenseRecovery?.status, "approved");
});

Deno.test("resolveLeaseTerms uses the row effective on the as-of date", () => {
  const result = resolveLeaseTerms(snapshot({
    rentScheduleRows: [
      rentRow({ id: "first-half", period_start: "2026-01-01", period_end: "2026-06-30", monthly_amount: 1000, annual_amount: 12000 }),
      rentRow({ id: "second-half", period_start: "2026-07-01", period_end: "2026-12-31", monthly_amount: 1200, annual_amount: 14400 }),
    ],
  }), "2026-08-01");

  assertEquals(result.rent?.monthlyAmount, 1200);
  assertEquals(result.rent?.annualAmount, 14400);
  assertEquals(result.sourceEvidence.some((entry) => entry.rentScheduleId === "second-half"), true);
});

Deno.test("resolveLeaseTerms reports gaps and never guesses rent", () => {
  const result = resolveLeaseTerms(snapshot(), "2027-01-15");
  assertEquals(result.rent, null);
  assertEquals(result.unresolvedTerms.some((entry) => entry.code === "RENT_SCHEDULE_GAP"), true);
});

Deno.test("resolveLeaseTerms blocks overlapping approved base rows", () => {
  const result = resolveLeaseTerms(snapshot({
    rentScheduleRows: [
      rentRow({ id: "row-a", period_start: "2026-01-01", period_end: "2026-12-31" }),
      rentRow({ id: "row-b", period_start: "2026-06-01", period_end: "2026-12-31", monthly_amount: 1100 }),
    ],
  }), "2026-07-01");

  assertEquals(result.rent, null);
  assertEquals(result.unresolvedTerms.some((entry) => entry.code === "RENT_SCHEDULE_OVERLAP"), true);
});

Deno.test("resolveLeaseTerms applies abatement rows without false overlap", () => {
  const result = resolveLeaseTerms(snapshot({
    rentScheduleRows: [
      rentRow(),
      rentRow({
        id: "abatement-1",
        row_type: "abatement",
        monthly_amount: 0,
        annual_amount: 0,
        is_abatement: true,
        abatement_percent: 100,
      }),
    ],
  }), "2026-03-01");

  assertEquals(result.rent?.monthlyAmount, 1000);
  assertEquals(result.rent?.abatementApplied?.percent, 100);
});

Deno.test("resolveLeaseTerms ignores draft and superseded rent rows", () => {
  const result = resolveLeaseTerms(snapshot({
    rentScheduleRows: [
      rentRow({ id: "draft-row", monthly_amount: 500, status: "draft" }),
      rentRow({ id: "superseded-row", monthly_amount: 700, status: "superseded" }),
      rentRow({ id: "approved-row", monthly_amount: 1000 }),
    ],
  }), "2026-06-15");

  assertEquals(result.rent?.monthlyAmount, 1000);
});

Deno.test("resolveLeaseTerms does not expose pre-approval terms", () => {
  const result = resolveLeaseTerms(snapshot(), "2025-01-01");
  assertEquals(result.rent, null);
  assertEquals(result.unresolvedTerms[0].code, "LEASE_NOT_YET_APPROVED_AS_OF_DATE");
});

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveLeaseTerms } from "../_shared/lease-terms/resolve.ts";
import type { LeaseTermsSnapshot, RentScheduleRow } from "../_shared/lease-terms/contracts/resolved-lease-terms.ts";

let seq = 0;
const uid = (prefix: string) => `${prefix}-${++seq}`;

function rentRow(overrides: Partial<RentScheduleRow> = {}): RentScheduleRow {
  return {
    id: uid("rent"),
    row_type: "base_rent",
    phase: "contracted",
    period_start: "2026-01-01",
    period_end: "2026-12-31",
    monthly_amount: 10000,
    annual_amount: 120000,
    rsf: 5000,
    status: "approved",
    is_abatement: false,
    abatement_percent: null,
    building_id: "building-1",
    unit_id: "unit-1",
    approved_at: "2026-01-05T00:00:00Z",
    approved_by: "reviewer@example.test",
    source: "approved_abstract",
    ...overrides,
  };
}

function snapshot(overrides: Partial<LeaseTermsSnapshot> = {}): LeaseTermsSnapshot {
  return {
    leaseId: "lease-1",
    orgId: "org-1",
    propertyId: "property-1",
    unitId: "unit-1",
    abstractVersion: 1,
    approvedAt: "2026-01-05T00:00:00Z",
    approvedFields: {},
    sourceDocumentId: "doc-1",
    rentScheduleRows: [rentRow()],
    expenseRuleSet: { id: "rule-set-1", status: "approved", approvedAt: "2026-01-05T00:00:00Z" },
    ...overrides,
  };
}

Deno.test("resolveLeaseTerms: happy path resolves a single approved rent row", () => {
  const result = resolveLeaseTerms(snapshot(), "2026-06-15");
  assertEquals(result.rent?.monthlyAmount, 10000);
  assertEquals(result.rent?.periodStart, "2026-01-01");
  assertEquals(result.rent?.effectiveDatingSupported, true);
  assertEquals(result.premises?.buildingId, "building-1");
  assertEquals(result.premises?.rsf, 5000);
  assertEquals(result.premises?.effectiveDatingSupported, true);
  assertEquals(result.unresolvedTerms.some((u) => u.code === "RENT_SCHEDULE_GAP"), false);
});

Deno.test("resolveLeaseTerms: rent evidence cites the lease-level rent field's document for an approved_abstract row", () => {
  const result = resolveLeaseTerms(
    snapshot({
      sourceDocumentId: "doc-42",
      approvedFields: {
        monthly_rent: {
          value: "10000",
          source_page: 3,
          source_text: "Base Rent: $10,000/month",
          reviewer: "reviewer@example.test",
          reviewed_at: "2026-01-05T00:00:00Z",
        },
      },
    }),
    "2026-06-15",
  );
  const rentEvidenceEntry = result.sourceEvidence.find((e) => e.kind === "rent_schedule_row");
  assertEquals(rentEvidenceEntry?.scheduleSource, "approved_abstract");
  assertEquals(rentEvidenceEntry?.documentId, "doc-42");
  assertEquals(rentEvidenceEntry?.sourcePage, 3);
  assertEquals(rentEvidenceEntry?.sourceText, "Base Rent: $10,000/month");
});

Deno.test("resolveLeaseTerms: manual rent schedule rows carry no document evidence, even if a rent field exists", () => {
  const rows = [rentRow({ source: "manual" })];
  const result = resolveLeaseTerms(
    snapshot({
      rentScheduleRows: rows,
      approvedFields: {
        monthly_rent: { value: "10000", source_page: 3, source_text: "irrelevant", reviewer: null, reviewed_at: null },
      },
    }),
    "2026-06-15",
  );
  const rentEvidenceEntry = result.sourceEvidence.find((e) => e.kind === "rent_schedule_row");
  assertEquals(rentEvidenceEntry?.scheduleSource, "manual");
  assertEquals(rentEvidenceEntry?.documentId, null);
  assertEquals(rentEvidenceEntry?.sourcePage, null);
  assertEquals(rentEvidenceEntry?.sourceText, null);
});

Deno.test("resolveLeaseTerms: premises effectiveDatingSupported is true only when the rent schedule itself resolved", () => {
  const resolved = resolveLeaseTerms(snapshot(), "2026-06-15");
  assertEquals(resolved.premises?.effectiveDatingSupported, true);

  const gapped = resolveLeaseTerms(snapshot(), "2027-06-15");
  assertEquals(gapped.premises?.effectiveDatingSupported, false);
  assertEquals(gapped.premises?.propertyId, "property-1");
  assertEquals(gapped.premises?.buildingId, null);
});

Deno.test("resolveLeaseTerms: mid-year rent change resolves each period correctly", () => {
  const rows = [
    rentRow({ period_start: "2026-01-01", period_end: "2026-06-30", monthly_amount: 10000, annual_amount: 60000 }),
    rentRow({ period_start: "2026-07-01", period_end: "2026-12-31", monthly_amount: 11000, annual_amount: 66000 }),
  ];
  const snap = snapshot({ rentScheduleRows: rows });

  const first = resolveLeaseTerms(snap, "2026-03-01");
  assertEquals(first.rent?.monthlyAmount, 10000);

  const second = resolveLeaseTerms(snap, "2026-09-01");
  assertEquals(second.rent?.monthlyAmount, 11000);
});

Deno.test("resolveLeaseTerms: gap in rent schedule is reported, never guessed", () => {
  const result = resolveLeaseTerms(snapshot(), "2027-06-15");
  assertEquals(result.rent, null);
  assertEquals(result.unresolvedTerms.some((u) => u.term === "rent" && u.code === "RENT_SCHEDULE_GAP"), true);
});

Deno.test("resolveLeaseTerms: overlapping approved base rows are flagged, not silently picked", () => {
  const rows = [
    rentRow({ id: "rent-a", period_start: "2026-01-01", period_end: "2026-12-31" }),
    rentRow({ id: "rent-b", period_start: "2026-01-01", period_end: "2026-12-31" }),
  ];
  const result = resolveLeaseTerms(snapshot({ rentScheduleRows: rows }), "2026-06-15");
  assertEquals(result.rent, null);
  assertEquals(result.unresolvedTerms.some((u) => u.term === "rent" && u.code === "RENT_SCHEDULE_OVERLAP"), true);
});

Deno.test("resolveLeaseTerms: abatement row overlays base rent instead of causing a false overlap", () => {
  const rows = [
    rentRow({ id: "rent-base", period_start: "2026-01-01", period_end: "2026-12-31", monthly_amount: 10000 }),
    rentRow({
      id: "rent-abate",
      row_type: "abatement",
      is_abatement: true,
      period_start: "2026-01-01",
      period_end: "2026-02-28",
      abatement_percent: 100,
      monthly_amount: 0,
    }),
  ];
  const result = resolveLeaseTerms(snapshot({ rentScheduleRows: rows }), "2026-01-15");
  assertEquals(result.rent?.monthlyAmount, 10000);
  assertEquals(result.rent?.abatementApplied, { percent: 100, monthlyAmount: 0 });
  assertEquals(result.unresolvedTerms.some((u) => u.code === "RENT_SCHEDULE_OVERLAP"), false);
});

Deno.test("resolveLeaseTerms: percentage rent row coexists without causing a false overlap", () => {
  const rows = [
    rentRow({ id: "rent-base" }),
    rentRow({ id: "rent-pct", row_type: "percentage_rent", monthly_amount: null, annual_amount: null }),
  ];
  const result = resolveLeaseTerms(snapshot({ rentScheduleRows: rows }), "2026-06-15");
  assertEquals(result.rent?.rowType, "base_rent");
  assertEquals(result.unresolvedTerms.some((u) => u.code === "RENT_SCHEDULE_OVERLAP"), false);
  assertEquals(result.percentageRent, { hasScheduledPercentageRentRows: true, rowCount: 1, effectiveDatingSupported: false });
});

Deno.test("resolveLeaseTerms: draft and superseded rows are never selected", () => {
  const rows = [
    rentRow({ id: "rent-draft", status: "draft" }),
    rentRow({ id: "rent-superseded", status: "superseded" }),
  ];
  const result = resolveLeaseTerms(snapshot({ rentScheduleRows: rows }), "2026-06-15");
  assertEquals(result.rent, null);
  assertEquals(result.unresolvedTerms.some((u) => u.code === "RENT_SCHEDULE_GAP"), true);
});

Deno.test("resolveLeaseTerms: asOfDate before lease approval is wholly unresolved", () => {
  const result = resolveLeaseTerms(snapshot(), "2025-12-01");
  assertEquals(result.rent, null);
  assertEquals(result.premises, null);
  assertEquals(result.unresolvedTerms.some((u) => u.code === "LEASE_NOT_YET_APPROVED_AS_OF_DATE"), true);
});

Deno.test("resolveLeaseTerms: missing abstract fields surface as unresolved, not thrown errors", () => {
  const result = resolveLeaseTerms(snapshot({ approvedFields: {} }), "2026-06-15");
  assertEquals(result.managementFee, null);
  assertEquals(result.taxes, null);
  assertEquals(result.insurance, null);
  assertEquals(result.unresolvedTerms.some((u) => u.term === "managementFee" && u.code === "MANAGEMENT_FEE_NOT_FOUND"), true);
});

Deno.test("resolveLeaseTerms: approved abstract fields pass through with effectiveDatingSupported false", () => {
  const result = resolveLeaseTerms(
    snapshot({
      approvedFields: {
        management_fee_basis: {
          value: "annualized_tenant_rent",
          source_page: 4,
          source_text: "4% of Annual Rent",
          reviewer: "reviewer@example.test",
          reviewed_at: "2026-01-05T00:00:00Z",
        },
      },
    }),
    "2026-06-15",
  );
  assertEquals(result.managementFee, { management_fee_basis: "annualized_tenant_rent", effectiveDatingSupported: false });
  assertEquals(result.sourceEvidence.some((e) => e.kind === "abstract_field" && e.fieldKey === "management_fee_basis"), true);
});

Deno.test("resolveLeaseTerms: reporting requirements are always unresolved (not modeled in schema yet)", () => {
  const result = resolveLeaseTerms(snapshot(), "2026-06-15");
  assertEquals(result.reportingRequirements, null);
  assertEquals(
    result.unresolvedTerms.some((u) => u.term === "reportingRequirements" && u.code === "REPORTING_REQUIREMENTS_NOT_MODELED"),
    true,
  );
});

Deno.test("resolveLeaseTerms: missing expense rule set is a named exception, not a silent null", () => {
  const result = resolveLeaseTerms(snapshot({ expenseRuleSet: null }), "2026-06-15");
  assertEquals(result.expenseRecovery, null);
  assertEquals(result.cam, null);
  assertEquals(result.unresolvedTerms.some((u) => u.term === "expenseRecovery" && u.code === "EXPENSE_RECOVERY_NOT_FOUND"), true);
});

Deno.test("resolveLeaseTerms: draft expense rule set is surfaced but flagged not approved", () => {
  const result = resolveLeaseTerms(
    snapshot({ expenseRuleSet: { id: "rule-set-2", status: "draft", approvedAt: null } }),
    "2026-06-15",
  );
  assertEquals(result.expenseRecovery?.ruleSetId, "rule-set-2");
  assertEquals(result.expenseRecovery?.status, "draft");
  assertEquals(result.unresolvedTerms.some((u) => u.term === "expenseRecovery" && u.code === "EXPENSE_RECOVERY_NOT_APPROVED"), true);
});

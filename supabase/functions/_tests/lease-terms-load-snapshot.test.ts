// Mock-client style matches supabase/functions/_tests/approved-lease-expense-rules.test.ts:
// a chainable builder that ignores filter args and resolves to canned
// per-table data — no real DB required for this pure data-shape test.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { loadLeaseTermsSnapshot } from "../_shared/lease-terms/load-lease-terms-snapshot.ts";

function chain(result: any) {
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    order: () => builder,
    limit: () => builder,
    maybeSingle: () => Promise.resolve(result),
    then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject),
  };
  return builder;
}

function mockClient(tables: Record<string, any>) {
  return {
    from: (table: string) => {
      if (!(table in tables)) throw new Error(`Unexpected table in test: ${table}`);
      return chain(tables[table]);
    },
  };
}

Deno.test("loadLeaseTermsSnapshot: assembles a snapshot from leases + rent_schedules + rule sets", async () => {
  const client = mockClient({
    leases: {
      data: {
        id: "lease-1",
        org_id: "org-1",
        property_id: "property-1",
        unit_id: "unit-1",
        abstract_version: 2,
        abstract_snapshot: {
          approved_at: "2026-01-05T00:00:00Z",
          approved: { management_fee_basis: { value: "annualized_tenant_rent", source_page: 4 } },
          source_document: { uploaded_file_id: "doc-1" },
        },
      },
      error: null,
    },
    rent_schedules: {
      data: [{
        id: "rent-1", row_type: "base_rent", phase: "contracted",
        period_start: "2026-01-01", period_end: "2026-12-31",
        monthly_amount: 10000, annual_amount: 120000, rsf: 5000,
        status: "approved", is_abatement: false, abatement_percent: null,
        building_id: "building-1", unit_id: "unit-1",
        approved_at: "2026-01-05T00:00:00Z", approved_by: "reviewer@example.test",
        source: "approved_abstract",
      }],
      error: null,
    },
    lease_expense_rule_sets: {
      data: [{ id: "rule-set-1", status: "approved", approved_at: "2026-01-05T00:00:00Z" }],
      error: null,
    },
  });

  const snapshot = await loadLeaseTermsSnapshot(client, { orgId: "org-1", leaseId: "lease-1" });

  assertEquals(snapshot?.leaseId, "lease-1");
  assertEquals(snapshot?.abstractVersion, 2);
  assertEquals(snapshot?.approvedAt, "2026-01-05T00:00:00Z");
  assertEquals(snapshot?.rentScheduleRows.length, 1);
  assertEquals(snapshot?.rentScheduleRows[0].monthly_amount, 10000);
  assertEquals(snapshot?.rentScheduleRows[0].source, "approved_abstract");
  assertEquals(snapshot?.expenseRuleSet, { id: "rule-set-1", status: "approved", approvedAt: "2026-01-05T00:00:00Z" });
  assertEquals(snapshot?.approvedFields.management_fee_basis.value, "annualized_tenant_rent");
  assertEquals(snapshot?.sourceDocumentId, "doc-1");
});

Deno.test("loadLeaseTermsSnapshot: returns null for a lease outside the caller's org (cross-org isolation)", async () => {
  const client = mockClient({ leases: { data: null, error: null } });
  const snapshot = await loadLeaseTermsSnapshot(client, { orgId: "org-2", leaseId: "lease-1" });
  assertEquals(snapshot, null);
});

Deno.test("loadLeaseTermsSnapshot: no expense rule set yields a null pointer, not a thrown error", async () => {
  const client = mockClient({
    leases: {
      data: {
        id: "lease-1", org_id: "org-1", property_id: "property-1", unit_id: "unit-1",
        abstract_version: 1,
        abstract_snapshot: { approved_at: "2026-01-05T00:00:00Z", approved: {} },
      },
      error: null,
    },
    rent_schedules: { data: [], error: null },
    lease_expense_rule_sets: { data: [], error: null },
  });

  const snapshot = await loadLeaseTermsSnapshot(client, { orgId: "org-1", leaseId: "lease-1" });
  assertEquals(snapshot?.expenseRuleSet, null);
  assertEquals(snapshot?.rentScheduleRows, []);
});

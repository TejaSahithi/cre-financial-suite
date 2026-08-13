// Mock-client style is a chainable builder that ignores filter args and
// resolves to canned per-table data — no real DB required for this pure
// data-shape test. The optional per-table `calls` array borrows the
// call-recording pattern from supabase/functions/_tests/approved-lease-expense-rules.test.ts's
// "approved publication materializes..." test (a `calls: any[]` pushed to
// on each recorded invocation), needed for Fix 5's test since this mock
// otherwise can't distinguish "the query has the right filters" from
// "the query returns the right canned data regardless of its filters".
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { loadLeaseTermsSnapshot } from "../_shared/lease-terms/load-lease-terms-snapshot.ts";

function chain(result: any, calls?: any[]) {
  const record = (method: string, ...args: any[]) => {
    if (calls) calls.push([method, ...args]);
  };
  const builder: any = {
    select: (...args: any[]) => {
      record("select", ...args);
      return builder;
    },
    eq: (...args: any[]) => {
      record("eq", ...args);
      return builder;
    },
    neq: (...args: any[]) => {
      record("neq", ...args);
      return builder;
    },
    order: (...args: any[]) => {
      record("order", ...args);
      return builder;
    },
    limit: (...args: any[]) => {
      record("limit", ...args);
      return builder;
    },
    maybeSingle: () => Promise.resolve(result),
    then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject),
  };
  return builder;
}

function mockClient(tables: Record<string, any>, callsByTable?: Record<string, any[]>) {
  return {
    from: (table: string) => {
      if (!(table in tables)) throw new Error(`Unexpected table in test: ${table}`);
      return chain(tables[table], callsByTable?.[table]);
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
        abstract_version: 2,
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
  assertEquals(snapshot?.rentScheduleRows[0].abstract_version, 2);
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

Deno.test("loadLeaseTermsSnapshot: expense rule set query excludes archived sets and puts null versions last", async () => {
  const ruleSetCalls: any[] = [];
  const client = mockClient(
    {
      leases: {
        data: {
          id: "lease-1", org_id: "org-1", property_id: "property-1", unit_id: "unit-1",
          abstract_version: 1,
          abstract_snapshot: { approved_at: "2026-01-05T00:00:00Z", approved: {} },
        },
        error: null,
      },
      rent_schedules: { data: [], error: null },
      lease_expense_rule_sets: {
        data: [{ id: "rule-set-live", status: "approved", approved_at: "2026-01-05T00:00:00Z" }],
        error: null,
      },
    },
    { lease_expense_rule_sets: ruleSetCalls },
  );

  await loadLeaseTermsSnapshot(client, { orgId: "org-1", leaseId: "lease-1" });

  // Would fail if someone dropped the archived-exclusion filter or the
  // explicit nullsFirst:false ordering (the two things that let an
  // archived higher-version set, or a null-version row, shadow a live
  // approved one — see Fix 5 in the final review fix brief).
  assertEquals(
    ruleSetCalls.some((c) => c[0] === "neq" && c[1] === "status" && c[2] === "archived"),
    true,
  );
  assertEquals(
    ruleSetCalls.some((c) => c[0] === "order" && c[1] === "version" && c[2]?.ascending === false && c[2]?.nullsFirst === false),
    true,
  );
});

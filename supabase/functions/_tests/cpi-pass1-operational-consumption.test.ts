// @ts-nocheck
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveApprovedIndexAdjustment } from "../_shared/reference-data/approved-index-adjustment.ts";
import { generateObligationOccurrences } from "../_shared/obligations/obligation-engine.ts";

function mockSupabase(tables: Record<string, any[]>) {
  function query(table: string) {
    const state: any = { rows: [...(tables[table] || [])] };
    const api: any = {
      select() {
        return api;
      },
      eq(key: string, value: unknown) {
        state.rows = state.rows.filter((row: any) => row[key] === value);
        return api;
      },
      in(key: string, values: unknown[]) {
        state.rows = state.rows.filter((row: any) => values.includes(row[key]));
        return api;
      },
      order() {
        return api;
      },
      limit(count: number) {
        state.rows = state.rows.slice(0, count);
        return api;
      },
      then(resolve: (value: unknown) => void) {
        resolve({ data: state.rows, error: null });
      },
    };
    return api;
  }
  return { from: query };
}

function series(overrides = {}) {
  return {
    id: "series-selection-1",
    org_id: "org-a",
    lease_id: "lease-a",
    field_key: "rent_escalation",
    provider: "bls",
    series_id: "CUUR0000SA0",
    display_name: "CPI-U all items",
    status: "approved",
    approved_at: "2026-01-02T00:00:00Z",
    approved_by: "user-a",
    ...overrides,
  };
}

function observation(overrides = {}) {
  return {
    id: "obs-base",
    org_id: "org-a",
    provider: "bls",
    series_id: "CUUR0000SA0",
    period: "2025-12",
    value: 300,
    retrieved_at: "2026-01-02T01:00:00Z",
    source_url: "https://api.bls.gov/publicAPI/v2/timeseries/data/CUUR0000SA0",
    payload_fingerprint: "fp",
    status: "approved",
    approved_at: "2026-01-02T02:00:00Z",
    approved_by: "approver-a",
    ...overrides,
  };
}

function cpiRule(overrides = {}) {
  return {
    index_adjustment_applicable: true,
    index_adjustment_type: "cpi",
    index_source: "bls",
    index_base_period: "2025-12",
    index_current_period: "2026-12",
    ...overrides,
  };
}

Deno.test("Pass 1 CPI resolver consumes only approved selected series and observations", async () => {
  const supabase = mockSupabase({
    reference_series_selections: [series()],
    reference_observations: [
      observation({ id: "obs-base", period: "2025-12", value: 300 }),
      observation({ id: "obs-current", period: "2026-12", value: 315 }),
    ],
  });

  const resolved = await resolveApprovedIndexAdjustment(supabase, {
    orgId: "org-a",
    leaseId: "lease-a",
    rule: cpiRule(),
    fieldKeys: ["rent_escalation", "cpi"],
    chargeType: "cpi_rent_adjustment",
    baseAmount: 1000,
  });

  assertEquals(resolved.result.status, "calculated");
  assertEquals(resolved.result.amount, 1050);
  assertEquals(resolved.result.evidence.map((e: any) => e.observation_id), ["obs-base", "obs-current"]);
});

Deno.test("Pass 1 CPI resolver blocks unapproved or missing current observation", async () => {
  const supabase = mockSupabase({
    reference_series_selections: [series()],
    reference_observations: [observation({ id: "obs-base", period: "2025-12", value: 300 })],
  });

  const resolved = await resolveApprovedIndexAdjustment(supabase, {
    orgId: "org-a",
    leaseId: "lease-a",
    rule: cpiRule(),
    fieldKeys: ["rent_escalation", "cpi"],
    chargeType: "cpi_rent_adjustment",
    baseAmount: 1000,
  });

  assertEquals(resolved.result.status, "blocked");
  assertEquals(resolved.result.reasonCodes, ["CURRENT_REFERENCE_OBSERVATION_NOT_FOUND"]);
});

Deno.test("Pass 1 CPI resolver blocks ambiguous approved series", async () => {
  const supabase = mockSupabase({
    reference_series_selections: [
      series({ id: "series-1", series_id: "CUUR0000SA0" }),
      series({ id: "series-2", series_id: "CWUR0000SA0" }),
    ],
    reference_observations: [],
  });

  const resolved = await resolveApprovedIndexAdjustment(supabase, {
    orgId: "org-a",
    leaseId: "lease-a",
    rule: cpiRule({ index_source: null }),
    fieldKeys: ["rent_escalation", "cpi"],
    chargeType: "cpi_rent_adjustment",
    baseAmount: 1000,
  });

  assertEquals(resolved.result.status, "blocked");
  assertEquals(resolved.result.reasonCodes, ["REFERENCE_SERIES_AMBIGUOUS"]);
});

Deno.test("Pass 1 CPI resolver keeps historical calculation bound to original observation IDs", async () => {
  const baseTables = {
    reference_series_selections: [series()],
    reference_observations: [
      observation({ id: "obs-base", period: "2025-12", value: 300 }),
      observation({ id: "obs-current", period: "2026-12", value: 315 }),
      observation({ id: "obs-later", period: "2027-12", value: 330 }),
    ],
  };
  const first = await resolveApprovedIndexAdjustment(mockSupabase(baseTables), {
    orgId: "org-a",
    leaseId: "lease-a",
    rule: cpiRule(),
    fieldKeys: ["rent_escalation", "cpi"],
    chargeType: "cpi_rent_adjustment",
    baseAmount: 1000,
  });
  const replay = await resolveApprovedIndexAdjustment(mockSupabase(baseTables), {
    orgId: "org-a",
    leaseId: "lease-a",
    rule: cpiRule(),
    fieldKeys: ["rent_escalation", "cpi"],
    chargeType: "cpi_rent_adjustment",
    baseAmount: 1000,
  });

  assertEquals(first.result.amount, 1050);
  assertEquals(replay.result.evidence.map((e: any) => e.observation_id), ["obs-base", "obs-current"]);
});

Deno.test("Pass 1 obligations generate reconciliation statement deadline after year end", () => {
  const rows = generateObligationOccurrences({
    obligation: {
      id: "obl-1",
      org_id: "org-a",
      lease_id: "lease-a",
      property_id: "property-a",
      obligation_type: "reconciliation_statement",
      due_rule: { rule_type: "statement_due_after_year_end", days_after_year_end: 90 },
      status: "active",
    },
    windowStart: "2027-01-01",
    windowEnd: "2027-04-30",
    asOfDate: "2027-01-15",
  });

  assertEquals(rows.length, 1);
  assertEquals(rows[0].period_end, "2026-12-31");
  assertEquals(rows[0].due_date, "2027-03-31");
  assertEquals(rows[0].idempotency_key, "obl-1:statement_due_after_year_end:2026:2027-03-31");
});

Deno.test("Pass 1 obligations generate tenant liability cutoff and preserve late-statement rule", () => {
  const rows = generateObligationOccurrences({
    obligation: {
      id: "obl-2",
      org_id: "org-a",
      lease_id: "lease-a",
      property_id: "property-a",
      obligation_type: "tenant_liability_cutoff",
      due_rule: {
        rule_type: "tenant_liability_cutoff",
        statement_date: "2027-03-31",
        period_start: "2026-01-01",
        period_end: "2026-12-31",
        months_after_statement: 6,
        survives_late_statement: true,
      },
      status: "active",
    },
    windowStart: "2027-09-01",
    windowEnd: "2027-10-31",
    asOfDate: "2027-09-15",
  });

  assertEquals(rows.length, 1);
  assertEquals(rows[0].period_start, "2026-01-01");
  assertEquals(rows[0].due_date, "2027-10-01");
  assertEquals(rows[0].status, "open");
});

Deno.test("Pass 1 obligations fail ambiguous reconciliation deadline closed into review occurrence", () => {
  const rows = generateObligationOccurrences({
    obligation: {
      id: "obl-3",
      org_id: "org-a",
      obligation_type: "tenant_liability_cutoff",
      due_rule: { rule_type: "tenant_liability_cutoff", months_after_statement: 6 },
      status: "active",
    },
    windowStart: "2027-01-01",
    windowEnd: "2027-12-31",
  });

  assertEquals(rows.length, 1);
  assertEquals(rows[0].status, "pending_review");
  assertEquals(rows[0].idempotency_key, "obl-3:review_required:2027-01-01");
});


Deno.test("Pass 1 CPI resolver enforces cross-org reference isolation", async () => {
  const supabase = mockSupabase({
    reference_series_selections: [series({ org_id: "org-b" })],
    reference_observations: [
      observation({ org_id: "org-b", id: "obs-base", period: "2025-12", value: 300 }),
      observation({ org_id: "org-b", id: "obs-current", period: "2026-12", value: 315 }),
    ],
  });

  const resolved = await resolveApprovedIndexAdjustment(supabase, {
    orgId: "org-a",
    leaseId: "lease-a",
    rule: cpiRule(),
    fieldKeys: ["rent_escalation", "cpi"],
    chargeType: "cpi_rent_adjustment",
    baseAmount: 1000,
  });

  assertEquals(resolved.result.status, "blocked");
  assertEquals(resolved.result.reasonCodes, ["REFERENCE_SERIES_APPROVAL_REQUIRED"]);
});


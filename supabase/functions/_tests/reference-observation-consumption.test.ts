import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  createStaticReferenceDataProvider,
  resolveReferenceObservation,
} from "../_shared/reference-data/reference-data-provider.ts";
import {
  evaluateIndexAdjustedLeaseCharge,
  freezeApprovedReferenceObservation,
  selectApprovedReferenceObservation,
  type ReferenceObservationRow,
} from "../_shared/reference-data/reference-observation-consumption.ts";

function observation(overrides: Partial<ReferenceObservationRow> = {}): ReferenceObservationRow {
  return {
    id: "obs-1",
    org_id: "org-a",
    provider: "bls",
    series_id: "CUUR0000SA0",
    period: "2026-06",
    value: 321.5,
    retrieved_at: "2026-08-13T10:00:00Z",
    source_url: "https://api.bls.gov/publicAPI/v2/timeseries/data/CUUR0000SA0",
    payload_fingerprint: "fnv1a32:test",
    status: "approved",
    approved_at: "2026-08-13T12:00:00Z",
    approved_by: "user-a",
    ...overrides,
  };
}

Deno.test("approved observation freezes required CPI provenance into calculation evidence", () => {
  const base = freezeApprovedReferenceObservation(observation({ id: "base-obs", period: "2025-06", value: 300 }));
  const current = freezeApprovedReferenceObservation(observation({ id: "current-obs", period: "2026-06", value: 315 }));

  if (!base.ok || !current.ok) throw new Error("expected approved observations");
  const result = evaluateIndexAdjustedLeaseCharge({
    chargeType: "management_fee",
    leaseId: "lease-a",
    periodStart: "2026-01-01",
    periodEnd: "2026-12-31",
    baseAmount: 1000,
    baseObservation: base.observation,
    currentObservation: current.observation,
  });

  assertEquals(result.status, "calculated");
  assertEquals(result.amount, 1050);
  assertEquals((result.evidence[0] as any).observation_id, "base-obs");
  assertEquals((result.evidence[0] as any).provider, "bls");
  assertEquals((result.evidence[0] as any).provider_series_id, "CUUR0000SA0");
  assertEquals((result.evidence[0] as any).period, "2025-06");
  assertEquals((result.evidence[0] as any).value, 300);
  assertEquals((result.evidence[0] as any).retrieved_at, "2026-08-13T10:00:00Z");
  assertEquals((result.evidence[0] as any).approved_at, "2026-08-13T12:00:00Z");
  assertEquals((result.evidence[0] as any).approved_by, "user-a");
});

Deno.test("unapproved observation blocks CPI-dependent calculation input", () => {
  const selected = freezeApprovedReferenceObservation(observation({ status: "pending_review" }));
  assertEquals(selected.ok, false);
  assertEquals(selected.reasonCodes, ["REFERENCE_OBSERVATION_NOT_APPROVED"]);
});

Deno.test("ambiguous CPI series requires human selection and does not resolve an observation", async () => {
  const provider = createStaticReferenceDataProvider({
    series: [
      { provider: "bls", seriesId: "CUUR0000SA0", displayName: "CPI-U all items" },
      { provider: "bls", seriesId: "CWUR0000SA0", displayName: "CPI-W all items" },
    ],
    observations: [],
  });
  const result = await resolveReferenceObservation(provider, {
    provider: "bls",
    seriesHint: "CPI",
    period: "2026-06",
  });
  assertEquals(result.status, "requires_review");
  assertEquals(result.reasonCodes, ["REFERENCE_SERIES_AMBIGUOUS"]);
});

Deno.test("missing reference period blocks observation selection", () => {
  const selected = selectApprovedReferenceObservation([observation()], {
    orgId: "org-a",
    provider: "bls",
    seriesId: "CUUR0000SA0",
    period: "",
  });
  assertEquals(selected.ok, false);
  assertEquals(selected.reasonCodes, ["REFERENCE_PERIOD_REQUIRED"]);
});

Deno.test("duplicate observations for the same org/provider/series/period block consumption", () => {
  const selected = selectApprovedReferenceObservation([
    observation({ id: "obs-1" }),
    observation({ id: "obs-2" }),
  ], {
    orgId: "org-a",
    provider: "bls",
    seriesId: "CUUR0000SA0",
    period: "2026-06",
  });
  assertEquals(selected.ok, false);
  assertEquals(selected.reasonCodes, ["REFERENCE_OBSERVATION_DUPLICATE"]);
});

Deno.test("frozen approved observations keep historical CPI calculations reproducible", () => {
  const base = freezeApprovedReferenceObservation(observation({ id: "base-obs", period: "2025-06", value: 300 }));
  const current = freezeApprovedReferenceObservation(observation({ id: "current-obs", period: "2026-06", value: 315 }));
  const laterFetchedCurrent = freezeApprovedReferenceObservation(observation({ id: "later-obs", period: "2026-06", value: 330 }));
  if (!base.ok || !current.ok || !laterFetchedCurrent.ok) throw new Error("expected approved observations");

  const original = evaluateIndexAdjustedLeaseCharge({
    chargeType: "management_fee",
    baseAmount: 1000,
    baseObservation: base.observation,
    currentObservation: current.observation,
  });
  const replay = evaluateIndexAdjustedLeaseCharge({
    chargeType: "management_fee",
    baseAmount: 1000,
    baseObservation: base.observation,
    currentObservation: current.observation,
  });

  assertEquals(original.amount, 1050);
  assertEquals(replay.amount, 1050);
  assertEquals(laterFetchedCurrent.observation.value, 330);
});

Deno.test("cross-org observation rows are not eligible for Org A CPI consumption", () => {
  const selected = selectApprovedReferenceObservation([
    observation({ org_id: "org-b" }),
  ], {
    orgId: "org-a",
    provider: "bls",
    seriesId: "CUUR0000SA0",
    period: "2026-06",
  });
  assertEquals(selected.ok, false);
  assertEquals(selected.reasonCodes, ["REFERENCE_OBSERVATION_NOT_FOUND"]);
});

Deno.test("approved observation provider and series must match the approved series selection", () => {
  const approvedSelection = { org_id: "org-a", provider: "bls", series_id: "CUUR0000SA0" };
  const matched = selectApprovedReferenceObservation([observation()], {
    orgId: approvedSelection.org_id,
    provider: approvedSelection.provider,
    seriesId: approvedSelection.series_id,
    period: "2026-06",
  });
  const mismatched = selectApprovedReferenceObservation([observation({ series_id: "CWUR0000SA0" })], {
    orgId: approvedSelection.org_id,
    provider: approvedSelection.provider,
    seriesId: approvedSelection.series_id,
    period: "2026-06",
  });

  assertEquals(matched.ok, true);
  assertEquals(mismatched.ok, false);
  assertEquals(mismatched.reasonCodes, ["REFERENCE_OBSERVATION_NOT_FOUND"]);
});

Deno.test({
  name: "reference observations are uniquely constrained by org provider series and period",
  permissions: { read: [new URL("../../migrations/20269900000071_major_client_financial_domains.sql", import.meta.url)] },
  async fn() {
    const sql = await Deno.readTextFile(new URL("../../migrations/20269900000071_major_client_financial_domains.sql", import.meta.url));
    assertEquals(/UNIQUE \(org_id, provider, series_id, period\)/i.test(sql), true);
    assertEquals(/CREATE POLICY reference_observations_select[\s\S]*public\.(is_member_of_org\(org_id\)|get_my_org_ids\(\))/i.test(sql), true);
    assertEquals(/CREATE POLICY reference_series_selections_select[\s\S]*public\.(is_member_of_org\(org_id\)|get_my_org_ids\(\))/i.test(sql), true);
  },
});

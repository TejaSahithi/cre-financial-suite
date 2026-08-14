import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createBlsReferenceDataProvider } from "../_shared/reference-data/bls-provider.ts";
import { canVendorPerformService } from "../_shared/vendors/vendor-eligibility.ts";

Deno.test({
  name: "operational edge functions are registered for deployment",
  permissions: { read: [new URL("../../config.toml", import.meta.url)] },
  async fn() {
    const config = await Deno.readTextFile(new URL("../../config.toml", import.meta.url));
    [
      "compute-percentage-rent",
      "generate-obligation-occurrences",
      "evaluate-coi-compliance",
      "check-vendor-eligibility",
      "run-financial-controls",
      "resolve-lease-terms",
      "compute-management-fee",
      "resolve-reference-observation",
    ].forEach((name) => {
      assertStringIncludes(config, `[functions.${name}]`);
    });
  },
});


Deno.test({
  name: "lease-charge read model is a projection over authoritative calculation records",
  permissions: { read: [new URL("../../migrations/20269900000071_major_client_financial_domains.sql", import.meta.url)] },
  async fn() {
    const sql = await Deno.readTextFile(new URL("../../migrations/20269900000071_major_client_financial_domains.sql", import.meta.url));
    assertStringIncludes(sql, "CREATE VIEW public.lease_charge_read_model");
    assertStringIncludes(sql, "WITH (security_invoker = true)");
    assertStringIncludes(sql, "FROM public.percentage_rent_calculations prc");
    assertStringIncludes(sql, "FROM public.lease_charge_calculations lcc");
    assertStringIncludes(sql, "authoritative_table");
    assertEquals(/CREATE TABLE IF NOT EXISTS public\.lease_charge_read_model/i.test(sql), false);
  },
});
Deno.test({
  name: "lease-charge read model inherits cross-org isolation from underlying RLS policies",
  permissions: { read: [new URL("../../migrations/20269900000071_major_client_financial_domains.sql", import.meta.url), new URL("../../migrations/20269900000072_reference_observation_consumption.sql", import.meta.url)] },
  async fn() {
    const baseSql = await Deno.readTextFile(new URL("../../migrations/20269900000071_major_client_financial_domains.sql", import.meta.url));
    const hardeningSql = await Deno.readTextFile(new URL("../../migrations/20269900000072_reference_observation_consumption.sql", import.meta.url));
    const sql = `${baseSql}\n${hardeningSql}`;

    assertStringIncludes(sql, "CREATE VIEW public.lease_charge_read_model");
    assertStringIncludes(sql, "WITH (security_invoker = true)");
    assertStringIncludes(sql, "ALTER VIEW public.lease_charge_read_model SET (security_invoker = true)");
    assertEquals(/CREATE TABLE IF NOT EXISTS public\.lease_charge_read_model/i.test(sql), false);
    assertEquals(/SECURITY\s+DEFINER[\s\S]{0,400}lease_charge_read_model/i.test(sql), false);

    const percentagePolicy = /CREATE POLICY percentage_rent_calculations_select ON public\.percentage_rent_calculations[\s\S]*?FOR SELECT USING \(public\.is_member_of_org\(org_id\)\);/i;
    const leaseChargePolicy = /CREATE POLICY lease_charge_calculations_select ON public\.lease_charge_calculations[\s\S]*?FOR SELECT USING \(public\.is_member_of_org\(org_id\)\);/i;
    assertEquals(percentagePolicy.test(sql), true);
    assertEquals(leaseChargePolicy.test(sql), true);
  },
});
Deno.test("BLS provider does not guess ambiguous CPI family names", async () => {
  const fetchMock = (async () => {
    throw new Error("network should not be called for ambiguous CPI hints");
  }) as typeof fetch;
  const provider = createBlsReferenceDataProvider(fetchMock);
  const candidates = await provider.findSeries({ provider: "bls", seriesHint: "CPI-U", period: "2026-06" });
  assertEquals(candidates, []);
});

Deno.test("BLS provider resolves an explicit selected series observation", async () => {
  const provider = createBlsReferenceDataProvider(async () =>
    new Response(JSON.stringify({
      Results: {
        series: [{
          seriesID: "CUUR0000SA0",
          data: [{ year: "2026", period: "M06", value: "321.500" }],
        }],
      },
    }), { status: 200 })
  );
  const [series] = await provider.findSeries({ provider: "bls", seriesHint: "CUUR0000SA0", period: "2026-06" });
  const observation = await provider.getObservation(series, "2026-06");
  assertEquals(observation?.seriesId, "CUUR0000SA0");
  assertEquals(observation?.value, 321.5);
  assertEquals(observation?.payloadFingerprint.startsWith("fnv1a32:"), true);
});

Deno.test("vendor eligibility accepts standardized approved credential status", () => {
  const result = canVendorPerformService({
    vendorId: "vendor-1",
    serviceType: "hvac",
    jurisdiction: "TN",
    asOfDate: "2026-08-13",
    credentials: [{
      vendor_id: "vendor-1",
      service_type: "HVAC",
      jurisdiction: "tn",
      status: "approved",
      effective_date: "2026-01-01",
      expiration_date: "2027-01-01",
    }],
  });
  assertEquals(result.eligible, true);
  assertEquals(result.status, "eligible");
});
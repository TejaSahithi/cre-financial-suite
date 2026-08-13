import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  createStaticReferenceDataProvider,
  resolveReferenceObservation,
} from "../_shared/reference-data/reference-data-provider.ts";

Deno.test("reference data resolves one explicit CPI series and observation", async () => {
  const provider = createStaticReferenceDataProvider({
    series: [{
      provider: "bls",
      seriesId: "CUUR0000SA0",
      displayName: "CPI-U All Urban Consumers, U.S. city average, all items",
    }],
    observations: [{
      provider: "bls",
      seriesId: "CUUR0000SA0",
      period: "2026-06",
      value: 321.5,
      retrievedAt: "2026-08-13T00:00:00Z",
    }],
  });

  const result = await resolveReferenceObservation(provider, {
    provider: "bls",
    seriesHint: "CUUR0000SA0",
    period: "2026-06",
  });

  assertEquals(result.status, "resolved");
  assertEquals(result.observation?.seriesId, "CUUR0000SA0");
  assertEquals(result.observation?.payloadFingerprint.startsWith("fnv1a32:"), true);
});

Deno.test("reference data requires review when CPI series is ambiguous", async () => {
  const provider = createStaticReferenceDataProvider({
    series: [
      { provider: "bls", seriesId: "CUUR0000SA0", displayName: "CPI-U all items" },
      { provider: "bls", seriesId: "CWUR0000SA0", displayName: "CPI-W all items" },
    ],
    observations: [],
  });

  const result = await resolveReferenceObservation(provider, {
    provider: "bls",
    seriesHint: "all items",
    period: "2026-06",
  });

  assertEquals(result.status, "requires_review");
  assertEquals(result.reasonCodes, ["REFERENCE_SERIES_AMBIGUOUS"]);
  assertEquals(result.candidates.length, 2);
});

import type {
  ReferenceDataProvider,
  ReferenceObservation,
  ReferenceObservationRequest,
  ReferenceSeriesRef,
} from "./contracts/reference-data.ts";

function fingerprintPayload(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function parsePeriod(period: string) {
  const match = String(period || "").match(/^(\d{4})(?:-(\d{2}))?$/);
  if (!match) throw new Error("period must be YYYY or YYYY-MM");
  return {
    year: match[1],
    blsPeriod: match[2] ? `M${match[2]}` : "M13",
  };
}

function normalizeSeriesId(value: unknown) {
  return String(value || "").trim().toUpperCase();
}

export function createBlsReferenceDataProvider(fetchImpl: typeof fetch = fetch): ReferenceDataProvider {
  return {
    async findSeries(request: ReferenceObservationRequest): Promise<ReferenceSeriesRef[]> {
      const seriesId = normalizeSeriesId(request.seriesHint);
      if (!seriesId || seriesId === "CPI" || seriesId === "CPI-U" || seriesId === "CPI-W") return [];
      return [{
        provider: "bls",
        seriesId,
        displayName: seriesId,
        geography: null,
        frequency: "monthly",
        units: "index",
      }];
    },

    async getObservation(series: ReferenceSeriesRef, period: string): Promise<ReferenceObservation | null> {
      const { year, blsPeriod } = parsePeriod(period);
      const seriesId = normalizeSeriesId(series.seriesId);
      const url = `https://api.bls.gov/publicAPI/v2/timeseries/data/${encodeURIComponent(seriesId)}?startyear=${year}&endyear=${year}`;
      const response = await fetchImpl(url);
      if (!response.ok) throw new Error(`BLS request failed with ${response.status}`);
      const payload = await response.json();
      const rows = payload?.Results?.series?.[0]?.data || [];
      const row = rows.find((item: Record<string, unknown>) => String(item.period) === blsPeriod);
      if (!row) return null;
      const value = Number(row.value);
      if (!Number.isFinite(value)) return null;
      return {
        provider: "bls",
        seriesId,
        period,
        value,
        retrievedAt: new Date().toISOString(),
        payloadFingerprint: fingerprintPayload({ provider: "bls", seriesId, period, value, row }),
        sourceUrl: url,
      };
    },
  };
}

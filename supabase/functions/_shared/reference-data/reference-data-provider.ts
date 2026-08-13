import type {
  ReferenceDataProvider,
  ReferenceObservation,
  ReferenceObservationRequest,
  ReferenceObservationResolution,
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

function resolution(
  status: ReferenceObservationResolution["status"],
  reasonCodes: string[],
  observation: ReferenceObservation | null,
  candidates: ReferenceSeriesRef[],
): ReferenceObservationResolution {
  return {
    contractVersion: "reference-data-resolution-v1",
    status,
    reasonCodes,
    observation,
    candidates,
  };
}

export async function resolveReferenceObservation(
  provider: ReferenceDataProvider,
  request: ReferenceObservationRequest,
): Promise<ReferenceObservationResolution> {
  const candidates = await provider.findSeries(request);
  if (candidates.length === 0) {
    return resolution("missing", ["REFERENCE_SERIES_NOT_FOUND"], null, []);
  }
  if (candidates.length > 1) {
    return resolution("requires_review", ["REFERENCE_SERIES_AMBIGUOUS"], null, candidates);
  }

  const observation = await provider.getObservation(candidates[0], request.period);
  if (!observation) {
    return resolution("missing", ["REFERENCE_OBSERVATION_NOT_FOUND"], null, candidates);
  }
  return resolution("resolved", [], observation, candidates);
}

export function createStaticReferenceDataProvider(config: {
  series: ReferenceSeriesRef[];
  observations: Array<Omit<ReferenceObservation, "payloadFingerprint"> & { payloadFingerprint?: string }>;
}): ReferenceDataProvider {
  return {
    async findSeries(request: ReferenceObservationRequest): Promise<ReferenceSeriesRef[]> {
      const provider = request.provider.toLowerCase();
      const hint = String(request.seriesHint ?? "").trim().toLowerCase();
      return config.series.filter((series) => {
        if (series.provider.toLowerCase() !== provider) return false;
        if (!hint) return true;
        return (
          series.seriesId.toLowerCase().includes(hint) ||
          series.displayName.toLowerCase().includes(hint)
        );
      });
    },
    async getObservation(series: ReferenceSeriesRef, period: string): Promise<ReferenceObservation | null> {
      const match = config.observations.find((observation) =>
        observation.provider === series.provider &&
        observation.seriesId === series.seriesId &&
        observation.period === period
      );
      if (!match) return null;
      return {
        ...match,
        payloadFingerprint: match.payloadFingerprint ?? fingerprintPayload(match),
      };
    },
  };
}

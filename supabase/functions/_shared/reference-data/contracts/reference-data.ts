export interface ReferenceSeriesRef {
  provider: string;
  seriesId: string;
  displayName: string;
  geography?: string | null;
  frequency?: string | null;
  units?: string | null;
}

export interface ReferenceObservation {
  provider: string;
  seriesId: string;
  period: string;
  value: number;
  retrievedAt: string;
  payloadFingerprint: string;
  sourceUrl?: string | null;
}

export type ReferenceResolutionStatus = "resolved" | "missing" | "requires_review";

export interface ReferenceObservationResolution {
  contractVersion: "reference-data-resolution-v1";
  status: ReferenceResolutionStatus;
  reasonCodes: string[];
  observation: ReferenceObservation | null;
  candidates: ReferenceSeriesRef[];
}

export interface ReferenceObservationRequest {
  provider: string;
  seriesHint?: string | null;
  period: string;
  leaseId?: string | null;
  fieldKey?: string | null;
}

export interface ReferenceDataProvider {
  findSeries(request: ReferenceObservationRequest): Promise<ReferenceSeriesRef[]>;
  getObservation(series: ReferenceSeriesRef, period: string): Promise<ReferenceObservation | null>;
}

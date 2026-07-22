// @ts-nocheck

export const PORTFOLIO_INTELLIGENCE_SCHEMA_VERSION = "portfolio-intelligence-v8";
export const PORTFOLIO_FACT_SCHEMA_VERSION = "portfolio-lease-fact-v1";
export const PORTFOLIO_PAYLOAD_SCHEMA_VERSION = "portfolio-intelligence-payload-v1";
export const PORTFOLIO_INTELLIGENCE_ALGORITHM_VERSION = "portfolio-intelligence-release8-v1";

export type PortfolioSourceLayer = "reviewer_override" | "family_effective" | "document_local" | "legacy_fallback" | "none";
export type PortfolioMateriality = "approval_critical" | "financial" | "operational" | "informational";
export type PortfolioFactStatus = "draft" | "canonical_ready" | "review_required" | "approved" | "published" | "stale" | "blocked";
export type PortfolioResolutionStatus = "resolved" | "partially_resolved" | "missing_anchor" | "ambiguous" | "not_applicable";
export type PortfolioRiskSeverity = "low" | "medium" | "high" | "critical";

export interface PortfolioFieldValue {
  value: unknown;
  normalizedValue: unknown;
  status: string;
  sourceLayer: PortfolioSourceLayer;
  projectionId: string | null;
  evidenceIds: string[];
  reasonCodes: string[];
}

export interface PortfolioFactFinding {
  findingKey: string;
  severity: PortfolioRiskSeverity;
  fieldKeys: string[];
  reasonCodes: string[];
  message: string;
}

export interface PortfolioFactLineage {
  documentFamilyId: string;
  sourceGenerationId: string;
  sourceRunId: string | null;
  reviewerOverrideFieldKeys: string[];
  familyEffectiveFieldKeys: string[];
  documentLocalFieldKeys: string[];
  legacyFallbackFieldKeys: string[];
  missingFieldKeys: string[];
  sourceProjectionIds: string[];
  sourceEvidenceIds: string[];
}

export interface PortfolioLeaseFact {
  organizationId: string;
  portfolioId: string | null;
  propertyId: string | null;
  leaseId: string | null;
  documentFamilyId: string;
  sourceRunId: string | null;
  generationId: string;
  projectionVersion: string;
  reviewPayloadVersion: string;
  fields: Record<string, PortfolioFieldValue>;
  status: PortfolioFactStatus;
  findings: PortfolioFactFinding[];
  lineage: PortfolioFactLineage;
  createdAt: string;
  schemaVersion: string;
  algorithmVersion: string;
}

export interface PortfolioMetricLineage {
  metricKey: string;
  contributingFactIds: string[];
  excludedFactIds: string[];
  sourceFieldKeys: string[];
  sourceProjectionIds: string[];
  aggregationMethod: string;
  normalizationRules: string[];
  warnings: string[];
}

export function stablePortfolioId(prefix: string, parts: unknown[]): string {
  return `${prefix}:${parts.map((part) => String(part ?? "none").trim().toLowerCase()).join(":")}`;
}

export function asArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? "").trim()).filter(Boolean);
}

export function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.flatMap((value) => asArray(Array.isArray(value) ? value : [value])))].sort();
}

export function isoDate(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

export function numericValue(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

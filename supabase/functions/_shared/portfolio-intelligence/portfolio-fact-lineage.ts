// @ts-nocheck

import { asArray, type PortfolioFactLineage, type PortfolioLeaseFact } from "./types.ts";

export function buildPortfolioFactLineage(fact: PortfolioLeaseFact): PortfolioFactLineage {
  const entries = Object.entries(fact.fields ?? {});
  const byLayer = (layer: string) => entries.filter(([, value]) => value.sourceLayer === layer).map(([key]) => key).sort();
  return {
    documentFamilyId: fact.documentFamilyId,
    sourceGenerationId: fact.generationId,
    sourceRunId: fact.sourceRunId ?? null,
    reviewerOverrideFieldKeys: byLayer("reviewer_override"),
    familyEffectiveFieldKeys: byLayer("family_effective"),
    documentLocalFieldKeys: byLayer("document_local"),
    legacyFallbackFieldKeys: byLayer("legacy_fallback"),
    missingFieldKeys: entries.filter(([, value]) => ["not_found", "missing_source_evidence", "missing"].includes(value.status) || value.sourceLayer === "none").map(([key]) => key).sort(),
    sourceProjectionIds: [...new Set(entries.map(([, value]) => value.projectionId).filter(Boolean).map(String))].sort(),
    sourceEvidenceIds: [...new Set(entries.flatMap(([, value]) => asArray(value.evidenceIds)))].sort(),
  };
}

export function buildMetricLineage(args: { metricKey: string; facts: any[]; excludedFacts?: any[]; sourceFieldKeys: string[]; aggregationMethod: string; normalizationRules?: string[]; warnings?: string[] }) {
  return {
    metricKey: args.metricKey,
    contributingFactIds: args.facts.map((fact) => fact.id ?? fact.factId ?? fact.documentFamilyId).filter(Boolean).map(String).sort(),
    excludedFactIds: (args.excludedFacts ?? []).map((fact) => fact.id ?? fact.factId ?? fact.documentFamilyId).filter(Boolean).map(String).sort(),
    sourceFieldKeys: [...new Set(args.sourceFieldKeys)].sort(),
    sourceProjectionIds: [...new Set(args.facts.flatMap((fact) => Object.values(fact.fields ?? {}).map((field: any) => field?.projectionId).filter(Boolean)))].sort(),
    aggregationMethod: args.aggregationMethod,
    normalizationRules: [...new Set(args.normalizationRules ?? [])].sort(),
    warnings: [...new Set(args.warnings ?? [])].sort(),
  };
}

// @ts-nocheck

import { PORTFOLIO_FACT_SCHEMA_VERSION, PORTFOLIO_INTELLIGENCE_ALGORITHM_VERSION, isoDate, numericValue, type PortfolioFieldValue, type PortfolioLeaseFact } from "./types.ts";
import { PORTFOLIO_FIELD_REGISTRY } from "./portfolio-field-registry.ts";
import { buildPortfolioFactLineage } from "./portfolio-fact-lineage.ts";

const FIELD_ALIASES: Record<string, string[]> = {
  tenant_name: ["tenant_name", "tenant", "lessee"],
  landlord_name: ["landlord_name", "landlord", "lessor"],
  property_name: ["property_name", "property"],
  premises_identifier: ["premises_identifier", "premises", "suite", "unit"],
  commencement_date: ["commencement_date", "lease_commencement_date"],
  rent_commencement_date: ["rent_commencement_date"],
  expiration_date: ["expiration_date", "lease_expiration_date", "end_date"],
  term_months: ["term_months"],
  leased_area: ["leased_area", "rentable_area", "square_feet", "rsf"],
  base_rent_current: ["base_rent_current", "base_rent", "monthly_rent", "annual_rent"],
  base_rent_frequency: ["base_rent_frequency", "rent_frequency"],
  security_deposit: ["security_deposit"],
  renewal_options_count: ["renewal_options_count", "renewal_options"],
  termination_rights_count: ["termination_rights_count", "termination_rights"],
  insurance_requirement: ["insurance_requirement", "insurance"],
};

function normalizeByType(value: unknown, valueType: string): unknown {
  if (valueType === "date") return isoDate(value);
  if (["number", "money", "percentage", "duration"].includes(valueType)) return numericValue(value);
  if (valueType === "boolean") return value === true || String(value).toLowerCase() === "true";
  return value ?? null;
}

function pickCandidate(source: any, key: string) {
  for (const alias of FIELD_ALIASES[key] ?? [key]) {
    const value = source?.[alias];
    if (value && typeof value === "object" && ("value" in value || "normalizedValue" in value)) return value;
    if (value !== undefined && value !== null && value !== "") return { value, status: "resolved", sourceLayer: null };
  }
  return null;
}

function buildField(args: { key: string; definition: any; reviewer: any; family: any; document: any; legacy: any }): PortfolioFieldValue {
  const layers: Array<[string, any]> = [
    ["reviewer_override", pickCandidate(args.reviewer, args.key)],
    ["family_effective", pickCandidate(args.family, args.key)],
    ["document_local", pickCandidate(args.document, args.key)],
    ["legacy_fallback", pickCandidate(args.legacy, args.key)],
  ];
  for (const [layer, candidate] of layers) {
    if (!candidate) continue;
    const raw = candidate.value ?? candidate.normalizedValue;
    const normalized = candidate.normalizedValue ?? normalizeByType(raw, args.definition.valueType);
    const status = String(candidate.status ?? "resolved");
    if (raw === null || raw === undefined || status === "not_found") continue;
    return {
      value: raw,
      normalizedValue: normalized,
      status,
      sourceLayer: candidate.sourceLayer ?? layer,
      projectionId: candidate.projectionId ?? candidate.sourceProjectionId ?? null,
      evidenceIds: Array.isArray(candidate.evidenceIds) ? candidate.evidenceIds : Array.isArray(candidate.sourceEvidenceIds) ? candidate.sourceEvidenceIds : [],
      reasonCodes: Array.isArray(candidate.reasonCodes) ? candidate.reasonCodes : [],
    };
  }
  return { value: null, normalizedValue: null, status: "not_found", sourceLayer: "none", projectionId: null, evidenceIds: [], reasonCodes: ["portfolio_field_not_found"] };
}

export function buildPortfolioLeaseFact(args: { organizationId: string; portfolioId?: string | null; propertyId?: string | null; leaseId?: string | null; documentFamilyId: string; sourceRunId?: string | null; generationId: string; projectionVersion?: string; reviewPayloadVersion?: string; reviewerValues?: any; familyEffectiveValues?: any; documentLocalValues?: any; legacyValues?: any; coverage?: any; semantic?: any; now?: string }): PortfolioLeaseFact {
  const fields: Record<string, PortfolioFieldValue> = {};
  for (const definition of PORTFOLIO_FIELD_REGISTRY) {
    fields[definition.key] = buildField({ key: definition.key, definition, reviewer: args.reviewerValues ?? {}, family: args.familyEffectiveValues ?? {}, document: args.documentLocalValues ?? {}, legacy: args.legacyValues ?? {} });
  }

  const findings = Object.entries(fields).flatMap(([key, field]) => {
    const definition = PORTFOLIO_FIELD_REGISTRY.find((item) => item.key === key);
    if (!definition) return [];
    if (definition.materiality === "approval_critical" && ["not_found", "missing_source_evidence", "ambiguous"].includes(field.status)) {
      return [{ findingKey: `missing:${key}`, severity: "high", fieldKeys: [key], reasonCodes: [field.status], message: `${definition.label} is not ready for portfolio publication.` }];
    }
    if (field.sourceLayer === "legacy_fallback") {
      return [{ findingKey: `legacy:${key}`, severity: "medium", fieldKeys: [key], reasonCodes: ["legacy_fallback"], message: `${definition.label} is sourced from legacy fallback.` }];
    }
    return [];
  });

  const blocked = findings.some((finding) => finding.severity === "critical" || finding.reasonCodes.includes("missing_source_evidence"));
  const reviewRequired = findings.some((finding) => ["high", "medium"].includes(finding.severity));
  const status = blocked ? "blocked" : reviewRequired ? "review_required" : "canonical_ready";
  const fact: PortfolioLeaseFact = {
    organizationId: args.organizationId,
    portfolioId: args.portfolioId ?? null,
    propertyId: args.propertyId ?? null,
    leaseId: args.leaseId ?? null,
    documentFamilyId: args.documentFamilyId,
    sourceRunId: args.sourceRunId ?? null,
    generationId: args.generationId,
    projectionVersion: args.projectionVersion ?? "canonical-family-effective-v1",
    reviewPayloadVersion: args.reviewPayloadVersion ?? "enterprise-review-payload-v2",
    fields,
    status,
    findings,
    lineage: null,
    createdAt: args.now ?? new Date(0).toISOString(),
    schemaVersion: PORTFOLIO_FACT_SCHEMA_VERSION,
    algorithmVersion: PORTFOLIO_INTELLIGENCE_ALGORITHM_VERSION,
  };
  fact.lineage = buildPortfolioFactLineage(fact);
  return fact;
}

export function factToDatabaseRow(fact: PortfolioLeaseFact) {
  const get = (key: string) => fact.fields[key]?.normalizedValue ?? fact.fields[key]?.value ?? null;
  const fieldStatuses = Object.fromEntries(Object.entries(fact.fields).map(([key, value]) => [key, value.status]));
  const fieldSources = Object.fromEntries(Object.entries(fact.fields).map(([key, value]) => [key, { sourceLayer: value.sourceLayer, projectionId: value.projectionId, evidenceIds: value.evidenceIds }]));
  return {
    organization_id: fact.organizationId,
    portfolio_id: fact.portfolioId,
    property_id: fact.propertyId,
    lease_id: fact.leaseId,
    document_family_id: fact.documentFamilyId,
    source_run_id: fact.sourceRunId,
    source_generation_id: fact.generationId,
    projection_version: fact.projectionVersion,
    review_payload_version: fact.reviewPayloadVersion,
    tenant_name: get("tenant_name"),
    landlord_name: get("landlord_name"),
    property_name: get("property_name"),
    premises_identifier: get("premises_identifier"),
    lease_status: String(get("expiration_date") && new Date(String(get("expiration_date"))) < new Date() ? "expired" : "active"),
    commencement_date: get("commencement_date"),
    rent_commencement_date: get("rent_commencement_date"),
    expiration_date: get("expiration_date"),
    term_months: get("term_months"),
    leased_area: get("leased_area"),
    area_unit: fact.fields.leased_area?.reasonCodes?.find((code) => code.startsWith("unit:"))?.slice(5) ?? null,
    base_rent_current: get("base_rent_current"),
    base_rent_currency: fact.fields.base_rent_current?.reasonCodes?.find((code) => code.startsWith("currency:"))?.slice(9) ?? null,
    base_rent_frequency: get("base_rent_frequency"),
    security_deposit: get("security_deposit"),
    renewal_options_count: get("renewal_options_count"),
    termination_rights_count: get("termination_rights_count"),
    approval_status: fact.status === "canonical_ready" ? "ready" : "review_required",
    coverage_status: fact.lineage.missingFieldKeys.length ? "incomplete" : "complete",
    semantic_status: fact.findings.some((finding) => finding.reasonCodes.includes("legacy_fallback")) ? "fallback" : "ready",
    publication_status: fact.status,
    fact_payload: fact,
    field_statuses: fieldStatuses,
    field_sources: fieldSources,
    schema_version: fact.schemaVersion,
    algorithm_version: fact.algorithmVersion,
  };
}

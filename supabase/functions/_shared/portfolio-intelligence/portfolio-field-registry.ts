// @ts-nocheck

import type { PortfolioMateriality } from "./types.ts";

export interface PortfolioFieldDefinition {
  key: string;
  label: string;
  domain: string;
  valueType: "string" | "date" | "number" | "money" | "percentage" | "boolean" | "duration" | "schedule" | "object";
  materiality: PortfolioMateriality;
  aggregations: Array<"count" | "sum" | "average" | "minimum" | "maximum" | "distribution" | "timeline" | "none">;
  requiredStatuses: string[];
  excludedStatuses: string[];
}

export const PORTFOLIO_FIELD_REGISTRY: PortfolioFieldDefinition[] = [
  { key: "tenant_name", label: "Tenant", domain: "identity", valueType: "string", materiality: "approval_critical", aggregations: ["count", "distribution"], requiredStatuses: ["resolved", "confirmed", "overridden"], excludedStatuses: ["not_found", "missing_source_evidence"] },
  { key: "landlord_name", label: "Landlord", domain: "identity", valueType: "string", materiality: "informational", aggregations: ["distribution"], requiredStatuses: ["resolved", "confirmed", "overridden"], excludedStatuses: ["not_found"] },
  { key: "property_name", label: "Property", domain: "premises", valueType: "string", materiality: "operational", aggregations: ["distribution"], requiredStatuses: ["resolved", "confirmed", "overridden"], excludedStatuses: ["not_found"] },
  { key: "premises_identifier", label: "Premises", domain: "premises", valueType: "string", materiality: "approval_critical", aggregations: ["distribution"], requiredStatuses: ["resolved", "confirmed", "overridden"], excludedStatuses: ["not_found", "missing_source_evidence"] },
  { key: "commencement_date", label: "Commencement Date", domain: "term", valueType: "date", materiality: "approval_critical", aggregations: ["timeline", "minimum", "maximum"], requiredStatuses: ["resolved", "confirmed", "overridden"], excludedStatuses: ["stale", "not_found"] },
  { key: "rent_commencement_date", label: "Rent Commencement Date", domain: "rent", valueType: "date", materiality: "financial", aggregations: ["timeline"], requiredStatuses: ["resolved", "confirmed", "overridden"], excludedStatuses: ["stale", "not_found"] },
  { key: "expiration_date", label: "Expiration Date", domain: "term", valueType: "date", materiality: "approval_critical", aggregations: ["timeline", "minimum", "maximum", "distribution"], requiredStatuses: ["resolved", "confirmed", "overridden"], excludedStatuses: ["stale", "not_found"] },
  { key: "term_months", label: "Term Months", domain: "term", valueType: "duration", materiality: "operational", aggregations: ["average", "minimum", "maximum"], requiredStatuses: ["resolved", "confirmed", "overridden"], excludedStatuses: ["not_found"] },
  { key: "leased_area", label: "Leased Area", domain: "premises", valueType: "number", materiality: "financial", aggregations: ["sum", "average", "distribution"], requiredStatuses: ["resolved", "confirmed", "overridden"], excludedStatuses: ["not_found", "ambiguous"] },
  { key: "base_rent_current", label: "Current Base Rent", domain: "rent", valueType: "money", materiality: "financial", aggregations: ["sum", "average", "distribution"], requiredStatuses: ["resolved", "confirmed", "overridden"], excludedStatuses: ["not_found", "missing_source_evidence", "currency_mismatch"] },
  { key: "base_rent_frequency", label: "Base Rent Frequency", domain: "rent", valueType: "string", materiality: "financial", aggregations: ["distribution"], requiredStatuses: ["resolved", "confirmed", "overridden"], excludedStatuses: ["not_found"] },
  { key: "security_deposit", label: "Security Deposit", domain: "security", valueType: "money", materiality: "financial", aggregations: ["sum", "distribution"], requiredStatuses: ["resolved", "confirmed", "overridden"], excludedStatuses: ["not_found", "currency_mismatch"] },
  { key: "renewal_options_count", label: "Renewal Options", domain: "options", valueType: "number", materiality: "operational", aggregations: ["sum", "distribution"], requiredStatuses: ["resolved", "confirmed", "overridden"], excludedStatuses: ["ambiguous"] },
  { key: "termination_rights_count", label: "Termination Rights", domain: "rights", valueType: "number", materiality: "operational", aggregations: ["sum", "distribution"], requiredStatuses: ["resolved", "confirmed", "overridden"], excludedStatuses: ["ambiguous"] },
  { key: "insurance_requirement", label: "Insurance Requirement", domain: "insurance", valueType: "object", materiality: "operational", aggregations: ["count"], requiredStatuses: ["resolved", "confirmed", "overridden"], excludedStatuses: ["missing_source_evidence"] },
];

export function getPortfolioFieldDefinition(key: string): PortfolioFieldDefinition | null {
  return PORTFOLIO_FIELD_REGISTRY.find((field) => field.key === key) ?? null;
}

export function allowedPortfolioFieldKeys(): string[] {
  return PORTFOLIO_FIELD_REGISTRY.map((field) => field.key).sort();
}

export function fieldsByMateriality(materiality: PortfolioMateriality): PortfolioFieldDefinition[] {
  return PORTFOLIO_FIELD_REGISTRY.filter((field) => field.materiality === materiality);
}

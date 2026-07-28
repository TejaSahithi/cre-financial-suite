// @ts-nocheck
import { buildObligationListSchema, enumString, SOURCE_FIELDS } from "./obligation-schema-helpers.ts";
import type { ObligationSchemaDefinition } from "./cam-obligation.schema.ts";

export const INSURANCE_OBLIGATION_SCHEMA_VERSION = "insurance-obligation-v1";
const SCHEMA_NAME = "insurance_obligation_v1";

export const INSURANCE_COVERAGE_TYPE_VALUES = [
  "building", "tenant_property", "leasehold_improvements", "commercial_general_liability",
  "business_interruption", "workers_compensation", "other",
] as const;
export const INSURANCE_OBLIGATED_PARTY_VALUES = [
  "tenant", "landlord", "both", "conditional", "not_stated",
] as const;
export const INSURANCE_OBLIGATION_TYPE_VALUES = [
  "must_insure", "may_insure", "must_reimburse", "included_service", "waiver", "not_stated",
] as const;
export const ECONOMIC_TREATMENT_VALUES = [
  "direct_cost", "included_in_rent", "operating_expense_pass_through", "reimbursement", "not_stated",
] as const;
export const INSURANCE_OBLIGATION_STATUS_VALUES = [
  "explicit", "ambiguous", "conflicting", "not_found",
] as const;

export type InsuranceCoverageType = (typeof INSURANCE_COVERAGE_TYPE_VALUES)[number];
export type InsuranceObligatedParty = (typeof INSURANCE_OBLIGATED_PARTY_VALUES)[number];
export type InsuranceObligationType = (typeof INSURANCE_OBLIGATION_TYPE_VALUES)[number];
export type EconomicTreatment = (typeof ECONOMIC_TREATMENT_VALUES)[number];
export type InsuranceObligationStatus = (typeof INSURANCE_OBLIGATION_STATUS_VALUES)[number];

// Deliberately no default/fallback obligatedParty like "landlord" anywhere
// in this shape -- an included-in-rent economic treatment must be able to
// coexist with obligatedParty:"not_stated" (see the domain definition's
// prompt rule). Nothing in this schema or its converters may collapse that
// pair into "landlord".
export interface InsuranceObligation {
  coverageType: InsuranceCoverageType;
  obligatedParty: InsuranceObligatedParty;
  obligationType: InsuranceObligationType;
  economicTreatment: EconomicTreatment;
  status: InsuranceObligationStatus;
  sourcePage: number | null;
  sourceQuote: string | null;
}

const INSURANCE_OBLIGATION_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["coverageType", "obligatedParty", "obligationType", "economicTreatment", "status", "sourcePage", "sourceQuote"],
  properties: {
    coverageType: enumString(INSURANCE_COVERAGE_TYPE_VALUES),
    obligatedParty: enumString(INSURANCE_OBLIGATED_PARTY_VALUES),
    obligationType: enumString(INSURANCE_OBLIGATION_TYPE_VALUES),
    economicTreatment: enumString(ECONOMIC_TREATMENT_VALUES),
    status: enumString(INSURANCE_OBLIGATION_STATUS_VALUES),
    ...SOURCE_FIELDS,
  },
};

export function getInsuranceObligationStrictSchema(): ObligationSchemaDefinition {
  return {
    schemaName: SCHEMA_NAME,
    schemaVersion: INSURANCE_OBLIGATION_SCHEMA_VERSION,
    jsonSchema: buildObligationListSchema(INSURANCE_OBLIGATION_ITEM_SCHEMA),
  };
}

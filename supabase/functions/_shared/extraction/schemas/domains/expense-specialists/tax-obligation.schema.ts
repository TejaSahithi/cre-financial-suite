// @ts-nocheck
import { buildObligationListSchema, enumString, nullableString, SOURCE_FIELDS } from "./obligation-schema-helpers.ts";
import { RESPONSIBLE_PARTY_VALUES, OBLIGATION_STATUS_VALUES, type ResponsibleParty, type ObligationStatus, type ObligationSchemaDefinition } from "./cam-obligation.schema.ts";
import { ECONOMIC_TREATMENT_VALUES, type EconomicTreatment } from "./insurance-obligation.schema.ts";

export const TAX_OBLIGATION_SCHEMA_VERSION = "tax-obligation-v1";
const SCHEMA_NAME = "tax_obligation_v1";

// Represented separately per the spec: real-estate tax, tenant
// personal-property tax, special assessments, tax increases, tax
// reimbursements, and tax appeal rights are distinct concepts, never
// folded into one generic "taxes" obligation.
export const TAX_OBLIGATION_CATEGORY_VALUES = [
  "real_estate_tax", "personal_property_tax", "special_assessment",
  "tax_increase", "tax_reimbursement", "tax_appeal_right", "other",
] as const;

export type TaxObligationCategory = (typeof TAX_OBLIGATION_CATEGORY_VALUES)[number];

// economicTreatment mirrors InsuranceObligation's field of the same name --
// "taxes are included in Base Rent" establishes economic treatment only,
// never by itself a complete statement of legal responsibility (same
// guardrail the insurance schema applies, generalized).
export interface TaxObligation {
  category: TaxObligationCategory;
  responsibleParty: ResponsibleParty;
  economicTreatment: EconomicTreatment;
  baseYear: string | null;
  capOrLimit: string | null;
  status: ObligationStatus;
  sourcePage: number | null;
  sourceQuote: string | null;
}

const TAX_OBLIGATION_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["category", "responsibleParty", "economicTreatment", "baseYear", "capOrLimit", "status", "sourcePage", "sourceQuote"],
  properties: {
    category: enumString(TAX_OBLIGATION_CATEGORY_VALUES),
    responsibleParty: enumString(RESPONSIBLE_PARTY_VALUES),
    economicTreatment: enumString(ECONOMIC_TREATMENT_VALUES),
    baseYear: nullableString(),
    capOrLimit: nullableString(),
    status: enumString(OBLIGATION_STATUS_VALUES),
    ...SOURCE_FIELDS,
  },
};

export function getTaxObligationStrictSchema(): ObligationSchemaDefinition {
  return {
    schemaName: SCHEMA_NAME,
    schemaVersion: TAX_OBLIGATION_SCHEMA_VERSION,
    jsonSchema: buildObligationListSchema(TAX_OBLIGATION_ITEM_SCHEMA),
  };
}

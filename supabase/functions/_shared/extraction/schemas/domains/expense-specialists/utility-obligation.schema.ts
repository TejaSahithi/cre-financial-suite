// @ts-nocheck
import { buildObligationListSchema, enumString, SOURCE_FIELDS } from "./obligation-schema-helpers.ts";
import { RESPONSIBLE_PARTY_VALUES, OBLIGATION_STATUS_VALUES, type ResponsibleParty, type ObligationStatus, type ObligationSchemaDefinition } from "./cam-obligation.schema.ts";

export const UTILITY_OBLIGATION_SCHEMA_VERSION = "utility-obligation-v1";
const SCHEMA_NAME = "utility_obligation_v1";

export const UTILITY_TYPE_VALUES = [
  "electricity", "water", "sewer", "gas", "hvac", "telecommunications", "other",
] as const;
export const UTILITY_BILLING_METHOD_VALUES = [
  "direct_to_provider", "submetered", "pro_rata_share", "included_in_rent", "flat_fee", "not_stated",
] as const;

export type UtilityType = (typeof UTILITY_TYPE_VALUES)[number];
export type UtilityBillingMethod = (typeof UTILITY_BILLING_METHOD_VALUES)[number];

// One obligation per utility TYPE actually named in the evidence -- a
// clause naming 4 utilities must produce 4 separate obligations, never one
// generic result (see the domain definition's promptConcepts).
export interface UtilityObligation {
  utilityType: UtilityType;
  responsibleParty: ResponsibleParty;
  billingMethod: UtilityBillingMethod;
  status: ObligationStatus;
  sourcePage: number | null;
  sourceQuote: string | null;
}

const UTILITY_OBLIGATION_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["utilityType", "responsibleParty", "billingMethod", "status", "sourcePage", "sourceQuote"],
  properties: {
    utilityType: enumString(UTILITY_TYPE_VALUES),
    responsibleParty: enumString(RESPONSIBLE_PARTY_VALUES),
    billingMethod: enumString(UTILITY_BILLING_METHOD_VALUES),
    status: enumString(OBLIGATION_STATUS_VALUES),
    ...SOURCE_FIELDS,
  },
};

export function getUtilityObligationStrictSchema(): ObligationSchemaDefinition {
  return {
    schemaName: SCHEMA_NAME,
    schemaVersion: UTILITY_OBLIGATION_SCHEMA_VERSION,
    jsonSchema: buildObligationListSchema(UTILITY_OBLIGATION_ITEM_SCHEMA),
  };
}

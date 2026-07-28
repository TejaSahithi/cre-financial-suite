// @ts-nocheck
import { buildObligationListSchema, enumString, SOURCE_FIELDS } from "./obligation-schema-helpers.ts";
import { RESPONSIBLE_PARTY_VALUES, OBLIGATION_STATUS_VALUES, type ResponsibleParty, type ObligationStatus, type ObligationSchemaDefinition } from "./cam-obligation.schema.ts";

export const REPAIR_OBLIGATION_SCHEMA_VERSION = "repair-obligation-v1";
const SCHEMA_NAME = "repair_obligation_v1";

// One obligation per component actually named in the evidence -- a clause
// splitting responsibility across several components must produce several
// separate obligations, never one generic result.
export const REPAIR_COMPONENT_VALUES = [
  "interior", "structure", "roof", "hvac", "common_areas", "parking",
  "capital_replacements", "code_compliance", "other",
] as const;
export const REPAIR_OBLIGATION_TYPE_VALUES = [
  "maintain", "repair", "replace", "reimburse", "not_stated",
] as const;

export type RepairComponent = (typeof REPAIR_COMPONENT_VALUES)[number];
export type RepairObligationType = (typeof REPAIR_OBLIGATION_TYPE_VALUES)[number];

export interface RepairObligation {
  component: RepairComponent;
  responsibleParty: ResponsibleParty;
  obligationType: RepairObligationType;
  status: ObligationStatus;
  sourcePage: number | null;
  sourceQuote: string | null;
}

const REPAIR_OBLIGATION_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["component", "responsibleParty", "obligationType", "status", "sourcePage", "sourceQuote"],
  properties: {
    component: enumString(REPAIR_COMPONENT_VALUES),
    responsibleParty: enumString(RESPONSIBLE_PARTY_VALUES),
    obligationType: enumString(REPAIR_OBLIGATION_TYPE_VALUES),
    status: enumString(OBLIGATION_STATUS_VALUES),
    ...SOURCE_FIELDS,
  },
};

export function getRepairObligationStrictSchema(): ObligationSchemaDefinition {
  return {
    schemaName: SCHEMA_NAME,
    schemaVersion: REPAIR_OBLIGATION_SCHEMA_VERSION,
    jsonSchema: buildObligationListSchema(REPAIR_OBLIGATION_ITEM_SCHEMA),
  };
}

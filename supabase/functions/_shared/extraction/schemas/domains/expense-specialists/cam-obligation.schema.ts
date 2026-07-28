// @ts-nocheck
import {
  buildObligationListSchema,
  enumString,
  nullableNumber,
  nullableString,
  stringArray,
  SOURCE_FIELDS,
} from "./obligation-schema-helpers.ts";

export const CAM_OBLIGATION_SCHEMA_VERSION = "cam-obligation-v1";
const SCHEMA_NAME = "cam_obligation_v1";

export const CAM_OBLIGATION_CATEGORY_VALUES = [
  "common_area_maintenance", "operating_expenses", "management_fee", "administrative_fee", "other",
] as const;
export const RESPONSIBLE_PARTY_VALUES = [
  "tenant", "landlord", "shared", "mixed", "conditional", "not_stated",
] as const;
export const CAM_PAYMENT_MECHANISM_VALUES = [
  "additional_rent", "reimbursement", "direct_payment", "included_in_rent", "not_stated",
] as const;
export const CAM_ALLOCATION_METHOD_VALUES = [
  "pro_rata_share", "fixed_percentage", "actual_cost", "formula", "not_stated",
] as const;
export const CAM_AMOUNT_TYPE_VALUES = [
  "fixed", "percentage", "pass_through", "formula", "included", "not_stated",
] as const;
export const CAM_CAP_TYPE_VALUES = [
  "cumulative_percentage", "non_cumulative_percentage", "fixed_amount", "other",
] as const;
export const OBLIGATION_STATUS_VALUES = [
  "explicit", "derived", "ambiguous", "conflicting", "not_found",
] as const;

export type CamObligationCategory = (typeof CAM_OBLIGATION_CATEGORY_VALUES)[number];
export type ResponsibleParty = (typeof RESPONSIBLE_PARTY_VALUES)[number];
export type CamPaymentMechanism = (typeof CAM_PAYMENT_MECHANISM_VALUES)[number];
export type CamAllocationMethod = (typeof CAM_ALLOCATION_METHOD_VALUES)[number];
export type CamAmountType = (typeof CAM_AMOUNT_TYPE_VALUES)[number];
export type CamCapType = (typeof CAM_CAP_TYPE_VALUES)[number];
export type ObligationStatus = (typeof OBLIGATION_STATUS_VALUES)[number];

export interface CamObligationCap {
  type: CamCapType;
  value: number | null;
  appliesTo: string | null;
}

export interface CamObligation {
  category: CamObligationCategory;
  responsibleParty: ResponsibleParty;
  paymentMechanism: CamPaymentMechanism;
  allocationMethod: CamAllocationMethod;
  amountType: CamAmountType;
  amount: number | null;
  percentage: number | null;
  cap: CamObligationCap | null;
  inclusions: string[];
  exclusions: string[];
  reconciliationFrequency: string | null;
  auditRight: string | null;
  status: ObligationStatus;
  sourcePage: number | null;
  sourceQuote: string | null;
}

export interface ObligationSchemaDefinition {
  schemaName: string;
  schemaVersion: string;
  jsonSchema: Record<string, unknown>;
}

const CAP_SCHEMA = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "value", "appliesTo"],
      properties: {
        type: enumString(CAM_CAP_TYPE_VALUES),
        value: nullableNumber(),
        appliesTo: nullableString(),
      },
    },
    { type: "null" },
  ],
};

const CAM_OBLIGATION_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "category", "responsibleParty", "paymentMechanism", "allocationMethod", "amountType",
    "amount", "percentage", "cap", "inclusions", "exclusions", "reconciliationFrequency",
    "auditRight", "status", "sourcePage", "sourceQuote",
  ],
  properties: {
    category: enumString(CAM_OBLIGATION_CATEGORY_VALUES),
    responsibleParty: enumString(RESPONSIBLE_PARTY_VALUES),
    paymentMechanism: enumString(CAM_PAYMENT_MECHANISM_VALUES),
    allocationMethod: enumString(CAM_ALLOCATION_METHOD_VALUES),
    amountType: enumString(CAM_AMOUNT_TYPE_VALUES),
    amount: nullableNumber(),
    percentage: nullableNumber(),
    cap: CAP_SCHEMA,
    inclusions: stringArray(),
    exclusions: stringArray(),
    reconciliationFrequency: nullableString(),
    auditRight: nullableString(),
    status: enumString(OBLIGATION_STATUS_VALUES),
    ...SOURCE_FIELDS,
  },
};

export function getCamObligationStrictSchema(): ObligationSchemaDefinition {
  return {
    schemaName: SCHEMA_NAME,
    schemaVersion: CAM_OBLIGATION_SCHEMA_VERSION,
    jsonSchema: buildObligationListSchema(CAM_OBLIGATION_ITEM_SCHEMA),
  };
}

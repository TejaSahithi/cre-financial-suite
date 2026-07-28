// @ts-nocheck
/**
 * Strict Structured Outputs pilot — expenses_and_cam domain schema (v1).
 *
 * The only domain piloted in this phase (see llm-strict-outputs-mode.ts and
 * the "Strict Structured Outputs" plan for why): confirmed highest-error,
 * highest-field-density domain (23 fields across 4 sub-concepts -- expense
 * recovery/CAM, taxes, insurance, utility/reimbursement -- see
 * adaptive-extractor.ts's DOMAIN_CONCEPTS.expenses_and_cam).
 *
 * The field LIST is generated from LEASE_SCHEMA via the same
 * getSchemaEntriesForDomain() helper adaptive-extractor.ts's own
 * fieldsForDomain() uses for the authoritative path -- never hand-
 * duplicated, so this pilot schema cannot silently drift from the real
 * field set as LEASE_SCHEMA evolves.
 */

import { getSchema, type FieldDef } from "../../schemas.ts";
import { getSchemaEntriesForDomain } from "../../enrich-bounded-stage/domain-fields.ts";
import type { ModuleType } from "../../types.ts";
import { buildDomainSchemaDefinition, type DomainSchemaDefinition } from "../schema-registry.ts";

export const EXPENSES_AND_CAM_SCHEMA_VERSION = "expenses-and-cam-v1";
const SCHEMA_NAME = "expenses_and_cam_v1";

export function getExpensesAndCamStrictSchema(moduleType: ModuleType): DomainSchemaDefinition {
  const schema = getSchema(moduleType);
  const nonDerivedEntries = Object.entries(schema).filter(
    ([, def]) => !(def as FieldDef).derived,
  ) as Array<[string, FieldDef]>;
  const fields = getSchemaEntriesForDomain(nonDerivedEntries, "expenses_and_cam") as Array<[string, FieldDef]>;
  return buildDomainSchemaDefinition({
    domain: "expenses_and_cam",
    schemaName: SCHEMA_NAME,
    schemaVersion: EXPENSES_AND_CAM_SCHEMA_VERSION,
    fields,
  });
}

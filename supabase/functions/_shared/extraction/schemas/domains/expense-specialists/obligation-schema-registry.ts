// @ts-nocheck
/**
 * Dispatches a Phase 5 expense-specialist domain id to its own obligation
 * strict schema. Small and explicit (5 real branches) rather than a
 * registry-driven lookup -- mirrors schema-registry.ts's own stated
 * rationale for staying undispatched with a single piloted domain, just
 * applied at "5 known specialists," not "N future ones."
 */

import type { LlmCallDomain } from "../../../domains/domain-registry.ts";
import { getCamObligationStrictSchema, type ObligationSchemaDefinition } from "./cam-obligation.schema.ts";
import { getTaxObligationStrictSchema } from "./tax-obligation.schema.ts";
import { getInsuranceObligationStrictSchema } from "./insurance-obligation.schema.ts";
import { getUtilityObligationStrictSchema } from "./utility-obligation.schema.ts";
import { getRepairObligationStrictSchema } from "./repair-obligation.schema.ts";

export type { ObligationSchemaDefinition };

/** Fails loud, mirrors getDomainDefinition()'s style -- an unrecognized
 *  specialist domain id here is a programming/configuration defect. */
export function getObligationStrictSchema(domain: LlmCallDomain): ObligationSchemaDefinition {
  switch (domain) {
    case "cam_and_operating_expenses": return getCamObligationStrictSchema();
    case "taxes": return getTaxObligationStrictSchema();
    case "insurance": return getInsuranceObligationStrictSchema();
    case "utilities": return getUtilityObligationStrictSchema();
    case "repairs_and_maintenance": return getRepairObligationStrictSchema();
    default: throw new Error(`No obligation schema registered for domain: ${domain}`);
  }
}

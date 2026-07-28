// @ts-nocheck
import type { ExtractionDomainDefinition } from "../../domain-definition.ts";

export const camAndOperatingExpensesDomain = {
  id: "cam_and_operating_expenses",
  enabled: false, // never enters LLM_CALL_DOMAINS -- shadow-only, invoked explicitly
  authorityMode: "shadow",
  domainFamily: "expense_specialist",
  executionOrder: 30,
  promptVersion: "cam-and-operating-expenses-specialist-v1",
  promptConcepts:
    "CAM / operating-expense recovery structure (net/gross/modified gross), CAM amount, base " +
    "year, expense stop, admin/management fee basis and percentage, gross-up provisions and " +
    "threshold, reconciliation frequency, audit rights -- extract as one obligation PER " +
    "distinct category (common_area_maintenance / operating_expenses / management_fee / " +
    "administrative_fee), never one generic answer for a clause naming several.",
  schemaName: "cam_obligation_v1",
  schemaVersion: "cam-obligation-v1",
  routingThreshold: 1,
  maximumEvidenceCharacters: 24_000,
  maximumOutputTokens: 4_000,
  criticalFields: [],
  dependencies: [],
  evidenceSourceDomains: ["expenses_and_cam"],
  shadowRunsAfter: ["expenses_and_cam"],
  participatesInBoundedEnrichment: false,
  boundedEnrichStageName: null,
} as const satisfies ExtractionDomainDefinition;

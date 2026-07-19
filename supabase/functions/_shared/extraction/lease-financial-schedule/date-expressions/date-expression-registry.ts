// @ts-nocheck
import { DATE_EXPRESSION_REGISTRY_VERSION } from "./date-expression-registry-version.ts";
import type { DateExpressionRegistryEntry, DateExpressionType } from "./date-expression-types.ts";

export const DATE_EXPRESSION_TYPES: DateExpressionRegistryEntry[] = [
  {
    expressionType: "fixed_date",
    displayName: "Fixed Date",
    description: "A specific date explicitly stated in an authoritative source or supplied by a reviewer.",
    requiredComponents: ["explicit_date"],
    allowedAnchorTypes: [],
    operandsPermitted: false,
    offsetsPermitted: false,
    recurrencePermitted: false,
    requiresDependencyProcessing: false,
    fixedResolvedDatePermitted: true,
    validationRules: ["explicit_date_required", "no_event_anchor_or_offset"],
    introducedIn: DATE_EXPRESSION_REGISTRY_VERSION,
  },
  {
    expressionType: "event_date",
    displayName: "Event Date",
    description: "A date tied to an event, such as certificate of occupancy or delivery of possession.",
    requiredComponents: ["event_key"],
    allowedAnchorTypes: ["event"],
    operandsPermitted: false,
    offsetsPermitted: false,
    recurrencePermitted: false,
    requiresDependencyProcessing: true,
    fixedResolvedDatePermitted: true,
    validationRules: ["event_key_required", "unresolved_until_authoritative_event"],
    introducedIn: DATE_EXPRESSION_REGISTRY_VERSION,
  },
  {
    expressionType: "relative_to_date",
    displayName: "Relative To Date",
    description: "A date offset before or after another fixed date or date expression.",
    requiredComponents: ["anchor", "offset_value", "offset_unit", "offset_direction"],
    allowedAnchorTypes: ["date", "expression", "concept"],
    operandsPermitted: false,
    offsetsPermitted: true,
    recurrencePermitted: false,
    requiresDependencyProcessing: true,
    fixedResolvedDatePermitted: false,
    validationRules: ["anchor_required", "offset_required", "no_p4_1_resolution"],
    introducedIn: DATE_EXPRESSION_REGISTRY_VERSION,
  },
  {
    expressionType: "relative_to_event",
    displayName: "Relative To Event",
    description: "A date offset before or after an event anchor.",
    requiredComponents: ["event_key", "offset_value", "offset_unit", "offset_direction"],
    allowedAnchorTypes: ["event"],
    operandsPermitted: false,
    offsetsPermitted: true,
    recurrencePermitted: false,
    requiresDependencyProcessing: true,
    fixedResolvedDatePermitted: false,
    validationRules: ["event_key_required", "offset_required", "no_p4_1_resolution"],
    introducedIn: DATE_EXPRESSION_REGISTRY_VERSION,
  },
  {
    expressionType: "earlier_of",
    displayName: "Earlier Of",
    description: "The earlier date among multiple candidate operands.",
    requiredComponents: ["operands"],
    allowedAnchorTypes: ["expression", "concept", "event"],
    operandsPermitted: true,
    offsetsPermitted: false,
    recurrencePermitted: false,
    requiresDependencyProcessing: true,
    fixedResolvedDatePermitted: false,
    validationRules: ["multiple_operands_required", "no_p4_1_resolution"],
    introducedIn: DATE_EXPRESSION_REGISTRY_VERSION,
  },
  {
    expressionType: "later_of",
    displayName: "Later Of",
    description: "The later date among multiple candidate operands.",
    requiredComponents: ["operands"],
    allowedAnchorTypes: ["expression", "concept", "event"],
    operandsPermitted: true,
    offsetsPermitted: false,
    recurrencePermitted: false,
    requiresDependencyProcessing: true,
    fixedResolvedDatePermitted: false,
    validationRules: ["multiple_operands_required", "no_p4_1_resolution"],
    introducedIn: DATE_EXPRESSION_REGISTRY_VERSION,
  },
  {
    expressionType: "minimum_of",
    displayName: "Minimum Of",
    description: "The minimum date or deadline from an operand set under a legal condition.",
    requiredComponents: ["operands"],
    allowedAnchorTypes: ["expression", "concept", "event"],
    operandsPermitted: true,
    offsetsPermitted: false,
    recurrencePermitted: false,
    requiresDependencyProcessing: true,
    fixedResolvedDatePermitted: false,
    validationRules: ["multiple_operands_required", "no_p4_1_resolution"],
    introducedIn: DATE_EXPRESSION_REGISTRY_VERSION,
  },
  {
    expressionType: "maximum_of",
    displayName: "Maximum Of",
    description: "The maximum date or deadline from an operand set under a legal condition.",
    requiredComponents: ["operands"],
    allowedAnchorTypes: ["expression", "concept", "event"],
    operandsPermitted: true,
    offsetsPermitted: false,
    recurrencePermitted: false,
    requiresDependencyProcessing: true,
    fixedResolvedDatePermitted: false,
    validationRules: ["multiple_operands_required", "no_p4_1_resolution"],
    introducedIn: DATE_EXPRESSION_REGISTRY_VERSION,
  },
  {
    expressionType: "dependent_date",
    displayName: "Dependent Date",
    description: "A date that depends on another unresolved expression, concept, or event.",
    requiredComponents: ["anchor"],
    allowedAnchorTypes: ["expression", "concept", "event"],
    operandsPermitted: false,
    offsetsPermitted: false,
    recurrencePermitted: false,
    requiresDependencyProcessing: true,
    fixedResolvedDatePermitted: false,
    validationRules: ["dependency_required", "no_p4_1_resolution"],
    introducedIn: DATE_EXPRESSION_REGISTRY_VERSION,
  },
  {
    expressionType: "recurring_deadline",
    displayName: "Recurring Deadline",
    description: "A repeating date obligation, such as a yearly statement due date.",
    requiredComponents: ["recurrence_definition"],
    allowedAnchorTypes: ["date", "expression", "concept", "event"],
    operandsPermitted: false,
    offsetsPermitted: true,
    recurrencePermitted: true,
    requiresDependencyProcessing: true,
    fixedResolvedDatePermitted: false,
    validationRules: ["bounded_recurrence_required", "no_occurrence_expansion_in_p4_1"],
    introducedIn: DATE_EXPRESSION_REGISTRY_VERSION,
  },
  {
    expressionType: "notice_window",
    displayName: "Notice Window",
    description: "A notice period anchored to another date expression or concept.",
    requiredComponents: ["anchor", "offset_value", "offset_unit", "offset_direction"],
    allowedAnchorTypes: ["date", "expression", "concept", "event"],
    operandsPermitted: false,
    offsetsPermitted: true,
    recurrencePermitted: false,
    requiresDependencyProcessing: true,
    fixedResolvedDatePermitted: false,
    validationRules: ["anchor_required", "window_required", "no_deadline_calculation_in_p4_1"],
    introducedIn: DATE_EXPRESSION_REGISTRY_VERSION,
  },
  {
    expressionType: "unresolved_expression",
    displayName: "Unresolved Expression",
    description: "A safely preserved date expression that lacks enough validated structure for resolution.",
    requiredComponents: [],
    allowedAnchorTypes: ["date", "expression", "concept", "event", "unknown"],
    operandsPermitted: true,
    offsetsPermitted: true,
    recurrencePermitted: true,
    requiresDependencyProcessing: true,
    fixedResolvedDatePermitted: false,
    validationRules: ["preserve_without_fabrication", "status_unresolved_or_needs_review"],
    introducedIn: DATE_EXPRESSION_REGISTRY_VERSION,
  },
];

export function getDateExpressionType(expressionType: string): DateExpressionRegistryEntry | undefined {
  return DATE_EXPRESSION_TYPES.find((entry) => entry.expressionType === expressionType);
}

export function validateDateExpressionRegistry() {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const entry of DATE_EXPRESSION_TYPES) {
    if (seen.has(entry.expressionType)) errors.push(`duplicate expression type: ${entry.expressionType}`);
    seen.add(entry.expressionType);
    if (!entry.displayName.trim()) errors.push(`${entry.expressionType}: displayName required`);
    if (!entry.description.trim()) errors.push(`${entry.expressionType}: description required`);
    if (entry.introducedIn !== DATE_EXPRESSION_REGISTRY_VERSION) {
      errors.push(`${entry.expressionType}: introducedIn must match registry version`);
    }
  }
  return { valid: errors.length === 0, errors };
}

export async function computeDateExpressionRegistryHash(): Promise<string> {
  const canonical = DATE_EXPRESSION_TYPES
    .map((entry) => [
      entry.expressionType,
      entry.displayName,
      entry.description,
      [...entry.requiredComponents].sort().join(","),
      [...entry.allowedAnchorTypes].sort().join(","),
      entry.operandsPermitted,
      entry.offsetsPermitted,
      entry.recurrencePermitted,
      entry.requiresDependencyProcessing,
      entry.fixedResolvedDatePermitted,
      [...entry.validationRules].sort().join(","),
      entry.introducedIn,
    ].join("|"))
    .sort()
    .join("\n");
  const bytes = new TextEncoder().encode(`${DATE_EXPRESSION_REGISTRY_VERSION}\n${canonical}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const CANONICAL_DATE_EXPRESSION_TYPES: DateExpressionType[] = DATE_EXPRESSION_TYPES.map((entry) => entry.expressionType);

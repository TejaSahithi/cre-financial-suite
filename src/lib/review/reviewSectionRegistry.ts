import type { ReviewDocumentViewModel, ReviewSectionViewModel } from "./types";
import { LEASE_FIELD_CONTRACT, STANDARD_FIELD_GROUPS } from "@/lib/leaseFieldContract";

export interface ReviewSectionDefinition {
  key: string;
  label: string;
  fieldKeys: string[];
  order: number;
  visibleWhen?: (document: ReviewDocumentViewModel) => boolean;
}

const GROUP_TO_SECTION: Record<string, string> = {
  document_identity: "document_identity",
  parties: "parties",
  property_premises: "premises",
  term_dates: "dates",
  rent_charges: "rent",
  expenses_recoveries: "cam",
  cam_rules: "cam",
  taxes: "taxes",
  insurance: "insurance",
  utilities: "utilities",
  repairs_maintenance: "defaults",
  legal_options: "options",
  critical_dates: "critical_dates",
  notices: "notices",
  signatures: "signatures",
  budget_inputs: "budget_inputs",
  approval_controls: "approval_controls",
};

const SECTION_LABELS: Record<string, { label: string; order: number }> = {
  document_identity: { label: "Document Identity", order: 1 },
  parties: { label: "Parties", order: 2 },
  premises: { label: "Premises", order: 3 },
  dates: { label: "Dates", order: 4 },
  rent: { label: "Rent", order: 5 },
  escalations: { label: "Escalations", order: 6 },
  cam: { label: "CAM", order: 7 },
  taxes: { label: "Taxes", order: 8 },
  insurance: { label: "Insurance", order: 9 },
  utilities: { label: "Utilities", order: 10 },
  defaults: { label: "Defaults", order: 11 },
  options: { label: "Options", order: 12 },
  critical_dates: { label: "Critical Dates", order: 13 },
  notices: { label: "Notices", order: 14 },
  signatures: { label: "Signatures", order: 15 },
  budget_inputs: { label: "Budget Inputs", order: 16 },
  approval_controls: { label: "Approval Controls", order: 17 },
  other_terms: { label: "Other Terms", order: 99 },
};

function sectionForField(field: any): string {
  if (["escalation_rate", "escalation_type", "escalation_timing"].includes(field?.canonicalKey)) return "escalations";
  return GROUP_TO_SECTION[field?.group] || "other_terms";
}

const fieldsBySection = new Map<string, string[]>();
for (const field of LEASE_FIELD_CONTRACT) {
  const section = sectionForField(field);
  fieldsBySection.set(section, [...(fieldsBySection.get(section) || []), field.canonicalKey]);
}

export const REVIEW_SECTION_REGISTRY: ReviewSectionDefinition[] = Object.entries(SECTION_LABELS)
  .map(([key, meta]) => ({
    key,
    label: meta.label,
    order: meta.order,
    fieldKeys: fieldsBySection.get(key) || [],
  }))
  .sort((a, b) => a.order - b.order);

export function buildReviewSections(fields: Record<string, unknown>): ReviewSectionViewModel[] {
  const known = new Set(REVIEW_SECTION_REGISTRY.flatMap((section) => section.fieldKeys));
  const sections = REVIEW_SECTION_REGISTRY.map((section) => ({ ...section, fieldKeys: section.fieldKeys.filter((key) => key in fields) }));
  const unknownKeys = Object.keys(fields).filter((key) => !known.has(key));
  const other = sections.find((section) => section.key === "other_terms");
  if (other) other.fieldKeys = [...new Set([...other.fieldKeys, ...unknownKeys])];
  return sections.filter((section) => section.fieldKeys.length > 0);
}

export function fieldContractByKey() {
  return new Map(LEASE_FIELD_CONTRACT.map((field) => [field.canonicalKey, field]));
}

export function sectionLabelForGroup(group: string | null | undefined): string {
  return STANDARD_FIELD_GROUPS.find((item) => item.key === group)?.label || SECTION_LABELS[GROUP_TO_SECTION[group || ""]]?.label || "Other Terms";
}

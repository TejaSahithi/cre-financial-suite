// @ts-nocheck

import type { EnterpriseReviewPayload } from "../document-intelligence-v3/enterprise-review-payload.ts";
import type { DefinitionRecord, CrossReferenceRecord, DocumentFamilyMemberSummary, AmendmentEffectRecord, ReviewFieldLineage } from "./types.ts";
import { buildSemanticCoverageSummary, buildSemanticFindings } from "./semantic-coverage.ts";
import { selectEffectiveProjection } from "./amendment-precedence.ts";
import { resolveDefinedTermsInText } from "./defined-term-resolver.ts";
import { buildSemanticSearchRecords } from "./semantic-field-search.ts";

export const ENTERPRISE_REVIEW_PAYLOAD_V2_SCHEMA_VERSION = "enterprise-review-payload-v2";

function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined && !(typeof value === "string" && value.trim() === "");
}

function approvalCriticalFieldKeys(payload: EnterpriseReviewPayload): string[] {
  return (payload.coverage?.entries ?? []).filter((entry: any) => entry.requiredForApproval).map((entry: any) => entry.canonicalFieldKey);
}

export function buildFieldLineage(args: { payload: EnterpriseReviewPayload; documentFamilyId?: string | null; definitions?: DefinitionRecord[]; crossReferences?: CrossReferenceRecord[]; amendmentEffects?: AmendmentEffectRecord[]; activeOverrides?: any[] }): Record<string, ReviewFieldLineage> {
  const overrides = new Map((args.activeOverrides ?? []).filter((row: any) => row?.is_active !== false).map((row: any) => [row.canonical_field_key ?? row.canonicalFieldKey, row]));
  const lineage: Record<string, ReviewFieldLineage> = {};
  for (const [fieldKey, field] of Object.entries(args.payload.fields ?? {})) {
    const selected = selectEffectiveProjection({
      fieldKey,
      documentFamilyId: args.documentFamilyId ?? null,
      baseProjection: { projectionId: (field as any).projectionId ?? null, normalizedValue: (field as any).value, value: (field as any).value, uploadedFileId: args.payload.uploadedFileId },
      amendmentEffects: args.amendmentEffects ?? [],
      reviewerOverride: overrides.get(fieldKey) ?? null,
      legacyValue: (field as any).authoritativeSource === "legacy_fallback" ? (field as any).value : null,
    });
    const definitionDependencies = resolveDefinedTermsInText({ text: `${(field as any).displayValue ?? ""} ${fieldKey.replace(/_/g, " ")}`, definitions: args.definitions ?? [], sourceDocumentId: args.payload.uploadedFileId });
    const crossReferenceDependencies = (args.crossReferences ?? []).filter((ref) => ref.sourceText && new RegExp(ref.sourceText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(`${(field as any).displayValue ?? ""} ${fieldKey.replace(/_/g, " ")}`));
    lineage[fieldKey] = {
      documentLocalValue: (field as any).value ?? null,
      familyEffectiveValue: selected.selectedLayer === "family_effective" ? selected.value : (field as any).value ?? null,
      reviewerEffectiveValue: selected.selectedLayer === "reviewer_override" ? selected.value : null,
      selectedLayer: selected.selectedLayer,
      amendmentPrecedence: selected.trace,
      supersededValues: selected.supersededValues,
      definitionDependencies,
      crossReferenceDependencies,
    };
  }
  return lineage;
}

export async function buildEnterpriseReviewPayloadV2(args: {
  payloadV1: EnterpriseReviewPayload;
  documentFamilyId?: string | null;
  documentRole?: string | null;
  familyMembers?: DocumentFamilyMemberSummary[];
  chronologyStatus?: string | null;
  definitions?: DefinitionRecord[];
  crossReferences?: CrossReferenceRecord[];
  amendmentEffects?: AmendmentEffectRecord[];
  activeOverrides?: any[];
  semanticSearchEnabled?: boolean;
}): Promise<any> {
  const lineageByField = buildFieldLineage({ payload: args.payloadV1, documentFamilyId: args.documentFamilyId ?? null, definitions: args.definitions ?? [], crossReferences: args.crossReferences ?? [], amendmentEffects: args.amendmentEffects ?? [], activeOverrides: args.activeOverrides ?? [] });
  const semanticCoverage = buildSemanticCoverageSummary({ definitions: args.definitions ?? [], references: args.crossReferences ?? [], amendmentEffects: args.amendmentEffects ?? [], lineageByField });
  const semanticFindings = buildSemanticFindings({ definitions: args.definitions ?? [], references: args.crossReferences ?? [], amendmentEffects: args.amendmentEffects ?? [], lineageByField, approvalCriticalFieldKeys: approvalCriticalFieldKeys(args.payloadV1) });
  const fields = Object.fromEntries(Object.entries(args.payloadV1.fields ?? {}).map(([key, field]: [string, any]) => {
    const lineage = lineageByField[key];
    const effectiveValue = lineage.selectedLayer === "reviewer_override" && hasValue(lineage.reviewerEffectiveValue)
      ? lineage.reviewerEffectiveValue
      : lineage.selectedLayer === "family_effective"
        ? lineage.familyEffectiveValue
        : field.value;
    return [key, {
      ...field,
      value: effectiveValue,
      displayValue: hasValue(effectiveValue) ? String(effectiveValue) : field.displayValue,
      lineage,
      authoritativeSource: lineage.selectedLayer === "family_effective" ? "canonical_family_effective" : lineage.selectedLayer === "reviewer_override" ? "reviewer_override" : field.authoritativeSource,
    }];
  }));
  const findings = [...(args.payloadV1.findings ?? []), ...semanticFindings];
  const payloadWithoutHash = {
    ...args.payloadV1,
    schemaVersion: ENTERPRISE_REVIEW_PAYLOAD_V2_SCHEMA_VERSION,
    fields,
    findings,
    documentFamily: {
      id: args.documentFamilyId ?? null,
      role: args.documentRole ?? "unknown",
      members: args.familyMembers ?? [],
      chronologyStatus: args.chronologyStatus ?? "unknown",
    },
    definitions: args.definitions ?? [],
    crossReferences: args.crossReferences ?? [],
    semanticCoverage,
    searchCapabilities: {
      enabled: Boolean(args.semanticSearchEnabled),
      entityTypes: ["field", "definition", "section", "finding", "evidence", "amendment_effect"],
    },
  };
  const searchRecords = buildSemanticSearchRecords({ uploadedFileId: args.payloadV1.uploadedFileId, documentFamilyId: args.documentFamilyId ?? null, runId: args.payloadV1.runId, generationId: args.payloadV1.generationId, fields, definitions: args.definitions ?? [], references: args.crossReferences ?? [], findings, amendmentEffects: args.amendmentEffects ?? [] });
  const encoded = new TextEncoder().encode(JSON.stringify(stable({ ...payloadWithoutHash, searchRecords: searchRecords.map((record) => ({ ...record, score: 0 })) })));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  const payloadHash = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return { ...payloadWithoutHash, payloadHash, semanticSearchRecords: searchRecords };
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]));
  return value;
}
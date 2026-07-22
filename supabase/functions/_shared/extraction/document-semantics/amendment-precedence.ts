// @ts-nocheck

import type { AmendmentEffectRecord, AmendmentPrecedenceTrace } from "./types.ts";

function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined && !(typeof value === "string" && value.trim() === "");
}

function sortEffects(effects: AmendmentEffectRecord[]): AmendmentEffectRecord[] {
  return [...effects].sort((a, b) => {
    const ad = String(a.effectiveDate ?? "0000-00-00");
    const bd = String(b.effectiveDate ?? "0000-00-00");
    if (ad !== bd) return ad.localeCompare(bd);
    return String(a.id ?? "").localeCompare(String(b.id ?? ""));
  });
}

export function selectEffectiveProjection(args: {
  fieldKey: string;
  documentFamilyId?: string | null;
  baseProjection?: any | null;
  amendmentEffects?: AmendmentEffectRecord[];
  reviewerOverride?: any | null;
  legacyValue?: unknown;
}) {
  const related = sortEffects((args.amendmentEffects ?? []).filter((effect) => effect.targetCanonicalFieldKey === args.fieldKey));
  const unresolved = related.filter((effect) => effect.resolutionStatus !== "resolved");
  const conflicting = related.filter((effect) => effect.resolutionStatus === "conflicting");
  const trace: AmendmentPrecedenceTrace = {
    documentFamilyId: args.documentFamilyId ?? null,
    baseProjectionId: args.baseProjection?.projectionId ?? args.baseProjection?.id ?? null,
    amendmentEffectIds: related.map((effect) => effect.id).filter(Boolean),
    selectedSourceDocumentId: args.baseProjection?.uploadedFileId ?? args.baseProjection?.uploaded_file_id ?? null,
    supersededProjectionIds: [],
    effectiveDate: null,
    resolutionStatus: "not_applicable",
    reasonCodes: [],
  };

  if (args.reviewerOverride && args.reviewerOverride.is_active !== false) {
    return { value: args.reviewerOverride.override_value ?? args.reviewerOverride.overrideValue ?? args.baseProjection?.normalizedValue ?? args.baseProjection?.value ?? null, selectedLayer: "reviewer_override", trace: { ...trace, resolutionStatus: "resolved", reasonCodes: ["reviewer_override_selected"] }, supersededValues: [] };
  }

  if (conflicting.length) return { value: args.baseProjection?.normalizedValue ?? args.baseProjection?.value ?? null, selectedLayer: hasValue(args.baseProjection?.normalizedValue ?? args.baseProjection?.value) ? "document_local" : "none", trace: { ...trace, resolutionStatus: "conflicting", reasonCodes: ["amendment_precedence_conflict"] }, supersededValues: [] };
  if (unresolved.length) return { value: args.baseProjection?.normalizedValue ?? args.baseProjection?.value ?? null, selectedLayer: hasValue(args.baseProjection?.normalizedValue ?? args.baseProjection?.value) ? "document_local" : "none", trace: { ...trace, resolutionStatus: "incomplete", reasonCodes: ["amendment_effect_unresolved"] }, supersededValues: [] };

  const authoritative = related.filter((effect) => ["replace", "override", "extend", "shorten", "delete", "rename", "restate"].includes(effect.effectType)).at(-1) ?? null;
  if (authoritative) {
    const value = authoritative.effectType === "delete" ? null : authoritative.replacementValue;
    return {
      value,
      selectedLayer: "family_effective",
      trace: { ...trace, selectedSourceDocumentId: authoritative.sourceUploadedFileId, effectiveDate: authoritative.effectiveDate, resolutionStatus: "resolved", reasonCodes: ["explicit_later_amendment_effect"] },
      supersededValues: hasValue(args.baseProjection?.normalizedValue ?? args.baseProjection?.value) ? [{ value: args.baseProjection?.normalizedValue ?? args.baseProjection?.value, sourceDocumentId: trace.selectedSourceDocumentId, effectId: authoritative.id, effectiveDate: authoritative.effectiveDate }] : [],
    };
  }

  const baseValue = args.baseProjection?.normalizedValue ?? args.baseProjection?.value ?? null;
  if (hasValue(baseValue)) return { value: baseValue, selectedLayer: "document_local", trace: { ...trace, resolutionStatus: "resolved", reasonCodes: ["base_lease_projection_selected"] }, supersededValues: [] };
  if (hasValue(args.legacyValue)) return { value: args.legacyValue, selectedLayer: "legacy_fallback", trace: { ...trace, resolutionStatus: "incomplete", reasonCodes: ["configured_legacy_fallback_selected"] }, supersededValues: [] };
  return { value: null, selectedLayer: "none", trace: { ...trace, resolutionStatus: related.length ? "incomplete" : "not_applicable", reasonCodes: related.length ? ["no_effective_value"] : [] }, supersededValues: [] };
}

export function buildFamilyEffectiveProjection(args: { fields: Record<string, any>; amendmentEffects?: AmendmentEffectRecord[]; documentFamilyId?: string | null; reviewerOverridesByKey?: Map<string, any>; legacyValuesByKey?: Map<string, unknown> }) {
  const out: Record<string, any> = {};
  for (const [fieldKey, field] of Object.entries(args.fields ?? {})) {
    out[fieldKey] = selectEffectiveProjection({
      fieldKey,
      documentFamilyId: args.documentFamilyId ?? null,
      baseProjection: { projectionId: field.projectionId ?? null, normalizedValue: field.value, value: field.value, uploadedFileId: field.uploadedFileId ?? null },
      amendmentEffects: args.amendmentEffects ?? [],
      reviewerOverride: args.reviewerOverridesByKey?.get(fieldKey) ?? null,
      legacyValue: args.legacyValuesByKey?.get(fieldKey) ?? null,
    });
  }
  return out;
}
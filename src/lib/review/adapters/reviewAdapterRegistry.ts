// @ts-nocheck
import { adaptEnterpriseReviewPayload } from "./enterpriseReviewAdapter";
import { adaptLegacyReviewPayload } from "./legacyReviewAdapter";
import { UnsupportedReviewPayloadSchemaError } from "../errors";

export function buildReviewDocumentViewModel(input) {
  const rolloutMode = input?.rolloutMode || "legacy";
  const common = {
    uploadedFileId: input?.uploadedFileId,
    runId: input?.runId,
    generationId: input?.generationId,
    stale: input?.stale,
  };

  if (rolloutMode === "legacy" || rolloutMode === "shadow") {
    return adaptLegacyReviewPayload(input?.legacyPayload || {}, { ...common, mode: rolloutMode });
  }

  if (rolloutMode === "canonical_hybrid" || rolloutMode === "canonical_strict") {
    try {
      if (!input?.enterprisePayload) throw new UnsupportedReviewPayloadSchemaError(null);
      return adaptEnterpriseReviewPayload(input.enterprisePayload, { mode: rolloutMode });
    } catch (error) {
      if (rolloutMode === "canonical_hybrid" && input?.allowLegacyFallbackOnCanonicalUnavailable) {
        return adaptLegacyReviewPayload(input?.legacyPayload || {}, { ...common, mode: "legacy" });
      }
      throw error;
    }
  }

  return adaptLegacyReviewPayload(input?.legacyPayload || {}, { ...common, mode: "legacy" });
}

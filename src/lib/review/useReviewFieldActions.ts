// @ts-nocheck
import { useCallback, useMemo, useState } from "react";
import { submitDocumentFieldReviewAction } from "@/services/documentIntelligenceV3Service";
import { recordReviewTelemetry } from "./reviewTelemetry";

const ENDPOINT_ACTION = {
  accept: "accept",
  override: "override",
  clear: "clear",
  not_applicable: "not_applicable",
  follow_up: "needs_followup",
};

function requiresReason(action) {
  return ["override", "clear", "not_applicable", "follow_up"].includes(action?.type);
}

function classifyActionError(result) {
  const message = String(result?.message || "").toLowerCase();
  if (result?.errorCode === "stale_review_generation" || message.includes("stale_review_generation") || message.includes("stale document generation")) return "stale_generation";
  if (message.includes("unauthorized") || message.includes("session")) return "unauthorized";
  if (message.includes("required")) return "validation";
  return "endpoint";
}

export function validateReviewFieldAction(action) {
  if (!action?.type || !ENDPOINT_ACTION[action.type]) return "Unsupported review action.";
  if (!action.fieldKey) return "Field key is required.";
  if (requiresReason(action) && !String(action.reason || "").trim()) return "A reason is required for this action.";
  if (action.type === "override" && action.value === undefined) return "Override value is required.";
  return null;
}

export function useReviewFieldActions({ document, uploadedFileId, runId, generationId, reload } = {}) {
  const [pendingByField, setPendingByField] = useState({});
  const [errorByField, setErrorByField] = useState({});

  const submitAction = useCallback(async (action) => {
    const validationError = validateReviewFieldAction(action);
    if (validationError) {
      setErrorByField((prev) => ({ ...prev, [action?.fieldKey || "__unknown__"]: { type: "validation", message: validationError } }));
      return { error: true, type: "validation", message: validationError };
    }

    if (pendingByField[action.fieldKey]) {
      return { error: true, type: "duplicate", message: "A review action is already pending for this field." };
    }

    const effectiveUploadedFileId = uploadedFileId || document?.uploadedFileId;
    const effectiveRunId = runId || document?.runId;
    const effectiveGenerationId = generationId || document?.generationId;
    setPendingByField((prev) => ({ ...prev, [action.fieldKey]: true }));
    setErrorByField((prev) => ({ ...prev, [action.fieldKey]: null }));

    try {
      const result = await submitDocumentFieldReviewAction({
        uploadedFileId: effectiveUploadedFileId,
        runId: effectiveRunId,
        generationId: effectiveGenerationId,
        canonicalFieldKey: action.fieldKey,
        action: ENDPOINT_ACTION[action.type],
        overrideValue: action.type === "override" ? action.value : null,
        reason: action.reason || null,
      });

      if (result?.error) {
        const type = classifyActionError(result);
        const failure = { error: true, type, message: result.message || "Review action failed." };
        setErrorByField((prev) => ({ ...prev, [action.fieldKey]: failure }));
        if (type === "stale_generation") {
          recordReviewTelemetry("stale_review_generation", { uploadedFileId: effectiveUploadedFileId, runId: effectiveRunId, generationId: effectiveGenerationId, fieldKey: action.fieldKey });
          await reload?.();
        }
        return failure;
      }

      recordReviewTelemetry("canonical_field_override", {
        uploadedFileId: effectiveUploadedFileId,
        runId: effectiveRunId,
        generationId: effectiveGenerationId,
        rolloutMode: document?.mode,
        fieldKey: action.fieldKey,
        status: action.type,
        source: "reviewer_override",
      });
      await reload?.();
      return { error: false };
    } finally {
      setPendingByField((prev) => ({ ...prev, [action.fieldKey]: false }));
    }
  }, [document, generationId, pendingByField, reload, runId, uploadedFileId]);

  return useMemo(() => ({
    submitAction,
    pendingByField,
    errorByField,
    isPending: (fieldKey) => Boolean(pendingByField[fieldKey]),
    getError: (fieldKey) => errorByField[fieldKey] || null,
  }), [errorByField, pendingByField, submitAction]);
}

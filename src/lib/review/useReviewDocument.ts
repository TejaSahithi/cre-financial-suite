// @ts-nocheck
import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchDocumentIntelligenceV4ReviewPayload } from "@/services/documentIntelligenceV3Service";
import { buildReviewDocumentViewModel } from "./adapters/reviewAdapterRegistry";
import { isUnsupportedReviewPayloadSchemaError } from "./errors";
import { recordReviewTelemetry } from "./reviewTelemetry";

function classifyError(error, response) {
  const message = String(error?.message || response?.message || "").toLowerCase();
  if (message.includes("unauthorized") || message.includes("missing supabase session")) return "unauthorized";
  if (message.includes("stale_review_generation") || message.includes("stale document generation") || message.includes("stale generation")) return "stale_generation";
  if (isUnsupportedReviewPayloadSchemaError(error)) return "unsupported_schema";
  if (message.includes("canonical") && message.includes("unavailable")) return "canonical_unavailable";
  return "network";
}

export function buildReviewDocumentFromResponse({ response, uploadedFile, legacyPayload, uploadedFileId, generationId, allowLegacyFallbackOnCanonicalUnavailable = false }) {
  const rolloutMode = response?.mode || "legacy";
  const document = buildReviewDocumentViewModel({
    rolloutMode,
    enterprisePayload: response?.enterpriseReviewPayload ?? null,
    legacyPayload: response?.legacyReviewPayload ?? legacyPayload ?? uploadedFile?.ui_review_payload ?? null,
    uploadedFileId,
    runId: response?.enterpriseReviewPayload?.runId ?? response?.enterpriseReviewPayload?.run_id ?? null,
    generationId: response?.enterpriseReviewPayload?.generationId ?? response?.enterpriseReviewPayload?.generation_id ?? generationId ?? uploadedFile?.active_generation_id ?? null,
    allowLegacyFallbackOnCanonicalUnavailable,
  });
  recordReviewTelemetry("review_mode_loaded", {
    uploadedFileId: document.uploadedFileId,
    runId: document.runId,
    generationId: document.generationId,
    rolloutMode: document.mode,
  });
  if (document.mode === "legacy" || document.mode === "shadow") recordReviewTelemetry("legacy_adapter_used", { uploadedFileId: document.uploadedFileId, rolloutMode: document.mode });
  if (document.coverage.legacyFallbacks > 0) recordReviewTelemetry("legacy_fallback_rendered", { uploadedFileId: document.uploadedFileId, rolloutMode: document.mode, source: "legacy_fallback" });
  return document;
}

export function useReviewDocument({ uploadedFileId, uploadedFile = null, legacyPayload = null, generationId = null, enabled = true, allowLegacyFallbackOnCanonicalUnavailable = false } = {}) {
  const query = useQuery({
    queryKey: ["review_document_view_model", uploadedFileId, generationId ?? uploadedFile?.active_generation_id ?? null],
    queryFn: () => fetchDocumentIntelligenceV4ReviewPayload({ uploadedFileId, generationId: generationId ?? uploadedFile?.active_generation_id ?? null }),
    enabled: Boolean(enabled && uploadedFileId),
    retry: false,
  });

  const result = useMemo(() => {
    const fallbackPayload = legacyPayload ?? uploadedFile?.ui_review_payload ?? null;
    if (!uploadedFileId) return { document: null, error: null };
    if (query.data?.error) {
      const error = classifyError(null, query.data);
      if (error === "stale_generation") recordReviewTelemetry("stale_review_generation", { uploadedFileId, generationId });
      return { document: null, error };
    }
    try {
      const document = buildReviewDocumentFromResponse({
        response: query.data || { mode: "legacy" },
        uploadedFile,
        legacyPayload: fallbackPayload,
        uploadedFileId,
        generationId,
        allowLegacyFallbackOnCanonicalUnavailable,
      });
      return { document, error: null };
    } catch (error) {
      const classified = classifyError(error, query.data);
      recordReviewTelemetry(classified === "unsupported_schema" ? "unsupported_review_schema" : "review_adapter_failed", {
        uploadedFileId,
        generationId,
        rolloutMode: query.data?.mode,
        schemaVersion: query.data?.enterpriseReviewPayload?.schemaVersion,
      });
      return { document: null, error: classified };
    }
  }, [allowLegacyFallbackOnCanonicalUnavailable, generationId, legacyPayload, query.data, uploadedFile, uploadedFileId]);

  const reload = useCallback(async () => {
    await query.refetch();
  }, [query]);

  return {
    document: result.document,
    loading: query.isLoading,
    refreshing: query.isFetching && !query.isLoading,
    error: result.error || (query.error ? classifyError(query.error, null) : null),
    reload,
  };
}

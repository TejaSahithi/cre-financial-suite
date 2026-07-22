type ReviewTelemetryMetadata = {
  orgId?: string | null;
  org_id?: string | null;
  uploadedFileId?: string | null;
  uploaded_file_id?: string | null;
  runId?: string | null;
  run_id?: string | null;
  generationId?: string | null;
  generation_id?: string | null;
  rolloutMode?: string | null;
  mode?: string | null;
  fieldKey?: string | null;
  field_key?: string | null;
  status?: string | null;
  source?: string | null;
  schemaVersion?: string | null;
  schema_version?: string | null;
};

const SAFE_EVENT_NAMES = new Set([
  "review_mode_loaded",
  "legacy_adapter_used",
  "legacy_fallback_rendered",
  "unsupported_review_schema",
  "review_adapter_failed",
  "stale_review_generation",
  "canonical_field_override",
]);

export function recordReviewTelemetry(eventName: string, metadata: ReviewTelemetryMetadata = {}) {
  if (!SAFE_EVENT_NAMES.has(eventName)) return;
  const safeMetadata = {
    orgId: metadata.orgId ?? metadata.org_id ?? null,
    uploadedFileId: metadata.uploadedFileId ?? metadata.uploaded_file_id ?? null,
    runId: metadata.runId ?? metadata.run_id ?? null,
    generationId: metadata.generationId ?? metadata.generation_id ?? null,
    rolloutMode: metadata.rolloutMode ?? metadata.mode ?? null,
    fieldKey: metadata.fieldKey ?? metadata.field_key ?? null,
    status: metadata.status ?? null,
    source: metadata.source ?? null,
    schemaVersion: metadata.schemaVersion ?? metadata.schema_version ?? null,
  };
  try {
    window.dispatchEvent(new CustomEvent("review-telemetry", { detail: { eventName, metadata: safeMetadata } }));
  } catch {
    // Telemetry must never affect review behavior.
  }
}
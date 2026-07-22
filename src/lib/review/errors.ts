export class UnsupportedReviewPayloadSchemaError extends Error {
  schemaVersion: string | null;

  constructor(schemaVersion: unknown) {
    super(`Unsupported review payload schema: ${schemaVersion || "unknown"}`);
    this.name = "UnsupportedReviewPayloadSchemaError";
    this.schemaVersion = schemaVersion ? String(schemaVersion) : null;
  }
}

export function isUnsupportedReviewPayloadSchemaError(error: unknown): error is UnsupportedReviewPayloadSchemaError {
  return error instanceof Error && error.name === "UnsupportedReviewPayloadSchemaError";
}
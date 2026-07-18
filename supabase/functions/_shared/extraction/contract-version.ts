// @ts-nocheck
/**
 * P1.7 — single source of truth for the extraction contract version,
 * replacing ~10 hardcoded "lease-review-evidence-v3" literals scattered
 * across ingest-file, normalize-pdf-output, enrichment-dispatch, and
 * pipeline.ts.
 *
 * Value is UNCHANGED, not bumped -- src/lib/leaseReviewSchema.js's
 * CURRENT_EXTRACTION_CONTRACT_VERSION staleness check is an exact string
 * comparison against whatever value backend writes actually stamp onto
 * uploaded_files/lease payloads. Changing the value here would mark every
 * existing record stale; this is a consolidation of WHERE the literal
 * lives, not a version change.
 */
export const EXTRACTION_CONTRACT_VERSION = "lease-review-evidence-v3";

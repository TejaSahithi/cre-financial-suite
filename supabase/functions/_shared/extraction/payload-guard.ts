// @ts-nocheck
/**
 * Shared "does this data have real content" checks, used both to decide
 * whether a minimal review payload is ready to open (core_ready) and to
 * guard every fallback-writing code path against overwriting real extracted
 * values with an empty manual_review_fallback payload (P0 guarantees 1-3).
 *
 * Single source of truth so normalize-pdf-output and lease-extraction-worker
 * never disagree about what counts as "meaningful."
 */

const SENTINEL_RE = /^(n\/a|na|null|none|unknown|-|—)$/i;

export function isMeaningfulFieldValue(value: unknown): boolean {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  const text = String(value).trim();
  return text.length > 0 && !SENTINEL_RE.test(text);
}

/** True if a standard_fields/custom_fields array has at least one real value. */
export function fieldListHasMeaningfulValues(fields: unknown): boolean {
  if (!Array.isArray(fields)) return false;
  return fields.some((f: any) => isMeaningfulFieldValue(f?.value));
}

/** True if a ui_review_payload (any shape produced by this pipeline) has real values. */
export function uiReviewPayloadHasMeaningfulValues(payload: unknown): boolean {
  const records = (payload as any)?.records;
  if (!Array.isArray(records) || records.length === 0) return false;
  return records.some((record: any) =>
    fieldListHasMeaningfulValues(record?.standard_fields) ||
    fieldListHasMeaningfulValues(record?.custom_fields) ||
    (record?.values && Object.values(record.values).some(isMeaningfulFieldValue)),
  );
}

/** True if parsed_data (uploaded_files.parsed_data) has real values — not the [{}] fallback shape. */
export function parsedDataHasMeaningfulValues(parsedData: unknown): boolean {
  if (!Array.isArray(parsedData) || parsedData.length === 0) return false;
  return parsedData.some(
    (row: any) => row && typeof row === "object" && Object.values(row).some(isMeaningfulFieldValue),
  );
}

/** True if normalized_output.rows has real values — not the [{}] fallback shape. */
export function normalizedOutputHasMeaningfulValues(normalizedOutput: unknown): boolean {
  const rows = (normalizedOutput as any)?.rows;
  return parsedDataHasMeaningfulValues(rows);
}

/**
 * True if ANY durable column on an uploaded_files row already has real
 * extracted values — the master check every fallback writer must consult
 * before overwriting anything (P0 guarantees 1-3).
 */
export function uploadedFileRowHasMeaningfulValues(row: {
  ui_review_payload?: unknown;
  parsed_data?: unknown;
  normalized_output?: unknown;
}): boolean {
  return (
    uiReviewPayloadHasMeaningfulValues(row?.ui_review_payload) ||
    parsedDataHasMeaningfulValues(row?.parsed_data) ||
    normalizedOutputHasMeaningfulValues(row?.normalized_output)
  );
}

// Core fields used to decide whether a lease's minimal payload is "ready
// enough" for a human to start reviewing, even before evidence enrichment
// finishes. Date and rent fields have two possible schema keys depending on
// which the extractor populated — either satisfies the category.
const CORE_FIELD_CATEGORIES: Array<string[]> = [
  ["tenant_name"],
  ["property_address", "property_name"],
  ["commencement_date", "start_date"],
  ["expiration_date", "end_date"],
  ["monthly_rent", "annual_rent"],
  ["square_footage"],
];

/**
 * core_ready: a lightweight "is this worth opening yet" signal, distinct
 * from full evidence enrichment. Requires tenant_name plus at least half of
 * the remaining core categories — not every optional field, and not a
 * literal source-evidence requirement (that's review_ready, tracked via
 * enrichment_status).
 */
export function computeCoreReady(standardFields: unknown): boolean {
  if (!Array.isArray(standardFields) || standardFields.length === 0) return false;
  const byKey = new Map<string, unknown>();
  for (const field of standardFields as any[]) {
    if (field?.field_key) byKey.set(field.field_key, field.value);
  }
  const categoryPresent = (keys: string[]) => keys.some((k) => isMeaningfulFieldValue(byKey.get(k)));

  const [tenantKeys, ...restCategories] = CORE_FIELD_CATEGORIES;
  if (!categoryPresent(tenantKeys)) return false;

  const presentCount = restCategories.filter(categoryPresent).length;
  return presentCount >= Math.ceil(restCategories.length / 2);
}

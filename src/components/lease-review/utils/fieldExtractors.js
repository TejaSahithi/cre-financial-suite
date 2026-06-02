import { cleanExtractedSourceText } from "@/pages/LeaseReview";

export function entryValue(entry) {
  if (entry == null) return null;
  if (typeof entry !== "object") return entry;
  return entry.normalized_value ?? entry.value ?? entry.raw_value ?? entry.raw ?? null;
}

export function entrySourceText(entry) {
  if (!entry || typeof entry !== "object") return null;
  return cleanExtractedSourceText(
    entry.exact_source_text
      ?? entry.exactSourceText
      ?? entry.source_clause
      ?? entry.source_text
      ?? entry.snippet
      ?? entry.evidence?.source_clause
      ?? entry.evidence?.source_text
      ?? entry.evidence?.exact_source_text,
  );
}

export function entrySourcePage(entry) {
  if (!entry || typeof entry !== "object") return null;
  const page = entry.source_page ?? entry.sourcePage ?? entry.page_number ?? entry.page
    ?? entry.evidence?.source_page ?? entry.evidence?.page_number ?? entry.evidence?.page;
  const numeric = Number(page);
  return Number.isFinite(numeric) ? numeric : null;
}

export function getEvidenceRecordForKey(fieldEvidence, fieldsWithEvidence, ed, key) {
  return fieldEvidence?.[key]
    || fieldsWithEvidence?.[key]
    || ed?.field_evidence?.[key]
    || ed?.fields?.[key]
    || null;
}

export function validEvidenceRecord(record) {
  if (!record || typeof record !== "object") return null;
  const sourceText = cleanExtractedSourceText(
    record.source_text
      ?? record.exact_source_text
      ?? record.source_clause
      ?? record.snippet
      ?? record.evidence?.source_text
      ?? record.evidence?.source_clause,
  );
  const sourcePage = record.source_page ?? record.page_number ?? record.page
    ?? record.evidence?.source_page ?? record.evidence?.page_number ?? null;
  if (!sourceText && sourcePage == null) return null;
  return {
    raw_value: record.raw_value ?? record.rawValue ?? record.value ?? null,
    source_page: sourcePage == null || sourcePage === "" ? null : Number(sourcePage),
    source_text: sourceText,
  };
}

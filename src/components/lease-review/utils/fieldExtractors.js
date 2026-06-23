import { cleanSourceEvidenceText, normalizeSourcePage } from "@/lib/leaseReviewSchema";

export function entryValue(entry) {
  if (entry == null) return null;
  if (typeof entry !== "object") return entry;
  return entry.normalized_value
    ?? entry.normalizedValue
    ?? entry.normalized_meaning
    ?? entry.normalizedMeaning
    ?? entry.value
    ?? entry.raw_value
    ?? entry.rawValue
    ?? entry.raw
    ?? null;
}

export function entrySourceText(entry) {
  if (!entry || typeof entry !== "object") return null;
  return cleanSourceEvidenceText(
    entry.exact_source_text
      ?? entry.exactSourceText
      ?? entry.source_clause
      ?? entry.source_text
      ?? entry.exact_text
      ?? entry.clause_text
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
  return normalizeSourcePage(page);
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
  const sourceText = cleanSourceEvidenceText(
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
    source_page: normalizeSourcePage(sourcePage),
    source_text: sourceText,
  };
}

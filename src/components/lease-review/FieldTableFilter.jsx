import React from "react";
import { readFieldValue, readFieldEvidence, isResolvedReview } from "@/lib/leaseReviewSchema";

// Legacy filter-key definitions kept for the exported helpers used by tests
// and any power-user code that calls countFieldsByFilter / fieldMatchesFilter.
const FILTER_KEYS = ["all", "required", "problems", "missing", "no_source", "dynamic", "conflicts"];

/**
 * Count how many fields match each legacy filter category.
 * Exported so tests and external callers can introspect field counts.
 */
export function countFieldsByFilter(fields, lease, fieldReviews, conflictKeys) {
  const counts = { all: fields.length };
  for (const key of FILTER_KEYS.slice(1)) counts[key] = 0;

  for (const field of fields) {
    const value = readFieldValue(lease, field.key);
    const { sourceText } = readFieldEvidence(lease, field.key);
    const review = fieldReviews?.[field.key];
    const resolved = isResolvedReview(review);
    const hasValue = value !== null && value !== undefined && value !== "";

    if (field.required) counts.required++;
    if (field.required && !resolved) counts.problems++;
    if (!hasValue) counts.missing++;
    if (hasValue && !sourceText) counts.no_source++;
    if (field.dynamic_document_item) counts.dynamic++;
    if (conflictKeys?.has(field.key)) counts.conflicts++;
  }

  return counts;
}

/**
 * Whether a single field matches a legacy filter key.
 * Exported for tests; the component itself no longer uses legacy filter keys.
 */
export function fieldMatchesFilter(field, filter, value, sourceText, review, conflictKeys) {
  if (filter === "all") return true;
  const hasValue = value !== null && value !== undefined && value !== "";
  const resolved = isResolvedReview(review);
  switch (filter) {
    case "required":   return field.required === true;
    case "problems":   return field.required === true && !resolved;
    case "missing":    return !hasValue;
    case "no_source":  return hasValue && !sourceText;
    case "dynamic":    return field.dynamic_document_item === true;
    case "conflicts":  return conflictKeys?.has(field.key) === true;
    default:           return true;
  }
}

/**
 * Simple two-option toggle shown above each field-review table.
 *
 * Props:
 *   showMissing  — boolean, current toggle state
 *   onToggle     — (showMissing: boolean) => void
 */
export default function FieldTableFilter({ showMissing, onToggle }) {
  const base = "rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors";
  const active = "bg-slate-800 text-white";
  const inactive = "bg-slate-100 text-slate-600 hover:bg-slate-200";

  return (
    <div className="flex gap-1.5 pb-1">
      <button
        onClick={() => onToggle(false)}
        className={`${base} ${!showMissing ? active : inactive}`}
      >
        Extracted fields only
      </button>
      <button
        onClick={() => onToggle(true)}
        className={`${base} ${showMissing ? active : inactive}`}
      >
        Show missing fields
      </button>
    </div>
  );
}

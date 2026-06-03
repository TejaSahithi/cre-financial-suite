import React, { useMemo } from "react";
import { readFieldValue, readFieldEvidence, isResolvedReview } from "@/lib/leaseReviewSchema";

const FILTERS = [
  { key: "all",        label: "All" },
  { key: "required",   label: "Required" },
  { key: "problems",   label: "Problems" },
  { key: "missing",    label: "Missing" },
  { key: "no_source",  label: "No Source" },
  { key: "dynamic",    label: "Dynamic" },
  { key: "conflicts",  label: "Conflicts" },
];

/**
 * Count how many fields match each filter category. Exported so FieldReviewTable
 * can apply the same logic for hiding rows.
 */
export function countFieldsByFilter(fields, lease, fieldReviews, conflictKeys) {
  const counts = { all: fields.length };
  for (const { key } of FILTERS.slice(1)) counts[key] = 0;

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
 * Whether a single field matches the active filter. Used in FieldReviewTable
 * to hide non-matching rows.
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
 * Filter button bar shown above each field tab table.
 */
export default function FieldTableFilter({
  fields,
  lease,
  fieldReviews,
  conflictKeys,
  activeFilter,
  onFilterChange,
}) {
  const counts = useMemo(
    () => countFieldsByFilter(fields, lease, fieldReviews, conflictKeys),
    [fields, lease, fieldReviews, conflictKeys],
  );

  return (
    <div className="flex flex-wrap gap-1.5 pb-1">
      {FILTERS.map(({ key, label }) => {
        const count = counts[key] ?? 0;
        if (key !== "all" && count === 0) return null;
        const active = activeFilter === key;
        return (
          <button
            key={key}
            onClick={() => onFilterChange(key)}
            className={`flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
              active
                ? "bg-slate-800 text-white"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
          >
            {label}
            {key !== "all" && (
              <span className={`rounded-full px-1 text-[9px] font-bold ${active ? "bg-slate-600 text-slate-200" : "bg-slate-300 text-slate-600"}`}>
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

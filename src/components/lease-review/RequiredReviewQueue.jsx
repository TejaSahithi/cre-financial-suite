import React from "react";
import { Check, Pencil, AlertCircle, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LEASE_REVIEW_FIELDS, readFieldValue } from "@/lib/leaseReviewSchema";

// Map tab key → short display label for the jump chip.
const TAB_LABELS = {
  parties_premises: "Parties",
  dates_term: "Dates",
  rent_charges: "Rent",
  expenses_recoveries: "Expenses",
  cam_rules: "CAM",
  insurance: "Insurance",
  legal_options: "Legal",
};

const fieldMeta = Object.fromEntries(LEASE_REVIEW_FIELDS.map((f) => [f.key, f]));

/**
 * Compact task queue shown above the confidence cards.
 * Lists only the required fields that are blocking approval so the
 * reviewer can resolve them without scanning the whole table.
 */
export default function RequiredReviewQueue({
  pendingKeys,
  leaseFull,
  onJumpToTab,
  onAccept,
  onEdit,
}) {
  if (!pendingKeys || pendingKeys.length === 0) return null;

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
      <div className="mb-2 flex items-center gap-2">
        <AlertCircle className="h-4 w-4 text-amber-600 shrink-0" />
        <span className="text-sm font-semibold text-amber-900">
          {pendingKeys.length} required field{pendingKeys.length !== 1 ? "s" : ""} need review before approval
        </span>
      </div>
      <ul className="space-y-1">
        {pendingKeys.map((key) => {
          const meta = fieldMeta[key];
          if (!meta) return null;
          const value = readFieldValue(leaseFull, key);
          const hasValue = value !== null && value !== undefined && value !== "";
          const tabLabel = TAB_LABELS[meta.tab] || meta.tab;

          return (
            <li key={key} className="flex items-center gap-2 rounded-lg bg-white/70 px-3 py-2 text-xs">
              {/* Field label + tab jump */}
              <button
                className="flex items-center gap-1 font-medium text-amber-900 hover:text-amber-700 text-left flex-1 min-w-0"
                onClick={() => onJumpToTab(meta.tab)}
                title={`Jump to ${meta.label} in ${tabLabel} tab`}
              >
                <ChevronRight className="h-3 w-3 shrink-0" />
                <span className="truncate">{meta.label}</span>
                <span className="ml-1 shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">
                  {tabLabel}
                </span>
              </button>

              {/* Current value (if any) */}
              {hasValue ? (
                <span className="text-slate-500 truncate max-w-[120px]" title={String(value)}>
                  {String(value).slice(0, 40)}
                </span>
              ) : (
                <span className="text-slate-400 italic">not found</span>
              )}

              {/* Quick actions */}
              {hasValue && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 shrink-0 px-2 text-[10px] text-emerald-700 hover:bg-emerald-50"
                  onClick={(e) => { e.stopPropagation(); onAccept(key); }}
                >
                  <Check className="mr-1 h-3 w-3" />
                  Accept
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="h-6 shrink-0 px-2 text-[10px] text-blue-700 hover:bg-blue-50"
                onClick={(e) => { e.stopPropagation(); onEdit(key); }}
              >
                <Pencil className="mr-1 h-3 w-3" />
                {hasValue ? "Edit" : "Fill in"}
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

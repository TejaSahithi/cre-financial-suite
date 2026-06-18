import React from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Check,
  ChevronDown,
  Eye,
  Gavel,
  HelpCircle,
  MinusCircle,
  Pencil,
  X,
} from "lucide-react";
import {
  REVIEW_STATUSES,
  readFieldEvidence,
  readFieldValue,
  resolveSourceTextQuality,
} from "@/lib/leaseReviewSchema";
import { getLeaseFieldLabel, hasLeaseFieldOptions } from "@/lib/leaseFieldOptions";
import { validateFieldValue } from "@/components/lease-review/utils/fieldValidator";
import { isReviewRowDisplayable } from "@/components/lease-review/utils/dynamicFields";

// ── Formatters ────────────────────────────────────────────────────────────────

const displayValue = (field, value) => {
  if (value == null || value === "") return "—";
  if (Array.isArray(value)) {
    if (value.length === 0) return "—";
    const isObjectArray = value.some((v) => v !== null && typeof v === "object");
    if (isObjectArray) return `${value.length} row${value.length === 1 ? "" : "s"}`;
    return value.join(", ");
  }
  // Non-array objects should never reach display — guard against [object Object]
  if (typeof value === "object") return "—";
  const str = String(value);
  // Legacy stringified arrays (e.g. from old extractions before looksLikeNoise fix)
  if (str.includes("[object Object]")) return "—";
  if (field.type === "currency" && !Number.isNaN(Number(str))) {
    return `$${Number(str).toLocaleString()}`;
  }
  if (field.type === "select" && hasLeaseFieldOptions(field.options || field.key)) {
    return getLeaseFieldLabel(field.options || field.key, str) || str;
  }
  if (field.type === "boolean") {
    return value === true || str === "true" || str === "yes" ? "Yes" : "No";
  }
  return str;
};

function truncate(text, max = 140) {
  if (!text) return "—";
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// ── Source quality badge ──────────────────────────────────────────────────────

const SOURCE_QUALITY_BADGE = {
  exact:   { label: "Exact",     cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  partial: { label: "Partial",   cls: "bg-amber-50 text-amber-700 border-amber-200" },
  derived: { label: "Derived",   cls: "bg-blue-50 text-blue-700 border-blue-200" },
  inferred: { label: "Inferred", cls: "bg-purple-50 text-purple-700 border-purple-200" },
  conflict: { label: "Conflict", cls: "bg-red-50 text-red-700 border-red-200" },
  missing: { label: "No source", cls: "bg-red-50 text-red-600 border-red-200" },
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function FieldReviewTable({
  fields,
  lease,
  fieldReviews,
  onOpenDetail,
  onQuickAction,
  showMissing = false,
  conflictKeys,
}) {
  if (!fields || fields.length === 0) {
    return (
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
        No fields in this section.
      </div>
    );
  }

  const visibleFields = fields.filter((field) => {
    return isReviewRowDisplayable(field, { showMissing });
  });

  if (visibleFields.length === 0) {
    return (
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
        No extracted fields in this section. Toggle "Show missing fields" to see all.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[200px] text-xs">Field</TableHead>
            <TableHead className="w-[200px] text-xs">Normalized Value</TableHead>
            <TableHead className="w-[60px] text-xs text-center">Page</TableHead>
            <TableHead className="text-xs">Source Text</TableHead>
            <TableHead className="w-[170px] text-xs text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visibleFields.map((field) => {
            const review = fieldReviews?.[field.key];
            const reviewStatus = review?.status || REVIEW_STATUSES.PENDING;
            const value = field.normalized_value ?? field.value ?? readFieldValue(lease, field.key);
            const evidence = readFieldEvidence(lease, field.key);
            const sourceText = field.source_text ?? field.exact_source_text ?? evidence.sourceText;
            const extractionStatus = field.status ?? field.extraction_status ?? evidence.extractionStatus;
            const sourcePage = field.page_number ?? field.source_page ?? evidence.sourcePage;
            const required = field.required;
            const validationResult = validateFieldValue(field.key, value);
            const isConflict = conflictKeys?.has(field.key);
            const sourceQualityKey = resolveSourceTextQuality({
              value,
              sourceText,
              sourcePage,
              extractionStatus,
              evidenceType: field.evidence_type ?? evidence.evidenceType,
              sourceTextQuality: field.source_text_quality ?? evidence.sourceTextQuality,
              sourceFieldKeys: field.source_field_keys ?? evidence.sourceFieldKeys,
              derivationTrace: field.derivation_trace ?? evidence.derivationTrace,
              conflictCandidates: isConflict ? [field.key] : [],
            });
            const sqBadge = SOURCE_QUALITY_BADGE[sourceQualityKey];

            const rowClass = isConflict
              ? "bg-red-50/40 hover:bg-red-50/70"
              : !validationResult.valid
                ? "bg-red-50/30 hover:bg-red-50/60"
                : reviewStatus === REVIEW_STATUSES.PENDING && required
                  ? "bg-amber-50/40 hover:bg-amber-50/70"
                  : reviewStatus === REVIEW_STATUSES.REJECTED
                    ? "bg-red-50/30 hover:bg-red-50/60"
                    : "";

            return (
              <TableRow
                key={field.key}
                className={`${rowClass} cursor-pointer`}
                onClick={() => onOpenDetail(field)}
              >
                {/* Field name */}
                <TableCell className="text-xs">
                  <div className="flex flex-wrap items-center gap-1 font-medium text-slate-700">
                    {field.field_label || field.label}
                    {required && <span className="text-red-500">*</span>}
                    {isConflict && (
                      <span className="rounded px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide bg-red-100 text-red-700">
                        Conflict
                      </span>
                    )}
                  </div>
                  {!validationResult.valid && (
                    <p className="mt-0.5 text-[9px] text-red-600 leading-tight">{validationResult.reason}</p>
                  )}
                </TableCell>

                {/* Normalized value — shown in red when validation fails so
                    reviewers can see what was extracted and decide to edit. */}
                <TableCell className="text-xs">
                  {value == null || value === "" ? (
                    <span className="text-slate-400">—</span>
                  ) : (
                    <span className={`font-semibold ${!validationResult.valid ? "text-red-700" : "text-slate-900"}`}>
                      {displayValue(field, value)}
                    </span>
                  )}
                </TableCell>

                {/* Page number */}
                <TableCell className="text-xs text-center text-slate-500">
                  {sourcePage != null ? sourcePage : "—"}
                </TableCell>

                {/* Source text + quality badge */}
                <TableCell className="text-xs" onClick={(e) => e.stopPropagation()}>
                  <div className="flex flex-col gap-1">
                    <p className="italic text-slate-500 leading-snug whitespace-pre-wrap break-words max-w-xs" title={sourceText ?? ""}>
                      {truncate(sourceText, 260)}
                    </p>
                    {sqBadge && (
                      <span className={`self-start inline-flex items-center rounded border px-1 py-0 text-[9px] font-medium ${sqBadge.cls}`}>
                        {sqBadge.label}
                      </span>
                    )}
                  </div>
                </TableCell>

                {/* Actions */}
                <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm" className="h-7 text-xs">
                        Actions
                        <ChevronDown className="ml-1 h-3.5 w-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-48">
                      <DropdownMenuItem onSelect={() => onOpenDetail(field)}>
                        <Eye className="mr-2 h-3.5 w-3.5 text-slate-500" />
                        Open detail
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => onQuickAction(field, "edit")}>
                        <Pencil className="mr-2 h-3.5 w-3.5 text-blue-600" />
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={() => onQuickAction(field, "accept")}>
                        <Check className="mr-2 h-3.5 w-3.5 text-emerald-600" />
                        Accept
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => onQuickAction(field, "reject")}>
                        <X className="mr-2 h-3.5 w-3.5 text-red-600" />
                        Reject
                      </DropdownMenuItem>
                      {field.allowNA !== false && (
                        <DropdownMenuItem onSelect={() => onQuickAction(field, "na")}>
                          <MinusCircle className="mr-2 h-3.5 w-3.5 text-slate-600" />
                          Mark N/A
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem onSelect={() => onQuickAction(field, "manual")}>
                        <HelpCircle className="mr-2 h-3.5 w-3.5 text-amber-600" />
                        Manual Required
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => onQuickAction(field, "legal")}>
                        <Gavel className="mr-2 h-3.5 w-3.5 text-purple-600" />
                        Needs Legal
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

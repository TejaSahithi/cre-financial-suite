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
} from "@/lib/leaseReviewSchema";
import { getLeaseFieldLabel, hasLeaseFieldOptions } from "@/lib/leaseFieldOptions";
import { fieldMatchesFilter } from "@/components/lease-review/FieldTableFilter";
import { validateFieldValue, computeSourceQuality } from "@/components/lease-review/utils/fieldValidator";

// ── Formatters ────────────────────────────────────────────────────────────────

const displayValue = (field, value) => {
  if (value == null || value === "") return "—";
  if (field.type === "currency" && !Number.isNaN(Number(value))) {
    return `$${Number(value).toLocaleString()}`;
  }
  if (field.type === "select" && hasLeaseFieldOptions(field.options || field.key)) {
    return getLeaseFieldLabel(field.options || field.key, value) || String(value);
  }
  if (field.type === "boolean") {
    return value === true || value === "true" || value === "yes" ? "Yes" : "No";
  }
  return String(value);
};

function truncate(text, max = 120) {
  if (!text) return "—";
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// ── Status computation ────────────────────────────────────────────────────────

const SOURCE_QUALITY_BADGE = {
  exact:   { label: "Exact",    cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  partial: { label: "Partial",  cls: "bg-amber-50 text-amber-700 border-amber-200" },
  derived: { label: "Derived",  cls: "bg-blue-50 text-blue-700 border-blue-200" },
  missing: { label: "No source",cls: "bg-red-50 text-red-600 border-red-200" },
};

const ROW_STATUS = {
  accepted:    { label: "Accepted",        cls: "bg-emerald-100 text-emerald-800" },
  rejected:    { label: "Rejected",        cls: "bg-red-100 text-red-800" },
  n_a:         { label: "N/A",             cls: "bg-slate-100 text-slate-500" },
  manual:      { label: "Manual",          cls: "bg-purple-100 text-purple-800" },
  missing:     { label: "Missing",         cls: "bg-red-50 text-red-600" },
  no_source:   { label: "No Source",       cls: "bg-orange-100 text-orange-800" },
  invalid:     { label: "Invalid",         cls: "bg-red-200 text-red-900" },
  dynamic:     { label: "Dynamic Clause",  cls: "bg-violet-100 text-violet-800" },
  pending:     { label: "Needs Review",    cls: "bg-amber-100 text-amber-800" },
};

function computeRowStatus(field, value, sourceText, extractionStatus, reviewStatus, validationResult) {
  if (!validationResult.valid) return "invalid";
  if (reviewStatus === REVIEW_STATUSES.ACCEPTED || reviewStatus === REVIEW_STATUSES.EDITED) return "accepted";
  if (reviewStatus === REVIEW_STATUSES.N_A) return "n_a";
  if (reviewStatus === REVIEW_STATUSES.MANUAL_REQUIRED || reviewStatus === REVIEW_STATUSES.NEEDS_LEGAL) return "manual";
  if (reviewStatus === REVIEW_STATUSES.REJECTED) return "rejected";
  const hasValue = value !== null && value !== undefined && value !== "";
  if (!hasValue) return "missing";
  if (!sourceText) return "no_source";
  return "pending";
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function FieldReviewTable({
  fields,
  lease,
  fieldReviews,
  onOpenDetail,
  onQuickAction,
  tableFilter = "all",
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
    if (tableFilter === "all") return true;
    const value = readFieldValue(lease, field.key);
    const { sourceText } = readFieldEvidence(lease, field.key);
    const review = fieldReviews?.[field.key];
    return fieldMatchesFilter(field, tableFilter, value, sourceText, review, conflictKeys);
  });

  if (visibleFields.length === 0) {
    return (
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
        No fields match the current filter.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[180px] text-xs">Field</TableHead>
            <TableHead className="w-[100px] text-xs">Status</TableHead>
            <TableHead className="w-[190px] text-xs">Normalized</TableHead>
            <TableHead className="text-xs">Exact Source Text</TableHead>
            <TableHead className="w-[170px] text-xs text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visibleFields.map((field) => {
            const review = fieldReviews?.[field.key];
            const reviewStatus = review?.status || REVIEW_STATUSES.PENDING;
            const value = readFieldValue(lease, field.key);
            const evidence = readFieldEvidence(lease, field.key);
            const { sourceText, extractionStatus } = evidence;
            const required = field.required;
            const validationResult = validateFieldValue(field.key, value);
            const rowStatusKey = computeRowStatus(field, value, sourceText, extractionStatus, reviewStatus, validationResult);
            const sourceQualityKey = computeSourceQuality(value, sourceText, extractionStatus);
            const sqBadge = SOURCE_QUALITY_BADGE[sourceQualityKey];
            const statusBadge = ROW_STATUS[rowStatusKey];

            const isConflict = conflictKeys?.has(field.key);
            const rowClass = isConflict
              ? "bg-red-50/40 hover:bg-red-50/70"
              : rowStatusKey === "invalid"
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
                    {field.label}
                    {required && <span className="text-red-500">*</span>}
                    {field.dynamic_document_item && (
                      <span className="rounded px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide bg-violet-100 text-violet-700">
                        AI
                      </span>
                    )}
                    {isConflict && (
                      <span className="rounded px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide bg-red-100 text-red-700">
                        Conflict
                      </span>
                    )}
                  </div>
                </TableCell>

                {/* Status */}
                <TableCell className="text-xs">
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${statusBadge.cls}`}>
                    {statusBadge.label}
                  </span>
                  {!validationResult.valid && (
                    <p className="mt-0.5 text-[9px] text-red-600 leading-tight">{validationResult.reason}</p>
                  )}
                </TableCell>

                {/* Normalized value */}
                <TableCell className="text-xs">
                  {value == null || value === "" ? (
                    <span className="text-slate-400">—</span>
                  ) : (
                    <span className={`font-semibold ${!validationResult.valid ? "text-red-700" : "text-slate-900"}`}>
                      {displayValue(field, value)}
                    </span>
                  )}
                </TableCell>

                {/* Source text + quality badge */}
                <TableCell className="text-xs" onClick={(e) => e.stopPropagation()}>
                  <div className="flex flex-col gap-1">
                    <p className="italic text-slate-500 leading-snug" title={sourceText ?? ""}>
                      {truncate(sourceText, 120)}
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

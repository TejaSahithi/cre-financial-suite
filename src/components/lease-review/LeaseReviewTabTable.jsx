import React, { useMemo, useState } from "react";
import { Search, SlidersHorizontal, Check, Pencil, X, Eye, Ban, Send, MoreHorizontal, AlertTriangle, CircleSlash } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { isMeaningfulValue } from "@/lib/leaseReviewSchema";

const TYPE_META = {
  standard: { label: "Standard", className: "bg-blue-50 text-blue-700 border-blue-100" },
  dynamic: { label: "Dynamic", className: "bg-violet-50 text-violet-700 border-violet-100" },
  expense_rule: { label: "Expense Rule", className: "bg-amber-50 text-amber-800 border-amber-100" },
  cam_rule: { label: "CAM Rule", className: "bg-cyan-50 text-cyan-700 border-cyan-100" },
  clause: { label: "Clause", className: "bg-slate-100 text-slate-700 border-slate-200" },
  read_only_reference: { label: "Reference", className: "bg-slate-50 text-slate-600 border-slate-200" },
};

const STATUS_META = {
  auto_populated: { label: "Auto-filled", className: "bg-emerald-50 text-emerald-700 border-emerald-100" },
  extracted: { label: "Extracted", className: "bg-emerald-50 text-emerald-700 border-emerald-100" },
  draft_from_extraction: { label: "Draft", className: "bg-amber-50 text-amber-800 border-amber-100" },
  draft: { label: "Draft", className: "bg-amber-50 text-amber-800 border-amber-100" },
  needs_review: { label: "Needs Review", className: "bg-amber-50 text-amber-800 border-amber-100" },
  missing: { label: "Missing", className: "bg-slate-100 text-slate-600 border-slate-200" },
  manual_required: { label: "Manual", className: "bg-purple-50 text-purple-700 border-purple-100" },
  rejected: { label: "Rejected", className: "bg-red-50 text-red-700 border-red-100" },
  approved: { label: "Approved", className: "bg-emerald-50 text-emerald-700 border-emerald-100" },
  pending: { label: "Pending", className: "bg-slate-100 text-slate-700 border-slate-200" },
  // Release 1: distinct badges for states computeFieldStatus() (in
  // leaseReviewFieldNormalizer.js) previously collapsed into a flat
  // "missing" before a reviewer ever saw the row.
  not_found: { label: "Not Stated", className: "bg-slate-100 text-slate-600 border-slate-200" },
  not_applicable: { label: "N/A", className: "bg-slate-50 text-slate-500 border-slate-200" },
  // Pre-existing gap: computeFieldStatus() could already return this, but
  // with no matching entry here it silently fell back to the generic
  // "Pending" badge (see the `|| STATUS_META.pending` fallback below).
  manually_edited: { label: "Edited", className: "bg-blue-50 text-blue-700 border-blue-100" },
};

// Phase 40: "how did this value come to exist" â€” distinct from STATUS_META
// ("is this row usable right now"). Values are resolved by
// resolveLeaseReviewExtractionMode() (leaseReviewFieldNormalizer.js), never
// guessed here â€” this map is presentation-only.
const EXTRACTION_MODE_META = {
  explicit: { label: "Explicit", className: "bg-emerald-50 text-emerald-700 border-emerald-100" },
  normalized: { label: "Normalized", className: "bg-blue-50 text-blue-700 border-blue-100" },
  inferred: { label: "Inferred", className: "bg-amber-50 text-amber-800 border-amber-100" },
  calculated: { label: "Calculated", className: "bg-cyan-50 text-cyan-700 border-cyan-100" },
  reviewer_entered: { label: "Reviewer Entered", className: "bg-purple-50 text-purple-700 border-purple-100" },
  manual: { label: "Manual", className: "bg-purple-50 text-purple-700 border-purple-100" },
  unknown: { label: "Unknown", className: "bg-slate-100 text-slate-600 border-slate-200" },
};

function formatValue(value) {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "-";
  if (typeof value === "object") return "-";
  return String(value);
}

function normalizeConfidence(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  return Math.round(value <= 1 ? value * 100 : value);
}

function sourcePreview(text) {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "-";
  return cleaned.length > 240 ? `${cleaned.slice(0, 239)}...` : cleaned;
}

function rowSearchText(row) {
  return [row.typeLabel, row.rowType, row.label, row.fieldKey, row.category, row.value, row.sourceText, row.source_text]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function shouldShowRow(row, showAdvanced) {
  if (row.defaultVisible) return true;
  if (showAdvanced) return true;
  if (row.requiredForApproval || row.requiredForBudget || row.requiredForCam || row.requiredForExpenseRules) return true;
  if (isMeaningfulValue(row.value ?? row.normalized_value ?? row.normalizedValue)) return true;
  if (row.sourceText || row.source_text) return true;
  return false;
}

export default function LeaseReviewTabTable({ rows = [], onOpenDetail, onQuickAction, onNavigateRules, reviewFields = {} }) {
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [showAdvanced, setShowAdvanced] = useState(false);

  const typeOptions = useMemo(() => {
    return Array.from(new Set(rows.map((row) => row.rowType).filter(Boolean))).sort();
  }, [rows]);
  const statusOptions = useMemo(() => {
    return Array.from(new Set(rows.map((row) => row.status).filter(Boolean))).sort();
  }, [rows]);

  const visibleRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (!shouldShowRow(row, showAdvanced)) return false;
      if (typeFilter !== "all" && row.rowType !== typeFilter) return false;
      if (statusFilter !== "all" && row.status !== statusFilter) return false;
      if (needle && !rowSearchText(row).includes(needle)) return false;
      return true;
    });
  }, [rows, query, typeFilter, statusFilter, showAdvanced]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-slate-400" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search rows" className="h-9 pl-8 text-sm" />
        </div>
        <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)} className="h-9 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700">
          <option value="all">All types</option>
          {typeOptions.map((type) => <option key={type} value={type}>{TYPE_META[type]?.label || type}</option>)}
        </select>
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="h-9 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700">
          <option value="all">All statuses</option>
          {statusOptions.map((status) => <option key={status} value={status}>{STATUS_META[status]?.label || status}</option>)}
        </select>
        <Button type="button" variant={showAdvanced ? "default" : "outline"} size="sm" className="h-9 text-xs" onClick={() => setShowAdvanced((value) => !value)}>
          <SlidersHorizontal className="mr-1.5 h-3.5 w-3.5" />
          Advanced
        </Button>
      </div>

      <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
        <Table className="min-w-[1080px]">
          <TableHeader className="sticky top-0 z-10 bg-slate-50">
            <TableRow>
              <TableHead className="w-[220px] text-xs">Field / Term</TableHead>
              <TableHead className="w-[220px] text-xs">Value</TableHead>
              <TableHead className="w-[120px] text-xs">Status</TableHead>
              <TableHead className="w-[90px] text-xs text-center">Confidence</TableHead>
              <TableHead className="w-[130px] text-xs">Extraction Mode</TableHead>
              <TableHead className="w-[70px] text-xs text-center">Page</TableHead>
              <TableHead className="min-w-[360px] text-xs">Source Text</TableHead>
              <TableHead className="w-[120px] text-xs text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="py-8 text-center text-sm text-slate-500">No rows match the current filters.</TableCell>
              </TableRow>
            ) : visibleRows.map((row, index) => {
              const statusMeta = STATUS_META[row.status] || STATUS_META.pending;
              const extractionModeMeta = EXTRACTION_MODE_META[row.extractionMode] || EXTRACTION_MODE_META.unknown;
              const confidence = row.confidencePercent ?? normalizeConfidence(row.confidence);
              const canFieldAction = row.rowType === "standard" && row.editable !== false;
              const canRuleAction = row.rowType === "expense_rule" || row.rowType === "cam_rule";
              const hasSourceEvidence = Boolean(row.sourceText || row.source_text || row.sourcePage || row.source_page || row.page_number);
              const viewSource = () => {
                if (onQuickAction) onQuickAction(row, "view_source");
                else onOpenDetail?.(row);
              };
              const fKey = row.key || row.fieldKey;
              const reviewField = reviewFields?.[fKey] ?? null;
              const rowValue = formatValue(row.value ?? row.normalized_value ?? row.normalizedValue);
              const reviewValue = reviewField ? formatValue(reviewField.displayValue ?? reviewField.value) : "-";
              const isMismatch = reviewField && rowValue !== "-" && reviewValue !== "-" && rowValue.trim().toLowerCase() !== reviewValue.trim().toLowerCase();

              return (
                <TableRow key={row.key || row.fieldKey || `${row.rowType}-${index}`} className="align-top hover:bg-slate-50/70">
                  <TableCell className="text-xs font-medium text-slate-800">
                    {row.label || row.fieldKey || "Untitled"}
                    {row.rowType === "read_only_reference" && <div className="mt-1 text-[10px] font-normal text-slate-500">Read-only reference</div>}
                  </TableCell>
                  <TableCell className="text-xs text-slate-700">
                    {rowValue}
                    {isMismatch && (
                      <div className="mt-1 flex items-center gap-1 text-[10px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5" title={`Canonical projection: ${reviewValue}`}>
                        <AlertTriangle className="w-3 h-3 text-amber-600 shrink-0" />
                        <span>Canonical: {reviewValue}</span>
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-xs"><Badge variant="outline" className={statusMeta.className}>{statusMeta.label}</Badge></TableCell>
                  <TableCell className="text-center text-xs text-slate-600">{confidence == null ? "-" : `${confidence}%`}</TableCell>
                  <TableCell className="text-xs"><Badge variant="outline" className={extractionModeMeta.className}>{extractionModeMeta.label}</Badge></TableCell>
                  <TableCell className="text-center text-xs text-slate-600">{row.sourcePage ?? row.source_page ?? row.page_number ?? "-"}</TableCell>
                  <TableCell className="text-xs text-slate-600"><span title={row.sourceText ?? row.source_text ?? ""}>{sourcePreview(row.sourceText ?? row.source_text)}</span></TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button type="button" variant="ghost" size="icon" className="h-7 w-7" title="Action" aria-label={`Action menu for ${row.label || row.fieldKey || "row"}`}>
                          <MoreHorizontal className="h-3.5 w-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-48">
                        {canFieldAction && (
                          <>
                            <DropdownMenuItem onSelect={() => onQuickAction?.(row, "accept")}><Check className="text-emerald-600" />Accept</DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => onQuickAction?.(row, "edit")}><Pencil className="text-blue-600" />Edit</DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => onQuickAction?.(row, "needs_review")}><AlertTriangle className="text-amber-600" />Mark Needs Review</DropdownMenuItem>
                            <DropdownMenuItem disabled={row.allowNA === false} onSelect={() => onQuickAction?.(row, "na")}><CircleSlash className="text-slate-600" />Mark N/A</DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => onQuickAction?.(row, "reject")}><X className="text-red-600" />Reject</DropdownMenuItem>
                          </>
                        )}
                        <DropdownMenuItem disabled={!hasSourceEvidence} onSelect={viewSource}><Eye className="text-slate-600" />View Source</DropdownMenuItem>
                        {row.rowType === "dynamic" && <DropdownMenuItem onSelect={() => onQuickAction?.(row, "ignore")}><Ban className="text-slate-600" />Ignore</DropdownMenuItem>}
                        {canRuleAction && <DropdownMenuItem onSelect={() => onNavigateRules?.(row)}><Send className="text-slate-600" />Review rule</DropdownMenuItem>}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
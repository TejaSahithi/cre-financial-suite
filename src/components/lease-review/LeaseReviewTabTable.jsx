import React, { useMemo, useState, useEffect } from "react";
import { Search, SlidersHorizontal, Check, Pencil, X, Eye, Ban, Send, MoreHorizontal, AlertTriangle, CircleSlash, CheckCircle2, AlertCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cleanSourceEvidenceText, isMeaningfulValue } from "@/lib/leaseReviewSchema";

const TYPE_META = {
  standard: { label: "Standard", className: "bg-blue-50 text-blue-700 border-blue-100" },
  dynamic: { label: "Dynamic", className: "bg-blue-50 text-blue-700 border-blue-100" },
  expense_rule: { label: "Expense Rule", className: "bg-amber-50 text-amber-800 border-amber-100" },
  cam_rule: { label: "CAM Rule", className: "bg-cyan-50 text-cyan-700 border-cyan-100" },
  clause: { label: "Clause", className: "bg-slate-100 text-slate-700 border-slate-200" },
  material_term: { label: "Material Term", className: "bg-blue-50 text-blue-700 border-blue-100" },
  read_only_reference: { label: "Reference", className: "bg-slate-50 text-slate-600 border-slate-200" },
};

const STATUS_META = {
  auto_populated: { label: "Auto-filled", className: "bg-emerald-50 text-emerald-700 border-emerald-100" },
  extracted: { label: "Extracted", className: "bg-emerald-50 text-emerald-700 border-emerald-100" },
  draft_from_extraction: { label: "Draft", className: "bg-amber-50 text-amber-800 border-amber-100" },
  draft: { label: "Draft", className: "bg-amber-50 text-amber-800 border-amber-100" },
  needs_review: { label: "Needs Review", className: "bg-amber-50 text-amber-800 border-amber-100" },
  missing: { label: "Missing", className: "bg-slate-100 text-slate-600 border-slate-200" },
  manual_required: { label: "Manual", className: "bg-blue-50 text-blue-700 border-blue-100" },
  rejected: { label: "Rejected", className: "bg-red-50 text-red-700 border-red-100" },
  approved: { label: "Approved", className: "bg-emerald-50 text-emerald-700 border-emerald-100" },
  pending: { label: "Pending", className: "bg-slate-100 text-slate-700 border-slate-200" },
  not_found: { label: "Not Stated", className: "bg-slate-100 text-slate-600 border-slate-200" },
  not_applicable: { label: "N/A", className: "bg-slate-50 text-slate-500 border-slate-200" },
  manually_edited: { label: "Edited", className: "bg-blue-50 text-blue-700 border-blue-100" },
};

const EXTRACTION_MODE_META = {
  explicit: { label: "Explicit", className: "bg-emerald-50 text-emerald-700 border-emerald-100" },
  normalized: { label: "Normalized", className: "bg-blue-50 text-blue-700 border-blue-100" },
  inferred: { label: "Inferred", className: "bg-amber-50 text-amber-800 border-amber-100" },
  calculated: { label: "Calculated", className: "bg-cyan-50 text-cyan-700 border-cyan-100" },
  reviewer_entered: { label: "Reviewer Entered", className: "bg-blue-50 text-blue-700 border-blue-100" },
  manual: { label: "Manual", className: "bg-blue-50 text-blue-700 border-blue-100" },
  unknown: { label: "Unknown", className: "bg-slate-100 text-slate-600 border-slate-200" },
};

function cleanDisplayText(value) {
  const cleaned = cleanSourceEvidenceText(value, { truncate: false });
  return cleaned || String(value ?? "").replace(/\s+/g, " ").trim();
}

function formatStructuredValue(value) {
  if (Array.isArray(value)) {
    if (value.length === 0) return "Not extracted";
    if (value.every((item) => item && typeof item === "object" && !Array.isArray(item))) {
      return value.map((item, index) => {
        const label = item.period || item.months || item.term || item.label || `Row ${index + 1}`;
        const amount = item.monthlyRent ?? item.monthly_rent ?? item.monthly_amount ?? item.amount ?? item.value ?? null;
        const psf = item.rentPsf ?? item.rent_psf ?? item.baseRentPsf ?? item.base_rent_psf ?? null;
        return [label, amount != null ? `monthly ${amount}` : null, psf != null ? `PSF ${psf}` : null]
          .filter(Boolean)
          .join(" - ");
      }).join("\n");
    }
    return value.map((item) => typeof item === "object" ? JSON.stringify(item) : String(item)).join("\n");
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([, itemValue]) => itemValue !== null && itemValue !== undefined && itemValue !== "");
    return entries.length
      ? entries.map(([key, itemValue]) => `${key}: ${typeof itemValue === "object" ? JSON.stringify(itemValue) : String(itemValue)}`).join("\n")
      : "Not extracted";
  }
  return null;
}

export function formatValue(value, row = null) {
  if (value === null || value === undefined || value === "") return "Not extracted";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value) || typeof value === "object") return formatStructuredValue(value);

  const dataType = row?.dataType || row?.type;
  if (dataType === "currency" || dataType === "money") {
    const num = typeof value === "number" ? value : Number(String(value).replace(/[$,\s]/g, ""));
    if (!Number.isNaN(num) && num !== null && num !== undefined && String(value).trim() !== "") {
      return "$" + num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
  }

  if (dataType === "percent") {
    const num = typeof value === "number" ? value : Number(String(value).replace(/[%\s]/g, ""));
    if (!Number.isNaN(num) && num !== null && num !== undefined && String(value).trim() !== "") {
      return num + "%";
    }
  }

  return cleanDisplayText(value) || "Not extracted";
}

export function valuePreview(value, row = null) {
  const formatted = formatValue(value, row);
  if (formatted === "Not extracted") return formatted;
  const maxLength = row?.type === "schedule" || row?.category === "schedule" || row?.category === "rent_schedule" ? 420 : 160;
  return formatted.length > maxLength ? `${formatted.slice(0, maxLength - 1).trimEnd()}...` : formatted;
}

function simpleStripMarkup(value) {
  return String(value ?? "")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sentenceBoundedPreview(value, maxLength = 300) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text || text === "-" || text === "null") return "-";
  if (text.length <= maxLength) return text;
  const clipped = text.slice(0, maxLength + 1);
  const sentenceEnd = Math.max(clipped.lastIndexOf("."), clipped.lastIndexOf("?"), clipped.lastIndexOf("!"));
  if (sentenceEnd >= 80) return clipped.slice(0, sentenceEnd + 1).trim();
  const lastSpace = clipped.lastIndexOf(" ");
  return `${clipped.slice(0, lastSpace > 80 ? lastSpace : maxLength).trimEnd()}...`;
}

export function sourcePreview(text) {
  const cleaned = cleanSourceEvidenceText(text, { truncate: false });
  if (cleaned) return sentenceBoundedPreview(cleaned);
  const fallback = simpleStripMarkup(text);
  return sentenceBoundedPreview(fallback);
}

function normalizeConfidence(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  return Math.round(value <= 1 ? value * 100 : value);
}

function rowSearchText(row) {
  return [row.typeLabel, row.rowType, row.label, row.fieldKey, row.category, row.value, row.sourceText, row.source_text]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function rowHasDisplayValue(row) {
  return isMeaningfulValue(row?.value ?? row?.normalized_value ?? row?.normalizedValue);
}

export function isMandatoryRow(row) {
  return Boolean(
    row?.requiredForApproval ||
    row?.required ||
    row?.is_required ||
    row?.mandatory
  );
}

export function rowMatchesCompletenessFilter(row, completenessFilter = "filled") {
  const hasValue = rowHasDisplayValue(row);
  if (completenessFilter === "filled") return hasValue;
  if (completenessFilter === "missing") {
    if (hasValue) return false;
    if (row?.rowType === "clause") return false;
    return Boolean(row?.defaultVisible || row?.requiredForApproval || row?.requiredForBudget || row?.requiredForCam || row?.requiredForExpenseRules || row?.sourceText || row?.source_text);
  }
  if (completenessFilter === "mandatory" || completenessFilter === "required") {
    return isMandatoryRow(row);
  }
  return true;
}

function shouldShowRow(row, showAdvanced) {
  if (row.defaultVisible) return true;
  if (showAdvanced) return true;
  if (row.requiredForApproval || row.requiredForBudget || row.requiredForCam || row.requiredForExpenseRules) return true;
  if (rowHasDisplayValue(row)) return true;
  if (row.sourceText || row.source_text) return true;
  return false;
}

function rowMatchesBaseFilters(row, { needle = "", typeFilter = "all", statusFilter = "all", showAdvanced = true } = {}) {
  if (!shouldShowRow(row, showAdvanced)) return false;
  if (typeFilter !== "all" && row.rowType !== typeFilter) return false;
  if (statusFilter !== "all" && row.status !== statusFilter) return false;
  if (needle && !rowSearchText(row).includes(needle)) return false;
  return true;
}

export default function LeaseReviewTabTable({
  rows = [],
  onOpenDetail,
  onQuickAction,
  onNavigateRules,
  reviewFields = {},
  approvalRequiredKeys = null,
}) {
  const [query, setQuery] = useState("");
  const hasStandardFields = useMemo(() => rows.some((row) => row.rowType === "standard"), [rows]);
  const [typeFilter, setTypeFilter] = useState(() => (rows.some((row) => row.rowType === "standard") ? "standard" : "all"));
  const [statusFilter, setStatusFilter] = useState("all");
  const [showAdvanced, setShowAdvanced] = useState(true);
  const [completenessFilter, setCompletenessFilter] = useState("filled");

  // Keep typeFilter aligned to standard when available
  useEffect(() => {
    if (hasStandardFields && typeFilter === "all" && !rows.every((row) => row.rowType === "clause" || row.rowType === "material_term")) {
      // Keep user choice or default to standard
    }
  }, [hasStandardFields, rows, typeFilter]);

  const typeOptions = useMemo(() => {
    return Array.from(new Set(rows.map((row) => row.rowType).filter(Boolean))).sort();
  }, [rows]);
  const statusOptions = useMemo(() => {
    return Array.from(new Set(rows.map((row) => row.status).filter(Boolean))).sort();
  }, [rows]);

  const baseFilteredRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => rowMatchesBaseFilters(row, { needle, typeFilter, statusFilter, showAdvanced }));
  }, [rows, query, typeFilter, statusFilter, showAdvanced]);

  const completenessCounts = useMemo(() => ({
    all: baseFilteredRows.length,
    filled: baseFilteredRows.filter((row) => rowMatchesCompletenessFilter(row, "filled")).length,
    missing: baseFilteredRows.filter((row) => rowMatchesCompletenessFilter(row, "missing")).length,
    mandatory: baseFilteredRows.filter((row) => rowMatchesCompletenessFilter(row, "mandatory")).length,
  }), [baseFilteredRows]);

  const visibleRows = useMemo(() => {
    return baseFilteredRows.filter((row) => rowMatchesCompletenessFilter(row, completenessFilter));
  }, [baseFilteredRows, completenessFilter]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex h-9 items-center rounded-md border border-slate-200 bg-white p-1 shadow-sm">
          <Button type="button" variant={completenessFilter === "all" ? "secondary" : "ghost"} size="sm" className="h-7 gap-1.5 px-2 text-xs" onClick={() => setCompletenessFilter("all")}>
            All
            <Badge variant="outline" className="ml-1 border-slate-200 bg-slate-50 text-slate-700">{completenessCounts.all}</Badge>
          </Button>
          <Button type="button" variant={completenessFilter === "filled" ? "secondary" : "ghost"} size="sm" className="h-7 gap-1.5 px-2 text-xs" onClick={() => setCompletenessFilter("filled")}>
            <Check className="h-3.5 w-3.5" />
            Filled
            <Badge variant="outline" className="ml-1 border-emerald-100 bg-emerald-50 text-emerald-700">{completenessCounts.filled}</Badge>
          </Button>
          <Button type="button" variant={completenessFilter === "missing" ? "secondary" : "ghost"} size="sm" className="h-7 gap-1.5 px-2 text-xs" onClick={() => setCompletenessFilter("missing")}>
            <AlertTriangle className="h-3.5 w-3.5" />
            Missing
            <Badge variant="outline" className="ml-1 border-slate-200 bg-slate-50 text-slate-600">{completenessCounts.missing}</Badge>
          </Button>
          <Button type="button" variant={completenessFilter === "mandatory" ? "secondary" : "ghost"} size="sm" className="h-7 gap-1.5 px-2 text-xs" onClick={() => setCompletenessFilter("mandatory")}>
            <AlertCircle className="h-3.5 w-3.5 text-amber-600" />
            Mandatory
            <Badge variant="outline" className="ml-1 border-amber-200 bg-amber-50 text-amber-700">{completenessCounts.mandatory}</Badge>
          </Button>
        </div>
      </div>
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
              const canFieldAction = row.rowType !== "read_only_reference";
              const canRuleAction = row.rowType === "expense_rule" || row.rowType === "cam_rule";
              const hasSourceEvidence = Boolean(row.sourceText || row.source_text || row.sourcePage || row.source_page || row.page_number);
              const viewSource = () => {
                if (onQuickAction) onQuickAction(row, "view_source");
                else onOpenDetail?.(row);
              };
              const fKey = row.fieldKey || row.field_key || row.canonicalKey || row.key;
              const requiredForApproval = Boolean(row.requiredForApproval || row.required || approvalRequiredKeys?.has?.(fKey));
              const reviewField = reviewFields?.[fKey] ?? null;
              const rawRowValue = row.value ?? row.normalized_value ?? row.normalizedValue;
              const displayRowValue = row.displayValue ?? row.display_value ?? rawRowValue;
              const fullRowValue = formatValue(displayRowValue, row);
              const rowValue = valuePreview(displayRowValue, row);
              const reviewValue = reviewField ? formatValue(reviewField.displayValue ?? reviewField.value, row) : "-";
              const rowConfirmed = rowHasDisplayValue(row) && (
                ["accepted", "edited", "approved", "reviewed"].includes(String(reviewField?.status || "").toLowerCase()) ||
                ["approved", "accepted", "edited", "reviewed"].includes(String(row.status || "").toLowerCase())
              );
              const isMismatch = reviewField && fullRowValue !== "Not extracted" && reviewValue !== "Not extracted" && fullRowValue.trim().toLowerCase() !== reviewValue.trim().toLowerCase();
              const sourceNotes = [
                isMismatch ? `Suggested: Canonical projection ${reviewValue}` : null,
                !isMismatch && row.validationMessage ? `Suggested: ${row.validationMessage}` : null,
              ].filter(Boolean);

              return (
                <TableRow key={row.key || row.fieldKey || `${row.rowType}-${index}`} className="align-top hover:bg-slate-50/70">
                  <TableCell className="text-xs font-medium text-slate-800">
                    {row.label || row.fieldKey || "Untitled"}
                    {requiredForApproval && (
                      <span className="ml-1 align-super text-red-500" title="Required for approval">*</span>
                    )}
                    {row.rowType === "read_only_reference" && <div className="mt-1 text-[10px] font-normal text-slate-500">Read-only reference</div>}
                  </TableCell>
                  <TableCell className="max-w-[220px] text-xs text-slate-700" title={fullRowValue !== "Not extracted" ? fullRowValue : undefined}>
                    <span className="block whitespace-pre-wrap break-words leading-relaxed">{rowValue}</span>
                  </TableCell>
                  <TableCell className="text-xs">
                    <span className="inline-flex items-center gap-1.5">
                      {rowConfirmed && <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" aria-label="Confirmed" />}
                      <Badge variant="outline" className={statusMeta.className}>{statusMeta.label}</Badge>
                    </span>
                  </TableCell>
                  <TableCell className="text-center text-xs text-slate-600">{confidence == null ? "-" : `${confidence}%`}</TableCell>
                  <TableCell className="text-xs"><Badge variant="outline" className={extractionModeMeta.className}>{extractionModeMeta.label}</Badge></TableCell>
                  <TableCell className="text-center text-xs text-slate-600">{row.sourcePage ?? row.source_page ?? row.page_number ?? "-"}</TableCell>
                  <TableCell className="text-xs text-slate-600">
                    <span title={sourcePreview(row.sourceText ?? row.source_text)}>{sourcePreview(row.sourceText ?? row.source_text)}</span>
                    {sourceNotes.map((note) => (
                      <div key={note} className="mt-1 flex items-start gap-1 text-[10px] leading-snug text-amber-700" title={note}>
                        <AlertTriangle className="mt-px h-3 w-3 shrink-0 text-amber-600" />
                        <span>{note}</span>
                      </div>
                    ))}
                  </TableCell>
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

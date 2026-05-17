import React from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
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
  REVIEW_STATUS_LABELS,
  REVIEW_STATUS_STYLES,
  EXTRACTION_STATUS_LABELS,
  EXTRACTION_STATUS_STYLES,
  classifyConfidence,
  readFieldConfidence,
  readFieldEvidence,
  readFieldValue,
  resolveExtractionStatus,
} from "@/lib/leaseReviewSchema";
import { getLeaseFieldLabel, hasLeaseFieldOptions } from "@/lib/leaseFieldOptions";

const confidenceClass = (score) => {
  const bucket = classifyConfidence(score);
  if (bucket === "high") return "bg-emerald-100 text-emerald-700";
  if (bucket === "medium") return "bg-amber-100 text-amber-700";
  if (bucket === "low") return "bg-red-100 text-red-700";
  return "bg-slate-100 text-slate-500";
};

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

function truncate(text, max = 80) {
  if (!text) return "—";
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export default function FieldReviewTable({
  fields,
  lease,
  fieldReviews,
  onOpenDetail,
  onQuickAction,
}) {
  if (!fields || fields.length === 0) {
    return (
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
        No fields in this section.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[200px] text-xs">Field</TableHead>
            <TableHead className="text-xs">Normalized</TableHead>
            <TableHead className="text-xs">Raw Extracted</TableHead>
            <TableHead className="w-[60px] text-xs">Page</TableHead>
            <TableHead className="text-xs">Exact Source Text</TableHead>
            <TableHead className="w-[100px] text-xs">Confidence</TableHead>
            <TableHead className="w-[110px] text-xs">Extraction</TableHead>
            <TableHead className="w-[110px] text-xs">Review</TableHead>
            <TableHead className="w-[180px] text-xs text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {fields.map((field) => {
            const review = fieldReviews?.[field.key];
            const status = review?.status || REVIEW_STATUSES.PENDING;
            const value = readFieldValue(lease, field.key);
            const evidence = readFieldEvidence(lease, field.key);
            const { rawValue, sourcePage, sourceText } = evidence;
            const confidence = readFieldConfidence(lease, field.key);
            const confidenceLabel = classifyConfidence(confidence) === "unknown" ? "Unknown" : `${Math.round(confidence)}%`;
            // Auto-fill the Normalized column only when the extractor is
            // confident AND has source evidence. Otherwise show the value as
            // a "Suggested:" hint so the reviewer must explicitly accept/edit.
            // Once the reviewer has touched the field (any non-pending status),
            // the value renders as confirmed regardless of confidence.
            const hasEvidence = Boolean(
              evidence?.sourcePage
              || (typeof evidence?.sourceText === "string" && evidence.sourceText.length > 0)
              || evidence?.rawValue,
            );
            const confidenceBucket = classifyConfidence(confidence);
            const isConfirmed = status !== REVIEW_STATUSES.PENDING;
            const isHighConfidence = confidenceBucket === "high" && hasEvidence;
            const valueIsSuggestion = value != null && value !== "" && !isConfirmed && !isHighConfidence;
            // Honor backend-stamped status; otherwise derive from value/confidence.
            const inferredExtractionStatus = resolveExtractionStatus(lease, field.key, {
              value,
              confidence,
              evidence,
            });
            const extractionStatusLabel = EXTRACTION_STATUS_LABELS[inferredExtractionStatus] || inferredExtractionStatus;
            const extractionStatusClass = EXTRACTION_STATUS_STYLES[inferredExtractionStatus] || "bg-slate-100 text-slate-700";
            const required = field.required;
            const rowClass = status === REVIEW_STATUSES.PENDING && required
              ? "bg-amber-50/40 hover:bg-amber-50/70"
              : status === REVIEW_STATUSES.REJECTED
                ? "bg-red-50/30 hover:bg-red-50/60"
                : "";

            return (
              <TableRow
                key={field.key}
                className={`${rowClass} cursor-pointer`}
                onClick={() => onOpenDetail(field)}
              >
                <TableCell className="text-xs">
                  <div className="flex items-center gap-1 font-medium text-slate-700">
                    {field.label}
                    {required && <span className="text-red-500">*</span>}
                  </div>
                </TableCell>
                <TableCell className="text-xs">
                  {value == null || value === "" ? (
                    <span className="text-slate-400">—</span>
                  ) : valueIsSuggestion ? (
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                        Suggested · verify
                      </span>
                      <span className="italic text-slate-600">{displayValue(field, value)}</span>
                    </div>
                  ) : (
                    <span className="font-medium text-slate-900">{displayValue(field, value)}</span>
                  )}
                </TableCell>
                <TableCell className="text-xs text-slate-600" title={rawValue ?? ""}>
                  {truncate(rawValue, 40)}
                </TableCell>
                <TableCell className="text-xs text-slate-600">{sourcePage ?? "—"}</TableCell>
                <TableCell className="text-xs italic text-slate-500" title={sourceText ?? ""}>
                  {truncate(sourceText, 60)}
                </TableCell>
                <TableCell>
                  <Badge className={`text-[10px] ${confidenceClass(confidence)}`}>{confidenceLabel}</Badge>
                </TableCell>
                <TableCell>
                  <Badge className={`text-[10px] ${extractionStatusClass}`} title={inferredExtractionStatus}>
                    {extractionStatusLabel}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Badge className={`text-[10px] ${REVIEW_STATUS_STYLES[status] || "bg-slate-100 text-slate-700"}`}>
                    {REVIEW_STATUS_LABELS[status]}
                  </Badge>
                </TableCell>
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

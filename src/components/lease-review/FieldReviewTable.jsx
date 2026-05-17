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
import { Check, ChevronRight, Pencil, X, MinusCircle, Gavel } from "lucide-react";
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
                <TableCell className="text-xs font-medium text-slate-900">
                  {displayValue(field, value)}
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
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-emerald-600 hover:bg-emerald-50"
                      title="Accept"
                      onClick={() => onQuickAction(field, "accept")}
                    >
                      <Check className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-blue-600 hover:bg-blue-50"
                      title="Edit"
                      onClick={() => onQuickAction(field, "edit")}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-red-600 hover:bg-red-50"
                      title="Reject"
                      onClick={() => onQuickAction(field, "reject")}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                    {field.allowNA !== false && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-slate-600 hover:bg-slate-100"
                        title="Mark N/A"
                        onClick={() => onQuickAction(field, "na")}
                      >
                        <MinusCircle className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-purple-600 hover:bg-purple-50"
                      title="Needs Legal Review"
                      onClick={() => onQuickAction(field, "legal")}
                    >
                      <Gavel className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-slate-500"
                      title="Open detail"
                      onClick={() => onOpenDetail(field)}
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

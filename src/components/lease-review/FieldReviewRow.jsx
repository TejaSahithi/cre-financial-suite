import React from 'react';
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator
} from "@/components/ui/dropdown-menu";
import { ExternalLink, ChevronDown, Check, Pencil, X, MinusCircle, HelpCircle, Gavel, Undo2 } from "lucide-react";
import {
  getLeaseFieldLabel,
  hasLeaseFieldOptions,
} from "@/lib/leaseFieldOptions";
import {
  REVIEW_STATUSES,
  REVIEW_STATUS_LABELS,
  REVIEW_STATUS_STYLES,
  readFieldValue,
  readFieldEvidence,
  readFieldConfidence,
  classifyConfidence,
  resolveExtractionStatus,
} from "@/lib/leaseReviewSchema";

const confidenceColor = (val) => {
  if (val == null) return "bg-slate-100 text-slate-600";
  if (val >= 90) return "bg-emerald-100 text-emerald-800 border border-emerald-200";
  if (val >= 70) return "bg-blue-100 text-blue-800 border border-blue-200";
  if (val >= 50) return "bg-amber-100 text-amber-800 border border-amber-200";
  return "bg-red-100 text-red-800 border border-red-200";
};

export function FieldReviewRow({
  field,
  lease,
  review,
  onAccept,
  onEdit,
  onReject,
  onMarkNA,
  onNeedsLegal,
  onMarkManualRequired,
  onReset,
  onViewInDocument,
}) {
  const value = readFieldValue(lease, field.key);
  const display =
    value == null || value === ""
      ? "—"
      : field.type === "currency" && !isNaN(Number(value))
      ? `$${Number(value).toLocaleString()}`
      : field.type === "select" && hasLeaseFieldOptions(field.options || field.key)
      ? getLeaseFieldLabel(field.options || field.key, value) || String(value)
      : field.type === "boolean"
      ? value === true || value === "true" || value === "yes"
        ? "Yes"
        : "No"
      : String(value);

  const { rawValue, sourcePage, sourceText, extractionStatus } = readFieldEvidence(lease, field.key);
  const confidence = readFieldConfidence(lease, field.key);
  const status = review?.status || REVIEW_STATUSES.PENDING;
  const required = field.required;
  const allowNA = field.allowNA !== false;
  const actionLabel = REVIEW_STATUS_LABELS[status] || "Review Action";
  const confidenceBucket = classifyConfidence(confidence);
  const confidenceLabel =
    confidenceBucket === "unknown"
      ? "Unknown Confidence"
      : `${Math.round(confidence)}%`;

  const inferredExtractionStatus =
    resolveExtractionStatus(lease, field.key, {
      value,
      confidence,
      evidence: { rawValue, sourcePage, sourceText, extractionStatus },
    });

  return (
    <Card className={status === REVIEW_STATUSES.PENDING && required ? "border-amber-200" : ""}>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">
                {field.label}
                {required && <span className="ml-1 text-red-500">*</span>}
              </p>
              <Badge className={`text-[10px] ${confidenceColor(confidence)}`}>{confidenceLabel}</Badge>
              <Badge className={`text-[10px] ${REVIEW_STATUS_STYLES[status]}`}>
                {REVIEW_STATUS_LABELS[status]}
              </Badge>
              <Badge className="bg-slate-50 text-[10px] text-slate-600">{inferredExtractionStatus}</Badge>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <p className="text-[10px] font-semibold uppercase text-slate-400">Normalized Value</p>
                <p className="text-sm font-medium text-slate-900">{display}</p>
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase text-slate-400">Raw Extracted</p>
                <p className="truncate text-sm text-slate-600" title={rawValue ?? ""}>{rawValue ?? "—"}</p>
              </div>
            </div>
            <details className="text-xs text-slate-500">
              <summary className="cursor-pointer text-slate-600 hover:text-slate-800">
                Source &amp; review metadata
              </summary>
              <div className="mt-2 space-y-1 rounded bg-slate-50 p-2">
                <p>
                  <span className="font-semibold text-slate-600">Source Page:</span>{" "}
                  <span className="text-slate-700">{sourcePage ?? "—"}</span>
                </p>
                <p>
                  <span className="font-semibold text-slate-600">Exact Source Text:</span>{" "}
                  <span className="italic text-slate-700">{sourceText || "No source text captured."}</span>
                </p>
                <p>
                  <span className="font-semibold text-slate-600">Confidence Score:</span>{" "}
                  <span className="text-slate-700">{typeof confidence === "number" ? `${Math.round(confidence)}%` : "Unknown"}</span>
                </p>
                <p>
                  <span className="font-semibold text-slate-600">Extraction Status:</span>{" "}
                  <span className="text-slate-700">{inferredExtractionStatus}</span>
                </p>
                <p>
                  <span className="font-semibold text-slate-600">Review Status:</span>{" "}
                  <span className="text-slate-700">{REVIEW_STATUS_LABELS[status]}</span>
                </p>
                {review?.reviewer && (
                  <p>
                    <span className="font-semibold text-slate-600">Reviewer:</span>{" "}
                    <span className="text-slate-700">{review.reviewer}</span>
                  </p>
                )}
                {review?.reviewed_at && (
                  <p>
                    <span className="font-semibold text-slate-600">Reviewed At:</span>{" "}
                    <span className="text-slate-700">{new Date(review.reviewed_at).toLocaleString()}</span>
                  </p>
                )}
              </div>
            </details>
            <Button variant="outline" size="sm" onClick={onViewInDocument}>
              <ExternalLink className="mr-1 h-3.5 w-3.5" />
              View in Document
            </Button>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="min-w-[170px] justify-between text-xs">
                {actionLabel}
                <ChevronDown className="ml-2 h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onClick={onAccept}>
                <Check className="h-4 w-4 text-emerald-600" />
                Accept
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onEdit}>
                <Pencil className="h-4 w-4 text-blue-600" />
                Edit
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onReject}>
                <X className="h-4 w-4 text-red-600" />
                Reject
              </DropdownMenuItem>
              {allowNA && (
                <DropdownMenuItem onClick={onMarkNA}>
                  <MinusCircle className="h-4 w-4 text-slate-600" />
                  Mark N/A
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={onMarkManualRequired}>
                <HelpCircle className="h-4 w-4 text-amber-600" />
                Mark Manual Required
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onNeedsLegal}>
                <Gavel className="h-4 w-4 text-purple-600" />
                Needs Legal Review
              </DropdownMenuItem>
              {status !== REVIEW_STATUSES.PENDING && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={onReset}>
                    <Undo2 className="h-4 w-4 text-slate-500" />
                    Reset
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardContent>
    </Card>
  );
}

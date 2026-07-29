import React, { useMemo } from "react";
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { STANDARD_FIELD_GROUPS } from "@/lib/leaseFieldContract";
import { getReviewStatusPresentation } from "@/lib/review/reviewStatusPresentation";

const STATUS_BADGE = {
  auto_populated: { label: "Auto-populated", className: "bg-emerald-50 text-emerald-700" },
  needs_review: { label: "Needs Review", className: "bg-amber-100 text-amber-800" },
  missing: { label: "Missing", className: "bg-slate-100 text-slate-600" },
  rejected: { label: "Rejected", className: "bg-red-100 text-red-700" },
  manually_edited: { label: "Manually Edited", className: "bg-blue-50 text-blue-700" },
};

const CONFIDENCE_BADGE = {
  high: "bg-emerald-50 text-emerald-700",
  medium: "bg-amber-50 text-amber-700",
  low: "bg-red-50 text-red-700",
  unknown: "bg-slate-100 text-slate-600",
};

function confidenceBucket(score) {
  if (typeof score !== "number" || Number.isNaN(score)) return "unknown";
  if (score >= 90) return "high";
  if (score >= 75) return "medium";
  return "low";
}

function formatValue(value) {
  if (value === null || value === undefined || value === "") return "Not extracted";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.length ? value.map((item) => typeof item === "object" ? JSON.stringify(item) : String(item)).join("\n") : "Not extracted";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

function GroupStats({ rows }) {
  const total = rows.length;
  const populated = rows.filter((r) => r.status !== "missing").length;
  const needsReview = rows.filter((r) => r.status === "needs_review").length;
  const missingRequired = rows.filter((r) => r.status === "missing" && r.requiredForApproval).length;
  const sourceBacked = rows.filter((r) => r.evidenceVerified).length;

  return (
    <div className="flex flex-wrap gap-2 text-xs">
      <Badge className="bg-slate-100 text-slate-700">{total} fields</Badge>
      <Badge className="bg-slate-100 text-slate-700">{populated} populated</Badge>
      {needsReview > 0 && <Badge className="bg-amber-100 text-amber-800">{needsReview} needs review</Badge>}
      {missingRequired > 0 && <Badge className="bg-red-100 text-red-700">{missingRequired} missing required</Badge>}
      <Badge className="bg-blue-50 text-blue-700">{sourceBacked} source-backed</Badge>
    </div>
  );
}

function FieldRow({ row, onOpenDetail }) {
  const statusMeta = getReviewStatusPresentation(row.canonicalStatus || row.canonical_status || row.status) || STATUS_BADGE[row.status] || STATUS_BADGE.missing;
  const confidenceMeta = CONFIDENCE_BADGE[confidenceBucket(row.confidence)];

  return (
    <button
      type="button"
      onClick={() => onOpenDetail?.(row)}
      className="flex w-full flex-col gap-1 rounded-md border border-slate-100 px-3 py-2 text-left hover:bg-slate-50"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-slate-800">{row.label}</span>
        <div className="flex items-center gap-1.5">
          {typeof row.confidence === "number" && (
            <Badge className={confidenceMeta}>{Math.round(row.confidence)}%</Badge>
          )}
          <Badge className={statusMeta.className}>{statusMeta.label}</Badge>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 text-xs text-slate-500">
        <span className="whitespace-pre-wrap break-words">{formatValue(row.value)}</span>
        {row.sourcePage != null && <span className="shrink-0">p.{row.sourcePage}</span>}
      </div>
      {row.sourceText && (
        <p className="line-clamp-1 text-xs italic text-slate-400">"{row.sourceText}"</p>
      )}
    </button>
  );
}

/**
 * Renders standardFields (from normalizeLeaseReviewData()) grouped by the 17
 * canonical groups (STANDARD_FIELD_GROUPS). Additive — sits alongside the
 * existing tab/FieldReviewTable structure, does not replace it.
 */
export default function StandardFieldsByGroup({ standardFields, onOpenDetail }) {
  const rowsByGroup = useMemo(() => {
    const map = new Map();
    for (const group of STANDARD_FIELD_GROUPS) map.set(group.key, []);
    for (const row of standardFields || []) {
      if (!map.has(row.group)) map.set(row.group, []);
      map.get(row.group).push(row);
    }
    return map;
  }, [standardFields]);

  const groupsWithFields = STANDARD_FIELD_GROUPS.filter((g) => (rowsByGroup.get(g.key) || []).length > 0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Standard Fields by Group</CardTitle>
        <p className="text-xs text-slate-500">
          Every {`LEASE_SCHEMA`} field, grouped per <code>docs/lease-standard-field-model.md</code>. This view is
          additive — the tabs below still show the same fields the original way.
        </p>
      </CardHeader>
      <CardContent>
        <Accordion type="multiple" className="w-full">
          {groupsWithFields.map((group) => {
            const rows = rowsByGroup.get(group.key) || [];
            return (
              <AccordionItem key={group.key} value={group.key}>
                <AccordionTrigger>
                  <div className="flex flex-1 flex-col gap-1 pr-4 text-left">
                    <span>{group.label}</span>
                    <GroupStats rows={rows} />
                  </div>
                </AccordionTrigger>
                <AccordionContent>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {rows.map((row) => (
                      <FieldRow key={row.canonicalKey} row={row} onOpenDetail={onOpenDetail} />
                    ))}
                  </div>
                </AccordionContent>
              </AccordionItem>
            );
          })}
        </Accordion>
      </CardContent>
    </Card>
  );
}

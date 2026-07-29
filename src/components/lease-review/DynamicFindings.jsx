import React from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function formatValue(value) {
  if (value === null || value === undefined || value === "") return "Not extracted";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.length ? value.map((item) => typeof item === "object" ? JSON.stringify(item) : String(item)).join("\n") : "Not extracted";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

/**
 * Facts extracted but not mapped to any standard LEASE_SCHEMA field — so no
 * important lease term disappears just because it isn't in LEASE_SCHEMA.
 * Reads `dynamicFindings` from normalizeLeaseReviewData() (leaseReviewFieldNormalizer.js),
 * which itself wraps the existing collectExtractedDocumentItems() — not a
 * new extraction path.
 *
 * Release 1 scope: read-only. No map-to-field/dismiss/mark-non-material
 * actions yet (those are a Release 2+ decision, once there's somewhere to
 * persist them) and this panel never blocks approval. Renders nothing when
 * there are no findings, rather than an empty-state card, so it doesn't add
 * persistent clutter to every document.
 */
export default function DynamicFindings({ dynamicFindings }) {
  const rows = dynamicFindings || [];
  if (rows.length === 0) return null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 pb-2">
        <div>
          <CardTitle className="text-base">Dynamic Findings</CardTitle>
          <p className="text-xs text-slate-500">
            Facts extracted from the document that don't map to a standard field. For review — mapping actions coming soon.
          </p>
        </div>
        <Badge className="bg-slate-100 text-slate-700">{rows.length} found</Badge>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {rows.map((row, idx) => (
            <div key={`${row.label}-${idx}`} className="rounded-md border border-slate-100 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-slate-800">{row.label}</span>
                <div className="flex items-center gap-1.5">
                  <Badge className="bg-slate-100 text-slate-600">{row.category}</Badge>
                  {typeof row.confidencePercent === "number" && (
                    <Badge className="bg-blue-50 text-blue-700">{Math.round(row.confidencePercent)}%</Badge>
                  )}
                </div>
              </div>
              <div className="mt-1 flex items-center justify-between gap-2 text-xs text-slate-500">
                <span className="whitespace-pre-wrap break-words">{formatValue(row.value)}</span>
                {row.sourcePage != null && <span className="shrink-0">p.{row.sourcePage}</span>}
              </div>
              {row.sourceText && (
                <p className="mt-1 line-clamp-2 text-xs italic text-slate-400">"{row.sourceText}"</p>
              )}
              <div className="mt-1 flex gap-3 text-[10px] uppercase tracking-wide text-slate-400">
                <span>Maps to existing field: {row.mapsToExistingField ? "Yes" : "No"}</span>
                <span>Creates dynamic row: {row.createsDynamicRow ? "Yes" : "No"}</span>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

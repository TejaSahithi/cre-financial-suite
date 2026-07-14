import React, { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLeaseExpenseRules } from "@/components/lease-review/SpecializedTables";
import { normalizeExpenseRuleRows, normalizeExpenseRuleFallback } from "@/lib/leaseReviewFieldNormalizer";

function formatValue(value) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

/**
 * CAM / Expense Rules — critical for CAM calculation, expense recoverability,
 * budget generation, owner reporting, and tenant dispute prevention.
 * Rich path: leaseExpenseRuleService.loadRuleSet() (same hook
 * ExpenseRulesTable/CamRulesTable already use, reused via
 * useLeaseExpenseRules() — not reimplemented), normalized via
 * normalizeExpenseRuleRows(). Falls back to the synchronous
 * workflow_output.expense_rules union while the DB query is loading or if
 * it errors, so this section never regresses to fully empty.
 */
export default function CamExpenseRulesPanel({ lease }) {
  const { data, isLoading, error } = useLeaseExpenseRules(lease);
  const rows = useMemo(() => {
    if (Array.isArray(data?.rules) && data.rules.length > 0) {
      return normalizeExpenseRuleRows(data.rules);
    }
    return normalizeExpenseRuleFallback(lease);
  }, [data, lease]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 pb-2">
        <div>
          <CardTitle className="text-base">CAM / Expense Rules</CardTitle>
          <p className="text-xs text-slate-500">
            Recovery structure, allocation, caps, and exclusions — drives CAM calculation and budget generation.
          </p>
        </div>
        <Badge className="bg-slate-100 text-slate-700">{rows.length} rules</Badge>
      </CardHeader>
      <CardContent>
        {isLoading && rows.length === 0 ? (
          <p className="text-sm text-slate-500">Loading expense rules…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-slate-500">
            {error ? "No expense rules table yet — showing extraction fallback only." : "No expense/CAM rules captured for this document."}
          </p>
        ) : (
          <div className="space-y-2">
            {rows.map((rule, idx) => (
              <div key={`${rule.category}-${idx}`} className="rounded-md border border-slate-100 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-slate-800">{formatValue(rule.category)}</span>
                  <div className="flex items-center gap-1.5">
                    <Badge className={rule.recoverable ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"}>
                      {rule.recoverable === true ? "Recoverable" : rule.recoverable === false ? "Not Recoverable" : "Unknown"}
                    </Badge>
                    {rule.needsReview && <Badge className="bg-amber-100 text-amber-800">Needs Review</Badge>}
                  </div>
                </div>
                <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs text-slate-500 sm:grid-cols-4">
                  <span>Allocation: {formatValue(rule.allocationMethod)}</span>
                  <span>Cap: {formatValue(rule.cap)}</span>
                  <span>Floor: {formatValue(rule.floor)}</span>
                  <span>Admin Fee: {formatValue(rule.adminFeePercent)}</span>
                </div>
                {rule.exclusions && (
                  <p className="mt-1 text-xs text-slate-500">Exclusions: {formatValue(rule.exclusions)}</p>
                )}
                <div className="mt-1 flex items-center justify-between gap-2 text-xs text-slate-400">
                  <span className="line-clamp-1 italic">{rule.sourceText ? `"${rule.sourceText}"` : "No source text captured."}</span>
                  <span className="shrink-0">
                    {rule.sourcePage != null ? `p.${rule.sourcePage}` : ""}
                    {typeof rule.confidence === "number" ? ` · ${Math.round(rule.confidence)}%` : ""}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

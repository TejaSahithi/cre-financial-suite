import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

/**
 * Classification Debug Panel
 *
 * Surfaces the exclusion histograms computed by loadApprovedLeaseExpenseRules
 * and loadApprovedActualExpenses so reviewers can see WHY a row that exists
 * in the database does not appear in the Classification workspace.
 *
 * This is a read-only diagnostic surface. It does not mutate any data and is
 * mounted only when the operator clicks "Show diagnostics".
 *
 * Props:
 *   ruleExclusions  — { reason: count, ... } from loadApprovedLeaseExpenseRules
 *   actualExclusions — { reason: count, ... } from loadApprovedActualExpenses
 *   summary         — { rawApprovedRulesCount, rawApprovedActualsCount,
 *                       rulesExcludedCount, actualsExcludedCount, ... }
 *   counts          — page-derived counts (actual_expenses, coverage_gaps,
 *                     needs_review, published_to_cam, excluded)
 *   existingClassifications — current rows (used to derive CAM-blocked reasons)
 */
export default function ClassificationDebugPanel({
  ruleExclusions = {},
  actualExclusions = {},
  summary = {},
  counts = {},
  existingClassifications = [],
}) {
  const ruleEligibleCount = (summary.rawApprovedRulesCount ?? 0) - (summary.rulesExcludedCount ?? 0);
  const actualEligibleCount = (summary.rawApprovedActualsCount ?? 0) - (summary.actualsExcludedCount ?? 0);

  // CAM-blocked breakdown — rows that exist but are not cam_ready.
  // Group by cam_status (or a synthetic "missing" bucket).
  const camBlockedBreakdown = {};
  let sentToCamCount = 0;
  for (const row of existingClassifications || []) {
    const sent = Boolean(row?.sent_to_cam);
    const status = String(row?.cam_status || "").toLowerCase();
    if (sent && status === "cam_ready") {
      sentToCamCount += 1;
      continue;
    }
    if (!sent) continue; // not even attempted
    const bucket = status || "missing_cam_status";
    camBlockedBreakdown[bucket] = (camBlockedBreakdown[bucket] ?? 0) + 1;
  }

  return (
    <Card className="border-dashed border-slate-300 bg-slate-50">
      <CardHeader className="flex flex-row items-center justify-between gap-3 pb-2">
        <CardTitle className="text-sm font-semibold text-slate-700">
          Classification Diagnostics
        </CardTitle>
        <Badge className="bg-slate-200 text-[10px] uppercase text-slate-700">read-only</Badge>
      </CardHeader>
      <CardContent className="space-y-4 p-4 text-xs text-slate-700">
        <p className="text-[11px] text-slate-500">
          Counts below explain why approved rows in the database may not appear in the workspace.
          Eligible rows pass <code className="rounded bg-white px-1">isRuleClassificationEligible</code> /
          <code className="ml-1 rounded bg-white px-1">isActualClassificationEligible</code>.
        </p>

        <DebugRow
          title="Approved Lease Rules"
          raw={summary.rawApprovedRulesCount ?? 0}
          eligible={ruleEligibleCount}
          excluded={summary.rulesExcludedCount ?? 0}
          exclusions={ruleExclusions}
        />

        <DebugRow
          title="Approved Actual Expenses"
          raw={summary.rawApprovedActualsCount ?? 0}
          eligible={actualEligibleCount}
          excluded={summary.actualsExcludedCount ?? 0}
          exclusions={actualExclusions}
        />

        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <Stat label="Actual Expenses" value={counts.actual_expenses ?? 0} />
          <Stat label="Coverage Gaps" value={counts.coverage_gaps ?? 0} />
          <Stat label="Needs Review" value={counts.needs_review ?? 0} />
          <Stat label="Excluded" value={counts.excluded ?? 0} />
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-slate-700">Sent to CAM</span>
            <span className="font-mono text-slate-900">{sentToCamCount}</span>
          </div>
          {Object.keys(camBlockedBreakdown).length > 0 && (
            <div className="rounded border border-amber-200 bg-amber-50 p-2">
              <p className="mb-1 text-[10px] font-semibold uppercase text-amber-800">
                CAM-blocked reasons (sent_to_cam but cam_status !== "cam_ready")
              </p>
              <div className="grid grid-cols-2 gap-1 text-[11px] md:grid-cols-3">
                {Object.entries(camBlockedBreakdown).map(([reason, count]) => (
                  <div key={reason} className="flex items-center justify-between rounded bg-white px-2 py-1">
                    <span className="text-amber-800">{reason}</span>
                    <span className="font-mono text-amber-900">{count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function DebugRow({ title, raw, eligible, excluded, exclusions }) {
  const nonZeroReasons = Object.entries(exclusions || {})
    .filter(([, count]) => count > 0)
    .sort(([, a], [, b]) => b - a);

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-baseline gap-3">
        <span className="font-semibold text-slate-700">{title}</span>
        <span className="text-[11px] text-slate-500">
          raw approved: <span className="font-mono text-slate-800">{raw}</span>
        </span>
        <span className="text-[11px] text-emerald-700">
          classification-eligible: <span className="font-mono">{eligible}</span>
        </span>
        <span className="text-[11px] text-amber-700">
          excluded: <span className="font-mono">{excluded}</span>
        </span>
      </div>
      {nonZeroReasons.length === 0 ? (
        <p className="text-[11px] text-slate-500">No exclusions in current scope.</p>
      ) : (
        <div className="grid grid-cols-2 gap-1 md:grid-cols-3 lg:grid-cols-4">
          {nonZeroReasons.map(([reason, count]) => (
            <div key={reason} className="flex items-center justify-between rounded border border-slate-200 bg-white px-2 py-1 text-[11px]">
              <span className="text-slate-600">{reason}</span>
              <span className="font-mono text-slate-900">{count}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="rounded border border-slate-200 bg-white px-2 py-1.5">
      <div className="text-[10px] font-semibold uppercase text-slate-500">{label}</div>
      <div className="font-mono text-sm text-slate-900">{value}</div>
    </div>
  );
}

import React, { useMemo } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

function normalizeWorkflow(lease) {
  return lease?.extraction_data?.workflow_output || lease?.extraction_data?.workflowOutput || {};
}

function formatCurrency(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "$0";
  return `$${num.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export function BudgetPreviewCard({ lease }) {
  const workflow = normalizeWorkflow(lease);
  const readiness = workflow?.budget_handoff_readiness || workflow?.budgetHandoffReadiness || {};
  const workflowPreview = workflow?.budget_preview || workflow?.budgetPreview || {};
  const blockedReasons = Array.isArray(readiness.blocked_reasons) ? readiness.blocked_reasons : [];
  const excludedInputs = Array.isArray(readiness.excluded_unapproved_inputs) ? readiness.excluded_unapproved_inputs : [];
  const gateReady = readiness.ready === true;

  const monthly = useMemo(() => {
    const workflowRent = workflowPreview?.rent_revenue_budget?.[0]?.monthly_rent;
    const v = Number(workflowRent || lease.monthly_rent || (lease.annual_rent ? lease.annual_rent / 12 : 0));
    return Number.isFinite(v) ? v : 0;
  }, [workflowPreview?.rent_revenue_budget, lease.monthly_rent, lease.annual_rent]);

  const startBasis = workflowPreview?.rent_revenue_budget?.[0]?.start_date || lease.commencement_date || lease.start_date;

  const months = useMemo(() => {
    const out = [];
    if (!startBasis) return out;
    const start = new Date(startBasis);
    const escalation = Number(lease.escalation_rate || 0) / 100;
    for (let i = 0; i < 12; i++) {
      const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
      const yearsIn = Math.floor(i / 12);
      const stepRent = monthly * Math.pow(1 + escalation, yearsIn);
      out.push({ label: d.toLocaleDateString(undefined, { year: "numeric", month: "short" }), amount: stepRent });
    }
    return out;
  }, [startBasis, lease.escalation_rate, monthly]);

  if (!startBasis || !monthly) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-slate-500">
          Budget preview requires a commencement date and monthly rent with valid evidence. Complete or approve those fields before Budget handoff.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Next 12 Months - Base Rent Preview</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className={gateReady ? "rounded-lg border border-emerald-200 bg-emerald-50 p-3" : "rounded-lg border border-amber-200 bg-amber-50 p-3"}>
          <p className={gateReady ? "text-xs font-semibold text-emerald-800" : "text-xs font-semibold text-amber-900"}>
            {gateReady ? "Budget handoff ready" : "Preview only - budget handoff blocked"}
          </p>
          <p className={gateReady ? "mt-1 text-xs text-emerald-700" : "mt-1 text-xs text-amber-800"}>
            {gateReady
              ? "Approved lease evidence, rent schedule, and recovery rules are eligible for downstream budget inputs."
              : "Values may be reviewed here, but they will not publish to Budget or Projection until the lease abstract, source evidence, rent schedule, and recovery rules are approved."}
          </p>
          {!gateReady && blockedReasons.length > 0 && (
            <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-amber-800">
              {blockedReasons.slice(0, 5).map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
          {!gateReady && excludedInputs.length > 0 && (
            <p className="mt-2 text-[11px] text-amber-700">
              Excluded until approved: {excludedInputs.slice(0, 8).join(", ")}{excludedInputs.length > 8 ? "..." : ""}
            </p>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-left text-slate-500">
                <th className="py-2">Month</th>
                <th className="py-2 text-right">Base Rent</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m) => (
                <tr key={m.label} className="border-b border-slate-100">
                  <td className="py-1.5 text-slate-700">{m.label}</td>
                  <td className="py-1.5 text-right text-slate-900">{formatCurrency(m.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
import React, { useMemo } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

export function BudgetPreviewCard({ lease }) {
  const monthly = useMemo(() => {
    const v = Number(lease.monthly_rent || (lease.annual_rent ? lease.annual_rent / 12 : 0));
    return Number.isFinite(v) ? v : 0;
  }, [lease.monthly_rent, lease.annual_rent]);

  const startBasis = lease.commencement_date || lease.start_date;

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
          Budget preview requires a commencement date and monthly rent. Complete those fields to see
          the next 12 months of base rent projected from the approved lease terms.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Next 12 Months — Base Rent Preview</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-xs text-slate-500">
          This is a read-only preview from the lease abstract under review. Approved lease data feeds
          Revenue Budget and Charge Schedule in downstream modules.
        </p>
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
                  <td className="py-1.5 text-right text-slate-900">${m.amount.toFixed(0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

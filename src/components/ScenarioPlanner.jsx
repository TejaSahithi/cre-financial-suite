import React, { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

function fmt(v) {
  if (!v && v !== 0) return "$0";
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toLocaleString()}`;
}

const DEFAULT_SCENARIOS = {
  base: { label: "Base", color: "bg-blue-100 text-blue-700", occupancyAdj: 0, rentAdj: 0, expenseAdj: 0 },
  optimistic: { label: "Optimistic", color: "bg-emerald-100 text-emerald-700", occupancyAdj: 5, rentAdj: 3, expenseAdj: -2 },
  conservative: { label: "Conservative", color: "bg-amber-100 text-amber-700", occupancyAdj: -10, rentAdj: -2, expenseAdj: 5 },
};

export default function ScenarioPlanner({ baseRevenue = 0, baseExpenses = 0, baseOccupancy = 0, baseRentPerSF = 0, totalSF = 0 }) {
  const [scenarios, setScenarios] = useState(DEFAULT_SCENARIOS);

  const updateScenario = (key, field, value) => {
    setScenarios(prev => ({ ...prev, [key]: { ...prev[key], [field]: parseFloat(value) || 0 } }));
  };

  const calcScenario = (s) => {
    const adjOcc = Math.min(100, Math.max(0, baseOccupancy + s.occupancyAdj));
    const adjLeasedSF = totalSF * (adjOcc / 100);
    const adjRentPerSF = baseRentPerSF * (1 + s.rentAdj / 100);
    const adjRevenue = adjLeasedSF * adjRentPerSF + (baseRevenue - baseRentPerSF * totalSF * (baseOccupancy / 100));
    const effectiveRevenue = baseRevenue > 0 ? baseRevenue * (1 + s.rentAdj / 100) * ((baseOccupancy + s.occupancyAdj) / Math.max(baseOccupancy, 1)) : 0;
    const adjExpenses = baseExpenses * (1 + s.expenseAdj / 100);
    const noi = effectiveRevenue - adjExpenses;
    const baseNOI = baseRevenue - baseExpenses;
    const noiDiff = noi - baseNOI;
    const revChange = baseRevenue > 0 ? ((effectiveRevenue - baseRevenue) / baseRevenue * 100) : 0;
    return { revenue: effectiveRevenue, expenses: adjExpenses, noi, noiDiff, revChange, occupancy: baseOccupancy + s.occupancyAdj };
  };

  return (
    <Card className="border-0 shadow-sm">
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm font-bold text-slate-900">Scenario Planning</CardTitle>
        <p className="text-[10px] text-slate-500">Adjust occupancy, rent, and expenses to compare outcomes</p>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        <Tabs defaultValue="base">
          <TabsList className="bg-slate-100 h-8">
            {Object.entries(scenarios).map(([key, s]) => (
              <TabsTrigger key={key} value={key} className="text-xs h-6 data-[state=active]:bg-white">
                <Badge className={`${s.color} text-[9px] mr-1`}>{s.label}</Badge>
              </TabsTrigger>
            ))}
          </TabsList>

          {Object.entries(scenarios).map(([key, s]) => {
            const calc = calcScenario(s);
            return (
              <TabsContent key={key} value={key} className="mt-3 space-y-3">
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <Label className="text-[10px] text-slate-500">Occupancy Adj (%)</Label>
                    <Input type="number" value={s.occupancyAdj} onChange={e => updateScenario(key, 'occupancyAdj', e.target.value)} className="h-8 text-sm" disabled={key === 'base'} />
                  </div>
                  <div>
                    <Label className="text-[10px] text-slate-500">Rent Change (%)</Label>
                    <Input type="number" value={s.rentAdj} onChange={e => updateScenario(key, 'rentAdj', e.target.value)} className="h-8 text-sm" disabled={key === 'base'} />
                  </div>
                  <div>
                    <Label className="text-[10px] text-slate-500">Expense Change (%)</Label>
                    <Input type="number" value={s.expenseAdj} onChange={e => updateScenario(key, 'expenseAdj', e.target.value)} className="h-8 text-sm" disabled={key === 'base'} />
                  </div>
                </div>

                <div className="grid grid-cols-4 gap-2">
                  {[
                    { label: "Revenue", value: calc.revenue, base: baseRevenue },
                    { label: "Expenses", value: calc.expenses, base: baseExpenses },
                    { label: "NOI", value: calc.noi, base: baseRevenue - baseExpenses },
                    { label: "Occupancy", value: `${calc.occupancy.toFixed(0)}%`, base: null },
                  ].map((m, i) => {
                    const diff = m.base !== null ? ((typeof m.value === 'number' ? m.value : 0) - m.base) : 0;
                    return (
                      <div key={i} className="bg-slate-50 rounded-lg p-2.5 text-center">
                        <p className="text-[9px] text-slate-500 uppercase font-semibold">{m.label}</p>
                        <p className="text-sm font-bold text-slate-900 tabular-nums">{typeof m.value === 'number' ? fmt(m.value) : m.value}</p>
                        {m.base !== null && key !== 'base' && (
                          <div className={`text-[9px] font-bold ${diff > 0 ? 'text-emerald-600' : diff < 0 ? 'text-red-600' : 'text-slate-400'}`}>
                            {diff > 0 ? '+' : ''}{fmt(diff)}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {key !== 'base' && (
                  <div className="flex items-center gap-4 bg-slate-50 rounded-lg p-2.5 text-xs">
                    <div className="flex items-center gap-1">
                      <span className="text-slate-500">NOI Δ:</span>
                      <span className={`font-bold ${calc.noiDiff >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{calc.noiDiff >= 0 ? '+' : ''}{fmt(calc.noiDiff)}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="text-slate-500">Revenue Δ:</span>
                      <span className={`font-bold ${calc.revChange >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{calc.revChange >= 0 ? '+' : ''}{calc.revChange.toFixed(1)}%</span>
                    </div>
                  </div>
                )}
              </TabsContent>
            );
          })}
        </Tabs>
      </CardContent>
    </Card>
  );
}
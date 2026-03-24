import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { ChevronRight, Briefcase, Building2 } from "lucide-react";

const statusColors = { active: "bg-emerald-100 text-emerald-700", draft: "bg-slate-100 text-slate-600", archived: "bg-red-100 text-red-600" };

export default function PortfolioSummary({ portfolios = [], properties = [] }) {
  const enriched = portfolios.map(p => {
    const props = properties.filter(pr => pr.portfolio_id === p.id);
    const totalSF = props.reduce((s, pr) => s + (pr.total_sf || 0), 0);
    const leasedSF = props.reduce((s, pr) => s + (pr.leased_sf || 0), 0);
    return { ...p, propCount: props.length, totalSF, occ: totalSF > 0 ? (leasedSF / totalSF * 100) : 0 };
  });

  return (
    <Card className="border-0 shadow-sm">
      <CardHeader className="pb-1 pt-3 px-4 flex flex-row items-center justify-between">
        <div>
          <CardTitle className="text-sm font-bold text-slate-900">Portfolios</CardTitle>
          <p className="text-xs text-slate-500">{portfolios.length} portfolio{portfolios.length !== 1 ? 's' : ''} · Drill into each for property-level data</p>
        </div>
        <Link to={createPageUrl("Portfolios")} className="text-xs text-blue-600 font-semibold flex items-center gap-0.5 hover:underline">
          Manage <ChevronRight className="w-3 h-3" />
        </Link>
      </CardHeader>
      <CardContent className="px-4 pb-3 pt-1">
        {enriched.length > 0 ? (
          <div className="space-y-1">
            {enriched.slice(0, 5).map(p => (
              <Link key={p.id} to={createPageUrl("Portfolios")} className="flex items-center gap-2.5 py-2 border-b border-slate-50 last:border-0 hover:bg-slate-50/50 rounded group">
                <div className="w-7 h-7 rounded-md bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center flex-shrink-0">
                  <Briefcase className="w-3.5 h-3.5 text-white" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-semibold text-slate-800 truncate">{p.name}</span>
                    <Badge className={`${statusColors[p.status] || statusColors.draft} text-xs uppercase px-1.5 py-0`}>{p.status}</Badge>
                  </div>
                  <p className="text-xs text-slate-500">{p.propCount} props · {(p.totalSF / 1000).toFixed(0)}K SF · {p.occ.toFixed(0)}% occ</p>
                </div>
                <ChevronRight className="w-3.5 h-3.5 text-slate-300 group-hover:text-slate-500 flex-shrink-0" />
              </Link>
            ))}
          </div>
        ) : (
          <div className="flex items-center justify-center py-6 text-xs text-slate-400">
            <Building2 className="w-4 h-4 mr-2 text-slate-300" /> No portfolios yet
          </div>
        )}
      </CardContent>
    </Card>
  );
}
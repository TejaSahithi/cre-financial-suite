import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Link } from "react-router-dom";
import { Briefcase } from "lucide-react";

export default function PortfolioList({ portfolios = [] }) {
  return (
    <Card>
      <CardHeader className="pb-2 flex flex-row items-center justify-between">
        <CardTitle className="text-base font-bold">Portfolios</CardTitle>
        <Link to="/Portfolios" className="text-xs text-blue-600 hover:underline">View All</Link>
      </CardHeader>
      <CardContent>
        {portfolios.length > 0 ? (
          <div className="space-y-1">
            {portfolios.slice(0, 5).map((p, i) => (
              <div key={i} className="flex items-center justify-between py-3 border-b border-slate-100 last:border-0">
                <div>
                  <p className="text-sm font-medium text-slate-900">{p.name}</p>
                  <p className="text-xs text-slate-400">{p.total_properties || 0} properties · {((p.total_sf || 0) / 1000).toFixed(0)}K SF</p>
                </div>
                <Badge className={p.status === 'active' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'} variant="outline">
                  {p.status || 'draft'}
                </Badge>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <Briefcase className="w-10 h-10 text-slate-200 mb-3" />
            <p className="text-sm font-medium text-slate-400">No portfolios yet</p>
            <p className="text-xs text-slate-300 mt-1">Create your first portfolio to organize properties</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
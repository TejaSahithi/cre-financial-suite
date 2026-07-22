import React, { useState } from "react";
import { Search } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { usePortfolioSearch } from "@/lib/portfolio-intelligence/hooks/usePortfolioIntelligence";

export default function PortfolioSearchCommand() {
  const [query, setQuery] = useState("leases expiring in the next 18 months");
  const search = usePortfolioSearch({ query, today: new Date().toISOString().slice(0, 10), limit: 10 });
  return (
    <Card className="border-slate-200 shadow-sm rounded-lg">
      <CardHeader className="px-4 py-3"><CardTitle className="text-sm flex items-center gap-2"><Search className="w-4 h-4" />Portfolio Search</CardTitle></CardHeader>
      <CardContent className="px-4 pb-4 space-y-3">
        <Input value={query} onChange={(event) => setQuery(event.target.value)} className="h-9" />
        <div className="text-xs text-slate-500">Plan: {search.data?.plan?.entity || "not planned"} · {search.data?.results?.length || 0} results</div>
      </CardContent>
    </Card>
  );
}

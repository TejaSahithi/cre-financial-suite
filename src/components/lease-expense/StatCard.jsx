import React from "react";
import { Card, CardContent } from "@/components/ui/card";

export default function StatCard({ label, value, accent }) {
  return (
    <Card className={accent ? `border-l-4 ${accent}` : ""}>
      <CardContent className="p-4">
        <p className="text-2xl font-bold text-slate-900">{value}</p>
        <p className="text-xs font-medium text-slate-500">{label}</p>
      </CardContent>
    </Card>
  );
}

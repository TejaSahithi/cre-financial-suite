import React from "react";
import { CalendarDays } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function PortfolioCriticalDatesPanel({ summary, events = [] }) {
  return (
    <Card className="border-slate-200 shadow-sm rounded-lg">
      <CardHeader className="px-4 py-3"><CardTitle className="text-sm flex items-center gap-2"><CalendarDays className="w-4 h-4" />Critical Dates</CardTitle></CardHeader>
      <CardContent className="px-4 pb-4 space-y-3">
        <div className="grid grid-cols-3 gap-2 text-xs"><div className="rounded-md border p-2"><div className="text-slate-500">Total</div><div className="font-semibold">{summary.total}</div></div><div className="rounded-md border p-2"><div className="text-slate-500">Blocking</div><div className="font-semibold">{summary.blocking}</div></div><div className="rounded-md border p-2"><div className="text-slate-500">Unresolved</div><div className="font-semibold">{summary.unresolved}</div></div></div>
        {events.slice(0, 6).map((event) => <div key={event.eventId} className="flex items-center justify-between gap-3 border-b border-slate-100 pb-2 last:border-0"><div className="min-w-0"><div className="text-xs font-medium truncate">{event.label}</div><div className="text-[11px] text-slate-500 truncate">{event.eventType} · {event.calculationStatus}</div></div><div className="text-xs tabular-nums text-slate-700">{event.eventDate || event.windowEnd || "Unresolved"}</div></div>)}
      </CardContent>
    </Card>
  );
}

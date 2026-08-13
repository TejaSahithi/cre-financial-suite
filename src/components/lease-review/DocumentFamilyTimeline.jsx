import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { FileClock } from "lucide-react";

function labelRole(role) {
  return String(role || "unknown").replace(/_/g, " ");
}

export default function DocumentFamilyTimeline({ documentFamily }) {
  const members = Array.isArray(documentFamily?.members) ? documentFamily.members : [];
  if (!documentFamily || members.length === 0) return null;

  return (
    <Card className="mb-4 border-slate-200 bg-white shadow-sm">
      <CardHeader className="border-b border-slate-100 bg-slate-50/50 pb-3">
        <CardTitle className="flex items-center gap-2 text-base font-semibold text-slate-800">
          <FileClock className="h-4 w-4 text-blue-600" /> Document Family Timeline
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-4">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {members.map((member, index) => (
            <React.Fragment key={member.uploadedFileId || `${member.role}-${index}`}>
              <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="font-semibold capitalize text-slate-800">{labelRole(member.role)}</span>
                  <Badge variant="outline" className="text-[10px]">{member.status || "active"}</Badge>
                </div>
                <div className="mt-1 font-mono text-[11px] text-slate-500">{member.effectiveDate || member.executionDate || "date unknown"}</div>
              </div>
              {index < members.length - 1 && <span className="text-slate-300">/</span>}
            </React.Fragment>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
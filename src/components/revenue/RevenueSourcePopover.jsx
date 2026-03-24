import React from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { FileText, Clock, ExternalLink } from "lucide-react";
import ModuleLink from "@/components/ModuleLink";

export default function RevenueSourcePopover({ children, sourceType, sourceId, sourceName, amount, lastUpdated }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="text-left hover:bg-blue-50 hover:text-blue-700 rounded px-1 -mx-1 transition-colors font-mono cursor-pointer">
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <div className="p-3 border-b bg-slate-50">
          <p className="text-xs font-semibold text-slate-700">Revenue Source</p>
        </div>
        <div className="p-3 space-y-2.5">
          <div className="flex items-center gap-2">
            <FileText className="w-3.5 h-3.5 text-slate-400" />
            <span className="text-xs text-slate-600">Source:</span>
            <Badge variant="outline" className="text-[10px]">{sourceType === 'lease' ? 'Lease' : sourceType === 'cam' ? 'CAM Calculation' : 'Other'}</Badge>
          </div>
          {sourceName && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500 ml-5">Name:</span>
              <span className="text-xs font-medium text-slate-700">{sourceName}</span>
            </div>
          )}
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500 ml-5">Amount:</span>
            <span className="text-xs font-mono font-semibold text-slate-900">${amount?.toLocaleString()}</span>
          </div>
          {lastUpdated && (
            <div className="flex items-center gap-2">
              <Clock className="w-3.5 h-3.5 text-slate-400" />
              <span className="text-xs text-slate-500">Updated:</span>
              <span className="text-xs text-slate-600">{new Date(lastUpdated).toLocaleDateString()}</span>
            </div>
          )}
          {sourceType === 'lease' && (
            <ModuleLink page="LeaseReview" params={`id=${sourceId}`} className="flex items-center gap-1 text-[11px] text-blue-600 hover:underline mt-1 ml-5">
              <ExternalLink className="w-3 h-3" /> View Lease
            </ModuleLink>
          )}
          {sourceType === 'cam' && (
            <ModuleLink page="CAMDashboard" className="flex items-center gap-1 text-[11px] text-blue-600 hover:underline mt-1 ml-5">
              <ExternalLink className="w-3 h-3" /> View CAM
            </ModuleLink>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
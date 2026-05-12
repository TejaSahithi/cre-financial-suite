import React from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { FileText } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function ClauseEvidenceDrawer({ isOpen, onClose, category, rule }) {
  if (!category || !rule) return null;

  const clauses = Array.isArray(rule.clauses) ? rule.clauses : [];

  return (
    <Sheet open={isOpen} onOpenChange={onClose}>
      <SheetContent className="sm:max-w-md overflow-y-auto">
        <SheetHeader className="mb-6">
          <SheetTitle className="flex items-center gap-2 text-blue-900">
            <FileText className="w-5 h-5" />
            AI Extraction Evidence
          </SheetTitle>
          <SheetDescription>
            Review the lease text used to classify the <strong>{category.category_name}</strong> category.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-6">
          <div className="space-y-2">
            <h4 className="text-sm font-medium text-slate-900">Extracted Status</h4>
            <div className="flex gap-2">
              <Badge variant={rule.row_status === 'uncertain' ? 'destructive' : 'default'}>
                {rule.row_status?.toUpperCase() || 'UNKNOWN'}
              </Badge>
              {rule.confidence && (
                <Badge variant="outline" className={rule.confidence < 0.7 ? "border-amber-500 text-amber-700" : "border-emerald-500 text-emerald-700"}>
                  Confidence: {(rule.confidence * 100).toFixed(0)}%
                </Badge>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <h4 className="text-sm font-medium text-slate-900">AI Reasoning</h4>
            <div className="p-3 bg-slate-50 border rounded-md text-sm text-slate-700 whitespace-pre-wrap">
              {rule.notes || "No specific reasoning provided."}
            </div>
          </div>

          <div className="space-y-2">
            <h4 className="text-sm font-medium text-slate-900">Source Clause</h4>
            {clauses.length > 0 ? (
              <div className="space-y-3">
                {clauses.map((clause, index) => (
                  <div key={`${clause.id || index}`} className="relative">
                    <div className="absolute left-0 top-0 bottom-0 w-1 bg-blue-200 rounded-l-md"></div>
                    <div className="pl-4 py-3 pr-3 bg-blue-50/50 border border-blue-100 rounded-md text-sm text-slate-800 whitespace-pre-wrap">
                      <div className="mb-2 flex gap-2 text-[11px] uppercase tracking-wide text-blue-700">
                        <span>{clause.clause_type || "Evidence"}</span>
                        {clause.page_number != null ? <span>Page {clause.page_number}</span> : null}
                      </div>
                      <div className="italic font-serif">{clause.clause_text}</div>
                    </div>
                  </div>
                ))}
              </div>
            ) : rule.source ? (
              <div className="relative">
                <div className="absolute left-0 top-0 bottom-0 w-1 bg-blue-200 rounded-l-md"></div>
                <div className="pl-4 py-3 pr-3 bg-blue-50/50 border border-blue-100 rounded-md text-sm text-slate-800 italic whitespace-pre-wrap font-serif">
                  "{rule.source}"
                </div>
              </div>
            ) : (
              <div className="p-3 bg-slate-50 border rounded-md text-sm text-slate-500 italic">
                No specific clause cited. (Likely inferred from omission).
              </div>
            )}
          </div>

          <div className="pt-4 border-t flex justify-end">
             <Button variant="outline" onClick={onClose}>Close</Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

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

function formatConfidence(value) {
  if (value == null) return "-";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "-";
  return `${Math.round(numeric <= 1 ? numeric * 100 : numeric)}%`;
}

function ruleStatusTone(rule) {
  if (["approved", "reviewed"].includes(String(rule?.review_status || "").toLowerCase()) && rule?.approval_status === "approved") {
    return "bg-emerald-100 text-emerald-700";
  }
  if (rule?.review_status === "needs_review") {
    return "bg-amber-100 text-amber-800";
  }
  return "bg-slate-100 text-slate-700";
}

export default function ClauseEvidenceDrawer({ isOpen, onClose, category, rule }) {
  if (!category || !rule) return null;

  const clauses = Array.isArray(rule.clauses) ? rule.clauses : [];
  const sourceText = rule.exact_source_text || rule.source || rule.notes || null;

  return (
    <Sheet open={isOpen} onOpenChange={onClose}>
      <SheetContent className="sm:max-w-2xl overflow-y-auto">
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
          <div className="grid gap-3 sm:grid-cols-2">
            <InfoCard label="Review Status">
              <Badge className={ruleStatusTone(rule)}>
                {rule.review_status || rule.row_status || "unknown"}
              </Badge>
            </InfoCard>
            <InfoCard label="Approval Status">
              <Badge variant="outline">{rule.approval_status || "draft"}</Badge>
            </InfoCard>
            <InfoCard label="Extraction Status">
              <Badge variant="outline">{rule.extraction_status || "unknown"}</Badge>
            </InfoCard>
            <InfoCard label="Published To CAM">
              <Badge variant="outline">{rule.published_to_cam ? "Yes" : "No"}</Badge>
            </InfoCard>
            <InfoCard label="Included In Base Rent">
              <Badge variant="outline">{rule.included_in_base_rent ? "Included" : "Separate"}</Badge>
            </InfoCard>
            <InfoCard label="Confidence Score">
              <Badge variant="outline">{formatConfidence(rule.confidence_score ?? rule.confidence)}</Badge>
            </InfoCard>
            <InfoCard label="Responsibility">
              <span>{rule.responsibility || "unknown"}</span>
            </InfoCard>
            <InfoCard label="Recovery Method">
              <span>{rule.recovery_method || "manual_review"}</span>
            </InfoCard>
            <InfoCard label="Recoverable From Tenant">
              <span>{rule.recoverable_from_tenant || "-"}</span>
            </InfoCard>
            <InfoCard label="Payment Treatment">
              <span>{rule.payment_treatment || "-"}</span>
            </InfoCard>
            <InfoCard label="CAM Eligible">
              <span>{rule.cam_eligible || "-"}</span>
            </InfoCard>
            <InfoCard label="Source Page">
              <span>{rule.source_page ?? "-"}</span>
            </InfoCard>
          </div>

          <div className="space-y-2">
            <h4 className="text-sm font-medium text-slate-900">AI Reasoning</h4>
            <div className="p-3 bg-slate-50 border rounded-md text-sm text-slate-700 whitespace-pre-wrap">
              {rule.notes || "No specific reasoning provided."}
            </div>
          </div>

          <div className="space-y-2">
            <h4 className="text-sm font-medium text-slate-900">Exact Source Text</h4>
            {sourceText ? (
              <div className="relative">
                <div className="absolute left-0 top-0 bottom-0 w-1 bg-blue-200 rounded-l-md" />
                <div className="pl-4 py-3 pr-3 bg-blue-50/50 border border-blue-100 rounded-md text-sm text-slate-800 italic whitespace-pre-wrap font-serif">
                  "{sourceText}"
                </div>
              </div>
            ) : (
              <div className="p-3 bg-slate-50 border rounded-md text-sm text-slate-500 italic">
                No exact source text was preserved. This rule should stay in needs review.
              </div>
            )}
          </div>

          <div className="space-y-2">
            <h4 className="text-sm font-medium text-slate-900">Clause Evidence</h4>
            {clauses.length > 0 ? (
              <div className="space-y-3">
                {clauses.map((clause, index) => (
                  <div key={`${clause.id || index}`} className="relative">
                    <div className="absolute left-0 top-0 bottom-0 w-1 bg-blue-200 rounded-l-md" />
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
            ) : (
              <div className="p-3 bg-slate-50 border rounded-md text-sm text-slate-500 italic">
                No clause-level evidence was saved for this rule.
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

function InfoCard({ label, children }) {
  return (
    <div className="rounded-md border bg-slate-50/70 p-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-2 text-sm text-slate-800">{children}</div>
    </div>
  );
}

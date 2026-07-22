import React, { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronRight, Cpu, FileText, AlertTriangle, UserCheck } from "lucide-react";
import ReviewFieldStatus from "@/components/review/ReviewFieldStatus";
import ReviewFieldEvidence from "@/components/review/ReviewFieldEvidence";
import ReviewFieldConflict from "@/components/review/ReviewFieldConflict";
import ReviewFieldDerivation from "@/components/review/ReviewFieldDerivation";

function formatSource(source) {
  if (!source || source === "none") return "None";
  return String(source).replace(/_/g, " ");
}

function formatConfidence(confidence) {
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return "-";
  return `${Math.round(confidence <= 1 ? confidence * 100 : confidence)}%`;
}

export function FieldDrawerIntelligence({ field }) {
  const [isOpen, setIsOpen] = useState(false);

  if (!field) return null;

  const reviewerAction = field.reviewerAction || { state: "none", reason: null };

  return (
    <section className="mt-4 overflow-hidden rounded-md border border-indigo-100 bg-indigo-50/30">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex w-full items-center justify-between bg-indigo-50/70 p-3 text-left transition-colors hover:bg-indigo-100/50"
        aria-expanded={isOpen}
      >
        <div className="flex items-center gap-2">
          <Cpu className="h-4 w-4 text-indigo-600" />
          <span className="text-xs font-semibold text-indigo-900">Canonical Review Intelligence</span>
          <ReviewFieldStatus status={field.status} />
          {field.blocking && (
            <Badge variant="outline" className="border-red-200 bg-red-50 text-[10px] text-red-700">
              Blocking
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1.5 text-xs font-medium text-indigo-700">
          <span>{isOpen ? "Hide" : "Show Details"}</span>
          {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </div>
      </button>

      {isOpen && (
        <div className="space-y-4 border-t border-indigo-100 bg-white p-3.5 text-xs">
          <div className="grid gap-3 rounded border border-slate-100 bg-slate-50 p-2.5 sm:grid-cols-3">
            <div>
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Authoritative Source</span>
              <div className="mt-0.5 font-medium capitalize text-slate-700">{formatSource(field.source)}</div>
            </div>
            <div>
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Canonical Confidence</span>
              <div className="mt-0.5 font-semibold text-slate-800">{formatConfidence(field.confidence)}</div>
            </div>
            <div>
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Review Path</span>
              <div className="mt-0.5 truncate font-mono text-slate-700" title={field.path}>{field.path}</div>
            </div>
          </div>

          {field.reasonCodes?.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 rounded border border-amber-100 bg-amber-50 p-2 text-amber-900">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600" />
              <span className="font-semibold">Reasons:</span>
              {field.reasonCodes.map((code) => (
                <span key={code} className="rounded bg-amber-100 px-1 py-0.5 font-mono text-[10px] text-amber-800">
                  {code}
                </span>
              ))}
            </div>
          )}

          {reviewerAction.state !== "none" && (
            <div className="rounded border border-blue-100 bg-blue-50 p-2 text-blue-900">
              <div className="flex items-center gap-1.5 font-semibold">
                <UserCheck className="h-3.5 w-3.5 text-blue-700" /> Reviewer Action
              </div>
              <p className="mt-1 capitalize">{reviewerAction.state.replace(/_/g, " ")}</p>
              {reviewerAction.reason && <p className="mt-1 text-blue-800">{reviewerAction.reason}</p>}
            </div>
          )}

          {field.conflict && <ReviewFieldConflict conflict={field.conflict} />}
          {field.derivation && <ReviewFieldDerivation derivation={field.derivation} />}

          <div className="space-y-2">
            <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-800">
              <FileText className="h-3.5 w-3.5 text-indigo-600" />
              Canonical Evidence References ({field.evidence?.length || 0})
            </span>
            <ReviewFieldEvidence evidence={field.evidence || []} />
          </div>

          <div className="rounded border border-slate-100 bg-slate-50 p-2 text-[11px] text-slate-500">
            Canonical projections are rendered through the ReviewDocument view model. Missing confidence, legacy fallback, and reviewer override states are kept distinct for approval and audit decisions.
          </div>
        </div>
      )}
    </section>
  );
}
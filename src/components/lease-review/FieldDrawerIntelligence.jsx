import React, { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronRight, Cpu, Layers, FileText, GitCompare, AlertTriangle } from "lucide-react";

export function FieldDrawerIntelligence({ enterpriseField, legacyValue }) {
  const [isOpen, setIsOpen] = useState(false);
  const [showFullSourceText, setShowFullSourceText] = useState({});

  if (!enterpriseField) return null;

  const {
    status,
    authoritativeSource,
    confidence,
    evidence = [],
    derivation,
    conflict,
    value: canonicalValue,
    displayValue: canonicalDisplayValue,
  } = enterpriseField;

  // Format canonical vs legacy comparison
  const canonicalFormatted = canonicalDisplayValue ?? (canonicalValue !== null && canonicalValue !== undefined ? String(canonicalValue) : "â€”");
  const legacyFormatted = legacyValue !== null && legacyValue !== undefined && legacyValue !== "" ? String(legacyValue) : "â€”";
  const isMismatch = legacyFormatted !== "â€”" && canonicalFormatted !== "â€”" && String(legacyValue).trim() !== String(canonicalValue).trim();

  const toggleSourceText = (idx) => {
    setShowFullSourceText((prev) => ({ ...prev, [idx]: !prev[idx] }));
  };

  return (
    <section className="mt-4 border border-indigo-100 rounded-md bg-indigo-50/30 overflow-hidden">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between p-3 text-left bg-indigo-50/70 hover:bg-indigo-100/50 transition-colors"
        aria-expanded={isOpen}
      >
        <div className="flex items-center gap-2">
          <Cpu className="w-4 h-4 text-indigo-600" />
          <span className="text-xs font-semibold text-indigo-900">Canonical Enterprise Intelligence</span>
          {isMismatch && (
            <Badge variant="outline" className="bg-amber-100 text-amber-800 border-amber-300 text-[10px]">
              Canonical Mismatch
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1.5 text-xs text-indigo-700 font-medium">
          <span>{isOpen ? "Hide" : "Show Details"}</span>
          {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </div>
      </button>

      {isOpen && (
        <div className="p-3.5 space-y-4 text-xs bg-white border-t border-indigo-100">
          {/* Status & Source Summary */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 bg-slate-50 p-2.5 rounded border border-slate-100">
            <div>
              <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Coverage Status</span>
              <div className="mt-0.5">
                <Badge variant="outline" className="bg-white text-slate-700 border-slate-300">
                  {status || "Unconfigured"}
                </Badge>
              </div>
            </div>

            <div>
              <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Authoritative Source</span>
              <div className="mt-0.5 text-slate-700 font-medium capitalize">
                {authoritativeSource ? authoritativeSource.replace(/_/g, " ") : "None"}
              </div>
            </div>

            <div>
              <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Canonical Confidence</span>
              <div className="mt-0.5 font-semibold text-slate-800">
                {typeof confidence === "number" ? `${Math.round(confidence * 100)}%` : "â€”"}
              </div>
            </div>
          </div>

          {/* Canonical vs Legacy Comparison */}
          <div className="p-3 rounded border border-slate-200 bg-slate-50/50 space-y-1.5">
            <div className="flex items-center gap-1.5 font-semibold text-slate-700 text-xs">
              <GitCompare className="w-3.5 h-3.5 text-indigo-600" />
              <span>Canonical vs Legacy Comparison</span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs pt-1">
              <div>
                <span className="text-[10px] text-slate-500">Displayed (Legacy) Value:</span>
                <div className="font-mono font-medium text-slate-900 bg-white px-2 py-1 rounded border border-slate-200 mt-0.5">
                  {legacyFormatted}
                </div>
              </div>
              <div>
                <span className="text-[10px] text-slate-500">Canonical Projection Value:</span>
                <div className="font-mono font-medium text-indigo-900 bg-white px-2 py-1 rounded border border-indigo-200 mt-0.5">
                  {canonicalFormatted}
                </div>
              </div>
            </div>
            {isMismatch && (
              <div className="flex items-center gap-1.5 text-amber-800 text-[11px] bg-amber-50 p-1.5 rounded border border-amber-200 mt-2">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                <span>Canonical mismatch detected. Current UI renders legacy value as primary source.</span>
              </div>
            )}
          </div>

          {/* Conflict details if present */}
          {conflict && (
            <div className="p-3 rounded border border-red-200 bg-red-50/50 space-y-2">
              <div className="flex items-center gap-1.5 font-semibold text-red-900 text-xs">
                <AlertTriangle className="w-3.5 h-3.5 text-red-600" />
                <span>Projection Conflict Detected</span>
              </div>
              <p className="text-red-700 text-xs">{conflict.summary || "Multiple candidates exist for this canonical field."}</p>
              {conflict.reasonCodes && conflict.reasonCodes.length > 0 && (
                <div className="flex items-center gap-1 flex-wrap">
                  <span className="text-[10px] text-red-600 font-medium">Reason Codes:</span>
                  {conflict.reasonCodes.map((rc) => (
                    <span key={rc} className="text-[10px] font-mono bg-red-100 text-red-800 px-1 py-0.5 rounded">
                      {rc}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Derivation trace if present */}
          {derivation && (
            <div className="p-3 rounded border border-purple-200 bg-purple-50/30 space-y-2">
              <div className="flex items-center gap-1.5 font-semibold text-purple-900 text-xs">
                <Layers className="w-3.5 h-3.5 text-purple-600" />
                <span>Derivation Trace</span>
              </div>
              <div className="text-xs text-purple-900">
                <span className="text-[10px] text-purple-600 font-medium">Method: </span>
                <span className="font-mono">{derivation.method}</span>
              </div>
              {derivation.reasonCodes && derivation.reasonCodes.length > 0 && (
                <div className="flex items-center gap-1 flex-wrap">
                  <span className="text-[10px] text-purple-600 font-medium">Derivation Reasons:</span>
                  {derivation.reasonCodes.map((rc) => (
                    <span key={rc} className="text-[10px] font-mono bg-purple-100 text-purple-800 px-1 py-0.5 rounded">
                      {rc}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Canonical Evidence references */}
          {evidence && evidence.length > 0 && (
            <div className="space-y-2">
              <span className="font-semibold text-slate-800 text-xs flex items-center gap-1.5">
                <FileText className="w-3.5 h-3.5 text-indigo-600" />
                Canonical Evidence References ({evidence.length})
              </span>
              <div className="space-y-2">
                {evidence.map((ev, idx) => {
                  const text = ev.sourceText || "";
                  const isLong = text.length > 150;
                  const isExpanded = showFullSourceText[idx];

                  return (
                    <div key={ev.evidenceId || idx} className="p-2.5 rounded bg-slate-50 border border-slate-200 text-xs space-y-1.5">
                      <div className="flex items-center justify-between flex-wrap gap-1 text-[11px] text-slate-500">
                        <div className="flex items-center gap-2 flex-wrap">
                          {ev.documentName && <span className="font-semibold text-slate-700">{ev.documentName}</span>}
                          {ev.documentType && <Badge variant="outline" className="text-[10px] px-1 py-0">{ev.documentType}</Badge>}
                          {ev.amendmentNumber && <span>Amend #{ev.amendmentNumber}</span>}
                          {ev.page !== null && <span>Page {ev.page}</span>}
                          {ev.section && <span>Sec: {ev.section}</span>}
                          {ev.sourceClauseCategory && <span className="font-mono text-indigo-600">{ev.sourceClauseCategory}</span>}
                        </div>
                        {ev.polygonAvailable && (
                          <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200 text-[9px] px-1">
                            Polygon Available
                          </Badge>
                        )}
                      </div>

                      {text && (
                        <div className="bg-white p-2 rounded border border-slate-200 text-slate-700 text-xs italic font-serif leading-relaxed">
                          "{isLong && !isExpanded ? `${text.slice(0, 150)}...` : text}"
                          {isLong && (
                            <button
                              type="button"
                              onClick={() => toggleSourceText(idx)}
                              className="ml-2 text-xs font-sans text-indigo-600 hover:underline font-medium not-italic"
                            >
                              {isExpanded ? "Show Less" : "Show More"}
                            </button>
                          )}
                        </div>
                      )}

                      <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono pt-0.5">
                        {ev.evidenceId && <span>Evidence ID: {ev.evidenceId}</span>}
                        {ev.claimId && <span>Claim ID: {ev.claimId}</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}


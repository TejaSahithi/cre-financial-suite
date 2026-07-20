import React from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getFieldContract } from "@/lib/leaseFieldContract";

function fieldLabel(key) {
  return getFieldContract(key)?.label ?? key;
}

/**
 * Advisory workflow blockers — NEVER final approval enforcement. Server
 * blockers (openai_fact_ledger, with legacy fallback) are preferred when present;
 * otherwise a clearly-labeled client-side estimate (pure re-use of the
 * field contract's requiredByDocumentProfile flags) fills in so this
 * section shows real, profile-aware content for legacy_hybrid leases too.
 */
export default function ApprovalBlockersPanel({ approvalBlockers }) {
  const { documentProfile, source, missingFields, warnings, budgetBlockers, camBlockers } = approvalBlockers || {};
  const sourceLabel = source === "server" ? "Extraction-computed advisory blockers" : "Client-side advisory estimate";
  const sourceBadgeClass = source === "server" ? "bg-blue-50 text-blue-700" : "bg-slate-100 text-slate-600";

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 pb-2">
        <div>
          <CardTitle className="text-base">Advisory Workflow Blockers</CardTitle>
          <p className="text-xs text-slate-500">
            Advisory only — does not block accept/reject or approval. Profile-aware: an assignment/amendment document
            is never held to full-lease requirements.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Badge className="bg-slate-100 text-slate-700">{documentProfile || "profile unknown"}</Badge>
          <Badge className={sourceBadgeClass}>{sourceLabel}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div>
          <p className="text-xs font-semibold uppercase text-slate-500">Missing fields required for this profile</p>
          {!missingFields?.length ? (
            <p className="text-slate-500">None — every field required for this document profile is populated.</p>
          ) : (
            <div className="mt-1 flex flex-wrap gap-1.5">
              {missingFields.map((key) => (
                <Badge key={key} className="bg-red-50 text-red-700">{fieldLabel(key)}</Badge>
              ))}
            </div>
          )}
        </div>

        {budgetBlockers?.length > 0 && (
          <div>
            <p className="text-xs font-semibold uppercase text-slate-500">Budget blockers</p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {budgetBlockers.map((key) => (
                <Badge key={key} className="bg-amber-100 text-amber-800">{fieldLabel(key)}</Badge>
              ))}
            </div>
          </div>
        )}

        {camBlockers?.length > 0 && (
          <div>
            <p className="text-xs font-semibold uppercase text-slate-500">CAM blockers</p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {camBlockers.map((key) => (
                <Badge key={key} className="bg-amber-100 text-amber-800">{fieldLabel(key)}</Badge>
              ))}
            </div>
          </div>
        )}

        {warnings?.length > 0 && (
          <div>
            <p className="text-xs font-semibold uppercase text-slate-500">Warnings</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-amber-700">
              {warnings.map((w, idx) => (
                <li key={idx}>{w}</li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

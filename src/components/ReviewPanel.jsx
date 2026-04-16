import React, { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

function extractRecordValues(record) {
  if (record?.values && typeof record.values === "object") {
    return { ...record.values };
  }

  if (record?.fields && typeof record.fields === "object") {
    return Object.fromEntries(
      Object.entries(record.fields).map(([key, field]) => [
        key,
        field && typeof field === "object" && "value" in field ? field.value : field,
      ]),
    );
  }

  return {};
}

function confidenceFor(record, fieldName) {
  const field = record?.fields?.[fieldName];
  if (field && typeof field === "object" && typeof field.confidence === "number") {
    return field.confidence <= 1 ? Math.round(field.confidence * 100) : Math.round(field.confidence);
  }
  if (typeof record?.confidence === "number") {
    return record.confidence <= 1 ? Math.round(record.confidence * 100) : Math.round(record.confidence);
  }
  return null;
}

function confidenceClass(score) {
  if (score == null) return "bg-slate-100 text-slate-500";
  if (score >= 85) return "bg-emerald-50 text-emerald-700";
  if (score >= 70) return "bg-amber-50 text-amber-700";
  return "bg-red-50 text-red-700";
}

export default function ReviewPanel({
  payload,
  onApprove,
  onReject,
  approving = false,
  rejecting = false,
}) {
  const initialRows = useMemo(
    () => (payload?.records || payload?.rows || []).map(extractRecordValues),
    [payload],
  );
  const sourceRecords = payload?.records || payload?.rows || [];
  const [rows, setRows] = useState(initialRows);
  const [rejectReason, setRejectReason] = useState("");

  useEffect(() => {
    setRows(initialRows);
  }, [initialRows]);

  const updateField = (rowIndex, fieldName, value) => {
    setRows((prev) =>
      prev.map((row, index) =>
        index === rowIndex ? { ...row, [fieldName]: value } : row,
      ),
    );
  };

  if (!payload) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-sm text-slate-500">
          No review payload is available yet.
        </CardContent>
      </Card>
    );
  }

  const warnings = payload.global_warnings || payload.warnings || [];
  const validationErrors = payload.validation_errors || payload.validationErrors || [];

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold text-slate-900">Review Extracted Fields</h2>
              <p className="text-xs text-slate-500">
                {payload.file_name || payload.file_id} - {payload.document_subtype || "generic"}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge className="bg-blue-50 text-blue-700">
                {payload.extraction_method || payload.pipeline_method || "extraction"}
              </Badge>
              {payload.review_required && (
                <Badge className="bg-amber-50 text-amber-700">review required</Badge>
              )}
            </div>
          </div>

          {warnings.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
              <div className="flex gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600" />
                <div className="space-y-1 text-xs text-amber-800">
                  {warnings.slice(0, 5).map((warning, index) => (
                    <p key={index}>{String(warning)}</p>
                  ))}
                </div>
              </div>
            </div>
          )}

          {validationErrors.length > 0 && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3">
              <div className="flex gap-2">
                <XCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-600" />
                <div className="space-y-1 text-xs text-red-800">
                  {validationErrors.slice(0, 5).map((error, index) => (
                    <p key={index}>
                      {error?.field ? `${error.field}: ` : ""}
                      {error?.message || String(error)}
                    </p>
                  ))}
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {rows.map((row, rowIndex) => (
        <Card key={rowIndex}>
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900">Record {rowIndex + 1}</h3>
              <Badge className="bg-slate-100 text-slate-600">
                {Object.keys(row).length} fields
              </Badge>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              {Object.entries(row).map(([fieldName, value]) => {
                const score = confidenceFor(sourceRecords[rowIndex], fieldName);
                return (
                  <label key={fieldName} className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-semibold uppercase text-slate-500">
                        {fieldName.replace(/_/g, " ")}
                      </span>
                      <Badge className={`text-[10px] ${confidenceClass(score)}`}>
                        {score == null ? "manual" : `${score}%`}
                      </Badge>
                    </div>
                    <input
                      value={value == null ? "" : String(value)}
                      onChange={(event) => updateField(rowIndex, fieldName, event.target.value)}
                      className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                    />
                  </label>
                );
              })}
            </div>
          </CardContent>
        </Card>
      ))}

      <Card>
        <CardContent className="p-4 space-y-3">
          <textarea
            value={rejectReason}
            onChange={(event) => setRejectReason(event.target.value)}
            placeholder="Optional rejection reason"
            className="min-h-[72px] w-full rounded-md border border-slate-200 px-3 py-2 text-sm outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100"
          />
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => onReject?.(rejectReason || "Rejected during review")}
              disabled={rejecting || approving}
            >
              {rejecting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <XCircle className="mr-2 h-4 w-4" />}
              Reject
            </Button>
            <Button
              onClick={() => onApprove?.(rows)}
              disabled={approving || rejecting || rows.length === 0}
              className="bg-emerald-600 hover:bg-emerald-700"
            >
              {approving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
              Approve and Store
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

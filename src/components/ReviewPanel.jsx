import React, { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  EyeOff,
  Loader2,
  Plus,
  RotateCcw,
  Save,
  X,
  XCircle,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

function isBlank(value) {
  return value == null || (typeof value === "string" && value.trim() === "");
}

function humanizeFieldName(fieldName) {
  return String(fieldName || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function confidencePercent(score) {
  if (typeof score !== "number") return null;
  return score <= 1 ? Math.round(score * 100) : Math.round(score);
}

function confidenceClass(score) {
  if (score == null) return "bg-slate-100 text-slate-500";
  if (score >= 85) return "bg-emerald-50 text-emerald-700";
  if (score >= 70) return "bg-amber-50 text-amber-700";
  return "bg-red-50 text-red-700";
}

function statusClass(status) {
  if (status === "accepted") return "bg-emerald-50 text-emerald-700";
  if (status === "edited") return "bg-blue-50 text-blue-700";
  if (status === "rejected") return "bg-red-50 text-red-700";
  if (status === "missing") return "bg-amber-50 text-amber-700";
  return "bg-slate-100 text-slate-600";
}

function normalizeLegacyValues(record) {
  if (record?.values && typeof record.values === "object") return record.values;
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

function normalizeField(field, recordIndex, kind) {
  const fieldKey = field.field_key || field.key || field.name || `custom_field_${Date.now()}`;
  const originalValue = "original_value" in field ? field.original_value : field.value ?? "";
  const status =
    field.status ||
    (field.rejected ? "rejected" : field.accepted ? "accepted" : isBlank(field.value) ? "missing" : "pending");

  return {
    id: field.id || `${recordIndex}:${kind}:${fieldKey}:${Math.random().toString(36).slice(2)}`,
    field_key: fieldKey,
    label: field.label || humanizeFieldName(fieldKey),
    value: field.value ?? "",
    original_value: originalValue ?? "",
    field_type: field.field_type || "string",
    required: !!field.required,
    is_standard: kind === "standard" ? field.is_standard !== false : false,
    confidence: field.confidence ?? null,
    source: field.source || (kind === "custom" ? "user" : "system"),
    evidence: field.evidence || null,
    status,
    accepted: status === "accepted" || status === "edited",
    rejected: status === "rejected",
    user_edit: field.user_edit || null,
  };
}

function normalizeRecord(record, index) {
  if (Array.isArray(record?.standard_fields) || Array.isArray(record?.custom_fields)) {
    const standardFields = (record.standard_fields || []).map((field) =>
      normalizeField(field, index, "standard"),
    );
    const customFields = (record.custom_fields || []).map((field) =>
      normalizeField(field, index, "custom"),
    );
    return {
      ...record,
      record_index: record.record_index ?? record.row_index ?? index,
      row_index: record.row_index ?? record.record_index ?? index,
      standard_fields: standardFields,
      custom_fields: customFields,
      rejected_fields: record.rejected_fields || [],
      missing_required: standardFields
        .filter((field) => field.required && field.status !== "rejected" && isBlank(field.value))
        .map((field) => field.field_key),
      warnings: record.warnings || [],
    };
  }

  const values = normalizeLegacyValues(record);
  const standardFields = Object.entries(values).map(([key, value]) =>
    normalizeField(
      {
        field_key: key,
        label: humanizeFieldName(key),
        value,
        original_value: value,
        confidence: record?.confidence ?? null,
        source: "system",
      },
      index,
      "standard",
    ),
  );

  return {
    record_index: index,
    row_index: index,
    standard_fields: standardFields,
    custom_fields: [],
    rejected_fields: [],
    missing_required: [],
    warnings: [],
  };
}

function flattenRecordValues(record) {
  const fields = [...(record.standard_fields || []), ...(record.custom_fields || [])];
  return Object.fromEntries(
    fields
      .filter((field) => field.status !== "rejected")
      .filter((field) => field.is_standard || !isBlank(field.value))
      .map((field) => [field.field_key, isBlank(field.value) ? null : field.value]),
  );
}

export default function ReviewPanel({
  payload,
  onApprove,
  onReject,
  onSave,
  approving = false,
  rejecting = false,
  saving = false,
}) {
  const initialRecords = useMemo(
    () => (payload?.records || payload?.rows || []).map(normalizeRecord),
    [payload],
  );
  const [records, setRecords] = useState(initialRecords);
  const [rejectReason, setRejectReason] = useState("");
  const [showRejected, setShowRejected] = useState(false);

  useEffect(() => {
    setRecords(initialRecords);
  }, [initialRecords]);

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
  const allFields = records.flatMap((record) => [
    ...(record.standard_fields || []),
    ...(record.custom_fields || []),
  ]);
  const rejectedCount = allFields.filter((field) => field.status === "rejected").length;
  const customCount = allFields.filter((field) => field.is_standard === false).length;
  const missingCount = allFields.filter((field) => field.status !== "rejected" && field.required && isBlank(field.value)).length;

  const updateField = (recordIndex, kind, fieldId, patch) => {
    setRecords((prev) =>
      prev.map((record, index) => {
        if (index !== recordIndex) return record;
        const key = kind === "custom" ? "custom_fields" : "standard_fields";
        const fields = (record[key] || []).map((field) =>
          field.id === fieldId ? { ...field, ...patch } : field,
        );
        return {
          ...record,
          [key]: fields,
          missing_required: (key === "standard_fields" ? fields : record.standard_fields)
            .filter((field) => field.required && field.status !== "rejected" && isBlank(field.value))
            .map((field) => field.field_key),
        };
      }),
    );
  };

  const editValue = (recordIndex, kind, field, value) => {
    updateField(recordIndex, kind, field.id, {
      value,
      status: value === field.original_value ? "pending" : "edited",
      accepted: value !== field.original_value,
      rejected: false,
      source: value === field.original_value ? field.source : "user",
      user_edit: value === field.original_value
        ? null
        : {
            previous: field.original_value,
            edited_at: new Date().toISOString(),
            edited_by: "current_user",
          },
    });
  };

  const editCustomKey = (recordIndex, field, fieldKey) => {
    updateField(recordIndex, "custom", field.id, {
      field_key: fieldKey,
      label: humanizeFieldName(fieldKey),
      status: "edited",
      accepted: true,
      source: "user",
    });
  };

  const acceptField = (recordIndex, kind, field) => {
    updateField(recordIndex, kind, field.id, {
      status: "accepted",
      accepted: true,
      rejected: false,
      source: "user",
    });
  };

  const rejectField = (recordIndex, kind, field) => {
    updateField(recordIndex, kind, field.id, {
      status: "rejected",
      accepted: false,
      rejected: true,
      source: field.source || "system",
    });
  };

  const undoField = (recordIndex, kind, field) => {
    updateField(recordIndex, kind, field.id, {
      status: isBlank(field.value) ? "missing" : "pending",
      accepted: false,
      rejected: false,
    });
  };

  const addCustomField = (recordIndex) => {
    setRecords((prev) =>
      prev.map((record, index) => {
        if (index !== recordIndex) return record;
        const id = `${recordIndex}:custom:${Date.now()}`;
        return {
          ...record,
          custom_fields: [
            ...(record.custom_fields || []),
            {
              id,
              field_key: "custom_field",
              label: "Custom Field",
              value: "",
              original_value: "",
              field_type: "string",
              required: false,
              is_standard: false,
              confidence: 1,
              source: "user",
              evidence: null,
              status: "edited",
              accepted: true,
              rejected: false,
              user_edit: {
                previous: null,
                edited_at: new Date().toISOString(),
                edited_by: "current_user",
              },
            },
          ],
        };
      }),
    );
  };

  const buildSubmitPayload = () => ({
    ...payload,
    schema_version: 2,
    records: records.map((record, index) => ({
      ...record,
      record_index: record.record_index ?? index,
      row_index: record.row_index ?? index,
      values: flattenRecordValues(record),
    })),
    rows: records.map((record, index) => ({
      ...record,
      record_index: record.record_index ?? index,
      row_index: record.row_index ?? index,
      values: flattenRecordValues(record),
    })),
    updated_at: new Date().toISOString(),
  });

  const renderField = (recordIndex, kind, field) => {
    if (field.status === "rejected" && !showRejected) return null;
    const score = confidencePercent(field.confidence);
    const isCustom = kind === "custom";

    return (
      <div
        key={field.id}
        className={`rounded-lg border p-3 ${field.status === "rejected" ? "border-red-200 bg-red-50" : "border-slate-200 bg-white"}`}
      >
        <div className="mb-2 flex flex-wrap items-center gap-2">
          {isCustom ? (
            <input
              value={field.field_key}
              onChange={(event) => editCustomKey(recordIndex, field, event.target.value)}
              className="min-w-[180px] flex-1 rounded-md border border-slate-200 px-2 py-1 text-xs font-semibold uppercase tracking-wide text-slate-600 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
              placeholder="custom_field_name"
            />
          ) : (
            <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              {field.label || humanizeFieldName(field.field_key)}
            </span>
          )}
          {field.required && <Badge className="bg-amber-50 text-amber-700">required</Badge>}
          {!field.is_standard && <Badge className="bg-indigo-50 text-indigo-700">custom</Badge>}
          <Badge className={`text-[10px] ${confidenceClass(score)}`}>
            {score == null ? field.source || "manual" : `${score}%`}
          </Badge>
          <Badge className={`text-[10px] ${statusClass(field.status)}`}>
            {field.status}
          </Badge>
        </div>

        <div className="flex gap-2">
          <input
            value={field.value == null ? "" : String(field.value)}
            onChange={(event) => editValue(recordIndex, kind, field, event.target.value)}
            disabled={field.status === "rejected"}
            placeholder={field.required ? "Missing required value" : "Add value"}
            className="min-w-0 flex-1 rounded-md border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-100 disabled:text-slate-400"
          />
          {isCustom && field.status === "rejected" ? (
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => undoField(recordIndex, kind, field)}
              title="Undo rejection"
            >
              <RotateCcw className="h-4 w-4" />
            </Button>
          ) : isCustom ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => acceptField(recordIndex, kind, field)}
                className="border-emerald-200 text-emerald-700 hover:bg-emerald-50"
                title="Accept field"
              >
                <Check className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => rejectField(recordIndex, kind, field)}
                className="border-red-200 text-red-700 hover:bg-red-50"
                title="Reject field"
              >
                <X className="h-4 w-4" />
              </Button>
            </>
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3 p-4">
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
              <Badge className="bg-slate-100 text-slate-700">{records.length} records</Badge>
              {customCount > 0 && <Badge className="bg-indigo-50 text-indigo-700">{customCount} custom</Badge>}
              {missingCount > 0 && <Badge className="bg-amber-50 text-amber-700">{missingCount} missing</Badge>}
              {rejectedCount > 0 && <Badge className="bg-red-50 text-red-700">{rejectedCount} rejected</Badge>}
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

          {rejectedCount > 0 && (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => addCustomField(0)}
              >
                <Plus className="mr-2 h-4 w-4" />
                Add custom field
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setShowRejected((value) => !value)}
              >
                <EyeOff className="mr-2 h-4 w-4" />
                {showRejected ? "Hide rejected fields" : "Show rejected fields"}
              </Button>
            </div>
          )}

          {rejectedCount === 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => addCustomField(0)}
            >
              <Plus className="mr-2 h-4 w-4" />
              Add custom field
            </Button>
          )}
        </CardContent>
      </Card>

      {records.map((record, recordIndex) => (
        <Card key={record.record_index ?? recordIndex}>
          <CardContent className="space-y-4 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">Record {recordIndex + 1}</h3>
                <p className="text-xs text-slate-500">
                  Standard UI fields are mapped first. Extra interpreted document fields appear as custom fields.
                </p>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              {(record.standard_fields || []).map((field) => renderField(recordIndex, "standard", field))}
              {(record.custom_fields || []).map((field) => renderField(recordIndex, "custom", field))}
            </div>
          </CardContent>
        </Card>
      ))}

      <Card>
        <CardContent className="space-y-3 p-4">
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
              disabled={rejecting || approving || saving}
            >
              {rejecting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <XCircle className="mr-2 h-4 w-4" />}
              Reject Document
            </Button>
            <Button
              variant="outline"
              onClick={() => onSave?.(buildSubmitPayload())}
              disabled={saving || approving || rejecting || records.length === 0}
            >
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
              Save Review
            </Button>
            <Button
              onClick={() => onApprove?.(buildSubmitPayload())}
              disabled={approving || rejecting || saving || records.length === 0}
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

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

function sanitizeReviewWarning(warning) {
  const text = String(warning || "");
  if (/no tables found/i.test(text)) return null;
  if (/GOOGLE_SERVICE_ACCOUNT_KEY|service account|private_key|JWT/i.test(text)) {
    return "AI fallback extraction is unavailable. Deterministic document parsing still ran.";
  }
  return text;
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

const LEASE_STANDARD_FIELDS = [
  { key: "tenant_name", label: "Tenant Name", required: true },
  { key: "landlord_name", label: "Landlord", required: true },
  { key: "property_name", label: "Property Name", required: false },
  { key: "property_address", label: "Property Address / Premises", required: true },
  { key: "assignor_name", label: "Assignor", required: false },
  { key: "assignee_name", label: "Assignee", required: false },
  { key: "assignment_effective_date", label: "Assignment Effective Date", required: false },
  { key: "landlord_consent", label: "Landlord Consent", required: false },
  { key: "assignee_notice_address", label: "Assignee Notice Address", required: false },
  { key: "assumption_scope", label: "Assumption Scope", required: false },
  { key: "unit_number", label: "Unit / Suite", required: false },
  { key: "start_date", label: "Start Date", required: true },
  { key: "end_date", label: "End Date", required: true },
  { key: "monthly_rent", label: "Monthly Rent", required: true },
  { key: "annual_rent", label: "Annual Rent", required: false },
  { key: "lease_term_months", label: "Lease Term Months", required: false },
  { key: "rent_per_sf", label: "Rent/SF", required: false },
  { key: "square_footage", label: "Square Footage", required: false },
  { key: "lease_type", label: "Lease Type", required: false },
  { key: "security_deposit", label: "Security Deposit", required: false },
  { key: "cam_amount", label: "CAM Amount", required: false },
  { key: "escalation_rate", label: "Escalation Rate", required: false },
  { key: "renewal_options", label: "Renewal Options", required: false },
  { key: "ti_allowance", label: "TI Allowance", required: false },
  { key: "free_rent_months", label: "Free Rent Months", required: false },
  { key: "status", label: "Status", required: false },
  { key: "notes", label: "Notes", required: false },
];

const CANONICAL_FIELD_ALIASES = {
  landlord: "landlord_name",
  landlord_name: "landlord_name",
  lessor: "landlord_name",
  tenant: "tenant_name",
  tenant_name: "tenant_name",
  lessee: "tenant_name",
  assignor: "assignor_name",
  assignor_name: "assignor_name",
  assignor_tenant: "assignor_name",
  assignor_assignor: "assignor_name",
  assignee: "assignee_name",
  assignee_name: "assignee_name",
  assignee_tenant: "assignee_name",
  assignee_assignee: "assignee_name",
  assignment_date: "assignment_effective_date",
  effective_date: "assignment_effective_date",
  assignment_effective_date: "assignment_effective_date",
  date_of_assignment: "assignment_effective_date",
  landlord_consent: "landlord_consent",
  consent: "landlord_consent",
  assignee_notice_address: "assignee_notice_address",
  assignee_address: "assignee_notice_address",
  notice_address: "assignee_notice_address",
  address_for_notices: "assignee_notice_address",
  assumption_scope: "assumption_scope",
  assumption: "assumption_scope",
  premises: "property_address",
  property_address: "property_address",
  premises_address: "property_address",
  premises_location: "property_address",
  address: "property_address",
  annual_rent: "annual_rent",
  yearly_rent: "annual_rent",
  base_rent_additional_year: "annual_rent",
  additional_year_base_rent: "annual_rent",
  new_lease_expiration_date: "end_date",
  lease_expiration_date: "end_date",
  original_lease_date: "start_date",
  premises_rentable_square_feet: "square_footage",
  rentable_square_feet: "square_footage",
  assignee_security_deposit_amount: "security_deposit",
  lease_term_months: "lease_term_months",
  term_months: "lease_term_months",
  lease_term: "lease_term_months",
  lease_term_extension_duration: "renewal_options",
  cam: "cam_amount",
  cam_charges: "cam_amount",
  common_area_maintenance: "cam_amount",
  common_area_maintenance_amount: "cam_amount",
  cam_amount: "cam_amount",
  monthly_rent: "monthly_rent",
  base_rent: "monthly_rent",
  start_date: "start_date",
  commencement_date: "start_date",
  end_date: "end_date",
  expiration_date: "end_date",
  suite: "unit_number",
  unit: "unit_number",
  lease_type: "lease_type",
};

function canonicalFieldKey(key) {
  const normalized = String(key || "")
    .trim()
    .toLowerCase()
    .replace(/[#%]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return CANONICAL_FIELD_ALIASES[normalized] || normalized;
}

function compactKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function isAddressLike(value) {
  return /\d{1,6}\s+[^,\n]{2,80}\s+(street|st\.?|avenue|ave\.?|road|rd\.?|drive|dr\.?|lane|ln\.?|suite|city|plaza|boulevard|blvd\.?)/i
    .test(String(value || ""));
}

function isCamClauseCustom(field) {
  const text = `${field.field_key || ""} ${field.value || ""}`;
  return /(^|\b)(pro[\s_-]?rata|common area maintenance|\bcam\b)(\b|$)/i.test(text);
}

function isBrokenContinuationCustom(field, standardByKey) {
  const key = compactKey(field.field_key);
  const value = String(field.value || "");
  if (!key || key.length < 4) return true;
  if (/^[a-z]/.test(value) && key.length <= 10) return true;

  const propertyName = compactKey(standardByKey.get("property_name")?.value);
  if (propertyName && key.startsWith(propertyName) && /lease term|start date|leased area|suite|unit/i.test(value)) {
    return true;
  }

  return false;
}

function normalizeComparableValue(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\$/g, "")
    .replace(/,/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.;:]$/g, "");
}

function dateLikeParts(value) {
  const text = String(value ?? "").trim();
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return { year: iso[1], month: iso[2], day: String(Number(iso[3])) };
  const long = text.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (long) {
    const months = {
      january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
      july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
    };
    return { year: long[3], month: months[long[1].toLowerCase()] || long[1].toLowerCase(), day: String(Number(long[2])) };
  }
  return null;
}

function isDuplicateCustomField(field, standardByKey) {
  const key = compactKey(field.field_key);
  const value = normalizeComparableValue(field.value);
  if (!key || !value) return false;

  if (/_(day|month|year)$/.test(key)) {
    const baseKey = key.replace(/_(day|month|year)$/, "");
    const canonicalDateKey = canonicalFieldKey(baseKey);
    const standardDate = standardByKey.get(canonicalDateKey);
    if (!standardDate || isBlank(standardDate.value)) return false;
    const parts = dateLikeParts(standardDate.value);
    if (!parts) return false;
    if (key.endsWith("_day")) return value.replace(/\D/g, "") === parts.day;
    if (key.endsWith("_year")) return value === parts.year;
    if (key.endsWith("_month")) {
      const monthNames = {
        january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
        july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
      };
      const normalizedMonth = monthNames[value] || value;
      const month = value.padStart(2, "0");
      return month === parts.month || normalizedMonth === parts.month || value === parts.month;
    }
  }

  for (const standard of standardByKey.values()) {
    if (standard?.is_standard === false || isBlank(standard?.value)) continue;
    const standardValue = normalizeComparableValue(standard.value);
    if (!standardValue) continue;
    if (value === standardValue) return true;
    if (standardValue.length > 8 && value.length > 8 && (standardValue.includes(value) || value.includes(standardValue))) {
      return true;
    }
  }

  return false;
}

function normalizeLeaseReviewFields(record, index, standardFields, customFields) {
  const standardByKey = new Map();
  for (const field of standardFields) {
    standardByKey.set(canonicalFieldKey(field.field_key), {
      ...field,
      field_key: canonicalFieldKey(field.field_key),
      is_standard: true,
    });
  }

  for (const template of LEASE_STANDARD_FIELDS) {
    if (!standardByKey.has(template.key)) {
      standardByKey.set(
        template.key,
        normalizeField(
          {
            field_key: template.key,
            label: template.label,
            value: "",
            original_value: "",
            required: template.required,
            is_standard: true,
            confidence: 0,
            source: "system",
            status: "missing",
          },
          index,
          "standard",
        ),
      );
    }
  }

  const remainingCustomFields = [];
  for (const field of customFields) {
    const canonicalKey = canonicalFieldKey(field.field_key);
    if (isBrokenContinuationCustom(field, standardByKey)) continue;
    if (isDuplicateCustomField(field, standardByKey)) continue;
    if (standardByKey.has(canonicalKey)) {
      const existing = standardByKey.get(canonicalKey);
      if (isBlank(existing.value) && !isBlank(field.value)) {
        standardByKey.set(canonicalKey, {
          ...existing,
          value: field.value,
          original_value: field.original_value ?? field.value,
          confidence: field.confidence,
          source: field.source,
          status: field.status === "rejected" ? "pending" : field.status,
          accepted: false,
          rejected: false,
        });
      }
      continue;
    }
    if (isCamClauseCustom(field)) {
      const notes = standardByKey.get("notes");
      if (notes && isBlank(notes.value) && !isBlank(field.value)) {
        standardByKey.set("notes", {
          ...notes,
          value: String(field.value),
          original_value: field.original_value ?? field.value,
          confidence: field.confidence,
          source: field.source,
          status: field.status === "rejected" ? "pending" : field.status,
          accepted: false,
          rejected: false,
        });
      }
    } else {
      remainingCustomFields.push(field);
    }
  }

  const propertyName = standardByKey.get("property_name");
  const propertyAddress = standardByKey.get("property_address");
  if (propertyName && propertyAddress && isBlank(propertyAddress.value) && isAddressLike(propertyName.value)) {
    standardByKey.set("property_address", {
      ...propertyAddress,
      value: propertyName.value,
      original_value: propertyName.original_value ?? propertyName.value,
      confidence: propertyName.confidence,
      source: propertyName.source,
      status: propertyName.status,
    });
    standardByKey.set("property_name", {
      ...propertyName,
      value: "",
      original_value: "",
      confidence: 0,
      source: "system",
      status: "missing",
      accepted: false,
      rejected: false,
    });
  }

  return {
    ...record,
    standard_fields: LEASE_STANDARD_FIELDS.map((field) => standardByKey.get(field.key)),
    custom_fields: remainingCustomFields,
  };
}

function normalizeRecord(record, index, moduleType) {
  if (Array.isArray(record?.standard_fields) || Array.isArray(record?.custom_fields)) {
    let standardFields = (record.standard_fields || []).map((field) =>
      normalizeField(field, index, "standard"),
    );
    let customFields = (record.custom_fields || []).map((field) =>
      normalizeField(field, index, "custom"),
    );
    let normalizedRecord = {
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
    if (moduleType === "leases" || moduleType === "lease") {
      normalizedRecord = normalizeLeaseReviewFields(normalizedRecord, index, standardFields, customFields);
      standardFields = normalizedRecord.standard_fields || [];
      customFields = normalizedRecord.custom_fields || [];
      normalizedRecord.missing_required = standardFields
        .filter((field) => field.required && field.status !== "rejected" && isBlank(field.value))
        .map((field) => field.field_key);
    }
    return normalizedRecord;
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
  approveLabel = "Approve and Store",
  approveDescription = "Save the reviewed rows and continue the workflow.",
  approving = false,
  rejecting = false,
  saving = false,
}) {
  const initialRecords = useMemo(
    () => (payload?.records || payload?.rows || []).map((record, index) =>
      normalizeRecord(record, index, payload?.module_type),
    ),
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

  const warnings = [...new Set((payload.global_warnings || payload.warnings || [])
    .map(sanitizeReviewWarning)
    .filter(Boolean))];
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
    const changed = value !== field.original_value;
    updateField(recordIndex, kind, field.id, {
      value,
      status: changed ? "edited" : "pending",
      accepted: kind === "custom" ? false : changed,
      rejected: false,
      source: changed ? "user" : field.source,
      user_edit: !changed
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
      accepted: false,
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
              status: "pending",
              accepted: false,
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
    const showCustomActions = isCustom && field.status !== "accepted" && field.status !== "rejected";

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
          ) : showCustomActions ? (
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
            {approveDescription && (
              <p className="mr-auto max-w-xl self-center text-xs text-slate-500">
                {approveDescription}
              </p>
            )}
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
              {approveLabel}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

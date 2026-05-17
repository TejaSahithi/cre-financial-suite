import React, { useEffect, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SelectWithCustom } from "@/components/ui/select-with-custom";
import {
  Check,
  ExternalLink,
  Gavel,
  HelpCircle,
  Loader2,
  MinusCircle,
  Pencil,
  Save,
  Undo2,
  X,
} from "lucide-react";
import {
  REVIEW_STATUSES,
  REVIEW_STATUS_LABELS,
  REVIEW_STATUS_STYLES,
  classifyConfidence,
  readFieldConfidence,
  readFieldEvidence,
  readFieldValue,
  NUMERIC_REVIEW_FIELDS,
} from "@/lib/leaseReviewSchema";
import {
  LEASE_FIELD_OPTIONS,
  getLeaseFieldLabel,
  hasLeaseFieldOptions,
} from "@/lib/leaseFieldOptions";
import { supabase } from "@/services/supabaseClient";

const confidenceClass = (score) => {
  const bucket = classifyConfidence(score);
  if (bucket === "high") return "bg-emerald-100 text-emerald-700";
  if (bucket === "medium") return "bg-amber-100 text-amber-700";
  if (bucket === "low") return "bg-red-100 text-red-700";
  return "bg-slate-100 text-slate-500";
};

function formatTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
}

export default function FieldDetailDrawer({
  open,
  onOpenChange,
  field,
  lease,
  review,
  onAccept,
  onReject,
  onMarkNA,
  onNeedsLegal,
  onMarkManualRequired,
  onReset,
  onSaveEdit,
  onViewInDocument,
  isSaving,
}) {
  const [mode, setMode] = useState("view");
  const [editValue, setEditValue] = useState("");
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const value = field ? readFieldValue(lease, field.key) : null;
  const { rawValue, sourcePage, sourceText, extractionStatus } = field
    ? readFieldEvidence(lease, field.key)
    : { rawValue: null, sourcePage: null, sourceText: null, extractionStatus: null };
  const confidence = field ? readFieldConfidence(lease, field.key) : null;
  const status = review?.status || REVIEW_STATUSES.PENDING;
  const confidenceLabel =
    classifyConfidence(confidence) === "unknown" ? "Unknown Confidence" : `${Math.round(confidence)}%`;
  const inferredExtractionStatus =
    extractionStatus
    || (value === null || value === undefined || value === ""
      ? "missing"
      : classifyConfidence(confidence) === "unknown"
        ? "extracted_no_confidence"
        : "extracted");

  // Reset edit mode + populate when drawer opens or field changes.
  useEffect(() => {
    if (!open || !field) return;
    setMode("view");
    setEditValue(value == null ? "" : String(value));
  }, [open, field?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load audit history when drawer opens.
  useEffect(() => {
    if (!open || !field?.key || !lease?.id || !supabase) {
      setHistory([]);
      return;
    }
    let cancelled = false;
    setHistoryLoading(true);
    (async () => {
      try {
        const { data, error } = await supabase
          .from("audit_logs")
          .select("id, action, field_changed, old_value, new_value, user_email, user_name, timestamp, created_at")
          .eq("entity_id", lease.id)
          .eq("field_changed", field.key)
          .order("timestamp", { ascending: false })
          .limit(25);
        if (!error && !cancelled) {
          setHistory(data || []);
        } else if (error) {
          // Suppress if audit table absent or columns differ.
          if (!cancelled) setHistory([]);
        }
      } catch {
        if (!cancelled) setHistory([]);
      } finally {
        if (!cancelled) setHistoryLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, field?.key, lease?.id, review?.reviewed_at]);

  if (!field) return null;

  const handleSave = async () => {
    let val = typeof editValue === "string" ? editValue.trim() : editValue;
    if (NUMERIC_REVIEW_FIELDS.has(field.key)) {
      const n = parseFloat(String(val).replace(/[$,]/g, ""));
      val = Number.isNaN(n) ? null : n;
    }
    if (field.type === "boolean") {
      val = val === true || val === "true" || val === "yes";
    }
    await onSaveEdit(field, val);
    setMode("view");
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-xl">
        <SheetHeader className="border-b border-slate-200 bg-slate-50 px-5 py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <SheetTitle className="truncate text-base">
                {field.label}
                {field.required && <span className="ml-1 text-red-500">*</span>}
              </SheetTitle>
              <SheetDescription className="text-xs text-slate-500">{field.key}</SheetDescription>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge className={`text-[10px] ${confidenceClass(confidence)}`}>{confidenceLabel}</Badge>
              <Badge className={`text-[10px] ${REVIEW_STATUS_STYLES[status] || "bg-slate-100 text-slate-700"}`}>
                {REVIEW_STATUS_LABELS[status]}
              </Badge>
            </div>
          </div>
        </SheetHeader>

        <div className="flex-1 space-y-5 px-5 py-4 text-sm">
          {/* Value / edit */}
          <section className="space-y-2">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Normalized Value
            </p>
            {mode === "edit" ? (
              <div className="space-y-2">
                {hasLeaseFieldOptions(field.options || field.key) ? (
                  <SelectWithCustom
                    value={editValue}
                    onChange={(next) => setEditValue(next)}
                    options={LEASE_FIELD_OPTIONS[field.options || field.key]}
                    placeholder={`Select ${field.label.toLowerCase()}`}
                  />
                ) : field.type === "boolean" ? (
                  <Select value={String(editValue)} onValueChange={(v) => setEditValue(v)}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="true">Yes</SelectItem>
                      <SelectItem value="false">No</SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    type={
                      field.type === "number" || field.type === "currency"
                        ? "number"
                        : field.type === "date"
                        ? "date"
                        : "text"
                    }
                  />
                )}
                <div className="flex justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={() => setMode("view")}>
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    className="bg-blue-600 hover:bg-blue-700"
                    onClick={handleSave}
                    disabled={isSaving}
                  >
                    {isSaving ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Save className="mr-1 h-3 w-3" />}
                    Save edit
                  </Button>
                </div>
              </div>
            ) : (
              <p className="rounded-md bg-slate-50 px-3 py-2 text-base font-medium text-slate-900">
                {value == null || value === ""
                  ? "—"
                  : field.type === "currency" && !Number.isNaN(Number(value))
                  ? `$${Number(value).toLocaleString()}`
                  : field.type === "select" && hasLeaseFieldOptions(field.options || field.key)
                  ? getLeaseFieldLabel(field.options || field.key, value) || String(value)
                  : String(value)}
              </p>
            )}
          </section>

          {/* Raw extracted */}
          <section className="grid gap-3 sm:grid-cols-2">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Raw Value</p>
              <p className="mt-1 break-words text-sm text-slate-700">{rawValue ?? "—"}</p>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Source Page</p>
              <p className="mt-1 text-sm text-slate-700">{sourcePage ?? "—"}</p>
            </div>
          </section>

          <section>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Exact Source Text</p>
            <p className="mt-1 whitespace-pre-wrap rounded-md bg-slate-50 px-3 py-2 text-xs italic text-slate-700">
              {sourceText || "No source text captured."}
            </p>
          </section>

          <section className="grid gap-3 sm:grid-cols-2">
            <Meta label="Confidence Score" value={confidenceLabel} />
            <Meta label="Extraction Status" value={inferredExtractionStatus} />
            <Meta label="Review Status" value={REVIEW_STATUS_LABELS[status]} />
            <Meta label="Reviewer" value={review?.reviewer || "—"} />
            <Meta label="Reviewed At" value={formatTime(review?.reviewed_at)} />
          </section>

          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Audit History</p>
              {historyLoading && <Loader2 className="h-3 w-3 animate-spin text-slate-400" />}
            </div>
            {history.length === 0 ? (
              <p className="text-xs text-slate-500">No prior review actions recorded.</p>
            ) : (
              <ul className="space-y-1.5">
                {history.map((row) => (
                  <li key={row.id} className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-slate-700">{row.action}</span>
                      <span className="text-[10px] text-slate-500">{formatTime(row.timestamp || row.created_at)}</span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-slate-600">
                      {row.user_email || row.user_name || "system"}
                    </div>
                    {(row.old_value || row.new_value) && (
                      <div className="mt-0.5 text-[11px] text-slate-500">
                        {row.old_value ? `from ${row.old_value} ` : ""}
                        {row.new_value ? `→ ${row.new_value}` : ""}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <Textarea
            placeholder="Notes for this review (optional)…"
            rows={2}
            value={review?.note || ""}
            onChange={() => { /* read-only here; edits flow through the action panel */ }}
            disabled
          />
        </div>

        <div className="sticky bottom-0 border-t border-slate-200 bg-white px-5 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button variant="outline" size="sm" onClick={onViewInDocument}>
              <ExternalLink className="mr-1 h-3.5 w-3.5" />
              View in Document
            </Button>
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                size="sm"
                variant="outline"
                className="text-emerald-700"
                onClick={() => onAccept(field)}
                disabled={isSaving}
              >
                <Check className="mr-1 h-3.5 w-3.5" />
                Accept
              </Button>
              <Button size="sm" variant="outline" className="text-blue-700" onClick={() => setMode("edit")}>
                <Pencil className="mr-1 h-3.5 w-3.5" />
                Edit
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="text-red-700"
                onClick={() => onReject(field)}
                disabled={isSaving}
              >
                <X className="mr-1 h-3.5 w-3.5" />
                Reject
              </Button>
              {field.allowNA !== false && (
                <Button size="sm" variant="outline" onClick={() => onMarkNA(field)} disabled={isSaving}>
                  <MinusCircle className="mr-1 h-3.5 w-3.5" />
                  N/A
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                className="text-amber-700"
                onClick={() => onMarkManualRequired(field)}
                disabled={isSaving}
              >
                <HelpCircle className="mr-1 h-3.5 w-3.5" />
                Manual
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="text-purple-700"
                onClick={() => onNeedsLegal(field)}
                disabled={isSaving}
              >
                <Gavel className="mr-1 h-3.5 w-3.5" />
                Legal
              </Button>
              {status !== REVIEW_STATUSES.PENDING && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-slate-500"
                  onClick={() => onReset(field)}
                  disabled={isSaving}
                >
                  <Undo2 className="mr-1 h-3.5 w-3.5" />
                  Reset
                </Button>
              )}
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Meta({ label, value }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-xs text-slate-700">{value}</p>
    </div>
  );
}

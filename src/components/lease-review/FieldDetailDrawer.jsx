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
  EXTRACTION_STATUS_LABELS,
  classifyConfidence,
  readFieldConfidence,
  readFieldEvidence,
  readFieldValue,
  resolveExtractionStatus,
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
  initialMode = "view",
  onAccept,
  onReject,
  onMarkNA,
  onNeedsLegal,
  onMarkManualRequired,
  onReset,
  onSaveEdit,
  onSaveOverrideReason,
  onSaveEvidence,
  onViewInDocument,
  isSaving,
}) {
  const [mode, setMode] = useState(initialMode);
  const [editValue, setEditValue] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  // Editable evidence form state — reviewer can correct what extraction
  // missed or got wrong without re-running the pipeline.
  const [evRaw, setEvRaw] = useState("");
  const [evSourcePage, setEvSourcePage] = useState("");
  const [evSourceText, setEvSourceText] = useState("");
  const [evConfidence, setEvConfidence] = useState("");
  const [evExtractionStatus, setEvExtractionStatus] = useState("");
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const value = field ? readFieldValue(lease, field.key) : null;
  const evidence = field
    ? readFieldEvidence(lease, field.key)
    : { rawValue: null, sourcePage: null, sourceText: null, extractionStatus: null };
  const { rawValue, sourcePage, sourceText } = evidence;
  const confidence = field ? readFieldConfidence(lease, field.key) : null;
  const status = review?.status || REVIEW_STATUSES.PENDING;
  const confidenceLabel =
    classifyConfidence(confidence) === "unknown" ? "Unknown Confidence" : `${Math.round(confidence)}%`;
  const inferredExtractionStatus = field
    ? resolveExtractionStatus(lease, field.key, { value, confidence, evidence })
    : "missing";
  const extractionStatusLabel = EXTRACTION_STATUS_LABELS[inferredExtractionStatus] || inferredExtractionStatus;

  // Reset edit mode + populate when drawer opens or field changes. Honors
  // the parent's initialMode so the dropdown "Edit" item can open the
  // drawer already in edit mode.
  useEffect(() => {
    if (!open || !field) return;
    setMode(initialMode || "view");
    setEditValue(value == null ? "" : String(value));
    setOverrideReason(typeof review?.note === "string" ? review.note : "");
    setEvRaw(evidence?.rawValue == null ? "" : String(evidence.rawValue));
    setEvSourcePage(evidence?.sourcePage == null ? "" : String(evidence.sourcePage));
    setEvSourceText(evidence?.sourceText == null ? "" : String(evidence.sourceText));
    setEvConfidence(typeof confidence === "number" ? String(confidence) : "");
    setEvExtractionStatus(evidence?.extractionStatus || inferredExtractionStatus || "");
  }, [open, field?.key]);  

  // Whether this field needs an override reason to clear the approval gate.
  const hasEvidence = Boolean(
    evidence?.sourcePage
    || (typeof evidence?.sourceText === "string" && evidence.sourceText.length > 0)
    || evidence?.rawValue,
  );
  const valuePresent = value !== null && value !== undefined && value !== "";
  const needsOverride =
    field?.required
    && valuePresent
    && !hasEvidence
    && (review?.status === REVIEW_STATUSES.ACCEPTED || review?.status === REVIEW_STATUSES.EDITED);
  const hasStoredOverride = typeof review?.note === "string" && review.note.trim().length > 0;

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
    if (NUMERIC_REVIEW_FIELDS.has(field.key) || field.type === "number" || field.type === "currency") {
      const n = parseFloat(String(val).replace(/[$,]/g, ""));
      val = Number.isNaN(n) ? null : n;
    }
    if (field.type === "boolean") {
      val = val === true || val === "true" || val === "yes";
    }
    // Bundle evidence form state alongside the value so a single "Save edit"
    // click persists everything the reviewer typed. Blank fields are
    // omitted (encoded as undefined) so the parent can preserve the
    // extractor's existing evidence rather than clobbering it with null.
    const evidencePatch = {
      raw_value: typeof evRaw === "string" && evRaw.trim().length > 0 ? evRaw.trim() : undefined,
      source_page: (() => {
        const trimmed = String(evSourcePage ?? "").trim();
        if (!trimmed) return undefined;
        const n = parseInt(trimmed, 10);
        return Number.isFinite(n) ? n : undefined;
      })(),
      source_text: typeof evSourceText === "string" && evSourceText.trim().length > 0 ? evSourceText.trim() : undefined,
      confidence: (() => {
        const trimmed = String(evConfidence ?? "").trim();
        if (!trimmed) return undefined;
        const n = parseFloat(trimmed);
        if (!Number.isFinite(n)) return undefined;
        // Accept either 0-1 or 0-100 input; normalize to 0-100.
        return n <= 1 ? Math.round(n * 100) : Math.round(n);
      })(),
      extraction_status: typeof evExtractionStatus === "string" && evExtractionStatus.trim().length > 0 ? evExtractionStatus.trim() : undefined,
    };
    await onSaveEdit(field, val, evidencePatch);
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

          {/* Editable evidence form — reviewer can correct extractor output
              without re-running the pipeline. Persists via onSaveEvidence. */}
          <section className="space-y-3 rounded-md border border-slate-200 bg-slate-50/50 p-3">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-600">
                Evidence (editable)
              </p>
              <span className="text-[10px] text-slate-500">All fields below can be corrected by the reviewer</span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label className="text-[10px] font-semibold uppercase text-slate-500">Raw Value</Label>
                <Input
                  className="mt-1"
                  value={evRaw}
                  onChange={(e) => setEvRaw(e.target.value)}
                  placeholder="e.g. $1,400 per month"
                  disabled={!onSaveEvidence || isSaving}
                />
              </div>
              <div>
                <Label className="text-[10px] font-semibold uppercase text-slate-500">Source Page</Label>
                <Input
                  className="mt-1"
                  type="number"
                  value={evSourcePage}
                  onChange={(e) => setEvSourcePage(e.target.value)}
                  placeholder="e.g. 3"
                  disabled={!onSaveEvidence || isSaving}
                />
              </div>
            </div>
            <div>
              <Label className="text-[10px] font-semibold uppercase text-slate-500">Exact Source Text</Label>
              <Textarea
                className="mt-1"
                rows={3}
                value={evSourceText}
                onChange={(e) => setEvSourceText(e.target.value)}
                placeholder="Paste the verbatim sentence from the lease document"
                disabled={!onSaveEvidence || isSaving}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label className="text-[10px] font-semibold uppercase text-slate-500">Confidence Score (0–100)</Label>
                <Input
                  className="mt-1"
                  type="number"
                  min="0"
                  max="100"
                  step="1"
                  value={evConfidence}
                  onChange={(e) => setEvConfidence(e.target.value)}
                  placeholder="e.g. 95"
                  disabled={!onSaveEvidence || isSaving}
                />
              </div>
              <div>
                <Label className="text-[10px] font-semibold uppercase text-slate-500">Extraction Status</Label>
                <Select value={evExtractionStatus} onValueChange={setEvExtractionStatus} disabled={!onSaveEvidence || isSaving}>
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Select status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="extracted">Extracted</SelectItem>
                    <SelectItem value="extracted_no_confidence">Extracted (no confidence)</SelectItem>
                    <SelectItem value="missing_source_evidence">Missing Source Evidence</SelectItem>
                    <SelectItem value="not_found">Not Found</SelectItem>
                    <SelectItem value="manual_required">Manual Required</SelectItem>
                    <SelectItem value="calculated">Calculated</SelectItem>
                    <SelectItem value="conflict_detected">Conflict Detected</SelectItem>
                    <SelectItem value="missing">Missing</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setEvRaw(evidence?.rawValue == null ? "" : String(evidence.rawValue));
                  setEvSourcePage(evidence?.sourcePage == null ? "" : String(evidence.sourcePage));
                  setEvSourceText(evidence?.sourceText == null ? "" : String(evidence.sourceText));
                  setEvConfidence(typeof confidence === "number" ? String(confidence) : "");
                  setEvExtractionStatus(evidence?.extractionStatus || inferredExtractionStatus || "");
                }}
                disabled={isSaving}
              >
                Reset
              </Button>
              <Button
                size="sm"
                className="bg-blue-600 hover:bg-blue-700"
                disabled={!onSaveEvidence || isSaving}
                onClick={() =>
                  onSaveEvidence && onSaveEvidence(field, {
                    raw_value: evRaw.trim() || null,
                    source_page: evSourcePage === "" ? null : Number(evSourcePage),
                    source_text: evSourceText.trim() || null,
                    confidence: evConfidence === "" ? null : Number(evConfidence),
                    extraction_status: evExtractionStatus || null,
                  })
                }
              >
                {isSaving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                Save Evidence
              </Button>
            </div>
          </section>

          <section className="grid gap-3 sm:grid-cols-2">
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

          <section className={`space-y-2 rounded-md border p-3 ${needsOverride ? "border-amber-300 bg-amber-50" : "border-slate-200 bg-slate-50"}`}>
            <div className="flex items-center justify-between gap-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-600">
                Reviewer Override / Note
              </p>
              {needsOverride && !hasStoredOverride && (
                <Badge className="bg-amber-100 text-[10px] text-amber-800">Required for approval</Badge>
              )}
              {hasStoredOverride && (
                <Badge className="bg-emerald-100 text-[10px] text-emerald-800">Override stored</Badge>
              )}
            </div>
            <Textarea
              placeholder={
                needsOverride
                  ? "Explain why this value is accepted without source evidence (e.g. confirmed verbally with tenant, reviewed in source PDF page 3)…"
                  : "Optional reviewer note for this field…"
              }
              rows={3}
              value={overrideReason}
              onChange={(e) => setOverrideReason(e.target.value)}
              disabled={!onSaveOverrideReason || isSaving}
            />
            <div className="flex items-center justify-end gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setOverrideReason(typeof review?.note === "string" ? review.note : "")}
                disabled={isSaving}
              >
                Reset
              </Button>
              <Button
                size="sm"
                className="bg-blue-600 hover:bg-blue-700"
                onClick={() => onSaveOverrideReason && onSaveOverrideReason(field, overrideReason)}
                disabled={!onSaveOverrideReason || isSaving || overrideReason === (review?.note || "")}
              >
                {isSaving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                Save Reason
              </Button>
            </div>
            {needsOverride && (
              <p className="text-[11px] text-amber-700">
                This required field has no extracted source page/text. Either provide an override reason here, or
                Edit and re-confirm to attach evidence — otherwise approval stays blocked.
              </p>
            )}
          </section>
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
                onClick={async () => {
                  // If the reviewer typed value/evidence in the form but
                  // hasn't clicked Save edit yet, persist that first so
                  // the Accept gate sees fresh evidence. handleSave runs
                  // through onSaveEdit which now bundles evidence too.
                  if (mode === "edit") {
                    try { await handleSave(); }
                    catch (err) { console.warn("[FieldDetailDrawer] save-before-accept failed:", err); return; }
                  }
                  await onAccept(field);
                }}
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

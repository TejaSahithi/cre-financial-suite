import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  ChevronDown,
  Check,
  CheckCircle2,
  ExternalLink,
  FileText,
  FileX,
  Gavel,
  HelpCircle,
  Loader2,
  MinusCircle,
  Pencil,
  RefreshCw,
  Send,
  Undo2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { leaseService } from "@/services/leaseService";
import { NotificationService, createEntityService } from "@/services/api";
import { expenseService } from "@/services/expenseService";
import useOrgQuery from "@/hooks/useOrgQuery";
import { useComputeTrigger } from "@/hooks/useComputeTrigger";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SelectWithCustom } from "@/components/ui/select-with-custom";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  LEASE_FIELD_OPTIONS,
  getLeaseFieldLabel,
  hasLeaseFieldOptions,
} from "@/lib/leaseFieldOptions";
import {
  LEASE_REVIEW_TABS,
  FIELDS_BY_TAB,
  LEASE_REVIEW_FIELDS,
  REQUIRED_FIELD_KEYS,
  REVIEW_STATUSES,
  REVIEW_STATUS_LABELS,
  REVIEW_STATUS_STYLES,
  NUMERIC_REVIEW_FIELDS,
  readFieldValue,
  readFieldEvidence,
  readFieldConfidence,
  isResolvedReview,
  classifyConfidence,
  resolveFieldColumns,
  hasEvidenceOverride,
} from "@/lib/leaseReviewSchema";
import { createPageUrl } from "@/utils";
import { invokeEdgeFunction } from "@/services/edgeFunctions";
import { supabase } from "@/services/supabaseClient";
import {
  approveLeaseAbstract,
  saveAbstractDraft,
  rejectLeaseAbstract,
} from "@/services/leaseAbstractService";
import { logAudit } from "@/services/audit";
import { leaseExpenseRuleService } from "@/services/leaseExpenseRuleService";
import FieldReviewTable from "@/components/lease-review/FieldReviewTable";
import FieldDetailDrawer from "@/components/lease-review/FieldDetailDrawer";
import {
  RentScheduleTable,
  ExpenseRulesTable,
  CamRulesTable,
  CriticalDatesTable,
  ClauseRecordsTable,
} from "@/components/lease-review/SpecializedTables";
import ExtractionDebugPanel from "@/components/lease-review/ExtractionDebugPanel";

const documentService = createEntityService("Document");

const confidenceColor = (score) => {
  const bucket = classifyConfidence(score);
  if (bucket === "high") return "bg-emerald-100 text-emerald-700";
  if (bucket === "medium") return "bg-amber-100 text-amber-700";
  if (bucket === "low") return "bg-red-100 text-red-700";
  return "bg-slate-100 text-slate-500";
};

// ── Text-matching evidence synthesizer ──────────────────────────────────
// Given a docling-shaped object ({text_blocks, full_text}) and a field
// value, find the verbatim snippet in the document and return
// { raw, text, page }. Lets us populate Raw / Page / Source Text even when
// the original extractor stamped no evidence on the field.

function buildSearchBlocks(docling) {
  const blocks = [];
  const raw = Array.isArray(docling?.text_blocks) ? docling.text_blocks : [];
  for (const block of raw) {
    const text = String(block?.text ?? "").trim();
    if (!text) continue;
    blocks.push({
      text,
      lowered: text.toLowerCase(),
      page: Number.isFinite(Number(block?.page)) ? Number(block.page) : null,
    });
  }
  // Add full_text as a fallback block with unknown page so single-page
  // documents still resolve.
  if (docling?.full_text && blocks.length === 0) {
    blocks.push({
      text: String(docling.full_text),
      lowered: String(docling.full_text).toLowerCase(),
      page: null,
    });
  }
  return blocks;
}

// Generic / sentinel values that produce false matches if we text-search
// for them anywhere in the document. The extractor sometimes stores these
// as a literal string when it couldn't read the field — they should not
// generate evidence.
const JUNK_NEEDLE_VALUES = new Set([
  "unknown", "n/a", "na", "none", "null", "tbd", "not specified",
  "not applicable", "see lease", "as set forth", "per lease",
  // Internal/category-key shaped strings the workflow sometimes leaks.
  "renewal_options", "tax_responsibility", "insurance_responsibility",
  "maintenance_responsibility", "utilities_responsibility",
  "hvac", "cam", "nnn", "gross", "full_service", "modified_gross",
]);

function isJunkNeedle(text) {
  if (!text) return true;
  const lowered = String(text).trim().toLowerCase();
  if (lowered.length < 4) return true;             // single words / 3-char tokens match too broadly
  if (JUNK_NEEDLE_VALUES.has(lowered)) return true;
  // category-key shape: lowercase + underscores, no spaces, no digits
  if (/^[a-z]+(?:_[a-z]+)+$/.test(lowered)) return true;
  // pure number under 4 digits (matches in too many places — page numbers, list indices)
  if (/^\d{1,3}$/.test(lowered)) return true;
  return false;
}

// Normalize a value for matching: lowercase, currency stripped, common
// punctuation removed. Produces a set of candidate needles to try, with
// junk filtered out.
function candidateNeedles(value, field) {
  const needles = [];
  const push = (s) => {
    const t = String(s ?? "").trim();
    if (!t) return;
    if (isJunkNeedle(t)) return;
    if (!needles.includes(t)) needles.push(t);
  };
  const asString = String(value ?? "").trim();
  if (!asString) return needles;
  if (isJunkNeedle(asString)) return needles;
  push(asString);

  // Currency / numeric: try with and without thousands separators, with $.
  if (field?.type === "currency" || field?.type === "number") {
    const num = Number(String(value).replace(/[$,%\s,]/g, ""));
    if (Number.isFinite(num) && num >= 1000) {
      // Skip small numbers — they match too broadly (page numbers, "Unit 5", etc.)
      push(num.toString());
      push(num.toLocaleString("en-US"));
      push(`$${num.toLocaleString("en-US")}`);
      push(`$${num.toFixed(2)}`);
      push(`${num.toLocaleString("en-US")}.00`);
    }
  }

  // Dates: try several human formats around an ISO date.
  if (field?.type === "date" && /^\d{4}-\d{2}-\d{2}$/.test(asString)) {
    const d = new Date(`${asString}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) {
      const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
      const monthsShort = months.map((m) => m.slice(0, 3));
      const y = d.getUTCFullYear();
      const m1 = d.getUTCMonth();
      const day = d.getUTCDate();
      push(`${months[m1]} ${day}, ${y}`);
      push(`${monthsShort[m1]} ${day}, ${y}`);
      push(`${m1 + 1}/${day}/${y}`);
      push(`${String(m1 + 1).padStart(2, "0")}/${String(day).padStart(2, "0")}/${y}`);
    }
  }

  // Entity names: try without trailing punctuation.
  if (field?.type === "text" || field?.type === undefined) {
    push(asString.replace(/[,.]+$/, ""));
  }
  return needles;
}

function findEvidenceForValue(blocks, value, field) {
  const needles = candidateNeedles(value, field);
  if (needles.length === 0) return null;
  for (const needle of needles) {
    const loweredNeedle = needle.toLowerCase();
    for (const block of blocks) {
      const hit = block.lowered.indexOf(loweredNeedle);
      if (hit < 0) continue;
      // Require a word-boundary on at least one side so "1110" doesn't match
      // inside "11102025" or a page footer like "Page 1110".
      const before = hit === 0 ? "" : block.lowered[hit - 1];
      const after = block.lowered[hit + loweredNeedle.length] || "";
      const isWordChar = (c) => /[a-z0-9]/.test(c);
      if (isWordChar(before) && isWordChar(after)) continue;
      // Pull a ~160-char window centered on the match.
      const start = Math.max(0, hit - 60);
      const end = Math.min(block.text.length, hit + needle.length + 100);
      const snippet = block.text.slice(start, end).replace(/\s+/g, " ").trim();
      return {
        raw: block.text.slice(hit, hit + needle.length),
        text: snippet,
        page: block.page,
      };
    }
  }
  return null;
}

// Detect numeric conflicts between extracted source and stored value
// (e.g. monthly_rent vs annual_rent / 12). Returns an array of human
// strings describing each conflict — empty array means no conflict.
function detectFieldConflicts(lease) {
  const conflicts = [];
  const monthly = Number(lease?.monthly_rent || 0);
  const annual = Number(lease?.annual_rent || 0);
  if (monthly > 0 && annual > 0) {
    const expectedAnnual = monthly * 12;
    if (Math.abs(expectedAnnual - annual) / Math.max(expectedAnnual, annual) > 0.05) {
      conflicts.push({
        field_key: "monthly_rent",
        label: "Monthly Rent × 12 ≠ Annual Rent",
        detail: `${monthly.toLocaleString()} × 12 = ${expectedAnnual.toLocaleString()} vs annual ${annual.toLocaleString()}`,
      });
    }
  }
  const start = lease?.commencement_date || lease?.start_date;
  const end = lease?.expiration_date || lease?.end_date;
  if (start && end && new Date(start) >= new Date(end)) {
    conflicts.push({
      field_key: "commencement_date",
      label: "Commencement date is on or after expiration",
      detail: `${start} → ${end}`,
    });
  }
  const leaseDate = lease?.lease_date;
  if (leaseDate && start && new Date(leaseDate) > new Date(start)) {
    conflicts.push({
      field_key: "lease_date",
      label: "Lease signed after commencement",
      detail: `signed ${leaseDate}, commences ${start}`,
    });
  }
  // Commencement equals the lease-signing date — almost always means the
  // extractor put the signing date into start_date by mistake. Real CRE
  // leases rarely start the day they're signed.
  if (leaseDate && start && new Date(leaseDate).toDateString() === new Date(start).toDateString()) {
    conflicts.push({
      field_key: "commencement_date",
      label: "Commencement date equals lease signing date",
      detail: `Likely extractor copied the signing date (${leaseDate}) into start_date — verify the actual commencement.`,
    });
  }
  // Term shorter than 30 days — usually means end_date got the wrong year
  // (e.g. "January 31" was assumed to be the same year as the start).
  if (start && end) {
    const startMs = new Date(start).getTime();
    const endMs = new Date(end).getTime();
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
      const days = Math.round((endMs - startMs) / 86400000);
      if (days < 30) {
        conflicts.push({
          field_key: "expiration_date",
          label: `Lease term is only ${days} day(s)`,
          detail: `${start} → ${end} is suspiciously short. The expiration date may have been extracted with the wrong year (commonly +1 year off).`,
        });
      }
    }
  }
  return conflicts;
}

export default function LeaseReview() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const urlParams = new URLSearchParams(location.search);
  const leaseId = urlParams.get("id");

  const { trigger: triggerCompute } = useComputeTrigger();

  // UI state
  const [activeTab, setActiveTab] = useState("summary");
  const [editingField, setEditingField] = useState(null);
  const [editValue, setEditValue] = useState("");
  const [showSignature, setShowSignature] = useState(false);
  const [showApproval, setShowApproval] = useState(false);
  const [showReject, setShowReject] = useState(false);
  const [showSendBack, setShowSendBack] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [approving, setApproving] = useState(false);
  const [reextracting, setReextracting] = useState(false);
  const [reextractStage, setReextractStage] = useState(""); // "running" | "polling" | "applying"
  const [showReextractConfirm, setShowReextractConfirm] = useState(false);

  // Approval form
  const [approvalSignedBy, setApprovalSignedBy] = useState("");
  const [approvalSignedAt, setApprovalSignedAt] = useState("");
  const [approvalComments, setApprovalComments] = useState("");
  const [approvalDocumentUrl, setApprovalDocumentUrl] = useState("");

  // Reject / send-back form
  const [rejectReason, setRejectReason] = useState("");
  const [sendBackReason, setSendBackReason] = useState("");

  // Signature dialog
  const [signatureRecipientId, setSignatureRecipientId] = useState("");
  const [signatureMessage, setSignatureMessage] = useState("");
  const [sendingSignature, setSendingSignature] = useState(false);

  // Field review state — keyed by field key.
  const [fieldReviews, setFieldReviews] = useState({});

  // Field detail drawer state. drawerMode lets the dropdown's "Edit" item
  // open the drawer already in edit mode (otherwise the user has to click
  // Edit a second time inside the drawer).
  const [drawerField, setDrawerField] = useState(null);
  const [drawerMode, setDrawerMode] = useState("view");
  const drawerReview = drawerField ? fieldReviews[drawerField.key] : null;
  const openDrawer = (field, mode = "view") => {
    setDrawerMode(mode);
    setDrawerField(field);
  };

  // Lease query
  const { data: lease, isLoading } = useQuery({
    queryKey: ["lease", leaseId],
    queryFn: () => leaseService.filter({ id: leaseId }),
    enabled: !!leaseId,
    select: (data) => data?.[0],
  });

  // Hydrate field reviews from the lease record when it loads. Prefer the
  // dedicated lease_field_reviews table (queryable audit trail); fall back
  // to extraction_data.field_reviews for older records.
  //
  // We hydrate ONCE per lease id. Subsequent refetches (triggered by
  // saveAbstractDraft, mutation invalidations, auto-extract, etc.) must NOT
  // overwrite local state — otherwise an Accept the user just clicked would
  // get wiped when the lease object re-renders before the DB upsert lands.
  // After the first hydration the local fieldReviews state is the source of
  // truth until the user reloads the page.
  const hydratedReviewsForLeaseId = useRef(null);
  useEffect(() => {
    if (!lease?.id) return;
    if (hydratedReviewsForLeaseId.current === lease.id) return;
    hydratedReviewsForLeaseId.current = lease.id;
    let cancelled = false;
    (async () => {
      let nextReviews = lease.extraction_data?.field_reviews || {};
      if (supabase && lease.id) {
        try {
          const { data, error } = await supabase
            .from("lease_field_reviews")
            .select("field_key, status, normalized_value, note, reviewer, reviewed_at")
            .eq("lease_id", lease.id);
          if (!error && Array.isArray(data) && data.length > 0) {
            const merged = { ...nextReviews };
            for (const row of data) {
              merged[row.field_key] = {
                status: row.status,
                value: row.normalized_value,
                note: row.note,
                reviewer: row.reviewer,
                reviewed_at: row.reviewed_at,
              };
            }
            nextReviews = merged;
          }
        } catch (err) {
          console.warn("[LeaseReview] load reviews skipped:", err?.message || err);
        }
      }
      if (!cancelled) setFieldReviews(nextReviews);
    })();
    return () => {
      cancelled = true;
    };
  }, [lease?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-link: when a lease has no source_file_id, search uploaded_files
  // for a matching upload by tenant_name / property_id / building_id /
  // unit_id and link it automatically. Also keeps the ranked candidate
  // list around so the banner can show a picker if no candidate clears
  // the score threshold.
  const [linkCandidates, setLinkCandidates] = useState([]); // [{id, file_name, score, status}]
  const [autoLinkDebug, setAutoLinkDebug] = useState(null); // { query_count, tenant, found, top_score }
  useEffect(() => {
    if (!lease?.id || !supabase) return;
    if (lease.extraction_data?.source_file_id) {
      setLinkCandidates([]);
      setAutoLinkDebug(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        // Cast a wide net — every module_type, broad status filter.
        // Older uploads may have module_type='lease' (singular), or null.
        const { data: files, error } = await supabase
          .from("uploaded_files")
          .select("id, file_name, property_id, building_id, unit_id, ui_review_payload, status, module_type, updated_at")
          .eq("org_id", lease.org_id)
          .order("updated_at", { ascending: false })
          .limit(60);
        if (cancelled) return;
        if (error) {
          console.warn("[LeaseReview] auto-link query failed:", error.message);
          setAutoLinkDebug({ query_count: 0, error: error.message });
          return;
        }
        // Prefer lease uploads but don't exclude others outright — the
        // module_type column has been inconsistent across the codebase.
        const leaseLike = (files || []).filter((f) => {
          const mod = String(f.module_type || "").toLowerCase();
          if (!mod) return true; // unknown module → include
          return mod === "leases" || mod === "lease";
        });

        const norm = (s) => String(s ?? "").trim().toLowerCase();
        const tenant = norm(lease.tenant_name);

        const score = (file) => {
          let s = 0;
          let reasons = [];
          if (lease.unit_id && file.unit_id === lease.unit_id) { s += 4; reasons.push("unit"); }
          if (lease.building_id && file.building_id === lease.building_id) { s += 2; reasons.push("building"); }
          if (lease.property_id && file.property_id === lease.property_id) { s += 2; reasons.push("property"); }
          if (tenant) {
            const records = file?.ui_review_payload?.records || file?.ui_review_payload?.rows || [];
            const fileTenants = records.flatMap((r) => {
              const std = r?.standard_fields || [];
              const fromStd = std.find((f) => f?.field_key === "tenant_name")?.value;
              const fromVals = r?.values?.tenant_name;
              return [fromStd, fromVals].filter(Boolean).map(norm);
            });
            if (fileTenants.some((t) => t === tenant || (t && tenant.includes(t)) || (t && t.includes(tenant)))) {
              s += 5;
              reasons.push("tenant_payload");
            }
            const fileNameLower = norm(file.file_name);
            if (tenant.split(/\s+/).some((token) => token.length >= 4 && fileNameLower.includes(token))) {
              s += 2;
              reasons.push("tenant_in_filename");
            }
          }
          return { s, reasons };
        };

        // Sort by score desc, then by updated_at desc — so ties between
        // re-uploads of the same file always put the freshest one first.
        const ranked = leaseLike
          .map((f) => {
            const { s, reasons } = score(f);
            return { file: f, score: s, reasons };
          })
          .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            const tb = new Date(b.file.updated_at || 0).getTime();
            const ta = new Date(a.file.updated_at || 0).getTime();
            return tb - ta;
          });

        const candidates = ranked.slice(0, 10).map((r) => ({
          id: r.file.id,
          file_name: r.file.file_name,
          score: r.score,
          status: r.file.status,
          updated_at: r.file.updated_at,
          reasons: r.reasons,
        }));
        if (!cancelled) setLinkCandidates(candidates);

        const dbg = {
          query_count: files?.length ?? 0,
          lease_like: leaseLike.length,
          tenant,
          top_score: candidates[0]?.score ?? 0,
          top_candidate: candidates[0]?.file_name ?? null,
        };
        if (!cancelled) setAutoLinkDebug(dbg);
        console.log("[LeaseReview] auto-link diagnostic:", dbg, "candidates:", candidates.slice(0, 5));

        // Decide whether to auto-link.
        //   - Score must clear the minimum (≥ 5)
        //   - Decisive if ANY of:
        //       a) Every tied-at-top candidate has the same normalized filename
        //          (re-uploads of the same document — not ambiguous)
        //       b) Top beats the runner-up of a DIFFERENT filename by ≥ 3 points
        //       c) Top score is very high (≥ 10) AND >= 2 of the tied candidates
        //          share the top's normalized filename — pick the most recent
        //          from that filename group regardless of unrelated ties
        const top = ranked[0];
        if (!top || top.score < 5 || cancelled) {
          console.log("[LeaseReview] auto-link: skip — no candidate clears minimum score (top:", top?.score, "min: 5)");
          return;
        }
        const normName = (n) => String(n || "").trim().toLowerCase().replace(/\s+/g, " ");
        const topName = normName(top.file.file_name);
        const tiedWithTop = ranked.filter((r) => r.score === top.score);
        const sameFileTies = tiedWithTop.filter((r) => normName(r.file.file_name) === topName);
        const allTiedSameFile = sameFileTies.length === tiedWithTop.length;
        const runnerUpDifferentFile = ranked
          .find((r) => normName(r.file.file_name) !== topName);
        const gapClear = !runnerUpDifferentFile
          || top.score - runnerUpDifferentFile.score >= 3;
        const highScoreSameFileMajority = top.score >= 10 && sameFileTies.length >= 2;
        const decisive = allTiedSameFile || gapClear || highScoreSameFileMajority;
        console.log("[LeaseReview] auto-link decision:", {
          top_score: top.score,
          tied_count: tiedWithTop.length,
          same_file_tied_count: sameFileTies.length,
          all_tied_same_file: allTiedSameFile,
          runner_up_different_file_score: runnerUpDifferentFile?.score ?? null,
          gap_clear: gapClear,
          high_score_same_file_majority: highScoreSameFileMajority,
          decisive,
        });
        if (!decisive) {
          console.log("[LeaseReview] auto-link: skip — no decisive winner. Top tied with different-named candidates; user must pick manually.");
          return;
        }

        // When multiple uploads tie at the top score and share the filename,
        // pick the most recent of that group (ranked sort already ordered
        // them updated_at desc within score). This avoids accidentally
        // linking a different-name candidate that happens to share the score.
        const chosen = (allTiedSameFile || highScoreSameFileMajority) ? sameFileTies[0] : top;

        const nextExtraction = {
          ...(lease.extraction_data || {}),
          source_file_id: chosen.file.id,
          source_file_name: chosen.file.file_name ?? null,
          auto_linked_at: new Date().toISOString(),
          auto_link_score: chosen.score,
          auto_link_reasons: chosen.reasons,
        };
        const { error: updateErr } = await supabase
          .from("leases")
          .update({ extraction_data: nextExtraction })
          .eq("id", lease.id);
        if (updateErr) {
          console.warn("[LeaseReview] auto-link write failed:", updateErr.message, updateErr.details || "");
          return;
        }
        console.log(`[LeaseReview] auto-linked lease ${lease.id} → uploaded_files ${chosen.file.id} (score=${chosen.score}, file=${chosen.file.file_name}, reasons=${chosen.reasons.join("+")})`);

        // Update the React-Query cache immediately so the page reflects the
        // new source_file_id without waiting for a refetch round-trip. The
        // invalidate still runs so server state is the source of truth.
        try {
          queryClient.setQueryData(["lease", leaseId], (prev) => {
            if (!prev) return prev;
            return { ...prev, extraction_data: nextExtraction };
          });
        } catch { /* setQueryData best-effort */ }
        queryClient.invalidateQueries({ queryKey: ["lease", leaseId] });
      } catch (err) {
        console.warn("[LeaseReview] auto-link skipped:", err?.message || err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [lease?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Manual link from the banner picker.
  const handleLinkSourceFile = async (fileId) => {
    if (!fileId || !lease?.id) return;
    try {
      const picked = linkCandidates.find((c) => c.id === fileId);
      const nextExtraction = {
        ...(lease.extraction_data || {}),
        source_file_id: fileId,
        source_file_name: picked?.file_name ?? null,
        manually_linked_at: new Date().toISOString(),
      };
      const { error: updateErr } = await supabase
        .from("leases")
        .update({ extraction_data: nextExtraction })
        .eq("id", lease.id);
      if (updateErr) throw updateErr;
      toast.success(`Linked to ${picked?.file_name || fileId}`);
      queryClient.invalidateQueries({ queryKey: ["lease", leaseId] });
    } catch (err) {
      console.error("[LeaseReview] manual link failed:", err);
      toast.error(err?.message || "Could not link source file");
    }
  };

  // Backfill evidence for legacy leases. If a lease has values but no
  // extraction_data.workflow_output / field_evidence (created via the older
  // review-approve path or the previous client fallback), reach back to the
  // source uploaded_files.ui_review_payload and persist the missing
  // workflow_output + fields-with-evidence + field_evidence shapes so the
  // table can render Raw / Page / Source Text / Confidence without a
  // re-extraction.
  useEffect(() => {
    if (!lease?.id || !supabase) return;
    const ed = lease.extraction_data || {};
    const evidenceMap = ed.field_evidence || {};
    const hasMeaningfulEvidence = Object.values(evidenceMap).some(
      (e) => e && (e.source_text || e.source_page || e.raw_value),
    );
    const hasWorkflowFields = Boolean(
      ed.workflow_output?.lease_fields
      || ed.workflow_output?.records?.[0]?.lease_fields,
    );
    const sourceFileId = ed.source_file_id;
    if ((hasMeaningfulEvidence || hasWorkflowFields) || !sourceFileId) return;

    let cancelled = false;
    (async () => {
      try {
        const { data: file, error } = await supabase
          .from("uploaded_files")
          .select("ui_review_payload, docling_raw, normalized_output, parsed_data")
          .eq("id", sourceFileId)
          .maybeSingle();
        if (error || !file || cancelled) return;

        // ── Step 1: pull whatever evidence the ui_review_payload already has.
        const fieldsWithEvidence = {};
        const fieldEvidence = {};
        const reviewedRow = (file.ui_review_payload?.records || file.ui_review_payload?.rows || [])[0];
        if (reviewedRow) {
          const allFields = [
            ...(reviewedRow.standard_fields || []),
            ...(reviewedRow.custom_fields || []),
          ];
          for (const field of allFields) {
            if (!field?.field_key) continue;
            fieldsWithEvidence[field.field_key] = {
              value: field.value ?? null,
              confidence: typeof field.confidence === "number" ? field.confidence : null,
              source: field.source ?? null,
              evidence: field.evidence ?? null,
              source_page: field.evidence?.page_number ?? null,
              source_text: field.evidence?.source_clause ?? field.evidence?.source_text ?? null,
              raw_value: field.original_value ?? field.evidence?.raw_value ?? null,
              extraction_status: field.status ?? null,
            };
            if (field.evidence) {
              fieldEvidence[field.field_key] = {
                raw_value: field.original_value ?? field.evidence.raw_value ?? null,
                source_page: field.evidence.page_number ?? field.evidence.source_page ?? null,
                source_text: field.evidence.source_clause ?? field.evidence.source_text ?? null,
                extraction_status: field.status ?? null,
              };
            }
          }
        }

        // ── Step 2: synthesize evidence by text-matching every known field
        // value against the docling text blocks. This is the fallback that
        // works even when the original extractor stamped no evidence at all.
        const docling = file.docling_raw || file.normalized_output || null;
        if (docling) {
          const blocks = buildSearchBlocks(docling);
          for (const field of LEASE_REVIEW_FIELDS) {
            const value = readFieldValue(lease, field.key);
            if (value == null || value === "") continue;
            // Don't overwrite real evidence we already have.
            const existing = fieldEvidence[field.key] || ed.field_evidence?.[field.key];
            if (existing?.source_text || existing?.raw_value) continue;
            const hit = findEvidenceForValue(blocks, value, field);
            if (!hit) continue;
            fieldEvidence[field.key] = {
              raw_value: hit.raw,
              source_page: hit.page,
              source_text: hit.text,
              extraction_status: "extracted_text_match",
            };
            fieldsWithEvidence[field.key] = {
              ...(fieldsWithEvidence[field.key] || {}),
              value,
              raw_value: hit.raw,
              source_page: hit.page,
              source_text: hit.text,
              extraction_status: "extracted_text_match",
            };
          }
        }

        const wf = file.ui_review_payload?.metadata?.workflow_output;
        const workflowOutput = Array.isArray(wf?.records) ? wf.records[0] : wf || null;

        if (Object.keys(fieldEvidence).length === 0 && !workflowOutput) {
          // Nothing to backfill — don't churn the row.
          return;
        }

        const nextExtraction = {
          ...ed,
          fields: { ...(ed.fields || {}), ...fieldsWithEvidence },
          field_evidence: { ...(ed.field_evidence || {}), ...fieldEvidence },
          ...(workflowOutput ? { workflow_output: workflowOutput } : {}),
          evidence_backfilled_at: new Date().toISOString(),
        };

        const { error: updateErr } = await supabase
          .from("leases")
          .update({ extraction_data: nextExtraction })
          .eq("id", lease.id);
        if (updateErr) {
          console.warn("[LeaseReview] evidence backfill update failed:", updateErr.message);
          return;
        }
        queryClient.invalidateQueries({ queryKey: ["lease", leaseId] });
      } catch (err) {
        console.warn("[LeaseReview] evidence backfill failed:", err?.message || err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [lease?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Mark related notifications as read.
  useEffect(() => {
    if (!leaseId) return;
    NotificationService.list()
      .then((notifs) => {
        const related = notifs.filter((n) => !n.is_read && n.link?.includes(leaseId));
        for (const n of related) {
          NotificationService.update(n.id, { is_read: true }).catch(() => {});
        }
      })
      .catch((err) => console.warn("[LeaseReview] notification clear failed:", err));
  }, [leaseId]);

  const { data: stakeholders = [] } = useOrgQuery("Stakeholder");

  // Lease expense rule set status + counts (drives the warning banner and
  // the Expense/CAM card on the summary tab). If the dedicated tables aren't
  // deployed yet (PGRST205), degrade silently with empty totals instead of
  // throwing — otherwise the approval flow sees an error toast for an
  // optional side feature.
  const { data: ruleSetSummary } = useQuery({
    queryKey: ["lease-expense-rule-summary", leaseId],
    enabled: !!leaseId,
    retry: false,
    queryFn: async () => {
      const EMPTY = { ruleSet: null, expense: { total: 0, approved: 0 }, cam: { total: 0, approved: 0 }, tableMissing: false };
      if (!supabase || !leaseId) return EMPTY;
      const { data: ruleSets, error } = await supabase
        .from("lease_expense_rule_sets")
        .select("id, status, approved_at, version")
        .eq("lease_id", leaseId)
        .neq("status", "archived")
        .order("version", { ascending: false })
        .limit(1);
      if (error) {
        if (error.code === "PGRST205" || error.code === "42P01" || /lease_expense_rule_sets/i.test(error.message || "")) {
          return { ...EMPTY, tableMissing: true };
        }
        throw error;
      }
      const ruleSet = ruleSets?.[0] || null;
      if (!ruleSet) return EMPTY;
      const { data: rules, error: rulesErr } = await supabase
        .from("lease_expense_rules")
        .select("id, row_status, mentioned_in_lease, is_recoverable, expense_category_id, gross_up_applicable, is_subject_to_cap, cap_type, admin_fee_applicable")
        .eq("rule_set_id", ruleSet.id);
      if (rulesErr && (rulesErr.code === "PGRST205" || rulesErr.code === "42P01")) {
        return { ruleSet, expense: { total: 0, approved: 0 }, cam: { total: 0, approved: 0 }, tableMissing: true };
      }
      const approvedSet = ruleSet.status === "approved";
      const totals = (rules || []).reduce(
        (acc, r) => {
          const status = String(r.row_status || "").toLowerCase();
          const isCam = Boolean(r.gross_up_applicable || r.is_subject_to_cap || r.cap_type || r.admin_fee_applicable);
          const isApproved = approvedSet && ["confirmed", "approved", "accepted"].includes(status);
          if (isCam) {
            acc.cam.total += 1;
            if (isApproved) acc.cam.approved += 1;
          } else {
            acc.expense.total += 1;
            if (isApproved) acc.expense.approved += 1;
          }
          return acc;
        },
        { expense: { total: 0, approved: 0 }, cam: { total: 0, approved: 0 } },
      );
      return { ruleSet, ...totals, tableMissing: false };
    },
  });
  const approvedRuleSet = ruleSetSummary?.ruleSet?.status === "approved" ? ruleSetSummary.ruleSet : null;

  const updateLeaseMutation = useMutation({
    mutationFn: async ({ id, data }) => leaseService.update(id, data),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: ["lease", leaseId] });
      queryClient.invalidateQueries({ queryKey: ["leases"] });
      if (updated?.property_id) {
        triggerCompute(
          "compute-lease",
          { property_id: updated.property_id, fiscal_year: new Date().getFullYear() },
          { silent: true },
        )
          .then(() => {
            queryClient.invalidateQueries({ queryKey: ["snapshot", "lease"] });
            queryClient.invalidateQueries({ queryKey: ["snapshot", "revenue"] });
          })
          .catch(() => {});
      }
    },
    onError: (err) => {
      console.error("[LeaseReview] update failed:", err);
      toast.error(`Update failed: ${err?.message ?? "Unknown error"}`);
    },
  });

  // Auto-run extraction the first time we land on a lease that has a source
  // file linked but no MEANINGFUL extracted data yet. "Meaningful" =
  // workflow_output present (the extractor actually ran) OR at least one
  // field key with a non-null value (real extraction, not a placeholder
  // shell from upload). A stale empty `fields: {}` object from a previous
  // failed attempt must NOT block auto-extraction — that was preventing
  // re-extract from firing on partially-initialized leases.
  const autoExtractFiredRef = useRef(null);
  useEffect(() => {
    if (!lease?.id) return;
    if (autoExtractFiredRef.current === lease.id) return;
    if (reextracting) return;
    const sourceFileId = lease?.extraction_data?.source_file_id;
    if (!sourceFileId) return;

    const hasWorkflow = !!lease?.extraction_data?.workflow_output;
    const hasMeaningfulField = (obj) => {
      if (!obj || typeof obj !== "object") return false;
      return Object.values(obj).some((v) => {
        if (v == null) return false;
        if (typeof v === "object") return v?.value != null && v.value !== "";
        return v !== "" && v !== "unknown" && v !== "n/a";
      });
    };
    const hasRealFields =
      hasMeaningfulField(lease?.extraction_data?.fields) ||
      hasMeaningfulField(lease?.extraction_data?.extracted_fields);
    if (hasWorkflow || hasRealFields) {
      console.log("[LeaseReview] auto-extract: skip — lease already has extraction data", {
        hasWorkflow,
        hasRealFields,
      });
      autoExtractFiredRef.current = lease.id;
      return;
    }
    autoExtractFiredRef.current = lease.id;
    console.log("[LeaseReview] auto-running re-extract — source linked but no extracted data yet");
    toast.info("Source file linked. Running extraction in the background…");
    handleReextractLease();
  }, [lease?.id, lease?.extraction_data?.source_file_id, lease?.extraction_data?.fields, lease?.extraction_data?.extracted_fields, lease?.extraction_data?.workflow_output, reextracting]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Early returns -------------------------------------------------------
  if (!leaseId) {
    return (
      <div className="flex h-96 flex-col items-center justify-center p-6">
        <FileX className="mb-4 h-12 w-12 text-slate-300" />
        <h2 className="mb-2 text-xl font-bold text-slate-900">No Lease Selected</h2>
        <p className="mb-4 text-sm text-slate-500">Select a lease from the Leases page to review.</p>
        <Link to={createPageUrl("Leases")}>
          <Button>Go to Leases</Button>
        </Link>
      </div>
    );
  }
  if (isLoading) {
    return (
      <div className="flex h-96 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
      </div>
    );
  }
  if (!lease) {
    return (
      <div className="flex h-96 flex-col items-center justify-center p-6">
        <FileX className="mb-4 h-12 w-12 text-slate-300" />
        <h2 className="mb-2 text-xl font-bold text-slate-900">Lease Not Found</h2>
        <p className="mb-4 text-sm text-slate-500">This lease may have been deleted or you don't have access.</p>
        <Link to={createPageUrl("Leases")}>
          <Button>Go to Leases</Button>
        </Link>
      </div>
    );
  }

  // --- Derived data --------------------------------------------------------
  const requiredReviewedKeys = REQUIRED_FIELD_KEYS.filter((k) => isResolvedReview(fieldReviews[k]));
  const requiredPendingKeys = REQUIRED_FIELD_KEYS.filter((k) => !isResolvedReview(fieldReviews[k]));
  const requiredResolved = requiredPendingKeys.length === 0;
  const totalFields = LEASE_REVIEW_FIELDS.length;
  const resolvedCount = LEASE_REVIEW_FIELDS.reduce(
    (acc, f) => acc + (isResolvedReview(fieldReviews[f.key]) ? 1 : 0),
    0,
  );

  // Confidence buckets from real extracted_fields confidence_score.
  const confidenceBuckets = LEASE_REVIEW_FIELDS.reduce(
    (acc, f) => {
      const value = readFieldValue(lease, f.key);
      if (value === null || value === undefined || value === "") return acc;
      const score = readFieldConfidence(lease, f.key);
      acc[classifyConfidence(score)] += 1;
      return acc;
    },
    { high: 0, medium: 0, low: 0, unknown: 0 },
  );

  // Manual_required + conflicts surface as their own counters.
  const manualRequiredCount = Object.values(fieldReviews).filter(
    (r) => r?.status === REVIEW_STATUSES.MANUAL_REQUIRED || r?.status === REVIEW_STATUSES.NEEDS_LEGAL,
  ).length;
  const conflicts = detectFieldConflicts(lease);

  // Validation checks (kept for summary panel).
  const validationChecks = [];
  const commencementValue = lease.commencement_date || lease.start_date;
  const expirationValue = lease.expiration_date || lease.end_date;
  if (commencementValue && expirationValue) {
    const startOk = new Date(commencementValue) < new Date(expirationValue);
    validationChecks.push({
      pass: startOk,
      label: "Commencement < Expiration",
      detail: startOk
        ? `${commencementValue} → ${expirationValue}`
        : "Expiration date is on/before commencement",
    });
  }
  if (lease.tenant_name) {
    validationChecks.push({ pass: true, label: "Tenant name present", detail: lease.tenant_name });
  }
  if (lease.annual_rent) {
    validationChecks.push({
      pass: lease.annual_rent > 0,
      label: "Annual rent > $0",
      detail: `$${Number(lease.annual_rent).toLocaleString()}`,
    });
  }
  const sf = lease.total_sf || lease.square_footage;
  if (sf) {
    validationChecks.push({
      pass: sf > 0,
      label: "Square footage present",
      detail: `${Number(sf).toLocaleString()} SF`,
    });
  }
  validationChecks.push({
    pass: confidenceBuckets.low === 0,
    label: "All confidence scores ≥ 75%",
    detail: confidenceBuckets.low === 0 ? "No low-confidence fields detected" : `${confidenceBuckets.low} low-confidence field(s)`,
  });
  validationChecks.push({
    pass: requiredResolved,
    label: "Required fields reviewed",
    detail: requiredResolved
      ? `All ${REQUIRED_FIELD_KEYS.length} required fields are resolved`
      : `${requiredPendingKeys.length} required field(s) pending review`,
  });
  validationChecks.push({
    pass: conflicts.length === 0,
    label: "No unresolved conflicts",
    detail: conflicts.length === 0 ? "No data conflicts detected" : `${conflicts.length} conflict(s) detected`,
  });
  const passCount = validationChecks.filter((v) => v.pass).length;

  const totalSf = lease.total_sf || lease.square_footage;

  const scopedStakeholders = stakeholders.filter(
    (s) => !s.property_id || !lease.property_id || s.property_id === lease.property_id,
  );
  const signatureRecipients = scopedStakeholders.filter((s) => s.email);

  // --- Approval blockers ---------------------------------------------------
  const expenseCamUnreviewed =
    ruleSetSummary &&
    ruleSetSummary.ruleSet &&
    (ruleSetSummary.expense.total + ruleSetSummary.cam.total) > 0 &&
    !approvedRuleSet;
  // Source-evidence gate. Two separate buckets:
  //  - pendingNoEvidence: required field, never reviewed, no docling/extractor
  //    evidence. Reviewer hasn't taken responsibility; would be auto-accepted
  //    silently without this gate.
  //  - acceptedNoEvidence: required field that IS marked accepted/edited but
  //    has no source page/text/raw — the reviewer eyeballed it but didn't
  //    record where the value came from. The screenshot bug. To approve, they
  //    must either (a) provide an override reason on the field, or (b) edit
  //    & re-confirm so evidence is set, or (c) mark Manual Required / N/A.
  const pendingNoEvidence = REQUIRED_FIELD_KEYS.filter((key) => {
    if (isResolvedReview(fieldReviews[key])) return false;
    const { sourcePage, sourceText, rawValue } = readFieldEvidence(lease, key);
    return !sourcePage && !sourceText && !rawValue;
  });
  const acceptedNoEvidence = REQUIRED_FIELD_KEYS.filter((key) => {
    const review = fieldReviews[key];
    if (!review) return false;
    const status = review.status;
    // N/A and Manual Required are intentional decisions — no evidence required.
    if (status === REVIEW_STATUSES.N_A || status === REVIEW_STATUSES.MANUAL_REQUIRED) return false;
    if (!isResolvedReview(review)) return false;
    if (hasEvidenceOverride(review)) return false;
    const { sourcePage, sourceText, rawValue } = readFieldEvidence(lease, key);
    return !sourcePage && !sourceText && !rawValue;
  });

  const approvalBlockers = [];
  if (requiredPendingKeys.length > 0) {
    approvalBlockers.push({
      kind: "required_pending",
      title: `${requiredPendingKeys.length} required field(s) pending review`,
      detail: requiredPendingKeys
        .map((k) => LEASE_REVIEW_FIELDS.find((f) => f.key === k)?.label || k)
        .join(", "),
    });
  }
  if (conflicts.length > 0) {
    approvalBlockers.push({
      kind: "conflicts",
      title: `${conflicts.length} unresolved conflict(s)`,
      detail: conflicts.map((c) => c.label).join(" • "),
    });
  }
  if (expenseCamUnreviewed) {
    approvalBlockers.push({
      kind: "expense_cam",
      title: "Expense / CAM rules not approved",
      detail: `${ruleSetSummary.expense.total} expense rules, ${ruleSetSummary.cam.total} CAM rules awaiting approval`,
    });
  }
  if (pendingNoEvidence.length > 0) {
    approvalBlockers.push({
      kind: "pending_no_evidence",
      title: `${pendingNoEvidence.length} required field(s) pending without source evidence`,
      detail: pendingNoEvidence
        .map((k) => LEASE_REVIEW_FIELDS.find((f) => f.key === k)?.label || k)
        .join(", "),
    });
  }
  if (acceptedNoEvidence.length > 0) {
    approvalBlockers.push({
      kind: "accepted_no_evidence",
      title: `${acceptedNoEvidence.length} accepted required field(s) lack source evidence — provide override reason`,
      detail: acceptedNoEvidence
        .map((k) => LEASE_REVIEW_FIELDS.find((f) => f.key === k)?.label || k)
        .join(", "),
    });
  }
  const canApprove = approvalBlockers.length === 0;
  const blockerMessage = canApprove
    ? "All checks passed. You can approve the lease abstract."
    : approvalBlockers.map((b) => b.title).join(" • ");
  const approvalDisabledTooltip = canApprove
    ? "Approve the lease abstract"
    : "Cannot approve: required fields are pending, conflicts exist, or required fields lack source evidence (provide an override reason in the field detail drawer).";

  // --- Field-action helpers -----------------------------------------------

  // Persist a field review change to the backend (saveAbstractDraft writes
  // both the JSONB shape AND lease_field_reviews) and write an audit log
  // entry. UI updates optimistically; on error the local state is reverted.
  const persistFieldAction = async ({ field, status, value, previousReview, note }) => {
    const next = {
      ...fieldReviews,
      [field.key]: {
        ...(fieldReviews[field.key] || {}),
        status,
        ...(value !== undefined ? { value } : {}),
        ...(note !== undefined ? { note } : {}),
        reviewed_at: new Date().toISOString(),
      },
    };
    setFieldReviews(next);
    try {
      await saveAbstractDraft({ lease, fieldReviews: next, reviewer: lease?.signed_by || null });
      await logAudit({
        entityType: "LeaseFieldReview",
        entityId: lease.id,
        action: status === REVIEW_STATUSES.EDITED ? "field_edit" : `field_${status}`,
        orgId: lease.org_id,
        fieldChanged: field.key,
        oldValue: previousReview ? previousReview.value ?? previousReview.status : null,
        newValue: value !== undefined ? value : status,
        propertyId: lease.property_id || null,
      });
    } catch (err) {
      console.error("[LeaseReview] persistFieldAction failed:", err);
      toast.error(err?.message || "Could not save review action");
      // revert
      setFieldReviews(fieldReviews);
    }
  };

  const handleAccept = (field) => {
    // Refuse auto-accept when there's no source evidence — the reviewer must
    // either Edit + confirm, mark Manual Required, or mark N/A.
    const value = readFieldValue(lease, field.key);
    const { sourcePage, sourceText } = readFieldEvidence(lease, field.key);
    const hasEvidence = sourcePage != null || (typeof sourceText === "string" && sourceText.length > 0);
    if (value == null || value === "") {
      toast.error("Cannot accept a field with no value. Edit, mark N/A, or mark Manual Required.");
      return;
    }
    if (!hasEvidence) {
      toast.error("Cannot accept without source evidence. Edit and confirm the value, or mark Manual Required.");
      return;
    }
    return persistFieldAction({
      field,
      status: REVIEW_STATUSES.ACCEPTED,
      previousReview: fieldReviews[field.key],
    });
  };
  const handleReject = (field) =>
    persistFieldAction({
      field,
      status: REVIEW_STATUSES.REJECTED,
      previousReview: fieldReviews[field.key],
    });
  const handleMarkNA = (field) =>
    persistFieldAction({
      field,
      status: REVIEW_STATUSES.N_A,
      previousReview: fieldReviews[field.key],
    });
  const handleNeedsLegal = (field) =>
    persistFieldAction({
      field,
      status: REVIEW_STATUSES.NEEDS_LEGAL,
      previousReview: fieldReviews[field.key],
    });
  const handleMarkManualRequired = (field) =>
    persistFieldAction({
      field,
      status: REVIEW_STATUSES.MANUAL_REQUIRED,
      previousReview: fieldReviews[field.key],
    });
  const handleResetField = async (field) => {
    const previousReview = fieldReviews[field.key];
    const next = { ...fieldReviews };
    delete next[field.key];
    setFieldReviews(next);
    try {
      await saveAbstractDraft({ lease, fieldReviews: next, reviewer: lease?.signed_by || null });
      if (supabase) {
        await supabase
          .from("lease_field_reviews")
          .delete()
          .eq("lease_id", lease.id)
          .eq("field_key", field.key);
      }
      await logAudit({
        entityType: "LeaseFieldReview",
        entityId: lease.id,
        action: "field_reset",
        orgId: lease.org_id,
        fieldChanged: field.key,
        oldValue: previousReview?.status || null,
        newValue: null,
      });
    } catch (err) {
      console.error("[LeaseReview] reset failed:", err);
      toast.error(err?.message || "Could not reset review");
      setFieldReviews(fieldReviews);
    }
  };

  const openEdit = (field) => {
    setEditingField(field);
    const current = readFieldValue(lease, field.key);
    setEditValue(current == null ? "" : String(current));
  };

  const handleFieldSave = async () => {
    if (!editingField) return;
    const key = editingField.key;
    let val = typeof editValue === "string" ? editValue.trim() : editValue;
    if (NUMERIC_REVIEW_FIELDS.has(key)) {
      const n = parseFloat(String(val).replace(/[$,]/g, ""));
      val = Number.isNaN(n) ? null : n;
    }
    if (editingField.type === "boolean") {
      val = val === true || val === "true" || val === "yes";
    }

    // Write to every aliased column so legacy + new columns stay in sync.
    const columnUpdates = {};
    for (const column of resolveFieldColumns(key)) {
      columnUpdates[column] = val;
    }
    // total_sf alias → square_footage column (legacy).
    if (key === "total_sf") columnUpdates.square_footage = val;

    const previousValue = readFieldValue(lease, key);

    try {
      const updatedLease = await updateLeaseMutation.mutateAsync({
        id: lease.id,
        data: {
          ...columnUpdates,
          extraction_data: {
            ...(lease.extraction_data || {}),
            fields: {
              ...(lease.extraction_data?.fields || {}),
              [key]: { value: val, manually_edited: true, edited_at: new Date().toISOString() },
            },
          },
        },
      });
      await persistFieldAction({
        field: editingField,
        status: REVIEW_STATUSES.EDITED,
        value: val,
        previousReview: { value: previousValue, status: fieldReviews[key]?.status },
      });

      toast.success(`Updated ${editingField.label}`);
      setEditingField(null);
    } catch {
      /* toasted */
    }
  };

  // --- Bottom action handlers ---------------------------------------------
  const handleSaveDraft = async () => {
    setSavingDraft(true);
    try {
      const updated = await saveAbstractDraft({
        lease,
        fieldReviews,
        reviewer: lease?.signed_by || null,
      });
      queryClient.invalidateQueries({ queryKey: ["lease", leaseId] });
      queryClient.invalidateQueries({ queryKey: ["leases"] });
      if (updated?.property_id) {
        triggerCompute(
          "compute-lease",
          { property_id: updated.property_id, fiscal_year: new Date().getFullYear() },
          { silent: true },
        ).catch(() => {});
      }
      toast.success("Review draft saved");
    } catch (err) {
      console.error("[LeaseReview] saveDraft failed:", err);
      toast.error(err?.message || "Could not save review draft");
    } finally {
      setSavingDraft(false);
    }
  };

  const handleApproveAbstract = async () => {
    if (!canApprove) {
      toast.error(blockerMessage);
      return;
    }
    if (!approvalSignedBy.trim()) {
      toast.error("Enter the signatory name before approving.");
      return;
    }
    if (!approvalSignedAt) {
      toast.error("Enter the signature date/time before approving.");
      return;
    }

    setApproving(true);
    try {
      let resolvedDocumentUrl = approvalDocumentUrl || null;
      if (!resolvedDocumentUrl && supabase) {
        const uploadedFile = await findUploadedFileForLease(lease);
        resolvedDocumentUrl = await resolveUploadedFileUrl(uploadedFile);
      }

      const approvedLease = await approveLeaseAbstract({
        lease,
        fieldReviews,
        approvedBy: approvalSignedBy,
        signedAt: approvalSignedAt,
        comments: approvalComments,
        documentUrl: resolvedDocumentUrl,
      });

      queryClient.setQueryData(["lease", leaseId], approvedLease);
      queryClient.invalidateQueries({ queryKey: ["lease", leaseId] });
      queryClient.invalidateQueries({ queryKey: ["leases"] });

      // Auto-resolve building_id / unit_id when the lease was uploaded
      // without them. Looks up buildings & units under the lease's property
      // and matches against extracted text (building_name, suite_number,
      // unit_number, premises_address). Format-agnostic — works whenever
      // the document mentions a recognizable suite or building label.
      try {
        if (
          supabase &&
          approvedLease?.id &&
          approvedLease?.property_id &&
          (!approvedLease.building_id || !approvedLease.unit_id)
        ) {
          const extractionData = approvedLease.extraction_data || {};
          const extractedFields = approvedLease.extracted_fields
            || extractionData.extracted_fields
            || extractionData.fields
            || {};
          const fieldVal = (key) => {
            const entry = extractedFields?.[key];
            if (entry == null) return null;
            if (typeof entry === "object") return entry.value ?? entry.raw_value ?? null;
            return entry;
          };
          const extractedBuildingName = String(
            fieldVal("building_name")
            ?? fieldVal("building")
            ?? approvedLease.building_name
            ?? "",
          ).trim();
          const extractedUnitText = String(
            fieldVal("unit_number")
            ?? fieldVal("suite_number")
            ?? fieldVal("suite")
            ?? approvedLease.unit_number
            ?? "",
          ).trim();
          const premisesAddress = String(
            fieldVal("premises_address")
            ?? fieldVal("property_address")
            ?? "",
          ).trim();

          const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

          const [{ data: candidateBuildings }, { data: candidateUnits }] = await Promise.all([
            supabase
              .from("buildings")
              .select("id, name, building_id_code, property_id")
              .eq("property_id", approvedLease.property_id),
            supabase
              .from("units")
              .select("id, unit_number, unit_id_code, building_id, property_id")
              .eq("property_id", approvedLease.property_id),
          ]);

          const updates = {};

          if (!approvedLease.building_id && (extractedBuildingName || premisesAddress) && candidateBuildings?.length) {
            const needles = [extractedBuildingName, premisesAddress].filter(Boolean).map(norm);
            const match = candidateBuildings.find((b) => {
              const haystack = [b.name, b.building_id_code].map(norm).filter(Boolean);
              return haystack.some((h) => needles.some((n) => n && (n.includes(h) || h.includes(n))));
            });
            if (match?.id) updates.building_id = match.id;
          }

          const buildingIdForUnit = updates.building_id || approvedLease.building_id || null;
          if (!approvedLease.unit_id && extractedUnitText && candidateUnits?.length) {
            const needle = norm(extractedUnitText);
            const scoped = buildingIdForUnit
              ? candidateUnits.filter((u) => u.building_id === buildingIdForUnit)
              : candidateUnits;
            const match = (scoped.length ? scoped : candidateUnits).find((u) => {
              const haystack = [u.unit_number, u.unit_id_code].map(norm).filter(Boolean);
              return haystack.some((h) => h && (h === needle || h.includes(needle) || needle.includes(h)));
            });
            if (match?.id) {
              updates.unit_id = match.id;
              if (!updates.building_id && match.building_id) updates.building_id = match.building_id;
            }
          }

          if (Object.keys(updates).length > 0) {
            const { error: linkErr } = await supabase
              .from("leases")
              .update(updates)
              .eq("id", approvedLease.id);
            if (linkErr) {
              console.warn("[LeaseReview] building/unit auto-link skipped:", linkErr.message);
            } else {
              Object.assign(approvedLease, updates);
              console.log("[LeaseReview] auto-linked building/unit:", updates);
              queryClient.invalidateQueries({ queryKey: ["leases"] });
            }
          }
        }
      } catch (linkErr) {
        console.warn("[LeaseReview] building/unit auto-link error:", linkErr?.message || linkErr);
      }

      // Auto-build rent projection snapshots for the surrounding fiscal
      // years (and both projection modes) so the Rent Projection page has
      // authoritative monthly_projections to render — without the user
      // having to click Run Engine. Done across:
      //   - current FY, current+1, current-1 (covers the most common views)
      //   - the FY that contains the lease commencement (term first year)
      //   - both contracted_only and include_approved_renewals modes
      if (approvedLease?.property_id) {
        const currentYear = new Date().getFullYear();
        // Parse any commencement/expiration format (ISO, US, "Feb 1, 2024",
        // Date objects). We want the FY spanned by the lease term so the
        // first/last year of the schedule are pre-computed for any document.
        const safeYear = (raw) => {
          if (!raw) return null;
          if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw.getFullYear();
          const s = String(raw).trim();
          const isoMatch = s.match(/^(\d{4})-\d{2}-\d{2}/);
          if (isoMatch) return Number(isoMatch[1]);
          const parsed = new Date(s);
          return Number.isNaN(parsed.getTime()) ? null : parsed.getFullYear();
        };
        const commencementYear = safeYear(
          approvedLease.commencement_date
          ?? approvedLease.start_date
          ?? approvedLease.lease_start_date
          ?? approvedLease.term_start_date,
        );
        const expirationYear = safeYear(
          approvedLease.expiration_date
          ?? approvedLease.end_date
          ?? approvedLease.lease_end_date
          ?? approvedLease.term_end_date,
        );
        const fiscalYears = Array.from(new Set([
          currentYear - 1,
          currentYear,
          currentYear + 1,
          ...(commencementYear ? [commencementYear, commencementYear + 1] : []),
          ...(expirationYear ? [expirationYear] : []),
        ])).filter((y) => Number.isFinite(y) && y > 1900 && y < 2100);
        const modes = ["contracted_only", "include_approved_renewals"];
        for (const fy of fiscalYears) {
          for (const mode of modes) {
            triggerCompute(
              "compute-lease",
              {
                property_id: approvedLease.property_id,
                building_id: approvedLease.building_id || undefined,
                unit_id: approvedLease.unit_id || undefined,
                fiscal_year: fy,
                projection_mode: mode,
              },
              { silent: true },
            ).catch(() => {});
          }
        }
        queryClient.invalidateQueries({ queryKey: ["snapshot", "lease"] });
      }

      // Auto-populate lease_critical_dates from the approved abstract.
      // Same shape the migration backfill uses, but for new approvals
      // going forward. Idempotent via ON CONFLICT (lease_id, date_type,
      // due_date). Failures degrade silently if the table isn't there.
      //
      // Format-agnostic: any date string ("2024-02-01", "02/01/2024",
      // "February 1, 2024", ISO with time, etc.) is coerced to YYYY-MM-DD.
      // Renewal notice accepts numeric days/months OR text like
      // "90 days" / "3 months" / "6-month notice". Falls back through
      // every known alias so leases from different document templates work.
      try {
        const toIsoDate = (value) => {
          if (!value) return null;
          if (value instanceof Date) {
            if (Number.isNaN(value.getTime())) return null;
            return value.toISOString().slice(0, 10);
          }
          const raw = String(value).trim();
          if (!raw) return null;
          // Already YYYY-MM-DD (with or without trailing time) — keep as-is.
          const isoMatch = raw.match(/^(\d{4}-\d{2}-\d{2})/);
          if (isoMatch) return isoMatch[1];
          // MM/DD/YYYY or M/D/YYYY → reorder.
          const usMatch = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
          if (usMatch) {
            const [, m, d, y] = usMatch;
            const yyyy = y.length === 2 ? (Number(y) > 50 ? `19${y}` : `20${y}`) : y;
            return `${yyyy}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
          }
          const parsed = new Date(raw);
          if (Number.isNaN(parsed.getTime())) return null;
          // Use UTC slice so timezone offset doesn't shift the date.
          return new Date(Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()))
            .toISOString()
            .slice(0, 10);
        };

        const toNoticeDays = (lease) => {
          // Numeric days first.
          for (const key of ["renewal_notice_days"]) {
            const v = Number(lease?.[key]);
            if (Number.isFinite(v) && v > 0) return v;
          }
          // Numeric months → days.
          for (const key of ["renewal_notice_months"]) {
            const v = Number(lease?.[key]);
            if (Number.isFinite(v) && v > 0) return Math.round(v * 30);
          }
          // Free-text fallback: "90 days", "3 months", "6-month notice".
          for (const key of ["renewal_notice_period", "renewal_notice", "notice_period"]) {
            const raw = String(lease?.[key] || "").toLowerCase();
            if (!raw) continue;
            const m = raw.match(/(\d+(?:\.\d+)?)\s*(day|month|year)/);
            if (!m) continue;
            const n = Number(m[1]);
            if (!Number.isFinite(n) || n <= 0) continue;
            if (m[2].startsWith("day")) return Math.round(n);
            if (m[2].startsWith("month")) return Math.round(n * 30);
            if (m[2].startsWith("year")) return Math.round(n * 365);
          }
          return null;
        };

        const commencement = toIsoDate(
          approvedLease.commencement_date
          ?? approvedLease.start_date
          ?? approvedLease.lease_start_date
          ?? approvedLease.term_start_date,
        );
        const expiration = toIsoDate(
          approvedLease.expiration_date
          ?? approvedLease.end_date
          ?? approvedLease.lease_end_date
          ?? approvedLease.term_end_date,
        );
        const optionDeadline = toIsoDate(
          approvedLease.option_exercise_deadline
          ?? approvedLease.renewal_exercise_deadline
          ?? approvedLease.option_deadline,
        );
        const rentCommencement = toIsoDate(approvedLease.rent_commencement_date);
        const renewalNoticeDays = toNoticeDays(approvedLease);

        const today = new Date().toISOString().slice(0, 10);
        const baseRow = {
          org_id: approvedLease.org_id,
          lease_id: approvedLease.id,
          property_id: approvedLease.property_id ?? null,
          source: "derived",
        };
        const rows = [];
        if (commencement) {
          rows.push({
            ...baseRow,
            date_type: "commencement",
            due_date: commencement,
            status: commencement <= today ? "completed" : "open",
          });
        }
        if (rentCommencement && rentCommencement !== commencement) {
          rows.push({
            ...baseRow,
            date_type: "rent_commencement",
            due_date: rentCommencement,
            status: rentCommencement <= today ? "completed" : "open",
          });
        }
        if (expiration) {
          rows.push({
            ...baseRow,
            date_type: "expiration",
            due_date: expiration,
            status: expiration < today ? "completed" : "open",
          });
          if (renewalNoticeDays && renewalNoticeDays > 0) {
            const expirationDate = new Date(`${expiration}T00:00:00Z`);
            expirationDate.setUTCDate(expirationDate.getUTCDate() - renewalNoticeDays);
            const noticeIso = expirationDate.toISOString().slice(0, 10);
            rows.push({
              ...baseRow,
              date_type: "renewal_notice",
              due_date: noticeIso,
              status: noticeIso < today ? "completed" : "open",
              reminder_days_before: 30,
            });
          }
        }
        if (optionDeadline) {
          rows.push({
            ...baseRow,
            date_type: "option_exercise",
            due_date: optionDeadline,
            status: optionDeadline < today ? "completed" : "open",
            reminder_days_before: 60,
          });
        }
        if (rows.length > 0 && supabase) {
          const { error: criticalErr } = await supabase
            .from("lease_critical_dates")
            .upsert(rows, { onConflict: "lease_id,date_type,due_date", ignoreDuplicates: true });
          if (criticalErr) {
            console.warn("[LeaseReview] lease_critical_dates upsert skipped:", criticalErr.message);
          } else {
            console.log(`[LeaseReview] inserted/refreshed ${rows.length} lease_critical_dates rows`);
            queryClient.invalidateQueries({ queryKey: ["lease_critical_dates"] });
          }
        }
      } catch (datesErr) {
        console.warn("[LeaseReview] critical dates auto-insert skipped:", datesErr?.message || datesErr);
      }

      // Persist expense rules from the workflow extractor — every lease that
      // mentions expense responsibility language should produce rules on
      // approval, even if no dollar amounts were extracted. This is the
      // authoritative source for the Lease Expense Rules page; without it
      // the page shows 0 rules after approval.
      //
      // We do two writes:
      //   1. persistExpenseRulesFromWorkflow with status="draft" — copies
      //      workflow_output.expense_rules into lease_expense_rules. Rules
      //      individually default to review_status="needs_review" per spec
      //      unless strong source evidence backs them.
      //   2. ensureApprovedRuleSet — promotes the rule_set status to
      //      "approved" so CAM/Budget queries can see it. Individual rule
      //      review_status is still governed by the strict policy above.
      let approvedExpenseRuleSet = null;
      try {
        const persisted = await leaseExpenseRuleService.persistExpenseRulesFromWorkflow({
          lease: approvedLease,
          status: "draft",
          createdFrom: "approval",
          approver: approvalSignedBy || null,
        });
        console.log(
          `[LeaseReview] persistExpenseRulesFromWorkflow → ${persisted?.rules?.length || 0} rules persisted`,
          { ruleSetId: persisted?.ruleSet?.id || null },
        );
      } catch (persistErr) {
        console.warn("[LeaseReview] persistExpenseRulesFromWorkflow skipped:", persistErr?.message || persistErr);
      }
      try {
        approvedExpenseRuleSet = await leaseExpenseRuleService.ensureApprovedRuleSet({ lease: approvedLease });
        console.log(
          `[LeaseReview] ensureApprovedRuleSet → ${approvedExpenseRuleSet?.rules?.length || 0} rules in approved set`,
          { ruleSetId: approvedExpenseRuleSet?.ruleSet?.id || null, status: approvedExpenseRuleSet?.ruleSet?.status },
        );
      } catch (ruleErr) {
        console.warn("[LeaseReview] approved expense rule publish skipped:", ruleErr?.message || ruleErr);
      }
      try {
        await expenseService.syncLeaseDerivedExpenses({ leases: [approvedLease] });
      } catch (syncErr) {
        console.warn("[LeaseReview] legacy lease-import cleanup skipped:", syncErr?.message || syncErr);
      }
      if (approvedExpenseRuleSet?.ruleSet?.id || approvedRuleSet?.id) {
        try {
          const propertyExpenses = await expenseService.filter({ property_id: approvedLease.property_id });
          await expenseService.classifyExpenses({ expenses: propertyExpenses, leases: [approvedLease] });
        } catch (classifyErr) {
          console.warn("[LeaseReview] expense classification skipped:", classifyErr?.message || classifyErr);
        }
      }
      queryClient.invalidateQueries({ queryKey: ["Expense"] });

      try {
        await documentService.create({
          org_id: lease.org_id,
          property_id: lease.property_id,
          lease_id: lease.id,
          type: "lease",
          name: `Lease — ${lease.tenant_name || "Unknown tenant"}`,
          status: "approved",
          signed_by: approvalSignedBy,
          signed_at: approvalSignedAt,
          comments: approvalComments,
          document_url: resolvedDocumentUrl,
        });
      } catch (docErr) {
        console.warn("[LeaseReview] Failed to save to documents:", docErr);
      }

      try {
        await NotificationService.create({
          org_id: lease.org_id,
          type: "lease_approved",
          title: "Lease Abstract Approved",
          message: `Lease abstract v${approvedLease.abstract_version || 1} for ${lease.tenant_name || "tenant"} approved. Signed by ${approvalSignedBy}.`,
          link: createPageUrl("LeaseReview", { id: lease.id }),
          priority: "normal",
        });
      } catch {
        /* non-fatal */
      }

      try {
        await logAudit({
          entityType: "Lease",
          entityId: lease.id,
          action: "lease_abstract_approved",
          orgId: lease.org_id,
          newValue: {
            abstract_version: approvedLease.abstract_version || 1,
            signed_by: approvalSignedBy,
            signed_at: approvalSignedAt,
          },
          propertyId: lease.property_id || null,
        });
      } catch (auditErr) {
        console.warn("[LeaseReview] approval audit log failed:", auditErr);
      }

      toast.success(`Lease abstract approved (v${approvedLease.abstract_version || 1})`);
      setShowApproval(false);
    } catch (err) {
      console.error("[LeaseReview] approve failed:", err);
      toast.error(err?.message || "Could not approve lease abstract");
    } finally {
      setApproving(false);
    }
  };

  const handleSendBack = async () => {
    try {
      await updateLeaseMutation.mutateAsync({
        id: lease.id,
        data: {
          status: "draft",
          extraction_data: {
            ...(lease.extraction_data || {}),
            send_back: {
              reason: sendBackReason,
              sent_back_at: new Date().toISOString(),
            },
          },
        },
      });
      toast.success("Sent back for re-extraction");
      setShowSendBack(false);
      const params = new URLSearchParams();
      if (lease.property_id) params.set("property", lease.property_id);
      if (lease.building_id) params.set("building", lease.building_id);
      if (lease.unit_id) params.set("unit", lease.unit_id);
      navigate(`${createPageUrl("LeaseUpload")}${params.toString() ? `?${params.toString()}` : ""}`);
    } catch {
      /* toasted */
    }
  };

  // One-click re-extract: invokes ingest-file → polls until processing
  // completes → copies the fresh ui_review_payload + workflow_output back
  // onto this lease. Saves the reviewer from the Re-link/Re-run/Apply Latest
  // dance for the common case where source_file_id is already set.
  async function handleReextractLease() {
    const sourceFileId = lease?.extraction_data?.source_file_id;
    if (!sourceFileId) {
      toast.error("No source file linked. Use Extraction Debug → Re-link Source Document first.");
      setShowReextractConfirm(false);
      return;
    }
    setReextracting(true);
    setReextractStage("running");
    setShowReextractConfirm(false);
    try {
      // 1. Trigger re-extraction
      console.log("[Re-extract] calling ingest-file", { source_file_id: sourceFileId });
      const ingestData = await invokeEdgeFunction("ingest-file", {
        file_id: sourceFileId,
        module_type: "leases",
        force_reextract: true,
      });
      console.log("[Re-extract] ingest-file response:", ingestData);
      if (ingestData?.error) throw new Error(ingestData?.message || "Re-extraction failed");

      // 2. Poll uploaded_files.status. With the expanded LEASE_GROUPS the
      // pipeline now makes ~9 Gemini calls so allow up to 3 minutes total.
      setReextractStage("polling");
      const ACTIVE_STATUSES = new Set([
        "uploaded", "parsing", "parsed", "pdf_parsed", "validating", "validated", "storing", "stored", "computing",
      ]);
      const MAX_POLLS = 90; // 90 × 2s = 3 minutes
      let attempts = 0;
      let latestFile = null;
      let lastStatus = "";
      while (attempts < MAX_POLLS) {
        await new Promise((r) => setTimeout(r, 2000));
        const { data: row, error } = await supabase
          .from("uploaded_files")
          .select("id, status, ui_review_payload, error_message, updated_at")
          .eq("id", sourceFileId)
          .maybeSingle();
        if (error) throw error;
        latestFile = row;
        const status = String(row?.status || "").toLowerCase();
        if (status !== lastStatus) {
          console.log(`[Re-extract] poll #${attempts + 1}: status="${status}"`);
          lastStatus = status;
        }
        if (status === "failed") {
          throw new Error(row?.error_message || "Source extraction failed");
        }
        if (status === "review_required" || status === "completed") break;
        if (!ACTIVE_STATUSES.has(status) && row?.ui_review_payload) break;
        attempts += 1;
      }
      // Even on timeout, apply whatever's in ui_review_payload right now —
      // partial extraction is better than nothing, and the user can see what
      // came through.
      if (attempts >= MAX_POLLS) {
        console.warn("[Re-extract] polling timed out after 3 minutes — applying partial result if any");
        toast.warning("Re-extraction is taking longer than expected. Applying whatever's available now; check Extraction Debug for full status.");
      }
      if (!latestFile?.ui_review_payload) {
        throw new Error("Re-extraction produced no review payload. Check the source file in Extraction Debug.");
      }

      // 3. Apply the new ui_review_payload to this lease (same shape the
      // Extraction Debug "Apply Latest" button uses).
      setReextractStage("applying");
      const reviewedRow = (latestFile?.ui_review_payload?.records || latestFile?.ui_review_payload?.rows || [])[0];
      const wf = latestFile?.ui_review_payload?.metadata?.workflow_output;
      const workflowOutput = Array.isArray(wf?.records) ? wf.records[0] : wf || null;

      // Diagnostic dump — shows exactly what the deployed pipeline returned
      // for each field. If a field appears here with value=null, that's the
      // extractor giving up on it (rule patterns missed + LLM returned null).
      // If it's missing from this dump entirely, the field isn't in the
      // pipeline's schema/groups.
      try {
        const stdFields = reviewedRow?.standard_fields || [];
        const wfFields = workflowOutput?.lease_fields || {};
        console.group("[Re-extract] Pipeline output");
        console.log("ui_review_payload.records count:", (latestFile?.ui_review_payload?.records || []).length);
        console.log("standard_fields count:", stdFields.length);
        console.log("workflow_output.lease_fields keys:", Object.keys(wfFields));
        console.log("workflow_output.expense_rules count:", workflowOutput?.expense_rules?.length || 0);
        console.log("workflow_output.lease_clauses count:", workflowOutput?.lease_clauses?.length || 0);
        const summary = stdFields.map((f) => ({
          field_key: f.field_key,
          value: f.value,
          source: f.source,
          confidence: f.confidence,
          status: f.status,
          source_page: f.evidence?.page_number ?? null,
          source_text: (f.evidence?.source_clause ?? f.evidence?.source_text ?? "")?.slice(0, 60),
        }));
        console.table(summary);
        // What's MISSING from the pipeline output (the most useful info)
        const expected = ["tenant_name","landlord_name","property_address","permitted_use","square_footage",
                          "monthly_rent","annual_rent","commencement_date","expiration_date","lease_type",
                          "security_deposit","responsibility_taxes","responsibility_insurance","responsibility_utilities"];
        const returnedKeys = new Set(stdFields.map((f) => f.field_key));
        const missing = expected.filter((k) => !returnedKeys.has(k));
        const nullValues = stdFields.filter((f) => expected.includes(f.field_key) && (f.value == null || f.value === "")).map((f) => f.field_key);
        if (missing.length) console.warn("Expected fields NOT in pipeline output (schema gap):", missing);
        if (nullValues.length) console.warn("Pipeline returned NULL for these expected fields (extractor missed them):", nullValues);
        console.groupEnd();
      } catch (logErr) {
        console.warn("[Re-extract] diag dump failed:", logErr);
      }

      const fieldsWithEvidence = {};
      const evidenceMap = {};
      const confidenceMap = {};
      if (reviewedRow) {
        const allFields = [
          ...(reviewedRow.standard_fields || []),
          ...(reviewedRow.custom_fields || []),
        ];
        for (const f of allFields) {
          if (!f?.field_key) continue;
          fieldsWithEvidence[f.field_key] = {
            value: f.value ?? null,
            confidence: typeof f.confidence === "number" ? f.confidence : null,
            source: f.source ?? null,
            source_page: f.evidence?.page_number ?? null,
            source_text: f.evidence?.source_clause ?? f.evidence?.source_text ?? null,
            raw_value: f.original_value ?? f.evidence?.raw_value ?? null,
            extraction_status: f.status ?? null,
          };
          evidenceMap[f.field_key] = {
            raw_value: f.original_value ?? f.evidence?.raw_value ?? null,
            source_page: f.evidence?.page_number ?? null,
            source_text: f.evidence?.source_clause ?? f.evidence?.source_text ?? null,
            extraction_status: f.status ?? null,
          };
          if (typeof f.confidence === "number") {
            confidenceMap[f.field_key] = f.confidence <= 1 ? Math.round(f.confidence * 100) : Math.round(f.confidence);
          }
        }
      }
      // Re-extract overrides prior data. Strip stale sentinel/junk evidence
      // (e.g. raw_value="unknown" or source_text="renewal_options") that the
      // old extractor or the old text-matching backfill stamped. Otherwise
      // missing fields in the new extraction would keep showing the old junk.
      const sentinelValues = new Set([
        "unknown", "n/a", "na", "none", "null", "tbd", "not specified",
        "renewal_options", "tax_responsibility", "insurance_responsibility",
        "maintenance_responsibility", "utilities_responsibility",
      ]);
      const isJunkSentinel = (s) => {
        if (s == null) return false;
        const t = String(s).trim().toLowerCase();
        return sentinelValues.has(t) || /^[a-z]+(?:_[a-z]+)+$/.test(t);
      };
      const prevFields = lease.extraction_data?.fields || {};
      const prevEvidence = lease.extraction_data?.field_evidence || {};
      const cleanedFields = {};
      const cleanedEvidence = {};
      for (const [key, val] of Object.entries(prevFields)) {
        if (!val || typeof val !== "object") continue;
        if (isJunkSentinel(val.raw_value) || isJunkSentinel(val.value) || isJunkSentinel(val.source_text)) continue;
        cleanedFields[key] = val;
      }
      for (const [key, val] of Object.entries(prevEvidence)) {
        if (!val || typeof val !== "object") continue;
        if (isJunkSentinel(val.raw_value) || isJunkSentinel(val.source_text)) continue;
        cleanedEvidence[key] = val;
      }

      const nextExtraction = {
        ...(lease.extraction_data || {}),
        fields: { ...cleanedFields, ...fieldsWithEvidence },
        field_evidence: { ...cleanedEvidence, ...evidenceMap },
        confidence_scores: { ...(lease.extraction_data?.confidence_scores || {}), ...confidenceMap },
        ...(workflowOutput ? { workflow_output: workflowOutput } : {}),
        evidence_refreshed_at: new Date().toISOString(),
      };
      const { error: updateErr } = await supabase
        .from("leases")
        .update({ extraction_data: nextExtraction })
        .eq("id", lease.id);
      if (updateErr) throw updateErr;

      await logAudit({
        entityType: "Lease",
        entityId: lease.id,
        action: "lease_reextracted",
        orgId: lease.org_id,
        propertyId: lease.property_id || null,
        newValue: {
          source_file_id: sourceFileId,
          refreshed_at: nextExtraction.evidence_refreshed_at,
          stripped_junk_fields: Object.keys(prevFields).length - Object.keys(cleanedFields).length,
        },
      });

      // Also extract expense/CAM rules from the same source text so the
      // Expenses/Recoveries and CAM Rules tabs populate without a separate
      // user trip to the LeaseExpenseClassification page.
      setReextractStage("extracting_rules");
      try {
        const { data: categories } = await supabase
          .from("expense_categories")
          .select("id, category_name, subcategory_name, normalized_key, expense_classification");
        const refreshedLease = { ...lease, extraction_data: nextExtraction };
        await leaseExpenseRuleService.extractDraftRuleSet({
          lease: refreshedLease,
          categories: categories || [],
        });
      } catch (ruleErr) {
        console.warn("[LeaseReview] expense rule extraction skipped:", ruleErr?.message || ruleErr);
      }

      toast.success("Lease re-extracted. Latest values, evidence, and expense rules applied.");
      queryClient.invalidateQueries({ queryKey: ["lease", leaseId] });
      queryClient.invalidateQueries({ queryKey: ["lease-expense-rule-summary", leaseId] });
      queryClient.invalidateQueries({ queryKey: ["lease-expense-rules-detail", leaseId] });
    } catch (err) {
      console.error("[LeaseReview] re-extract failed:", err);
      toast.error(err?.message || "Could not re-extract lease");
    } finally {
      setReextracting(false);
      setReextractStage("");
    }
  }

  const handleRejectDocument = async () => {
    if (!rejectReason.trim()) {
      toast.error("Please provide a rejection reason.");
      return;
    }
    try {
      const rejectedLease = await rejectLeaseAbstract({
        lease,
        reason: rejectReason,
        reviewer: lease?.signed_by || null,
      });
      queryClient.setQueryData(["lease", leaseId], rejectedLease);
      queryClient.invalidateQueries({ queryKey: ["lease", leaseId] });
      queryClient.invalidateQueries({ queryKey: ["leases"] });
      toast.success("Lease document rejected");
      setShowReject(false);
    } catch (err) {
      console.error("[LeaseReview] reject failed:", err);
      toast.error(err?.message || "Could not reject document");
    }
  };

  const sendSignatureRequest = async () => {
    const recipient = signatureRecipients.find((s) => s.id === signatureRecipientId);
    if (!recipient) {
      toast.error("Select a signature recipient.");
      return;
    }
    setSendingSignature(true);
    try {
      const reviewUrl = window.location.origin + createPageUrl("LeaseReview", { id: lease.id });
      await NotificationService.create({
        org_id: lease.org_id,
        type: "signature_request",
        title: "Lease Signature Requested",
        message: `Signature requested from ${recipient.name} <${recipient.email}> for ${lease.tenant_name || "lease"}.`,
        link: createPageUrl("LeaseReview", { id: lease.id }),
        priority: "high",
      });
      await invokeEdgeFunction("send-email", {
        to: recipient.email,
        subject: `[Signature Requested] ${lease.tenant_name || "Lease"}`,
        html: `<h2>Lease Signature Requested</h2>
          <p>You have been asked to review and sign a lease.</p>
          <p><strong>Tenant:</strong> ${lease.tenant_name || "Unknown"}</p>
          ${signatureMessage ? `<p><strong>Message:</strong> ${signatureMessage}</p>` : ""}
          <p><a href="${reviewUrl}" style="background:#2563eb;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block;margin-top:12px;">Open Signature Request</a></p>`,
      });
      toast.success(`Signature request sent to ${recipient.name} <${recipient.email}>`);
      setShowSignature(false);
      setSignatureRecipientId("");
      setSignatureMessage("");
    } catch (err) {
      console.error("[LeaseReview] Signature request error:", err);
      toast.error(err?.message || "Failed to send signature request");
    } finally {
      setSendingSignature(false);
    }
  };

  // Open the original lease document. Resolves the source_file_id lazily so
  // every field's "View in Document" action goes to the same target.
  const viewInDocument = async (field) => {
    if (lease.approval_document_url) {
      window.open(lease.approval_document_url, "_blank", "noopener,noreferrer");
      return;
    }
    if (!supabase) {
      toast.info("No source document is linked to this lease.");
      return;
    }
    try {
      const uploadedFile = await findUploadedFileForLease(lease);
      const resolvedUrl = await resolveUploadedFileUrl(uploadedFile);
      if (!resolvedUrl) {
        toast.info("Source document URL is unavailable.");
        return;
      }
      const { sourcePage } = readFieldEvidence(lease, field.key);
      const url = sourcePage ? `${resolvedUrl}#page=${sourcePage}` : resolvedUrl;
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      console.error("[LeaseReview] viewInDocument failed:", err);
      toast.error("Could not open source document");
    }
  };

  // --- Render --------------------------------------------------------------
  const leaseStatus = lease.status || "draft";
  const requiredCounterTitle = `Required Reviewed ${requiredReviewedKeys.length} / ${REQUIRED_FIELD_KEYS.length}`;
  const requiredCounterPendingLabel = requiredResolved
    ? "All required fields reviewed"
    : `Required Pending ${requiredPendingKeys.length}`;

  return (
    <div className="space-y-6 p-6">
      <Link
        to={createPageUrl("Leases")}
        className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"
      >
        <ArrowLeft className="h-4 w-4" /> Back to Leases
      </Link>

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Lease Review</h1>
          <p className="text-sm text-slate-500">
            {lease.tenant_name || "Unknown tenant"} —{" "}
            {totalSf ? `${Number(totalSf).toLocaleString()} SF` : "—"} ·{" "}
            {getLeaseFieldLabel("lease_type", lease.lease_type) || "Unknown type"}
          </p>
          <p className="mt-0.5 text-xs text-slate-400">
            Term: {commencementValue || "—"} → {expirationValue || "—"}
            {lease.lease_date ? ` · Signed: ${lease.lease_date}` : ""}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge className={leaseStatus === "approved" ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-700"}>
              Status: {leaseStatus}
            </Badge>
            {lease.abstract_status && (
              <Badge className={lease.abstract_status === "approved" ? "bg-emerald-100 text-emerald-700" : "bg-blue-100 text-blue-700"}>
                Abstract: {lease.abstract_status}
                {lease.abstract_version ? ` · v${lease.abstract_version}` : ""}
              </Badge>
            )}
            <Badge className="bg-slate-100 text-slate-700">
              Reviewed {resolvedCount} / {totalFields}
            </Badge>
            <Badge
              title={requiredResolved
                ? "All required fields have been accepted, edited, marked N/A, or marked manual_required."
                : `${requiredPendingKeys.length} required field(s) still need a review decision.`}
              className={requiredResolved ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-800"}
            >
              {requiredCounterTitle}
            </Badge>
            {!requiredResolved && (
              <Badge className="bg-amber-50 text-amber-700">{requiredCounterPendingLabel}</Badge>
            )}
            {conflicts.length > 0 && (
              <Badge className="bg-red-100 text-red-700">
                {conflicts.length} conflict{conflicts.length === 1 ? "" : "s"}
              </Badge>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => setShowReextractConfirm(true)}
            disabled={reextracting || !lease?.extraction_data?.source_file_id}
            title={
              lease?.extraction_data?.source_file_id
                ? "Re-run the AI extraction on the source PDF and refresh values + evidence on this lease"
                : "No source file is linked to this lease. Use Extraction Debug → Re-link Source Document first."
            }
          >
            {reextracting ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1 h-4 w-4" />}
            {reextracting
              ? reextractStage === "polling"
                ? "Waiting on extraction…"
                : reextractStage === "applying"
                  ? "Applying values…"
                  : reextractStage === "extracting_rules"
                    ? "Extracting expense rules…"
                    : "Re-extracting…"
              : "Re-extract Lease"}
          </Button>
          <Button
            variant="outline"
            onClick={() => navigate(createPageUrl("LeaseExpenseClassification", { id: lease.id }))}
          >
            Review Expense Rules
          </Button>
          <Button
            className="bg-blue-600 hover:bg-blue-700"
            onClick={() => setShowSignature(true)}
          >
            <Send className="mr-1 h-4 w-4" />
            Request Signature
          </Button>
        </div>
      </div>

      {/* Source-file banner with inline file picker. Shows the ranked list
          of uploaded_files candidates the auto-link found in this org —
          one click links the lease, no UUID copying needed. */}
      {!lease?.extraction_data?.source_file_id && (
        <div className="space-y-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <div>
            <p className="font-semibold">No source file linked to this lease.</p>
            <p className="text-xs text-red-700">
              Extraction (Docling + Gemini) can't run and the Re-extract Lease button is disabled until you point this lease at the uploaded PDF.
              {autoLinkDebug ? (
                <span className="block mt-1 italic">
                  Auto-link scanned {autoLinkDebug.query_count} uploads ({autoLinkDebug.lease_like} lease-shape), top score {autoLinkDebug.top_score} for "{autoLinkDebug.top_candidate || "—"}" against tenant "{autoLinkDebug.tenant || "—"}". If you see duplicates below, they're re-uploads of the same file — picking the most recent (top of the list) is safe. The UUID is just an internal identifier; you don't need to memorize it.
                </span>
              ) : null}
            </p>
          </div>
          {linkCandidates.length > 0 ? (
            <div className="space-y-1.5">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-red-900">Recent lease uploads in this org</p>
              <div className="max-h-64 space-y-1 overflow-auto rounded border border-red-200 bg-white">
                {linkCandidates.map((c) => (
                  <div key={c.id} className="flex items-center justify-between gap-2 border-b border-red-100 px-3 py-2 last:border-b-0">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium text-slate-900" title={c.file_name}>
                        {c.file_name || c.id}
                      </p>
                      <p className="text-[10px] text-slate-500">
                        score {c.score}
                        {c.reasons?.length ? ` · ${c.reasons.join("+")}` : ""}
                        {" · "}{c.status}
                        {" · "}{c.updated_at ? new Date(c.updated_at).toLocaleString() : ""}
                        {" · "}<code className="text-slate-400">{String(c.id).slice(0, 8)}…</code>
                      </p>
                    </div>
                    <Button
                      size="sm"
                      className="bg-red-600 text-white hover:bg-red-700"
                      onClick={() => handleLinkSourceFile(c.id)}
                    >
                      Link
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-xs italic text-red-700">
              No lease uploads found in this org. Upload a lease PDF first on the Upload Lease page, then come back here.
            </p>
          )}
          <Button
            size="sm"
            variant="outline"
            className="border-red-300 bg-white text-red-700 hover:bg-red-100"
            onClick={() => setActiveTab("extraction_debug")}
          >
            Or paste a UUID manually (Extraction Debug)
          </Button>
        </div>
      )}

      {/* Rule readiness banner */}
      <div
        className={`rounded-xl border px-4 py-3 text-sm ${
          approvedRuleSet
            ? "border-emerald-200 bg-emerald-50 text-emerald-800"
            : "border-amber-200 bg-amber-50 text-amber-800"
        }`}
      >
        {approvedRuleSet
          ? "Lease expense rules are approved. Approving the lease abstract will refresh lease-derived charges and CAM readiness."
          : "Expense/CAM rules have not been approved yet. Review the extracted rules before final abstract approval."}
      </div>

      {/* Confidence summary — 6 cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Card className="border-emerald-200 bg-emerald-50">
          <CardContent className="p-3">
            <p className="text-[10px] font-semibold uppercase text-emerald-600">High (≥90%)</p>
            <p className="text-2xl font-bold text-emerald-700">{confidenceBuckets.high}</p>
            <p className="text-[10px] text-emerald-500">Auto-populated</p>
          </CardContent>
        </Card>
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="p-3">
            <p className="text-[10px] font-semibold uppercase text-amber-600">Medium (75–89%)</p>
            <p className="text-2xl font-bold text-amber-700">{confidenceBuckets.medium}</p>
            <p className="text-[10px] text-amber-500">Flagged for review</p>
          </CardContent>
        </Card>
        <Card className="border-red-200 bg-red-50">
          <CardContent className="p-3">
            <p className="text-[10px] font-semibold uppercase text-red-600">Low (&lt;75%)</p>
            <p className="text-2xl font-bold text-red-600">{confidenceBuckets.low}</p>
            <p className="text-[10px] text-red-400">Verify before approval</p>
          </CardContent>
        </Card>
        <Card className="border-slate-200 bg-slate-50">
          <CardContent className="p-3">
            <p className="text-[10px] font-semibold uppercase text-slate-500">Unknown Confidence</p>
            <p className="text-2xl font-bold text-slate-700">{confidenceBuckets.unknown}</p>
            <p className="text-[10px] text-slate-500">No score recorded</p>
          </CardContent>
        </Card>
        <Card className="border-purple-200 bg-purple-50">
          <CardContent className="p-3">
            <p className="text-[10px] font-semibold uppercase text-purple-600">Manual Required</p>
            <p className="text-2xl font-bold text-purple-700">{manualRequiredCount}</p>
            <p className="text-[10px] text-purple-500">Needs human input or legal review</p>
          </CardContent>
        </Card>
        <Card className={conflicts.length > 0 ? "border-red-200 bg-red-50" : "border-slate-200 bg-white"}>
          <CardContent className="p-3">
            <p className={`text-[10px] font-semibold uppercase ${conflicts.length > 0 ? "text-red-600" : "text-slate-500"}`}>Conflicts</p>
            <p className={`text-2xl font-bold ${conflicts.length > 0 ? "text-red-700" : "text-slate-900"}`}>
              {conflicts.length}
            </p>
            <p className={`text-[10px] ${conflicts.length > 0 ? "text-red-500" : "text-slate-500"}`}>
              {conflicts.length > 0 ? "Resolve before approval" : "No data conflicts"}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="flex h-auto flex-wrap justify-start gap-1 border bg-white">
          {LEASE_REVIEW_TABS.map((tab) => {
            const tabFields = FIELDS_BY_TAB[tab.key] || [];
            const pendingInTab = tabFields.filter((f) => {
              if (!f.required) return false;
              return !isResolvedReview(fieldReviews[f.key]);
            }).length;
            return (
              <TabsTrigger key={tab.key} value={tab.key} className="text-xs">
                {tab.label}
                {pendingInTab > 0 && (
                  <span className="ml-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-200 px-1 text-[10px] font-semibold text-amber-900">
                    {pendingInTab}
                  </span>
                )}
              </TabsTrigger>
            );
          })}
        </TabsList>

        {/* Summary tab */}
        <TabsContent value="summary" className="mt-4 space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Lease Summary</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <SummaryStat label="Tenant" value={lease.tenant_name || "—"} />
              <SummaryStat label="Lease Type" value={getLeaseFieldLabel("lease_type", lease.lease_type) || "—"} />
              <SummaryStat
                label="Term (Commencement → Expiration)"
                value={`${commencementValue || "—"} → ${expirationValue || "—"}`}
              />
              <SummaryStat label="Lease Date (signed)" value={lease.lease_date || "—"} />
              <SummaryStat label="Monthly Rent" value={lease.monthly_rent ? `$${Number(lease.monthly_rent).toLocaleString()}` : "—"} />
              <SummaryStat label="Annual Rent" value={lease.annual_rent ? `$${Number(lease.annual_rent).toLocaleString()}` : "—"} />
              <SummaryStat label="Square Footage" value={totalSf ? `${Number(totalSf).toLocaleString()} SF` : "—"} />
            </CardContent>
          </Card>

          {/* Expense / CAM card */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Expense / CAM Readiness</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <SummaryStat
                  label="Expense rules extracted"
                  value={String(ruleSetSummary?.expense?.total ?? 0)}
                />
                <SummaryStat
                  label="Expense rules approved"
                  value={String(ruleSetSummary?.expense?.approved ?? 0)}
                />
                <SummaryStat
                  label="CAM rules extracted"
                  value={String(ruleSetSummary?.cam?.total ?? 0)}
                />
                <SummaryStat
                  label="CAM rules approved"
                  value={String(ruleSetSummary?.cam?.approved ?? 0)}
                />
              </div>
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-slate-500">
                  Expenses/CAM live under a separate rule set. Approve them there before approving the lease abstract.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => navigate(createPageUrl("LeaseExpenseClassification", { id: lease.id }))}
                >
                  Review Expense Rules
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Approval Blockers</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {approvalBlockers.length === 0 ? (
                <div className="flex items-center gap-2 rounded-lg bg-emerald-50 p-3 text-emerald-700">
                  <CheckCircle2 className="h-4 w-4" />
                  <span>No blockers. Ready to approve.</span>
                </div>
              ) : (
                approvalBlockers.map((b) => (
                  <div key={b.kind} className="rounded-lg border border-red-200 bg-red-50 p-3">
                    <div className="flex items-center gap-2 text-red-700">
                      <AlertTriangle className="h-4 w-4" />
                      <p className="text-sm font-semibold">{b.title}</p>
                    </div>
                    <p className="ml-6 mt-1 text-xs text-red-600">{b.detail}</p>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Validation Checks</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {validationChecks.map((c, i) => (
                  <div key={i} className={`rounded-lg p-2.5 ${c.pass ? "bg-emerald-50" : "bg-red-50"}`}>
                    <div className="flex items-center gap-2">
                      {c.pass ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                      ) : (
                        <AlertTriangle className="h-3.5 w-3.5 text-red-500" />
                      )}
                      <p className="text-xs font-medium text-slate-900">{c.label}</p>
                    </div>
                    <p className="ml-5 mt-0.5 text-[10px] text-slate-500">{c.detail}</p>
                  </div>
                ))}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Required Fields</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <p className="text-slate-700">
                  Approval is blocked until every required field is accepted, edited, marked N/A, or marked manual_required.
                </p>
                <ul className="mt-2 space-y-1 text-xs">
                  {REQUIRED_FIELD_KEYS.map((key) => {
                    const field = LEASE_REVIEW_FIELDS.find((f) => f.key === key);
                    const review = fieldReviews[key];
                    const resolved = isResolvedReview(review);
                    return (
                      <li key={key} className="flex items-center justify-between gap-2 rounded border border-slate-200 bg-slate-50 px-2 py-1">
                        <span className="text-slate-600">{field?.label || key}</span>
                        <Badge className={resolved ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-800"}>
                          {resolved ? REVIEW_STATUS_LABELS[review.status] : "Pending"}
                        </Badge>
                      </li>
                    );
                  })}
                </ul>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Field tabs — table-first per business section. */}
        {LEASE_REVIEW_TABS
          .filter((t) => !["summary", "rent_charges", "expenses_recoveries", "cam_rules", "clause_records", "critical_dates", "documents_exhibits", "budget_preview", "extraction_debug"].includes(t.key))
          .map((tab) => (
            <TabsContent key={tab.key} value={tab.key} className="mt-4 space-y-3">
              <FieldReviewTable
                fields={FIELDS_BY_TAB[tab.key] || []}
                lease={lease}
                fieldReviews={fieldReviews}
                onOpenDetail={(field) => openDrawer(field, "view")}
                onQuickAction={(field, action) => {
                  if (action === "accept") handleAccept(field);
                  else if (action === "edit") openDrawer(field, "edit");
                  else if (action === "reject") handleReject(field);
                  else if (action === "na") handleMarkNA(field);
                  else if (action === "legal") handleNeedsLegal(field);
                  else if (action === "manual") handleMarkManualRequired(field);
                }}
              />
            </TabsContent>
          ))}

        {/* Rent & Charges — single-value rent fields + generated rent rows.
            The rent_schedules table remains in the backend (rent projection,
            billing, etc. read from it); we just surface the rows here so
            reviewers see the schedule that approval will publish. */}
        <TabsContent value="rent_charges" className="mt-4 space-y-4">
          <FieldReviewTable
            fields={FIELDS_BY_TAB.rent_charges || []}
            lease={lease}
            fieldReviews={fieldReviews}
            onOpenDetail={(field) => openDrawer(field, "view")}
            onQuickAction={(field, action) => {
              if (action === "accept") handleAccept(field);
              else if (action === "edit") openDrawer(field, "edit");
              else if (action === "reject") handleReject(field);
              else if (action === "na") handleMarkNA(field);
              else if (action === "legal") handleNeedsLegal(field); else if (action === "manual") handleMarkManualRequired(field);
            }}
          />
          <RentScheduleTable leaseId={lease.id} />
        </TabsContent>

        {/* Expense Rules — single-value lease fields + repeatable rule rows. */}
        <TabsContent value="expenses_recoveries" className="mt-4 space-y-4">
          <FieldReviewTable
            fields={FIELDS_BY_TAB.expenses_recoveries || []}
            lease={lease}
            fieldReviews={fieldReviews}
            onOpenDetail={(field) => openDrawer(field, "view")}
            onQuickAction={(field, action) => {
              if (action === "accept") handleAccept(field);
              else if (action === "edit") openDrawer(field, "edit");
              else if (action === "reject") handleReject(field);
              else if (action === "na") handleMarkNA(field);
              else if (action === "legal") handleNeedsLegal(field); else if (action === "manual") handleMarkManualRequired(field);
            }}
          />
          <ExpenseRulesTable leaseId={lease.id} />
        </TabsContent>

        {/* CAM Rules — single-value CAM lease fields + repeatable CAM rules. */}
        <TabsContent value="cam_rules" className="mt-4 space-y-4">
          <FieldReviewTable
            fields={FIELDS_BY_TAB.cam_rules || []}
            lease={lease}
            fieldReviews={fieldReviews}
            onOpenDetail={(field) => openDrawer(field, "view")}
            onQuickAction={(field, action) => {
              if (action === "accept") handleAccept(field);
              else if (action === "edit") openDrawer(field, "edit");
              else if (action === "reject") handleReject(field);
              else if (action === "na") handleMarkNA(field);
              else if (action === "legal") handleNeedsLegal(field); else if (action === "manual") handleMarkManualRequired(field);
            }}
          />
          <CamRulesTable leaseId={lease.id} />
        </TabsContent>

        {/* Clause Records — all meaningful lease clauses against a predefined checklist. */}
        <TabsContent value="clause_records" className="mt-4 space-y-3">
          <ClauseRecordsTable lease={lease} />
        </TabsContent>

        {/* Critical Dates — derived from approved abstract. */}
        <TabsContent value="critical_dates" className="mt-4 space-y-3">
          <CriticalDatesTable lease={lease} />
        </TabsContent>

        {/* Documents / Exhibits tab */}
        <TabsContent value="documents_exhibits" className="mt-4 space-y-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Source Document</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {lease.approval_document_url ? (
                <a
                  href={lease.approval_document_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-700"
                >
                  <FileText className="h-4 w-4" />
                  Approved signed copy
                </a>
              ) : null}
              <SourceFileLink lease={lease} />
            </CardContent>
          </Card>
        </TabsContent>

        {/* Budget Preview tab */}
        <TabsContent value="budget_preview" className="mt-4 space-y-3">
          <BudgetPreviewCard lease={lease} />
        </TabsContent>

        {/* Extraction Debug tab — diagnose extraction issues. */}
        <TabsContent value="extraction_debug" className="mt-4 space-y-3">
          <ExtractionDebugPanel lease={lease} />
        </TabsContent>
      </Tabs>

      {/* Side drawer for full field detail. */}
      <FieldDetailDrawer
        open={!!drawerField}
        onOpenChange={(open) => {
          if (!open) {
            setDrawerField(null);
            setDrawerMode("view");
          }
        }}
        field={drawerField}
        lease={lease}
        review={drawerReview}
        initialMode={drawerMode}
        onAccept={(f) => handleAccept(f)}
        onReject={(f) => handleReject(f)}
        onMarkNA={(f) => handleMarkNA(f)}
        onNeedsLegal={(f) => handleNeedsLegal(f)}
        onMarkManualRequired={(f) => handleMarkManualRequired(f)}
        onReset={(f) => handleResetField(f)}
        onSaveEdit={async (f, val) => {
          // Mirror the existing handleFieldSave path but without the Dialog.
          const columnUpdates = {};
          for (const column of resolveFieldColumns(f.key)) columnUpdates[column] = val;
          if (f.key === "total_sf") columnUpdates.square_footage = val;
          const previousValue = readFieldValue(lease, f.key);
          try {
            const updatedLease = await updateLeaseMutation.mutateAsync({
              id: lease.id,
              data: {
                ...columnUpdates,
                extraction_data: {
                  ...(lease.extraction_data || {}),
                  fields: {
                    ...(lease.extraction_data?.fields || {}),
                    [f.key]: { value: val, manually_edited: true, edited_at: new Date().toISOString() },
                  },
                },
              },
            });
            await persistFieldAction({
              field: f,
              status: REVIEW_STATUSES.EDITED,
              value: val,
              previousReview: { value: previousValue, status: fieldReviews[f.key]?.status },
            });
            toast.success(`Updated ${f.label}`);
          } catch {
            /* toasted by mutation onError */
          }
        }}
        onViewInDocument={() => drawerField && viewInDocument(drawerField)}
        onSaveEvidence={async (f, evidencePatch) => {
          // Reviewer-corrected evidence. Lands in extraction_data.field_evidence
          // and (mirrored) in extraction_data.fields so every downstream reader
          // sees the same shape the extractor would have produced.
          try {
            const prevEvidence = lease.extraction_data?.field_evidence?.[f.key] || null;
            const prevField = lease.extraction_data?.fields?.[f.key] || null;
            const cleanPatch = {
              raw_value: evidencePatch.raw_value ?? null,
              source_page:
                typeof evidencePatch.source_page === "number" && Number.isFinite(evidencePatch.source_page)
                  ? evidencePatch.source_page
                  : null,
              source_text: evidencePatch.source_text ?? null,
              extraction_status: evidencePatch.extraction_status ?? null,
            };
            const confValue =
              typeof evidencePatch.confidence === "number" && Number.isFinite(evidencePatch.confidence)
                ? Math.max(0, Math.min(100, Math.round(evidencePatch.confidence)))
                : null;

            const nextExtraction = {
              ...(lease.extraction_data || {}),
              fields: {
                ...(lease.extraction_data?.fields || {}),
                [f.key]: {
                  ...(prevField || {}),
                  ...cleanPatch,
                  confidence: confValue,
                  manually_edited_evidence: true,
                  edited_at: new Date().toISOString(),
                },
              },
              field_evidence: {
                ...(lease.extraction_data?.field_evidence || {}),
                [f.key]: cleanPatch,
              },
              confidence_scores: {
                ...(lease.extraction_data?.confidence_scores || {}),
                ...(confValue != null ? { [f.key]: confValue } : {}),
              },
            };
            const { error: updateErr } = await supabase
              .from("leases")
              .update({ extraction_data: nextExtraction })
              .eq("id", lease.id);
            if (updateErr) throw updateErr;
            await logAudit({
              entityType: "LeaseFieldReview",
              entityId: lease.id,
              action: "field_evidence_edit",
              orgId: lease.org_id,
              fieldChanged: f.key,
              oldValue: prevEvidence ? JSON.stringify(prevEvidence) : null,
              newValue: JSON.stringify({ ...cleanPatch, confidence: confValue }),
              propertyId: lease.property_id || null,
            });
            toast.success(`Evidence saved for ${f.label}`);
            queryClient.invalidateQueries({ queryKey: ["lease", leaseId] });
          } catch (err) {
            console.error("[LeaseReview] evidence save failed:", err);
            toast.error(err?.message || "Could not save evidence");
          }
        }}
        onSaveOverrideReason={async (f, reason) => {
          // Persists the reason into fieldReviews[key].note so the approval
          // gate's `hasEvidenceOverride` check unblocks the field.
          const trimmed = (reason || "").trim();
          const previousReview = fieldReviews[f.key];
          const next = {
            ...fieldReviews,
            [f.key]: {
              ...(previousReview || {}),
              note: trimmed || null,
              evidence_override: trimmed.length > 0,
              reviewed_at: new Date().toISOString(),
            },
          };
          setFieldReviews(next);
          try {
            await saveAbstractDraft({ lease, fieldReviews: next, reviewer: lease?.signed_by || null });
            await logAudit({
              entityType: "LeaseFieldReview",
              entityId: lease.id,
              action: trimmed ? "field_override_reason_set" : "field_override_reason_cleared",
              orgId: lease.org_id,
              fieldChanged: f.key,
              oldValue: previousReview?.note || null,
              newValue: trimmed || null,
              propertyId: lease.property_id || null,
            });
            toast.success(trimmed ? "Override reason saved" : "Override reason cleared");
          } catch (err) {
            console.error("[LeaseReview] override save failed:", err);
            toast.error(err?.message || "Could not save override reason");
            setFieldReviews(fieldReviews);
          }
        }}
        isSaving={updateLeaseMutation.isPending}
      />

      {/* Sticky bottom action bar — once the abstract is approved we collapse
          to a confirmation message + Re-extract escape hatch (re-extraction
          creates the next version on next approval).
          Uses `sticky bottom-0` (not `fixed`) so the bar stays contained
          inside the Lease Review page's scroll area and does not overlap
          the sidebar / other modules. The negative horizontal margin lets
          the bar span the full width of the content area while the page
          itself keeps its `p-6` padding. */}
      <div className="sticky bottom-0 z-30 -mx-6 mt-4 border-t border-slate-200 bg-white/95 px-6 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
          {lease?.abstract_status === "approved" ? (
            <>
              <div className="text-xs">
                <span className="font-semibold text-emerald-700">
                  ✓ Lease abstract approved
                  {lease.abstract_version ? ` (v${lease.abstract_version})` : ""}
                </span>
                {lease.signed_by ? (
                  <span className="ml-2 text-slate-500">
                    by {lease.signed_by}
                    {lease.signed_at ? ` on ${new Date(lease.signed_at).toLocaleString()}` : ""}
                  </span>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Link to={createPageUrl("LeaseDetail") + `?id=${lease.id}`}>
                  <Button variant="outline">Open Lease Detail</Button>
                </Link>
                <Button
                  variant="outline"
                  onClick={() => setShowReextractConfirm(true)}
                  disabled={reextracting || !lease?.extraction_data?.source_file_id}
                  className="border-blue-300 text-blue-700 hover:bg-blue-50"
                  title="Re-run AI extraction — next approval will create a new version"
                >
                  {reextracting ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1 h-4 w-4" />}
                  {reextracting ? "Re-extracting…" : "Re-extract Lease"}
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className="text-xs text-slate-500">
                {canApprove ? (
                  <span className="text-emerald-700">All checks passed. You can approve the lease abstract.</span>
                ) : (
                  <span title={blockerMessage} className="text-amber-700">
                    Approval blocked: {blockerMessage}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  onClick={() => setShowReextractConfirm(true)}
                  disabled={reextracting || !lease?.extraction_data?.source_file_id}
                  className="border-blue-300 text-blue-700 hover:bg-blue-50"
                  title={
                    lease?.extraction_data?.source_file_id
                      ? "Re-run AI extraction on the source PDF"
                      : "No source file linked. Use Extraction Debug → Re-link first."
                  }
                >
                  {reextracting ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1 h-4 w-4" />}
                  {reextracting ? "Re-extracting…" : "Re-extract Lease"}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setShowReject(true)}
                  className="text-red-700"
                >
                  <Ban className="mr-1 h-4 w-4" />
                  Reject Document
                </Button>
                <Button variant="outline" onClick={() => setShowSendBack(true)}>
                  <Undo2 className="mr-1 h-4 w-4" />
                  Send Back for Re-extraction
                </Button>
                <Button
                  variant="outline"
                  onClick={handleSaveDraft}
                  disabled={savingDraft || updateLeaseMutation.isPending}
                >
                  {savingDraft && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                  Save Review Draft
                </Button>
                <Button
                  className={
                    canApprove
                      ? "bg-emerald-600 hover:bg-emerald-700"
                      : "border border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100"
                  }
                  onClick={() => {
                    if (!canApprove) {
                      toast.error(blockerMessage);
                      return;
                    }
                    setShowApproval(true);
                  }}
                  title={approvalDisabledTooltip}
                >
                  <CheckCircle2 className="mr-1 h-4 w-4" />
                  Approve Lease Abstract
                </Button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Dialogs */}

      {/* Edit Field */}
      <Dialog open={!!editingField} onOpenChange={(open) => !open && setEditingField(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit: {editingField?.label}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <Label>Current Value</Label>
              <p className="mt-1 text-sm text-slate-500">
                {editingField ? String(readFieldValue(lease, editingField.key) ?? "—") : ""}
              </p>
            </div>
            <div>
              <Label>New Value</Label>
              {editingField && hasLeaseFieldOptions(editingField.options || editingField.key) ? (
                <div className="mt-1">
                  <SelectWithCustom
                    value={editValue}
                    onChange={(next) => setEditValue(next)}
                    options={LEASE_FIELD_OPTIONS[editingField.options || editingField.key]}
                    placeholder={`Select ${editingField.label.toLowerCase()}`}
                  />
                </div>
              ) : editingField?.type === "boolean" ? (
                <Select value={String(editValue)} onValueChange={(v) => setEditValue(v)}>
                  <SelectTrigger className="mt-1">
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
                  className="mt-1"
                  type={
                    editingField?.type === "number" || editingField?.type === "currency"
                      ? "number"
                      : editingField?.type === "date"
                      ? "date"
                      : "text"
                  }
                />
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingField(null)}>
              Cancel
            </Button>
            <Button
              onClick={handleFieldSave}
              disabled={updateLeaseMutation.isPending}
              className="bg-blue-600 hover:bg-blue-700"
            >
              {updateLeaseMutation.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Approval dialog */}
      <Dialog open={showApproval} onOpenChange={setShowApproval}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Approve Lease Abstract</DialogTitle>
          </DialogHeader>
          <p className="mb-2 text-sm text-slate-500">
            Approval converts this draft into the official lease abstract. Downstream modules
            (Expenses, CAM, Budget, Billing) will only read from the approved abstract.
          </p>
          <div className="mb-3 rounded-lg bg-slate-50 p-3">
            <p className="text-sm font-medium text-slate-700">Lease Summary</p>
            <p className="text-xs text-slate-500">
              {lease.tenant_name} · {getLeaseFieldLabel("lease_type", lease.lease_type) || "—"} ·{" "}
              {commencementValue || "—"} to {expirationValue || "—"}
            </p>
          </div>
          <div className="space-y-3">
            <div>
              <Label className="text-xs font-semibold text-slate-700">
                Signed By <span className="text-red-500">*</span>
              </Label>
              <Input
                className="mt-1"
                placeholder="Full name of signatory"
                value={approvalSignedBy}
                onChange={(e) => setApprovalSignedBy(e.target.value)}
              />
            </div>
            <div>
              <Label className="text-xs font-semibold text-slate-700">
                Signed At <span className="text-red-500">*</span>
              </Label>
              <Input
                className="mt-1"
                type="datetime-local"
                value={approvalSignedAt}
                onChange={(e) => setApprovalSignedAt(e.target.value)}
              />
            </div>
            <div>
              <Label className="text-xs font-semibold text-slate-700">Document URL (optional)</Label>
              <Input
                className="mt-1"
                placeholder="https://... (signed lease document link)"
                value={approvalDocumentUrl}
                onChange={(e) => setApprovalDocumentUrl(e.target.value)}
              />
            </div>
            <div>
              <Label className="text-xs font-semibold text-slate-700">Comments</Label>
              <Textarea
                className="mt-1"
                rows={3}
                value={approvalComments}
                onChange={(e) => setApprovalComments(e.target.value)}
                placeholder="Any notes from the signing party..."
              />
            </div>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setShowApproval(false)}>
              Cancel
            </Button>
            <Button
              className="bg-emerald-600 hover:bg-emerald-700"
              onClick={handleApproveAbstract}
              disabled={approving || updateLeaseMutation.isPending}
            >
              {approving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              Confirm Approval
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject Document */}
      <Dialog open={showReject} onOpenChange={setShowReject}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject Lease Document</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-slate-500">
            Rejecting marks this lease draft as rejected. The original upload remains in the
            Documents list for reference.
          </p>
          <div className="space-y-2 py-2">
            <Label>Reason (required)</Label>
            <Textarea
              rows={4}
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Why is this document being rejected?"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowReject(false)}>
              Cancel
            </Button>
            <Button
              className="bg-red-600 hover:bg-red-700"
              onClick={handleRejectDocument}
              disabled={updateLeaseMutation.isPending}
            >
              {updateLeaseMutation.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Re-extract confirmation */}
      <Dialog open={showReextractConfirm} onOpenChange={setShowReextractConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Re-extract this lease?</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm text-slate-600">
            <p>
              This will re-run the AI extraction on the source PDF and overwrite
              <strong> extracted values, source page/text, confidence scores, and workflow output</strong> on
              this lease record.
            </p>
            <ul className="list-disc space-y-1 pl-5 text-xs text-slate-500">
              <li>Field review decisions you've already made (Accept / Edit / N/A / Manual) are <strong>preserved</strong>.</li>
              <li>Approval status, signed_by, and abstract_snapshot are <strong>not touched</strong>.</li>
              <li>Source file: <code>{lease?.extraction_data?.source_file_id || "(none)"}</code></li>
              <li>Takes ~30–60 seconds. Don't close the page while it's running.</li>
            </ul>
          </div>
          <DialogFooter className="mt-3">
            <Button variant="outline" onClick={() => setShowReextractConfirm(false)} disabled={reextracting}>
              Cancel
            </Button>
            <Button
              className="bg-blue-600 hover:bg-blue-700"
              onClick={handleReextractLease}
              disabled={reextracting || !lease?.extraction_data?.source_file_id}
            >
              {reextracting ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1 h-4 w-4" />}
              Re-extract Now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Send Back for Re-extraction */}
      <Dialog open={showSendBack} onOpenChange={setShowSendBack}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send Back for Re-extraction</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-slate-500">
            Marks this draft as needing re-extraction and returns you to Upload Lease with the
            scope pre-filled. The previous review notes are preserved.
          </p>
          <div className="space-y-2 py-2">
            <Label>Reason (optional)</Label>
            <Textarea
              rows={3}
              value={sendBackReason}
              onChange={(e) => setSendBackReason(e.target.value)}
              placeholder="What needs to be re-extracted?"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSendBack(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleSendBack}
              disabled={updateLeaseMutation.isPending}
              className="bg-amber-600 hover:bg-amber-700"
            >
              {updateLeaseMutation.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              Send Back
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Signature Request */}
      <Dialog open={showSignature} onOpenChange={setShowSignature}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Request Digital Signature</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-slate-500">
            Send the lease for signature to a designated stakeholder.
          </p>
          <div className="space-y-4 py-2">
            <div>
              <Label>Send To</Label>
              <Select value={signatureRecipientId} onValueChange={setSignatureRecipientId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select stakeholder" />
                </SelectTrigger>
                <SelectContent>
                  {signatureRecipients.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name} ({s.role?.replace("_", " ")}) · {s.email}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {signatureRecipients.length === 0 && (
                <p className="mt-1 text-xs text-amber-600">
                  No stakeholders with email are configured for this property.
                </p>
              )}
            </div>
            <div>
              <Label>Message (optional)</Label>
              <Textarea
                rows={3}
                value={signatureMessage}
                onChange={(e) => setSignatureMessage(e.target.value)}
                placeholder="Please review and sign this lease..."
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSignature(false)}>
              Cancel
            </Button>
            <Button
              className="bg-blue-600 hover:bg-blue-700"
              onClick={sendSignatureRequest}
              disabled={sendingSignature || signatureRecipients.length === 0}
            >
              {sendingSignature && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              Send Request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// --- Sub-components ------------------------------------------------------

function SummaryStat({ label, value }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-sm font-medium text-slate-900">{value}</p>
    </div>
  );
}

function FieldReviewRow({
  field,
  lease,
  review,
  onAccept,
  onEdit,
  onReject,
  onMarkNA,
  onNeedsLegal,
  onMarkManualRequired,
  onReset,
  onViewInDocument,
}) {
  const value = readFieldValue(lease, field.key);
  const display =
    value == null || value === ""
      ? "—"
      : field.type === "currency" && !isNaN(Number(value))
      ? `$${Number(value).toLocaleString()}`
      : field.type === "select" && hasLeaseFieldOptions(field.options || field.key)
      ? getLeaseFieldLabel(field.options || field.key, value) || String(value)
      : field.type === "boolean"
      ? value === true || value === "true" || value === "yes"
        ? "Yes"
        : "No"
      : String(value);

  const { rawValue, sourcePage, sourceText, extractionStatus } = readFieldEvidence(lease, field.key);
  const confidence = readFieldConfidence(lease, field.key);
  const status = review?.status || REVIEW_STATUSES.PENDING;
  const required = field.required;
  const allowNA = field.allowNA !== false;
  const actionLabel = REVIEW_STATUS_LABELS[status] || "Review Action";
  const confidenceBucket = classifyConfidence(confidence);
  const confidenceLabel =
    confidenceBucket === "unknown"
      ? "Unknown Confidence"
      : `${Math.round(confidence)}%`;

  const inferredExtractionStatus =
    extractionStatus
    || (value === null || value === undefined || value === ""
      ? "missing"
      : confidenceBucket === "unknown"
        ? "extracted_no_confidence"
        : "extracted");

  return (
    <Card className={status === REVIEW_STATUSES.PENDING && required ? "border-amber-200" : ""}>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">
                {field.label}
                {required && <span className="ml-1 text-red-500">*</span>}
              </p>
              <Badge className={`text-[10px] ${confidenceColor(confidence)}`}>{confidenceLabel}</Badge>
              <Badge className={`text-[10px] ${REVIEW_STATUS_STYLES[status]}`}>
                {REVIEW_STATUS_LABELS[status]}
              </Badge>
              <Badge className="bg-slate-50 text-[10px] text-slate-600">{inferredExtractionStatus}</Badge>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <p className="text-[10px] font-semibold uppercase text-slate-400">Normalized Value</p>
                <p className="text-sm font-medium text-slate-900">{display}</p>
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase text-slate-400">Raw Extracted</p>
                <p className="truncate text-sm text-slate-600" title={rawValue ?? ""}>{rawValue ?? "—"}</p>
              </div>
            </div>
            <details className="text-xs text-slate-500">
              <summary className="cursor-pointer text-slate-600 hover:text-slate-800">
                Source &amp; review metadata
              </summary>
              <div className="mt-2 space-y-1 rounded bg-slate-50 p-2">
                <p>
                  <span className="font-semibold text-slate-600">Source Page:</span>{" "}
                  <span className="text-slate-700">{sourcePage ?? "—"}</span>
                </p>
                <p>
                  <span className="font-semibold text-slate-600">Exact Source Text:</span>{" "}
                  <span className="italic text-slate-700">{sourceText || "No source text captured."}</span>
                </p>
                <p>
                  <span className="font-semibold text-slate-600">Confidence Score:</span>{" "}
                  <span className="text-slate-700">{typeof confidence === "number" ? `${Math.round(confidence)}%` : "Unknown"}</span>
                </p>
                <p>
                  <span className="font-semibold text-slate-600">Extraction Status:</span>{" "}
                  <span className="text-slate-700">{inferredExtractionStatus}</span>
                </p>
                <p>
                  <span className="font-semibold text-slate-600">Review Status:</span>{" "}
                  <span className="text-slate-700">{REVIEW_STATUS_LABELS[status]}</span>
                </p>
                {review?.reviewer && (
                  <p>
                    <span className="font-semibold text-slate-600">Reviewer:</span>{" "}
                    <span className="text-slate-700">{review.reviewer}</span>
                  </p>
                )}
                {review?.reviewed_at && (
                  <p>
                    <span className="font-semibold text-slate-600">Reviewed At:</span>{" "}
                    <span className="text-slate-700">{new Date(review.reviewed_at).toLocaleString()}</span>
                  </p>
                )}
              </div>
            </details>
            <Button variant="outline" size="sm" onClick={onViewInDocument}>
              <ExternalLink className="mr-1 h-3.5 w-3.5" />
              View in Document
            </Button>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="min-w-[170px] justify-between text-xs">
                {actionLabel}
                <ChevronDown className="ml-2 h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onClick={onAccept}>
                <Check className="h-4 w-4 text-emerald-600" />
                Accept
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onEdit}>
                <Pencil className="h-4 w-4 text-blue-600" />
                Edit
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onReject}>
                <X className="h-4 w-4 text-red-600" />
                Reject
              </DropdownMenuItem>
              {allowNA && (
                <DropdownMenuItem onClick={onMarkNA}>
                  <MinusCircle className="h-4 w-4 text-slate-600" />
                  Mark N/A
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={onMarkManualRequired}>
                <HelpCircle className="h-4 w-4 text-amber-600" />
                Mark Manual Required
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onNeedsLegal}>
                <Gavel className="h-4 w-4 text-purple-600" />
                Needs Legal Review
              </DropdownMenuItem>
              {status !== REVIEW_STATUSES.PENDING && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={onReset}>
                    <Undo2 className="h-4 w-4 text-slate-500" />
                    Reset
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardContent>
    </Card>
  );
}

function SourceFileLink({ lease }) {
  const { data } = useQuery({
    queryKey: ["uploaded-file-url", lease?.id, lease?.extraction_data?.source_file_id],
    queryFn: async () => {
      if (!lease) return null;
      const row = await findUploadedFileForLease(lease);
      if (!row) return null;
      const resolvedUrl = await resolveUploadedFileUrl(row);
      return { ...row, file_url: resolvedUrl || row.file_url };
    },
    enabled: !!lease,
  });
  if (!lease) return <p className="text-xs text-slate-500">No source file linked.</p>;
  if (!data?.file_url) return <p className="text-xs text-slate-500">Source file URL is unavailable.</p>;
  return (
    <a
      href={data.file_url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-700"
    >
      <FileText className="h-4 w-4" />
      {data.file_name || "Original upload"}
    </a>
  );
}

async function findUploadedFileForLease(lease) {
  if (!lease || !supabase) return null;

  const sourceFileId = lease.extraction_data?.source_file_id || null;
  if (sourceFileId) {
    const { data } = await supabase
      .from("uploaded_files")
      .select("id, org_id, file_url, file_name")
      .eq("id", sourceFileId)
      .maybeSingle();
    if (data) return data;
  }

  if (!lease.id) return null;

  let query = supabase
    .from("uploaded_files")
    .select("id, org_id, file_url, file_name")
    .contains("reviewed_output", { lease_review_ids: [lease.id] })
    .order("updated_at", { ascending: false })
    .limit(1);

  if (lease.org_id) {
    query = query.eq("org_id", lease.org_id);
  }

  const { data } = await query.maybeSingle();
  return data || null;
}

async function resolveUploadedFileUrl(fileRecord) {
  if (!fileRecord) return null;

  const storagePath = deriveFinancialUploadPath(fileRecord);
  if (storagePath) {
    const { data, error } = await supabase.storage
      .from("financial-uploads")
      .createSignedUrl(storagePath, 60 * 60);

    if (!error && data?.signedUrl) {
      return data.signedUrl;
    }
  }

  return fileRecord.file_url || null;
}

function deriveFinancialUploadPath(fileRecord) {
  const rawUrl = String(fileRecord?.file_url || "");
  const publicPrefix = "/storage/v1/object/public/financial-uploads/";
  const signPrefix = "/storage/v1/object/sign/financial-uploads/";

  const publicIndex = rawUrl.indexOf(publicPrefix);
  if (publicIndex >= 0) {
    return rawUrl.slice(publicIndex + publicPrefix.length).split("?")[0];
  }

  const signIndex = rawUrl.indexOf(signPrefix);
  if (signIndex >= 0) {
    return rawUrl.slice(signIndex + signPrefix.length).split("?")[0];
  }

  if (fileRecord?.org_id && fileRecord?.id) {
    return `${fileRecord.org_id}/${fileRecord.id}`;
  }

  return null;
}

function BudgetPreviewCard({ lease }) {
  const monthly = useMemo(() => {
    const v = Number(lease.monthly_rent || (lease.annual_rent ? lease.annual_rent / 12 : 0));
    return Number.isFinite(v) ? v : 0;
  }, [lease.monthly_rent, lease.annual_rent]);

  const startBasis = lease.commencement_date || lease.start_date;

  const months = useMemo(() => {
    const out = [];
    if (!startBasis) return out;
    const start = new Date(startBasis);
    const escalation = Number(lease.escalation_rate || 0) / 100;
    for (let i = 0; i < 12; i++) {
      const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
      const yearsIn = Math.floor(i / 12);
      const stepRent = monthly * Math.pow(1 + escalation, yearsIn);
      out.push({ label: d.toLocaleDateString(undefined, { year: "numeric", month: "short" }), amount: stepRent });
    }
    return out;
  }, [startBasis, lease.escalation_rate, monthly]);

  if (!startBasis || !monthly) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-slate-500">
          Budget preview requires a commencement date and monthly rent. Complete those fields to see
          the next 12 months of base rent projected from the approved lease terms.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Next 12 Months — Base Rent Preview</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-xs text-slate-500">
          This is a read-only preview from the lease abstract under review. Approved lease data feeds
          Revenue Budget and Charge Schedule in downstream modules.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-left text-slate-500">
                <th className="py-2">Month</th>
                <th className="py-2 text-right">Base Rent</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m) => (
                <tr key={m.label} className="border-b border-slate-100">
                  <td className="py-1.5 text-slate-700">{m.label}</td>
                  <td className="py-1.5 text-right text-slate-900">${m.amount.toFixed(0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  CheckCircle2,
  FileText,
  FileX,
  Loader2,
  Printer,
  RefreshCw,
  Send,
  Undo2,
} from "lucide-react";
import { toast } from "sonner";
import {
  leaseService,
  updateLeaseExtractionField,
  sendLeaseBackForReextraction,
} from "@/services/leaseService";
import { NotificationService } from "@/services/api";
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
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";


import {
  LEASE_FIELD_OPTIONS,
  getLeaseFieldLabel,
  hasLeaseFieldOptions,
} from "@/lib/leaseFieldOptions";
import {
  LEASE_REVIEW_TABS,
  LEASE_REVIEW_FIELDS,
  REQUIRED_FIELD_KEYS,
  REVIEW_STATUSES,
  REVIEW_STATUS_LABELS,
  NUMERIC_REVIEW_FIELDS,
  readFieldValue,
  readFieldEvidence,
  readFieldConfidence,
  isResolvedReview,
  classifyConfidence,
  resolveFieldColumns,
  resolveExtractionStatus,
  hasValidSourceEvidence,
  isCalculatedExtractionStatus,
  isManualExtractionStatus,
  cleanSourceEvidenceText,
  canAcceptCalculatedReviewField,
  isMeaningfulValue,
  resolveSourceTextQuality,
} from "@/lib/leaseReviewSchema";
import { getFieldAliases, resolveLeaseField } from "@/lib/leaseFieldResolver";
import { createPageUrl } from "@/utils";
import { invokeEdgeFunction } from "@/services/edgeFunctions";
import { supabase } from "@/services/supabaseClient";
import {
  saveAbstractDraft,
  rejectLeaseAbstract,
} from "@/services/leaseAbstractService";
import {
  approveLeaseWorkflow,
  createLeaseApprovalIdempotencyKey,
} from "@/services/leaseApprovalWorkflowService";
import { logAudit } from "@/services/audit";
import { leaseRulePipelineService } from "@/services/leaseRulePipelineService";
import { useAuth } from "@/lib/AuthContext";
import { isSuperAdmin } from "@/lib/rbac";
import { detectDocumentProfile } from "@/lib/documentProfile";
import FieldReviewTable from "@/components/lease-review/FieldReviewTable";
import FieldTableFilter from "@/components/lease-review/FieldTableFilter";
import { SummaryStat } from "@/components/lease-review/SummaryStat";
import {
  SourceFileLink,
  findUploadedFileForLease,
  resolveUploadedFileUrl,
} from "@/components/lease-review/SourceFileLink";
import { BudgetPreviewCard } from "@/components/lease-review/BudgetPreviewCard";
import FieldDetailDrawer from "@/components/lease-review/FieldDetailDrawer";
import {
  buildSearchBlocksFromSources,
  findEvidenceForValue,
  buildCalculatedSupportingEvidence,
} from "@/components/lease-review/utils/evidenceResolver";
import {
  entryValue,
} from "@/components/lease-review/utils/fieldExtractors";
import {
  buildLeaseReviewRowsByTab,
  inferDynamicItemType,
  isReviewRowDisplayable,
} from "@/components/lease-review/utils/dynamicFields";
import {
  detectFieldConflicts,
  detectDocumentMismatch,
} from "@/components/lease-review/utils/validation";
import { updateLeaseQueryCache } from "@/components/lease-review/utils/leaseQueryUtils";
import { matchBuildingAndUnit } from "@/components/lease-review/utils/buildingUnitMatcher";
import { calculateSnapshotFiscalYears } from "@/components/lease-review/utils/projectionUtils";
import { buildBulkApprovalState } from "@/components/lease-review/utils/bulkApproval";
import { validateCrossFieldWarnings } from "@/components/lease-review/utils/crossFieldValidator";

import {
  RentScheduleTable,
  CriticalDatesTable,
  ClauseRecordsTable,
} from "@/components/lease-review/SpecializedTables";
import ExtractionDebugPanel from "@/components/lease-review/ExtractionDebugPanel";

// Minimum number of source-backed fields required before a new extraction is
// considered "richer" than the previous one. Used only for debug diagnostics.
const SOURCE_BACKED_MIN_THRESHOLD = 1;

export default function LeaseReview() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const urlParams = new URLSearchParams(location.search);
  const leaseId = urlParams.get("id");

  const { trigger: triggerCompute } = useComputeTrigger();

  const { user } = useAuth();
  const isSuperAdminUser = isSuperAdmin(user);

  // UI state
  const [activeTab, setActiveTab] = useState("summary");
  const [editingField, setEditingField] = useState(null);
  const [editValue, setEditValue] = useState("");
  const [showSignature, setShowSignature] = useState(false);
  const [showApproval, setShowApproval] = useState(false);
  const [showPostApprovalBanner, setShowPostApprovalBanner] = useState(false);
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

  // Field review state - keyed by field key.
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

  // Fetch the source uploaded_file so readFieldValue can resolve extraction
  // data from ui_review_payload (the pipeline stores extracted fields there,
  // not on lease.extraction_data, until the abstract is approved).
  const resolvedSourceFileId = lease?.source_file_id ?? lease?.extraction_data?.source_file_id ?? null;
  const { data: uploadedFile, isFetching: isUploadedFileFetching } = useQuery({
    queryKey: ["uploaded_file_for_lease", resolvedSourceFileId],
    queryFn: async () => {
      if (!resolvedSourceFileId) return null;
      const { data, error } = await supabase
        .from("uploaded_files")
        .select("id, status, ui_review_payload, reviewed_output, normalized_output")
        .eq("id", resolvedSourceFileId)
        .single();
      if (error) {
        console.warn("[LeaseReview] uploaded_files fetch error:", error.message);
        return null;
      }
      return data;
    },
    enabled: !!resolvedSourceFileId,
  });

  // Merged lease object used for display only (FieldReviewTable, summary stats).
  // Mutation logic (save, approve, edit) continues to use the raw `lease`.
  const leaseFull = useMemo(() => {
    if (!lease) return lease;
    if (!uploadedFile) return lease;
    return { ...lease, uploaded_files: uploadedFile, uploaded_file: uploadedFile };
  }, [lease, uploadedFile]);

  // Detect cases where the uploaded document's extracted fields contradict the
  // stored lease values - usually signals the wrong PDF was linked.
  const documentMismatches = useMemo(
    () => detectDocumentMismatch(lease, uploadedFile),
    [lease, uploadedFile],
  );

  const isStalePayload = useMemo(() => {
    const version = uploadedFile?.ui_review_payload?.metadata?.extraction_contract_version ??
                    lease?.extraction_data?.extraction_debug?.extraction_contract_version;
    return !version || version < "lease-review-evidence-v3";
  }, [uploadedFile, lease]);

  // Per-tab "show missing fields" toggle. false = extracted only (default).
  // Must be declared here (before any early returns) so hooks always execute
  // in the same order.
  const [showMissingByTab, setShowMissingByTab] = useState({});

  // Custom field add dialog state
  const [customFieldDialog, setCustomFieldDialog] = useState(null); // { tabKey }
  const [customFieldForm, setCustomFieldForm] = useState({ label: "", value: "", sourceText: "", sourcePage: "" });
  const [customFieldSaving, setCustomFieldSaving] = useState(false);
  // User-added custom fields per tab (survives re-renders within the session)
  const [userCustomFields, setUserCustomFields] = useState({});

  const fieldsForTab = useMemo(() => {
    return buildLeaseReviewRowsByTab(leaseFull, { userCustomFields });
  }, [leaseFull, userCustomFields]);

  const allReviewRows = useMemo(() => Object.values(fieldsForTab).flat(), [fieldsForTab]);
  const reviewRowByKey = useMemo(() => {
    const map = new Map();
    allReviewRows.forEach((row) => {
      if (row?.key && !map.has(row.key)) map.set(row.key, row);
      if (row?.field_key && !map.has(row.field_key)) map.set(row.field_key, row);
    });
    return map;
  }, [allReviewRows]);

  const crossFieldWarnings = useMemo(
    () => validateCrossFieldWarnings(reviewRowByKey, leaseFull),
    [reviewRowByKey, leaseFull],
  );

  // Hydrate field reviews from the lease record when it loads. Prefer the
  // dedicated lease_field_reviews table (queryable audit trail); fall back
  // to extraction_data.field_reviews for older records.
  //
  // We hydrate ONCE per lease id. Subsequent refetches (triggered by
  // saveAbstractDraft, mutation invalidations, auto-extract, etc.) must NOT
  // overwrite local state - otherwise an Accept the user just clicked would
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
      // `lease_field_reviews` is an optional SQL mirror for reporting. In
      // client-side review, the authoritative state is the JSONB map on the
      // lease row; querying the mirror can be blocked by RLS in deployed
      // projects and creates noisy 403s while the review still works.
      const nextReviews = lease.extraction_data?.field_reviews || {};
      if (!cancelled) setFieldReviews(nextReviews);
    })();
    return () => {
      cancelled = true;
    };
  }, [lease?.id]);  

  // Auto-link: when a lease has no source_file_id, search uploaded_files
  // for a matching upload by tenant_name / property_id / building_id /
  // unit_id and link it automatically. Also keeps the ranked candidate
  // list around so the banner can show a picker if no candidate clears
  // the score threshold.
  const [linkCandidates, setLinkCandidates] = useState([]); // [{id, file_name, score, status}]
  const [autoLinkDebug, setAutoLinkDebug] = useState(null); // { query_count, tenant, found, top_score }
  useEffect(() => {
    if (!lease?.id || !supabase) return;
    if (lease.source_file_id || lease.extraction_data?.source_file_id) {
      setLinkCandidates([]);
      setAutoLinkDebug(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        // Cast a wide net - every module_type, broad status filter.
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
        // Prefer lease uploads but don't exclude others outright - the
        // module_type column has been inconsistent across the codebase.
        const leaseLike = (files || []).filter((f) => {
          const mod = String(f.module_type || "").toLowerCase();
          if (!mod) return true; // unknown module -> include
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

        // Sort by score desc, then by updated_at desc - so ties between
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
        //   - Score must clear the minimum (>= 5)
        //   - Decisive if ANY of:
        //       a) Every tied-at-top candidate has the same normalized filename
        //          (re-uploads of the same document - not ambiguous)
        //       b) Top beats the runner-up of a DIFFERENT filename by >= 3 points
        //       c) Top score is very high (>= 10) AND >= 2 of the tied candidates
        //          share the top's normalized filename - pick the most recent
        //          from that filename group regardless of unrelated ties
        const top = ranked[0];
        if (!top || top.score < 5 || cancelled) {
          console.log("[LeaseReview] auto-link: skip - no candidate clears minimum score (top:", top?.score, "min: 5)");
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
          console.log("[LeaseReview] auto-link: skip - no decisive winner. Top tied with different-named candidates; user must pick manually.");
          return;
        }

        // When multiple uploads tie at the top score and share the filename,
        // pick the most recent of that group (ranked sort already ordered
        // them updated_at desc within score). This avoids accidentally
        // linking a different-name candidate that happens to share the score.
        const chosen = (allTiedSameFile || highScoreSameFileMajority) ? sameFileTies[0] : top;

        const autoLinkPatch = {
          source_file_id: chosen.file.id,
          source_file_name: chosen.file.file_name ?? null,
          auto_linked_at: new Date().toISOString(),
          auto_link_score: chosen.score,
          auto_link_reasons: chosen.reasons,
        };
        const nextExtraction = {
          ...(lease.extraction_data || {}),
          ...autoLinkPatch,
        };
        try {
          await updateLeaseExtractionField({
            leaseId: lease.id,
            fieldArea: "source_link",
            action: "source_file_auto_linked",
            patch: autoLinkPatch,
          });
        } catch (updateErr) {
          console.warn("[LeaseReview] auto-link write failed:", updateErr?.message || updateErr);
          return;
        }
        console.log(`[LeaseReview] auto-linked lease ${lease.id} -> uploaded_files ${chosen.file.id} (score=${chosen.score}, file=${chosen.file.file_name}, reasons=${chosen.reasons.join("+")})`);

        // Update the React-Query cache immediately so the page reflects the
        // new source_file_id without waiting for a refetch round-trip. The
        // invalidate still runs so server state is the source of truth.
        try {
          updateLeaseQueryCache(queryClient, leaseId, { extraction_data: nextExtraction });
        } catch { /* setQueryData best-effort */ }
        queryClient.invalidateQueries({ queryKey: ["lease", leaseId] });
      } catch (err) {
        console.warn("[LeaseReview] auto-link skipped:", err?.message || err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [lease?.id]);  

  // Manual link from the banner picker.
  const handleLinkSourceFile = async (fileId) => {
    if (!fileId || !lease?.id) return;
    try {
      const picked = linkCandidates.find((c) => c.id === fileId);
      const manualLinkPatch = {
        source_file_id: fileId,
        source_file_name: picked?.file_name ?? null,
        manually_linked_at: new Date().toISOString(),
      };
      await updateLeaseExtractionField({
        leaseId: lease.id,
        fieldArea: "source_link",
        action: "source_file_manually_linked",
        patch: manualLinkPatch,
      });
      const nextExtraction = {
        ...(lease.extraction_data || {}),
        ...manualLinkPatch,
      };
      toast.success(`Linked to ${picked?.file_name || fileId}`);
      updateLeaseQueryCache(queryClient, leaseId, { extraction_data: nextExtraction });
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
    // source_file_id lives on the top-level lease row in production; the
    // extraction_data path is a legacy fallback from older pipeline versions.
    const sourceFileId = lease.source_file_id ?? ed.source_file_id;
    if (!sourceFileId) return;

    const reviewFieldKeys = LEASE_REVIEW_FIELDS.map((field) => field.key);
    const extractedFieldKeys = Object.keys(ed.fields || {});
    const candidateKeys = [...new Set([...reviewFieldKeys, ...extractedFieldKeys])];
    const needsEvidenceBackfill = candidateKeys.some((key) => {
      const value = readFieldValue(lease, key) ?? entryValue(ed.fields?.[key]);
      if (value == null || value === "") return false;
      const evidence = readFieldEvidence(lease, key);
      return !evidence.sourcePage && !evidence.sourceText;
    });
    if (!needsEvidenceBackfill) return;

    let cancelled = false;
    (async () => {
      try {
        const { data: file, error } = await supabase
          .from("uploaded_files")
          .select("ui_review_payload, docling_raw, normalized_output, parsed_data")
          .eq("id", sourceFileId)
          .maybeSingle();
        if (error || !file || cancelled) return;

        // - Step 1: pull whatever evidence the ui_review_payload already has.
        //
        // The extraction pipeline stores field data in two different shapes:
        //   A) Array format: records[0].standard_fields / .custom_fields
        //      -> each item is { field_key, value, evidence: { source_clause, ... } }
        //   B) Object map format: records[0].fields / .workflow_output.lease_fields
        //      -> each entry is { field_key: { value, source_text, source_page, ... } }
        //
        // We must handle BOTH. Previously only format A was read, causing
        // source_text from format B to be silently dropped and every such field
        // to display "No source" even when the pipeline returned a full quote.
        const fieldsWithEvidence = {};
        const fieldEvidence = {};
        const reviewedRow = (file.ui_review_payload?.records || file.ui_review_payload?.rows || [])[0];
        if (reviewedRow) {
          // - A) Array format -
          const allFields = [
            ...(Array.isArray(reviewedRow.standard_fields) ? reviewedRow.standard_fields : []),
            ...(Array.isArray(reviewedRow.custom_fields) ? reviewedRow.custom_fields : []),
          ];
          for (const field of allFields) {
            if (!field?.field_key) continue;
            const sourceText = cleanSourceEvidenceText(
              field.evidence?.exact_source_text ?? field.evidence?.source_clause ?? field.evidence?.source_text,
            );
            fieldsWithEvidence[field.field_key] = {
              value: field.value ?? null,
              confidence: typeof field.confidence === "number" ? field.confidence : null,
              source: field.source ?? null,
              evidence: field.evidence ?? null,
              source_page: field.evidence?.page_number ?? null,
              source_text: sourceText,
              raw_value: field.original_value ?? field.evidence?.raw_value ?? null,
              extraction_status: field.status ?? null,
            };
            if (field.evidence) {
              fieldEvidence[field.field_key] = {
                raw_value: field.original_value ?? field.evidence.raw_value ?? null,
                source_page: field.evidence.page_number ?? field.evidence.source_page ?? null,
                source_text: sourceText,
                extraction_status: field.status ?? null,
              };
            }
          }

          // - B) Object map format -
          // Covers records[0].fields, records[0].workflow_output.lease_fields,
          // and any other object map the pipeline might write.
          const objectMaps = [
            reviewedRow.fields,
            reviewedRow.workflow_output?.lease_fields,
            reviewedRow.workflow_output?.records?.[0]?.lease_fields,
          ];
          for (const map of objectMaps) {
            if (!map || typeof map !== "object" || Array.isArray(map)) continue;
            for (const [key, entry] of Object.entries(map)) {
              if (!key || !entry || typeof entry !== "object") continue;
              // Don't overwrite a richer record already added from format A.
              if (fieldEvidence[key]?.source_text) continue;
              const sourceText = cleanSourceEvidenceText(
                entry.exact_source_text ?? entry.exactSourceText
                ?? entry.source_clause ?? entry.source_text ?? entry.snippet
                ?? entry.evidence?.source_clause ?? entry.evidence?.source_text ?? null,
              );
              const sourcePage = entry.source_page ?? entry.sourcePage ?? entry.page_number ?? entry.page
                ?? entry.evidence?.source_page ?? entry.evidence?.page_number ?? null;
              const value = entry.normalized_value ?? entry.value ?? entry.raw_value ?? null;
              if (value == null && !sourceText) continue;
              fieldsWithEvidence[key] = {
                ...(fieldsWithEvidence[key] || {}),
                value,
                source_page: sourcePage,
                source_text: sourceText,
                raw_value: entry.raw_value ?? entry.rawValue ?? value,
                confidence: typeof entry.confidence_score === "number" ? entry.confidence_score
                  : typeof entry.confidence === "number" ? entry.confidence : null,
                extraction_status: entry.extraction_status ?? entry.extractionStatus ?? null,
              };
              if (sourceText || sourcePage != null) {
                fieldEvidence[key] = {
                  raw_value: entry.raw_value ?? entry.rawValue ?? value,
                  source_page: sourcePage,
                  source_text: sourceText,
                  extraction_status: entry.extraction_status ?? entry.extractionStatus ?? "extracted",
                };
              }
            }
          }
        }

        // - Step 2: synthesize evidence by text-matching every known field
        // value against the docling text blocks. This is the fallback that
        // works even when the original extractor stamped no evidence at all.
        const blocks = buildSearchBlocksFromSources(
          file.docling_raw,
          file.normalized_output,
          file.parsed_data,
          file.ui_review_payload,
        );
        if (blocks.length > 0) {
          const fieldByKey = new Map(LEASE_REVIEW_FIELDS.map((field) => [field.key, field]));
          for (const key of candidateKeys) {
            try {
              const field = fieldByKey.get(key) || {
                key,
                type: inferDynamicItemType(ed.fields?.[key], key),
              };
              const value = readFieldValue(lease, key) ?? entryValue(ed.fields?.[key]);
              if (value == null || value === "") continue;
              // Don't overwrite real source text we already have. If a row has
              // only a page or only a raw value, still try to attach the quote.
              const existing = fieldEvidence[key] || ed.field_evidence?.[key];
              if (existing?.source_text) continue;
              const hit = findEvidenceForValue(blocks, value, field);
              if (!hit) continue;
              const sourcePage = hit.page ?? existing?.source_page ?? existing?.page_number ?? null;
              fieldEvidence[key] = {
                ...(existing || {}),
                raw_value: existing?.raw_value ?? hit.raw,
                source_page: sourcePage,
                source_text: hit.text,
                extraction_status: "extracted_text_match",
              };
              fieldsWithEvidence[key] = {
                ...(fieldsWithEvidence[key] || {}),
                ...(ed.fields?.[key] || {}),
                value,
                raw_value: ed.fields?.[key]?.raw_value ?? hit.raw,
                source_page: sourcePage,
                source_text: hit.text,
                extraction_status: "extracted_text_match",
              };
            } catch (fieldErr) {
              console.warn(`[LeaseReview] evidence backfill: field "${key}" threw:`, fieldErr?.message);
            }
          }
        }

        // Step 3: calculated values cannot honestly claim their own exact
        // value was quoted. Still, reviewers need the source clause that
        // supports the calculation (e.g. monthly rent derived from an annual
        // rent sentence). Attach that supporting quote and keep the status
        // as calculated.
        for (const key of candidateKeys) {
          const value = readFieldValue(lease, key) ?? entryValue(ed.fields?.[key]);
          if (value == null || value === "") continue;
          const existing = fieldEvidence[key] || ed.field_evidence?.[key];
          if (existing?.source_text) continue;
          const supporting = buildCalculatedSupportingEvidence({
            key,
            value,
            lease,
            ed,
            fieldEvidence,
            fieldsWithEvidence,
          });
          if (!supporting) continue;
          fieldEvidence[key] = {
            ...(existing || {}),
            ...supporting,
          };
          fieldsWithEvidence[key] = {
            ...(fieldsWithEvidence[key] || {}),
            ...(ed.fields?.[key] || {}),
            value,
            ...supporting,
          };
        }

        const wf = file.ui_review_payload?.metadata?.workflow_output;
        const workflowOutput = Array.isArray(wf?.records) ? wf.records[0] : wf || null;

        if (Object.keys(fieldEvidence).length === 0 && !workflowOutput) {
          // Nothing to backfill - don't churn the row.
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
  }, [lease?.id]);  

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
  // throwing - otherwise the approval flow sees an error toast for an
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
        .select("id, row_status, review_status, approval_status, expense_category, cam_eligible, rule_type, admin_fee_percent, gross_up_percent, cap_percent, cap_amount, estimated_annual_amount, estimated_monthly_amount, tenant_share_percent, reconciliation_required")
        .eq("rule_set_id", ruleSet.id);
      if (rulesErr && (rulesErr.code === "PGRST205" || rulesErr.code === "42P01")) {
        return { ruleSet, expense: { total: 0, approved: 0 }, cam: { total: 0, approved: 0 }, tableMissing: true };
      }
      
      const totals = (rules || []).reduce(
        (acc, r) => {
          const expenseCat = String(r.expense_category || "").toLowerCase().replace(/[^a-z0-9]+/g, "_");
          const isCam = Boolean(
            ["cam", "operating_expenses", "common_area_maintenance"].includes(expenseCat) ||
            String(r.cam_eligible).toLowerCase() === "yes" ||
            String(r.rule_type || "").startsWith("cam_") ||
            r.admin_fee_percent != null ||
            r.gross_up_percent != null ||
            r.cap_percent != null ||
            r.cap_amount != null ||
            r.estimated_annual_amount != null ||
            r.estimated_monthly_amount != null ||
            r.tenant_share_percent != null ||
            r.reconciliation_required === true
          );

          const isApproved = String(r.approval_status || r.row_status).toLowerCase() === "approved" &&
            ["approved", "reviewed"].includes(String(r.review_status || r.row_status).toLowerCase());

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

  // Detect assignment/amendment-only documents so the rule-readiness banner
  // says something accurate. The pipeline tags these docs with
  // Classify the document using leaseFull so uploaded-file payload data
  // (ui_review_payload.records[0].*) is included in the signal check.
  // detectDocumentProfile uses full-lease signals (commencement, expiration,
  // rent) to override an incorrect AI-stamped "assignment" documentType.
  const isAssignmentOnlyDocument = useMemo(
    () => {
      const profile = detectDocumentProfile(leaseFull);
      return profile === "assignment" || profile === "amendment" || profile === "estoppel" || profile === "consent";
    },
    [leaseFull],
  );

  const updateLeaseMutation = useMutation({
    mutationFn: async ({ id, data }) => leaseService.update(id, data),
    onSuccess: (updated) => {
      // Seed the cache with the returned row so a chained read (e.g.
      // Save edit -> Accept) sees the new evidence immediately, without
      // waiting for the invalidation-triggered refetch to complete.
      if (updated && updated.id === leaseId) {
        updateLeaseQueryCache(queryClient, leaseId, updated);
      }
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

  const handleMarkAsFullLease = async () => {
    try {
      await updateLeaseExtractionField({
        leaseId: lease.id,
        fieldArea: "lease_flag",
        action: "document_type_override_set",
        patch: { document_type_override: "full_lease" },
      });
      const nextExtraction = {
        ...(lease.extraction_data || {}),
        document_type_override: "full_lease",
      };
      updateLeaseQueryCache(queryClient, leaseId, { extraction_data: nextExtraction });
      queryClient.invalidateQueries({ queryKey: ["lease", leaseId] });
      toast.success("Marked as full lease - banner dismissed.");
    } catch (err) {
      console.error("[LeaseReview] mark as full lease failed:", err);
      toast.error(err?.message || "Could not save override. Try again.");
    }
  };

  // Auto-run extraction the first time we land on a lease that hasn't been
  // through the full re-extract pipeline yet. The canonical "extraction has
  // been finalized" marker is `evidence_refreshed_at`, which only
  // handleReextractLease writes - review-approve creates the lease draft
  // with workflow_output as a placeholder but does NOT pull per-field
  // evidence from ui_review_payload.records[0].standard_fields the way
  // re-extract does. So the gate now skips only when:
  //   1. evidence_refreshed_at is already set (full pipeline ran), OR
  //   2. there is no source_file_id (nothing to re-extract from), OR
  //   3. there ARE meaningful fields with evidence (pre-existing lease that
  //      has good evidence even without the marker - don't disturb it).
  // This unifies the upload + re-extract paths so a freshly uploaded lease
  // gets the same field-evidence enrichment and lease-expense-rule
  // extraction as a manual Re-extract click.
  const autoExtractFiredRef = useRef(null);
  useEffect(() => {
    if (!lease?.id) return;
    if (autoExtractFiredRef.current === lease.id) return;
    if (reextracting) return;
    const sourceFileId = lease?.source_file_id ?? lease?.extraction_data?.source_file_id;
    if (!sourceFileId) return;

    // Wait until the uploadedFile query has resolved. `uploadedFile` is
    // `undefined` while the query is in-flight; it becomes null (not found /
    // error) or a real row once settled. Firing before that means all payload
    // checks (3b, 3c, 3d) see null and auto-re-extract fires incorrectly.
    if (isUploadedFileFetching || uploadedFile === undefined) return;

    // Helper: mark this lease as handled so the effect never fires twice.
    const done = () => { autoExtractFiredRef.current = lease.id; };

    // 1. Pipeline already finalized this lease.
    if (lease?.extraction_data?.evidence_refreshed_at) { done(); return; }

    // 1b. Lease top-level columns have meaningful values AND there's actual
    // extraction evidence - extraction already ran with real results.
    // NOTE: top-level columns can be set from scope selection (unit/building
    // context) without any LLM extraction running. We only skip if there's
    // also real field evidence proving extraction occurred.
    const leaseHasTopLevel = !!(
      lease?.tenant_name || lease?.monthly_rent || lease?.start_date ||
      lease?.end_date || lease?.commencement_date || lease?.expiration_date
    );
    const hasExtractionEvidence = !!(
      lease?.extraction_data?.evidence_refreshed_at ||
      (lease?.extraction_data?.field_evidence && Object.keys(lease.extraction_data.field_evidence || {}).length > 0)
    );
    if (leaseHasTopLevel && hasExtractionEvidence) {
      console.log("[LeaseReview] auto-extract: skip - lease has top-level values with extraction evidence");
      done(); return;
    }

    // 1c. extraction_data.fields has at least one non-null value.
    const edFields = lease?.extraction_data?.fields;
    const hasEdFields = edFields && typeof edFields === "object" &&
      Object.values(edFields).some((f) => f && typeof f === "object" && f.value != null && f.value !== "");
    if (hasEdFields) {
      console.log("[LeaseReview] auto-extract: skip - extraction_data.fields has meaningful values");
      done(); return;
    }

    // 1d. workflow_output.lease_fields has at least one non-null value.
    const wfLeaseFields = lease?.extraction_data?.workflow_output?.lease_fields;
    const hasWfFields = wfLeaseFields && typeof wfLeaseFields === "object" &&
      Object.values(wfLeaseFields).some((f) => f && typeof f === "object" && f.value != null && f.value !== "");
    if (hasWfFields) {
      console.log("[LeaseReview] auto-extract: skip - workflow_output.lease_fields has meaningful values");
      done(); return;
    }

    // 2. Lease already has per-field evidence stored (pre-evidence_refreshed_at
    //    leases that were reviewed before the flag was introduced).
    const fieldEvidence = lease?.extraction_data?.field_evidence;
    const hasPersistedEvidence =
      fieldEvidence &&
      typeof fieldEvidence === "object" &&
      Object.values(fieldEvidence).some(
        (e) => e && typeof e === "object" && (e.source_page != null || (typeof e.source_text === "string" && e.source_text.trim().length > 0)),
      );
    if (hasPersistedEvidence) {
      console.log("[LeaseReview] auto-extract: skip - lease already has per-field evidence");
      done(); return;
    }

    // 3. The uploaded file's ui_review_payload already contains extracted field data.
    const uiPayload = uploadedFile?.ui_review_payload;
    const ufRecord0 = (uiPayload?.records?.[0]) ?? null;
    const ufFieldMap =
      ufRecord0?.workflow_output?.lease_fields ||
      ufRecord0?.fields ||
      ufRecord0?.standard_fields ||
      null;
    // Only treat the payload as having real data when at least one field has a
    // non-null value. An all-null payload means the prior run had no LLM configured;
    // allow a re-extract in case credentials have since been added.
    const hasRealValues =
      ufFieldMap &&
      typeof ufFieldMap === "object" &&
      Object.values(ufFieldMap).some(
        (f) => f && typeof f === "object" && "value" in f && f.value != null && f.value !== "",
      );
    const hasUploadedFileData =
      ufFieldMap &&
      typeof ufFieldMap === "object" &&
      Object.keys(ufFieldMap).length > 2 &&
      hasRealValues;
    if (hasUploadedFileData) {
      console.log("[LeaseReview] auto-extract: skip - uploaded file already has extracted field data in ui_review_payload");
      done(); return;
    }

    // 3b. Pipeline ran but core mapping failed - retrying won't help without a
    // source-file change.
    if (uiPayload && (uiPayload.mapping_failed || uiPayload.metadata?.extractionDebug?.core_mapping_failed)) {
      console.log("[LeaseReview] auto-extract: skip - pipeline ran but core mapping failed");
      done(); return;
    }

    // 3c. ui_review_payload.records exists with real values - pipeline ran with results.
    if (uiPayload && Array.isArray(uiPayload.records) && uiPayload.records.length > 0 && hasRealValues) {
      console.log("[LeaseReview] auto-extract: skip - ui_review_payload present with extracted values");
      done(); return;
    }

    // 3d. Uploaded file already has a terminal status - pipeline ran.
    // When there are no real extracted values (all-null prior run) we allow a
    // one-shot auto-re-extract even from review_required so that newly configured
    // Vertex AI / Docling credentials take effect without a manual click.
    const ufStatus = uploadedFile?.status ?? uploadedFile?.processing_status ?? null;
    const terminalStatuses = hasRealValues
      ? ["review_required", "validated", "approved", "completed", "failed", "stored"]
      : ["validated", "approved", "completed", "stored"];
    if (ufStatus && terminalStatuses.includes(String(ufStatus))) {
      console.log(`[LeaseReview] auto-extract: skip - uploaded file status=${ufStatus} (pipeline already ran)`);
      done(); return;
    }

    // 4. A recent auto-extract failure for this lease was recorded in
    //    sessionStorage. Don't hammer the edge function; wait for the user to
    //    manually trigger Re-extract Lease once resources are available.
    const failureKey = `lease_auto_extract_failed_${lease.id}`;
    const lastFailedAt = Number(sessionStorage.getItem(failureKey) || 0);
    const RETRY_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes
    if (lastFailedAt && Date.now() - lastFailedAt < RETRY_COOLDOWN_MS) {
      console.log("[LeaseReview] auto-extract: skip - recent failure recorded, waiting for manual retry");
      done(); return;
    }

    done();
    console.log("[LeaseReview] auto-running re-extract - source linked but no extracted data found yet");
    toast.info("Running full lease extraction in the background...");
    handleReextractLease();
  }, [
    lease?.id,
    lease?.source_file_id,
    lease?.extraction_data?.source_file_id,
    lease?.extraction_data?.evidence_refreshed_at,
    lease?.extraction_data?.field_evidence,
    uploadedFile,
    isUploadedFileFetching,
    reextracting,
  ]);

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

  if (import.meta.env.DEV) {
    const requiredLogs = REQUIRED_FIELD_KEYS.map(k => {
      const resolved = resolveLeaseField(lease, k, { mode: "canonical" });
      return {
        field: k,
        status: resolved?.found ? "found" : "missing",
        sourcePath: resolved?.sourcePath || "none",
        reason: !resolved?.found ? (readFieldValue(lease, k) ? "stale/placeholder" : "missing entirely") : "N/A"
      };
    });
    console.table(requiredLogs);
  }

  const totalFields = LEASE_REVIEW_FIELDS.length;
  const resolvedCount = LEASE_REVIEW_FIELDS.reduce(
    (acc, f) => acc + (isResolvedReview(fieldReviews[f.key]) ? 1 : 0),
    0,
  );

  // Confidence buckets from visible canonical rows. Unknown confidence with
  // real evidence still counts as extracted instead of "failed extraction".
  const confidenceBuckets = allReviewRows.reduce(
    (acc, f) => {
      if (!isReviewRowDisplayable(f, { showMissing: false })) return acc;
      const value = f.normalized_value ?? f.value ?? readFieldValue(leaseFull, f.key);
      if (!isMeaningfulValue(value)) return acc;
      const sourceQuality = f.source_text_quality ?? resolveSourceTextQuality({
        value,
        sourceText: f.source_text,
        sourcePage: f.page_number ?? f.source_page,
        extractionStatus: f.extraction_status ?? f.status,
        evidenceType: f.evidence_type,
        sourceFieldKeys: f.source_field_keys,
        derivationTrace: f.derivation_trace,
      });
      if (["missing", "conflict", "inconsistent"].includes(sourceQuality)) return acc;
      const score = typeof f.confidence === "number" ? f.confidence : readFieldConfidence(leaseFull, f.key);
      const bucket = classifyConfidence(score);
      if (f.evidence_type === "derived" && bucket === "unknown") {
        acc.unknown += 1;
      } else {
        acc[bucket] += 1;
      }
      return acc;
    },
    { high: 0, medium: 0, low: 0, unknown: 0 },
  );

  const reviewCandidateRowsCount = allReviewRows.filter((row) =>
    isReviewRowDisplayable(row, { showMissing: false }) &&
    (isMeaningfulValue(row.normalized_value ?? row.value) || row.requires_review || row.review_reason)
  ).length;

  // Manual_required + conflicts surface as their own counters.
  const manualRequiredCount = Object.values(fieldReviews).filter(
    (r) => r?.status === REVIEW_STATUSES.MANUAL_REQUIRED || r?.status === REVIEW_STATUSES.NEEDS_LEGAL,
  ).length + allReviewRows.filter((row) => {
    const quality = row.source_text_quality ?? resolveSourceTextQuality({
      value: row.normalized_value ?? row.value,
      sourceText: row.source_text,
      sourcePage: row.page_number ?? row.source_page,
      evidenceType: row.evidence_type,
      extractionStatus: row.extraction_status ?? row.status,
    });
    return row.requires_review || row.evidence_type === "inferred" || quality === "conflict";
  }).length;
  const conflicts = detectFieldConflicts(lease);
  const conflictKeySet = new Set(conflicts.map((c) => c.field_key));

  // Core mapping failure: expense terms can be keyword-detected even when no
  // standard lease field was mapped from the document. When that happens we
  // must not present the expense-term counts as a successful extraction.
  const mappingDebug = lease?.extraction_data?.extraction_debug || {};
  const mappingWorkflowSummary =
    lease?.extraction_data?.workflow_output?.summary
    || lease?.extraction_data?.workflow_output?.records?.[0]?.summary
    || {};
  const coreMappingFailed = Boolean(
    mappingDebug.core_mapping_failed
    ?? mappingDebug.mapping_failure_reason
    ?? mappingWorkflowSummary.core_mapping_failed
    ?? mappingWorkflowSummary.mapping_failure_reason,
  );
  const workflowExpenseTermsFound = Number(mappingWorkflowSummary.lease_expense_terms_found ?? 0) || 0;
  const workflowCamTermsFound = Number(mappingWorkflowSummary.cam_terms_found ?? 0) || 0;
  const effectiveExpenseTermsFound = Math.max(Number(ruleSetSummary?.expense?.total ?? 0) || 0, workflowExpenseTermsFound);
  const effectiveCamTermsFound = Math.max(Number(ruleSetSummary?.cam?.total ?? 0) || 0, workflowCamTermsFound);

  // Validation checks (kept for summary panel).
  // For each field, prefer the stored leases-table column but fall back to
  // readFieldValue(leaseFull) so the Summary tab shows extraction data even
  // before the abstract has been approved and columns written.
  const validationChecks = [];
  const src = leaseFull ?? lease;
  const commencementValue =
    lease.commencement_date || lease.start_date ||
    readFieldValue(src, "commencement_date") || readFieldValue(src, "start_date");
  const expirationValue =
    lease.expiration_date || lease.end_date ||
    readFieldValue(src, "expiration_date") || readFieldValue(src, "end_date");
  if (commencementValue && expirationValue) {
    const startOk = new Date(commencementValue) < new Date(expirationValue);
    validationChecks.push({
      pass: startOk,
      label: "Commencement < Expiration",
      detail: startOk
        ? `${commencementValue} -> ${expirationValue}`
        : "Expiration date is on/before commencement",
    });
  }
  const canonicalSummaryValue = (key, fallbackValue = null) => {
    const row = reviewRowByKey.get(key);
    if (row) {
      const rowValue = row.normalized_value ?? row.value;
      return isMeaningfulValue(rowValue) ? rowValue : null;
    }
    return isMeaningfulValue(fallbackValue) ? fallbackValue : readFieldValue(src, key);
  };
  const summaryTenantName = canonicalSummaryValue("tenant_name", lease.tenant_name);
  const summaryLeaseType = canonicalSummaryValue("lease_type", lease.lease_type);
  const summaryLeaseDate = canonicalSummaryValue("lease_date", lease.lease_date);
  const summaryMonthlyRent = canonicalSummaryValue("monthly_rent", lease.monthly_rent);
  const summaryAnnualRent = canonicalSummaryValue("annual_rent", lease.annual_rent);
  if (summaryTenantName) {
    validationChecks.push({ pass: true, label: "Tenant name present", detail: summaryTenantName });
  }
  if (summaryAnnualRent) {
    validationChecks.push({
      pass: Number(summaryAnnualRent) > 0,
      label: "Annual rent > $0",
      detail: `$${Number(summaryAnnualRent).toLocaleString()}`,
    });
  }
  const sf = lease.total_sf || lease.square_footage || readFieldValue(src, "square_footage");
  if (sf) {
    validationChecks.push({
      pass: Number(sf) > 0,
      label: "Square footage present",
      detail: `${Number(sf).toLocaleString()} SF`,
    });
  }
  validationChecks.push({
    pass: confidenceBuckets.low === 0,
    label: "All confidence scores >= 75%",
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

  const totalSf = lease.total_sf || lease.square_footage || readFieldValue(src, "square_footage");

  const scopedStakeholders = stakeholders.filter(
    (s) => !s.property_id || !lease.property_id || s.property_id === lease.property_id,
  );
  const signatureRecipients = scopedStakeholders.filter((s) => s.email);

  // --- Approval blockers ---------------------------------------------------
  const expenseCamUnreviewed =
    (effectiveExpenseTermsFound + effectiveCamTermsFound) > 0 &&
    !approvedRuleSet;

  const bulkEvaluation = (() => {
    const allKnownKeys = new Set();
    allReviewRows.forEach((f) => {
      if (f.key) allKnownKeys.add(f.key);
      if (f.field_key) allKnownKeys.add(f.field_key);
    });

    const eligibleFields = [];
    const requiredBlockers = [];
    const optionalUnresolved = [];
    const requiredBlockerDetails = [];
    const autoNaFields = [];
    const autoNaDetails = [];
    const validationBlockers = [];

    allKnownKeys.forEach((key) => {
      const fieldDef = LEASE_REVIEW_FIELDS.find((f) => f.key === key) || {};
      const row = reviewRowByKey.get(key) || fieldDef;
      const isRequired = REQUIRED_FIELD_KEYS.includes(key);
      const isDynamic = !fieldDef.key;
      
      const review = fieldReviews[key];
      const reviewStatus = review?.status || "pending";
      
      if (reviewStatus === REVIEW_STATUSES.N_A) {
        return; // already marked N/A - doesn't block
      }

      const existingValidationErrors = [
        ...(Array.isArray(row?.validation_errors) ? row.validation_errors : []),
        ...(Array.isArray(row?.validationErrors) ? row.validationErrors : []),
      ];
      if (existingValidationErrors.length > 0) {
        if (isRequired) {
          validationBlockers.push({ key, label: fieldDef.label || key, reason: existingValidationErrors.join(", ") });
          requiredBlockers.push(key);
          requiredBlockerDetails.push({ key, label: fieldDef.label || key, reason: "Field failed validation" });
        } else {
          optionalUnresolved.push(key);
        }
        return;
      }

      if (['accepted', 'approved'].includes(reviewStatus)) {
        return; // already approved - doesn't block
      }
      
      if (reviewStatus === REVIEW_STATUSES.MANUAL_REQUIRED) {
        if (isRequired) {
          requiredBlockers.push(key);
          requiredBlockerDetails.push({ key, label: fieldDef.label || key, reason: "Manual Review Required" });
        } else {
          optionalUnresolved.push(key);
        }
        return;
      }

      if (isRequired && (lease?.extraction_data?.conflicts?.[key] || row?.evidence_type === "conflict") && !isResolvedReview(review)) {
        requiredBlockers.push(key);
        requiredBlockerDetails.push({ key, label: fieldDef.label || key, reason: "Unresolved Conflict" });
        return;
      }
      
      const value = row?.normalized_value ?? row?.value ?? readFieldValue(leaseFull, key);
      const evidence = readFieldEvidence(leaseFull, key);
      const extractionStatus = row?.extraction_status ?? row?.status ?? resolveExtractionStatus(leaseFull, key, {
        value,
        confidence: row?.confidence,
        evidence: {
          ...evidence,
          value,
          sourceText: row?.source_text ?? evidence?.sourceText,
          sourcePage: row?.page_number ?? row?.source_page ?? evidence?.sourcePage,
          extractionStatus: evidence?.extractionStatus || "pending",
        },
      });
      const sourceQuality = row?.source_text_quality ?? resolveSourceTextQuality({
        value,
        sourceText: row?.source_text ?? evidence?.sourceText,
        sourcePage: row?.page_number ?? row?.source_page ?? evidence?.sourcePage,
        extractionStatus,
        evidenceType: row?.evidence_type ?? evidence?.evidenceType,
        sourceFieldKeys: row?.source_field_keys ?? evidence?.sourceFieldKeys,
        derivationTrace: row?.derivation_trace ?? evidence?.derivationTrace,
      });
      const hasValue = isMeaningfulValue(value);
      const hasValidSource = hasValidSourceEvidence({
        value,
        sourceText: row?.source_text ?? evidence?.sourceText,
        sourcePage: row?.page_number ?? row?.source_page ?? evidence?.sourcePage,
        extractionStatus,
        evidenceType: row?.evidence_type ?? evidence?.evidenceType,
        sourceTextQuality: sourceQuality,
        sourceFieldKeys: row?.source_field_keys ?? evidence?.sourceFieldKeys,
        derivationTrace: row?.derivation_trace ?? evidence?.derivationTrace,
      });
      const validationErrors = [
        ...(Array.isArray(row?.validation_errors) ? row.validation_errors : []),
        ...(Array.isArray(row?.validationErrors) ? row.validationErrors : []),
        ...(Array.isArray(evidence?.validationErrors) ? evidence.validationErrors : []),
      ];

      let eligible = false;
      let reason = "";

      if (validationErrors.length > 0) {
        validationBlockers.push({ key, label: fieldDef.label || key, reason: validationErrors.join(", ") });
        reason = "Field failed validation";
      } else if (['manual', 'manual_edited'].includes(extractionStatus) || ['edited', 'manual_resolved', REVIEW_STATUSES.N_A].includes(reviewStatus)) {
        eligible = true;
      } else if (['extracted', 'extracted_no_confidence', 'extracted_text_match'].includes(extractionStatus)) {
        if (hasValue && hasValidSource) {
          eligible = true;
        } else if (hasValue) {
          reason = "Missing Source Evidence";
        } else {
          reason = "Missing Value";
        }
      } else if (['calculated', 'derived', 'computed'].includes(extractionStatus) || row?.evidence_type === "derived") {
        if (hasValue && canAcceptCalculatedReviewField(row || fieldDef)) {
          eligible = true;
        } else {
          reason = "Calculated field not allowed for bulk approval";
        }
      } else if (extractionStatus === 'inferred' || row?.evidence_type === "inferred" || row?.requires_review) {
        reason = row?.approval_blocking_reason || "Requires Human Approval";
      } else if (extractionStatus === 'not_found' || extractionStatus === 'pending') {
        reason = "Not Found";
      } else if (extractionStatus === 'rejected' || reviewStatus === 'rejected') {
        reason = "Rejected";
      } else if (isDynamic && !hasValidSource) {
        reason = "Dynamic Row Missing Source Evidence";
      }

      if (isDynamic && !eligible) {
        reason = reason || "Missing Source Evidence";
      }

      if (eligible) {
        eligibleFields.push(key);
      } else {
        if (isRequired) {
          const isUserRejected = reason === "Rejected";
          if (isUserRejected) {
            // User explicitly rejected - stays rejected, doesn't block approval
            optionalUnresolved.push(key);
          } else {
            // Required extraction gaps are hard blockers.
            requiredBlockers.push(key);
            requiredBlockerDetails.push({ key, label: fieldDef.label || key, reason: reason || "Needs Review" });
          }
        } else {
          optionalUnresolved.push(key);
        }
      }
    });

    return { eligibleFields, requiredBlockers, optionalUnresolved, requiredBlockerDetails, autoNaFields, autoNaDetails, validationBlockers };
  })();

  const approvalBlockers = [];
  if (bulkEvaluation.validationBlockers.length > 0) {
    approvalBlockers.push({
      kind: "validation_errors",
      title: `${bulkEvaluation.validationBlockers.length} field validation error(s) must be resolved before approval`,
      detail: bulkEvaluation.validationBlockers
        .map((b) => `${b.label} (${b.reason})`)
        .join(", "),
    });
  }

  if (bulkEvaluation.requiredBlockers.length > 0) {
    approvalBlockers.push({
      kind: "required_pending",
      title: `${bulkEvaluation.requiredBlockers.length} required field(s) must be resolved before approval`,
      detail: bulkEvaluation.requiredBlockerDetails
        .map((b) => `${b.label} (${b.reason})`)
        .join(", "),
    });
  }

  const canApprove = approvalBlockers.length === 0;
  const blockerMessage = canApprove
    ? "All checks passed. You can approve the lease abstract."
    : approvalBlockers.map((b) => b.title).join(" - ");
  const approvalDisabledTooltip = canApprove
    ? "Approve the lease abstract"
    : "Cannot approve: required fields have unresolved conflicts or require manual review. Check the Expenses/CAM tabs.";

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

  const handleAddCustomField = async () => {
    const { label, value, sourceText, sourcePage } = customFieldForm;
    if (!label.trim()) { toast.error("Field name is required."); return; }
    const key = `custom_${label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}_${Date.now()}`;
    const tabKey = customFieldDialog?.tabKey;
    const newField = {
      key,
      label: label.trim(),
      type: "text",
      is_custom: true,
      dynamic_document_item: false,
      tab: tabKey,
    };
    setCustomFieldSaving(true);
    try {
      // Persist value + evidence into extraction_data so readFieldValue picks it up
      const fieldPatch = { value: value.trim() || null, source_text: sourceText.trim() || null, source_page: sourcePage ? Number(sourcePage) : null, extraction_status: "manually_added", manually_edited: true };
      const fieldEvidencePatch = { source_text: sourceText.trim() || null, source_page: sourcePage ? Number(sourcePage) : null, extraction_status: "manually_added" };
      await updateLeaseExtractionField({
        leaseId: lease.id,
        fieldArea: "field_value",
        action: "custom_field_added",
        fieldKey: key,
        patch: { field: fieldPatch, field_evidence: fieldEvidencePatch },
      });
      // Also add to fieldReviews so Accept/Reject work immediately
      const nextReviews = { ...fieldReviews, [key]: { status: REVIEW_STATUSES.PENDING, value: value.trim() || null, reviewed_at: new Date().toISOString() } };
      setFieldReviews(nextReviews);
      // Add to local session fields so table shows it without reload
      setUserCustomFields((prev) => ({ ...prev, [tabKey]: [...(prev[tabKey] || []), newField] }));
      queryClient.invalidateQueries({ queryKey: ["lease", leaseId] });
      setCustomFieldDialog(null);
      setCustomFieldForm({ label: "", value: "", sourceText: "", sourcePage: "" });
      toast.success("Custom field added.");
    } catch (err) {
      toast.error(err?.message || "Could not add custom field.");
    } finally {
      setCustomFieldSaving(false);
    }
  };

  const handleAccept = (field) => {
    // Re-read the lease from the React Query cache. The closure-captured
    // `lease` ref is stale right after a Save edit chains into Accept; the
    // cache has the fresh write but the parent component hasn't re-rendered
    // yet. Falling back to the captured ref keeps things safe if the cache
    // is somehow empty.
    //
    // The query uses `select: (data) => data?.[0]` - meaning the CACHE
    // holds the raw array returned by leaseService.filter (typically
    // `[leaseRow]`), while `useQuery`'s `data` is the unwrapped first
    // element. We have to unwrap here too, otherwise readFieldValue
    // receives an array and returns null, blocking Accept with
    // "Cannot accept a field with no value" even when the displayed
    // value is fine.
    const cached = queryClient.getQueryData(["lease", leaseId]);
    const freshLease = Array.isArray(cached) ? (cached[0] ?? lease) : (cached || lease);
    const value = readFieldValue(freshLease, field.key);
    const evidence = readFieldEvidence(freshLease, field.key);
    const hasEvidence = hasValidSourceEvidence(evidence);

    // Manual-override signals: the reviewer can accept without lease
    // evidence by explicitly marking the field as Manual Required, or by
    // having saved a reviewer-edited record (source: "manual" /
    // manually_edited: true). Treat any of these as the equivalent of
    // evidence for the Accept gate.
    const fieldRecord = freshLease?.extraction_data?.fields?.[field.key] || {};
    const extractionStatus = String(
      fieldRecord.extraction_status
        || freshLease?.extraction_data?.field_evidence?.[field.key]?.extraction_status
        || "",
    ).toLowerCase();
    const isManualOverride =
      isManualExtractionStatus(extractionStatus)
      || fieldRecord.manually_edited === true
      || String(fieldRecord.source || "").toLowerCase() === "manual";

    if (value == null || value === "") {
      toast.error("Cannot accept a field with no value. Edit, mark N/A, or mark Manual Required.");
      return;
    }
    const isCalculated = isCalculatedExtractionStatus(extractionStatus);
    if (!hasEvidence && !isManualOverride && !isCalculated) {
      toast.error("Cannot accept without source evidence. Edit and confirm the value, or mark Manual Required.");
      return;
    }
    if (isCalculated && !hasEvidence && !isManualOverride) {
      toast.error("Cannot accept a calculated value without supporting source evidence. Save the source quote/page, or mark Manual Required.");
      return;
    }
    if (isCalculated && !canAcceptCalculatedReviewField(field)) {
      toast.error("Cannot accept a calculated value as extracted. Edit/confirm it with source evidence, or mark Manual Required.");
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
    if (NUMERIC_REVIEW_FIELDS.has(key) || editingField.type === "number" || editingField.type === "currency") {
      const n = parseFloat(String(val).replace(/[$,]/g, ""));
      val = Number.isNaN(n) ? null : n;
    }
    if (editingField.type === "boolean") {
      val = val === true || val === "true" || val === "yes";
    }

    // Write fixed fields to every aliased column so legacy + new columns stay
    // in sync. Dynamic discovered rows live only in extraction_data because
    // they intentionally do not have rigid lease-table columns.
    const columnUpdates = {};
    if (!editingField.dynamic_document_item) {
      for (const column of resolveFieldColumns(key)) {
        columnUpdates[column] = val;
      }
    }
    // total_sf alias -> square_footage column (legacy).
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
      approvalBlockers.forEach((b) =>
        toast.error(b.title, { description: b.detail, duration: 7000 })
      );
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
      // --- Bulk Approval Pre-pass ---
      const { eligibleFields, autoNaFields: fieldsToAutoNa } = bulkEvaluation;
      const nowIso = new Date().toISOString();
      const signedBy = approvalSignedBy || lease?.signed_by;

      const { nextFieldReviews, auditDetails } = buildBulkApprovalState({
        eligibleFields,
        autoNaFields: fieldsToAutoNa || [],
        fieldReviews,
        lease,
        signedBy,
        nowIso,
        reviewStatuses: REVIEW_STATUSES,
      });

      const auditLogPromises = auditDetails.map((details) =>
        logAudit({
          entityType: "LeaseFieldReview",
          entityId: lease.id,
          action: details.approval_method === "bulk_auto_na" ? "field_bulk_na" : "field_bulk_accepted",
          orgId: lease.org_id,
          details,
        }).catch((err) => {
          console.warn(`[LeaseReview] Bulk audit failed for ${details.field_key}:`, err);
        })
      );

      await Promise.allSettled(auditLogPromises);

      let resolvedDocumentUrl = approvalDocumentUrl || null;
      if (!resolvedDocumentUrl && supabase) {
        const uploadedFile = await findUploadedFileForLease(lease);
        resolvedDocumentUrl = await resolveUploadedFileUrl(uploadedFile);
      }

      const approvalResult = await approveLeaseWorkflow({
        leaseId: lease.id,
        signedBy: approvalSignedBy,
        signedAt: approvalSignedAt,
        approvalComments,
        approvalDocumentUrl: resolvedDocumentUrl,
        fieldReviews: nextFieldReviews,
        idempotencyKey: createLeaseApprovalIdempotencyKey(lease.id),
      });
      const approvedLease = approvalResult.lease;

      updateLeaseQueryCache(queryClient, leaseId, approvedLease);
      queryClient.invalidateQueries({ queryKey: ["lease", leaseId] });
      queryClient.invalidateQueries({ queryKey: ["leases"] });

      // Auto-resolve building_id / unit_id when the lease was uploaded
      // without them. Looks up buildings & units under the lease's property
      // and matches against extracted text.
      try {
        if (
          supabase &&
          approvedLease?.id &&
          approvedLease?.property_id &&
          (!approvedLease.building_id || !approvedLease.unit_id)
        ) {
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

          const updates = matchBuildingAndUnit({
            approvedLease,
            candidateBuildings: candidateBuildings || [],
            candidateUnits: candidateUnits || [],
          });

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
      // authoritative monthly_projections to render - without the user
      // having to click Run Engine. Done across:
      //   - current FY, current+1, current-1 (covers the most common views)
      //   - the FY that contains the lease commencement (term first year)
      //   - both contracted_only and include_approved_renewals modes
      if (approvedLease?.property_id) {
        const fiscalYears = calculateSnapshotFiscalYears(approvedLease);
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

      queryClient.invalidateQueries({ queryKey: ["lease_critical_dates"] });

      let approvedExpenseRuleSet = null;
      // Persist expense rules using the new leaseRulePipelineService
      // which aggregates workflow + structured + templates + LLM + text fallback
      if (!isStalePayload) {
        try {
          const persisted = await leaseRulePipelineService.generateLeaseExpenseRulesForLease({
            leaseId: lease.id,
            source: "approve_abstract",
            force: false
          });
          console.log(
            `[LeaseReview] generateLeaseExpenseRulesForLease -> ${persisted?.persistedRulesCount || 0} rules persisted`,
            persisted
          );
        } catch (persistErr) {
          console.warn("[LeaseReview] generateLeaseExpenseRulesForLease skipped:", persistErr?.message || persistErr);
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
      }
      queryClient.invalidateQueries({ queryKey: ["Expense"] });

      toast.success(`Lease abstract approved (v${approvedLease.abstract_version || 1})`);
      setShowApproval(false);
      setShowPostApprovalBanner(true);
    } catch (err) {
      console.error("[LeaseReview] approve failed:", err);
      toast.error(err?.message || "Could not approve lease abstract");
    } finally {
      setApproving(false);
    }
  };

  const handleSendBack = async () => {
    try {
      await sendLeaseBackForReextraction({ leaseId: lease.id, reason: sendBackReason });
      queryClient.invalidateQueries({ queryKey: ["lease", leaseId] });
      queryClient.invalidateQueries({ queryKey: ["leases"] });
      toast.success("Sent back for re-extraction");
      setShowSendBack(false);
      const params = new URLSearchParams();
      if (lease.property_id) params.set("property", lease.property_id);
      if (lease.building_id) params.set("building", lease.building_id);
      if (lease.unit_id) params.set("unit", lease.unit_id);
      navigate(`${createPageUrl("LeaseUpload")}${params.toString() ? `?${params.toString()}` : ""}`);
    } catch (err) {
      console.error("[LeaseReview] send back failed:", err);
      toast.error(err?.message || "Could not send lease back for re-extraction");
    }
  };

  // One-click re-extract: invokes ingest-file -> polls until processing
  // completes -> copies the fresh ui_review_payload + workflow_output back
  // onto this lease. Saves the reviewer from the Re-link/Re-run/Apply Latest
  // dance for the common case where source_file_id is already set.
  async function handleReextractLease() {
    const sourceFileId = lease?.source_file_id ?? lease?.extraction_data?.source_file_id;
    if (!sourceFileId) {
      toast.error("No source file linked. Use Extraction Debug -> Re-link Source Document first.");
      setShowReextractConfirm(false);
      return;
    }
    setReextracting(true);
    setReextractStage("running");
    setShowReextractConfirm(false);
    setFieldReviews({});
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

      // When parse-pdf-docling or normalize-pdf-output fails, ingest-file calls
      // parkForManualReview and returns { error: false, manual_review: true,
      // stage: "extraction"|"normalization", error_details: "..." }.
      // Surface the failure reason immediately instead of silently applying an
      // empty manual-review payload.
      if (ingestData?.manual_review === true) {
        const stage = ingestData?.stage || "extraction";
        const detail = ingestData?.error_details || "Unknown error";
        console.warn(`[Re-extract] pipeline fell back to manual review at stage=${stage}:`, detail);
        const stageLabel = stage === "normalization" ? "normalization" : "document parsing";
        toast.error(
          `Re-extraction failed during ${stageLabel}: ${detail.length > 120 ? detail.slice(0, 120) + "-" : detail}. Check edge function logs in Supabase for details.`,
          { duration: 8000 },
        );
        // Still write evidence_refreshed_at so the auto-extract loop stops.
        try {
          await supabase.from("leases").update({
            extraction_data: {
              ...(lease.extraction_data || {}),
              evidence_refreshed_at: new Date().toISOString(),
              extraction_debug: {
                ...(lease.extraction_data?.extraction_debug || {}),
                last_reextract_at: new Date().toISOString(),
                last_reextract_source_file_id: sourceFileId,
                last_reextract_manual_review_stage: stage,
                last_reextract_manual_review_reason: detail,
              },
            },
          }).eq("id", lease.id);
          queryClient.invalidateQueries({ queryKey: ["lease", leaseId] });
        } catch (_writeErr) {
          // Non-fatal - loop will stop on next successful extraction
        }
        return;
      }

      // 2. Poll uploaded_files.status. With the expanded LEASE_GROUPS the
      // pipeline now makes ~9 Gemini calls so allow up to 3 minutes total.
      setReextractStage("polling");
      const ACTIVE_STATUSES = new Set([
        "uploaded", "parsing", "parsed", "pdf_parsed", "validating", "validated", "storing", "stored", "computing",
      ]);
      const MAX_POLLS = 90; // 90 -- 2s = 3 minutes
      let attempts = 0;
      let latestFile = null;
      let lastStatus = "";
      while (attempts < MAX_POLLS) {
        await new Promise((r) => setTimeout(r, 2000));
        const { data: row, error } = await supabase
          .from("uploaded_files")
          .select("id, status, ui_review_payload, normalized_output, parsed_data, docling_raw, error_message, updated_at")
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
      // Even on timeout, apply whatever's in ui_review_payload right now -
      // partial extraction is better than nothing, and the user can see what
      // came through.
      if (attempts >= MAX_POLLS) {
        console.warn("[Re-extract] polling timed out after 3 minutes - applying partial result if any");
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

      // Diagnostic dump - shows exactly what the deployed pipeline returned
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
      const normalizeIncomingExtractionStatus = ({ value, confidence, sourcePage, sourceText, extractionStatus }) => {
        const explicit = String(extractionStatus || "").trim().toLowerCase();
        if (isCalculatedExtractionStatus(explicit)) return "calculated";
        if (isManualExtractionStatus(explicit)) return explicit;
        if (value == null || value === "") return "not_found";
        if (!hasValidSourceEvidence({ sourcePage, sourceText })) return "missing_source_evidence";
        return typeof confidence === "number" && !Number.isNaN(confidence) ? "extracted" : "extracted_no_confidence";
      };
      const upsertFieldEvidence = (fieldKey, payload = {}) => {
        if (!fieldKey) return;
        const sourceText = cleanSourceEvidenceText(payload.source_text ?? payload.source_clause);
        const sourcePage = payload.source_page ?? payload.page_number ?? null;
        const value = payload.value ?? null;
        const confidence = typeof payload.confidence === "number" ? payload.confidence : fieldsWithEvidence[fieldKey]?.confidence ?? null;
        const extractionStatus = normalizeIncomingExtractionStatus({
          value,
          confidence,
          sourcePage,
          sourceText,
          extractionStatus: payload.extraction_status ?? fieldsWithEvidence[fieldKey]?.extraction_status ?? null,
        });
        const validationErrors = Array.isArray(payload.validation_errors)
          ? payload.validation_errors
          : fieldsWithEvidence[fieldKey]?.validation_errors ?? [];
        fieldsWithEvidence[fieldKey] = {
          ...(fieldsWithEvidence[fieldKey] || {}),
          value,
          confidence,
          source: payload.source ?? fieldsWithEvidence[fieldKey]?.source ?? null,
          source_page: sourcePage,
          source_text: sourceText,
          raw_value: payload.raw_value ?? value,
          extraction_status: extractionStatus,
          validation_errors: validationErrors,
        };
        evidenceMap[fieldKey] = {
          raw_value: payload.raw_value ?? value,
          source_page: sourcePage,
          source_text: sourceText,
          extraction_status: extractionStatus,
          validation_errors: validationErrors,
        };
      };
      if (reviewedRow) {
        const allFields = [
          ...(reviewedRow.standard_fields || []),
          ...(reviewedRow.custom_fields || []),
        ];
        for (const f of allFields) {
          if (!f?.field_key) continue;
          upsertFieldEvidence(f.field_key, {
            value: f.value ?? null,
            confidence: typeof f.confidence === "number" ? f.confidence : null,
            source: f.source ?? null,
            source_page: f.evidence?.page_number ?? f.evidence?.source_page ?? null,
            source_text:
              f.evidence?.exact_source_text ??
              f.evidence?.source_clause ??
              f.evidence?.source_text ??
              null,
            raw_value: f.original_value ?? f.evidence?.raw_value ?? null,
            extraction_status: f.status ?? null,
            validation_errors: Array.isArray(f.validation_errors) ? f.validation_errors : [],
          });
          if (typeof f.confidence === "number") {
            confidenceMap[f.field_key] = f.confidence <= 1 ? Math.round(f.confidence * 100) : Math.round(f.confidence);
          }
        }
      }
      const workflowFields = workflowOutput?.lease_fields || {};
      for (const [fieldKey, wfField] of Object.entries(workflowFields)) {
        if (!wfField || typeof wfField !== "object") continue;
        upsertFieldEvidence(fieldKey, {
          value: wfField.value ?? null,
          confidence: wfField.confidence_score ?? null,
          source_page: wfField.source_page ?? null,
          source_text:
            wfField.exact_source_text ??
            wfField.source_clause ??
            wfField.source_text ??
            null,
          raw_value: wfField.value ?? null,
          extraction_status: wfField.extraction_status ?? null,
          validation_errors: Array.isArray(wfField.validation_errors) ? wfField.validation_errors : [],
        });
        if (typeof wfField.confidence_score === "number") {
          confidenceMap[fieldKey] = wfField.confidence_score <= 1
            ? Math.round(wfField.confidence_score * 100)
            : Math.round(wfField.confidence_score);
        }
      }
      if (!fieldsWithEvidence.square_footage && fieldsWithEvidence.rentable_area_sqft) {
        upsertFieldEvidence("square_footage", fieldsWithEvidence.rentable_area_sqft);
      }
      if (!fieldsWithEvidence.premises_address && fieldsWithEvidence.property_address) {
        upsertFieldEvidence("premises_address", fieldsWithEvidence.property_address);
      }
      for (const reviewField of LEASE_REVIEW_FIELDS) {
        const targetKey = reviewField.key;
        const targetEntry = fieldsWithEvidence[targetKey];
        const targetHasSource = hasValidSourceEvidence({
          sourcePage: targetEntry?.source_page,
          sourceText: targetEntry?.source_text,
        });
        if (targetEntry?.value != null && targetEntry.value !== "" && targetHasSource) continue;

        const aliasEntry = getFieldAliases(targetKey)
          .filter((alias) => alias !== targetKey)
          .map((alias) => fieldsWithEvidence[alias])
          .find((entry) => entry?.value != null && entry.value !== "" && hasValidSourceEvidence({
            sourcePage: entry.source_page,
            sourceText: entry.source_text,
          }));
        if (aliasEntry) upsertFieldEvidence(targetKey, aliasEntry);
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

      // - Re-extract preservation safety -
      // A re-extract that returns TRULY ZERO values must NOT blank previous
      // good extraction. But when the new extraction has actual field values
      // (even without source text evidence), we allow the write so users get
      // something useful rather than an endless "blocked" loop.
      // Approved/manually-edited fields are always preserved regardless.
      const isSourceBacked = (entry) => {
        if (!entry || typeof entry !== "object") return false;
        return hasValidSourceEvidence({
          sourcePage: entry.source_page,
          sourceText: entry.source_text,
        }) && !isCalculatedExtractionStatus(entry.extraction_status);
      };
      const hasNonNullValue = (entry) => {
        if (!entry || typeof entry !== "object") return false;
        return entry.value != null && entry.value !== "" && !isCalculatedExtractionStatus(entry.extraction_status);
      };
      const isProtectedField = (key, entry) => {
        if (entry?.manually_edited === true) return true;
        if (String(entry?.source || "").toLowerCase() === "manual") return true;
        const review = fieldReviews?.[key];
        const status = String(review?.status || "").toLowerCase();
        if (status === REVIEW_STATUSES.ACCEPTED || status === REVIEW_STATUSES.EDITED || status === "approved") return true;
        return false;
      };

      const previousSourceBackedCount = Object.values(cleanedFields).filter(isSourceBacked).length;
      const newSourceBackedCount = Object.values(fieldsWithEvidence).filter(isSourceBacked).length;
      const newNonNullCount = Object.values(fieldsWithEvidence).filter(hasNonNullValue).length;
      let manualFieldsPreservedCount = 0;
      let approvedFieldsPreservedCount = 0;
      let overwriteBlockedReason = null;

      // Block only when new extraction returned zero non-null values AND there
      // is previous good data to protect. When previous data is also empty we
      // must still write evidence_refreshed_at so the auto-extract loop stops -
      // there is nothing to protect and blocking leaves the loop running forever.
      if (newSourceBackedCount === 0 && newNonNullCount === 0 && previousSourceBackedCount > 0) {
        overwriteBlockedReason = "new_extraction_has_zero_source_backed_fields_previous_data_preserved";
      } else if (newSourceBackedCount === 0 && newNonNullCount > 0 && previousSourceBackedCount > 0) {
        // New extraction has values but no source evidence - only block if the
        // previous extraction was richer (source-backed). Surface as advisory.
        console.warn(
          `[LeaseReview] re-extract: new extraction has ${newNonNullCount} non-null fields but no source evidence. ` +
          `Previous had ${previousSourceBackedCount} source-backed fields - allowing write since LLM produced values.`
        );
      }

      // Build the merged fields/evidence/confidence so manual+approved+
      // previously-source-backed fields are NEVER lost when the new
      // extraction only covers part of the document.
      const mergedFields = { ...cleanedFields };
      const mergedEvidence = { ...cleanedEvidence };
      const mergedConfidence = { ...(lease.extraction_data?.confidence_scores || {}) };

      if (!overwriteBlockedReason) {
        for (const [key, newEntry] of Object.entries(fieldsWithEvidence)) {
          const prevEntry = cleanedFields[key];
          if (isProtectedField(key, prevEntry)) {
            if (prevEntry?.manually_edited === true || String(prevEntry?.source || "").toLowerCase() === "manual") {
              manualFieldsPreservedCount += 1;
            } else {
              approvedFieldsPreservedCount += 1;
            }
            continue; // keep manual / accepted previous entry as-is
          }
          // Otherwise overlay the new value only when it actually carries
          // evidence; an evidence-less new entry should not erase a
          // source-backed previous entry.
          if (isSourceBacked(newEntry) || !isSourceBacked(prevEntry)) {
            mergedFields[key] = newEntry;
          }
        }
        for (const [key, newEv] of Object.entries(evidenceMap)) {
          if (isProtectedField(key, cleanedFields[key])) continue;
          if (isSourceBacked(newEv) || !isSourceBacked(cleanedEvidence[key])) {
            mergedEvidence[key] = newEv;
          }
        }
        Object.assign(mergedConfidence, confidenceMap);
      } else {
        // Block path: count what we'd preserve to surface in the toast.
        for (const [key, prevEntry] of Object.entries(cleanedFields)) {
          if (!isProtectedField(key, prevEntry)) continue;
          if (prevEntry?.manually_edited === true || String(prevEntry?.source || "").toLowerCase() === "manual") {
            manualFieldsPreservedCount += 1;
          } else {
            approvedFieldsPreservedCount += 1;
          }
        }
      }

      const sourceExtractionDebug =
        latestFile?.ui_review_payload?.metadata?.extraction_debug
        || latestFile?.ui_review_payload?.metadata?.extractionDebug
        || latestFile?.normalized_output?.metadata?.extraction_debug
        || latestFile?.normalized_output?.metadata?.extractionDebug
        || {};
      const sourceFieldTrace = Array.isArray(sourceExtractionDebug.field_trace)
        ? sourceExtractionDebug.field_trace
        : [];
      const enrichedFieldTrace = sourceFieldTrace.map((trace) => {
        const aliases = trace.expected_aliases?.length ? trace.expected_aliases : getFieldAliases(trace.field_key);
        const persistedKey = aliases.find((alias) => mergedFields[alias]?.value != null && mergedFields[alias]?.value !== "");
        const persisted = persistedKey ? mergedFields[persistedKey] : null;
        const resolverFound = Boolean(persisted);
        const nextTrace = {
          ...trace,
          expected_aliases: aliases,
          persisted_to_extraction_data: resolverFound,
          persisted_value: persisted?.value ?? null,
          resolver_found_value: resolverFound,
          resolver_value: persisted?.value ?? null,
          resolver_status: persisted?.extraction_status ?? trace.resolver_status ?? null,
          rendered_in_tab: LEASE_REVIEW_FIELDS.some((field) => field.key === trace.field_key),
        };
        if (!nextTrace.resolver_found_value && nextTrace.persisted_to_extraction_data) {
          nextTrace.final_blank_reason = "resolver_alias_missing";
        } else if (!nextTrace.rendered_in_tab) {
          nextTrace.final_blank_reason = "dynamic_row_filter_hidden";
        } else if (nextTrace.resolver_status === "missing_source_evidence") {
          nextTrace.final_blank_reason = "missing_source_evidence";
        } else if (nextTrace.resolver_found_value && nextTrace.final_blank_reason === "llm_did_not_return") {
          nextTrace.final_blank_reason = null;
        }
        return nextTrace;
      });
      const missingTraceRows = enrichedFieldTrace.filter((trace) => trace.final_blank_reason);
      const missingByReason = missingTraceRows.reduce((acc, trace) => {
        acc[trace.final_blank_reason] = (acc[trace.final_blank_reason] || 0) + 1;
        return acc;
      }, {});

      const extractionDebug = {
        ...(lease.extraction_data?.extraction_debug || {}),
        ...sourceExtractionDebug,
        ...(enrichedFieldTrace.length ? {
          field_trace: enrichedFieldTrace,
          missing_fields_count: missingTraceRows.length,
          missing_by_reason: missingByReason,
          top_20_missing_fields: missingTraceRows.slice(0, 20).map((trace) => ({
            field_key: trace.field_key,
            display_label: trace.display_label,
            reason: trace.final_blank_reason,
          })),
        } : {}),
        last_reextract_at: new Date().toISOString(),
        last_reextract_source_file_id: sourceFileId,
        previous_source_backed_fields_count: previousSourceBackedCount,
        new_source_backed_fields_count: newSourceBackedCount,
        source_backed_min_threshold: SOURCE_BACKED_MIN_THRESHOLD,
        overwrite_allowed: !overwriteBlockedReason,
        overwrite_blocked_reason: overwriteBlockedReason,
        manual_fields_preserved_count: manualFieldsPreservedCount,
        approved_fields_preserved_count: approvedFieldsPreservedCount,
        merged_fields_total: Object.keys(mergedFields).length,
      };

      const nextExtraction = overwriteBlockedReason
        ? {
            // Preserve previous extraction entirely; only refresh the debug
            // breadcrumb so the reviewer can see this run was rejected.
            ...(lease.extraction_data || {}),
            extraction_debug: extractionDebug,
            last_reextract_blocked_at: extractionDebug.last_reextract_at,
          }
        : {
            ...(lease.extraction_data || {}),
            fields: mergedFields,
            field_evidence: mergedEvidence,
            confidence_scores: mergedConfidence,
            ...(workflowOutput ? { workflow_output: workflowOutput } : {}),
            evidence_refreshed_at: new Date().toISOString(),
            extraction_debug: extractionDebug,
          };

      const { error: updateErr } = await supabase
        .from("leases")
        .update({ extraction_data: nextExtraction })
        .eq("id", lease.id);
      if (updateErr) throw updateErr;

      if (overwriteBlockedReason) {
        // Re-extract produced nothing usable. Surface the blocker clearly
        // and short-circuit - the success toast / rule generation below
        // assume a successful overwrite.
        console.warn("[LeaseReview] re-extract blocked from overwriting previous data:", {
          reason: overwriteBlockedReason,
          previousSourceBackedCount,
          newSourceBackedCount,
          manualFieldsPreservedCount,
          approvedFieldsPreservedCount,
        });
        toast.error(
          previousSourceBackedCount > 0
            ? `Re-extract produced no source-backed fields. Previous ${previousSourceBackedCount} extracted field${previousSourceBackedCount === 1 ? "" : "s"} preserved. Check Extraction Debug for details.`
            : "Re-extract produced no source-backed fields. The source document may be unreadable; check Extraction Debug.",
        );
        queryClient.invalidateQueries({ queryKey: ["lease", leaseId] });
        return;
      }

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
          previous_source_backed_fields_count: previousSourceBackedCount,
          new_source_backed_fields_count: newSourceBackedCount,
          manual_fields_preserved_count: manualFieldsPreservedCount,
          approved_fields_preserved_count: approvedFieldsPreservedCount,
        },
      });

      // Also extract expense/CAM rules from the same source text so the
      // Expenses/Recoveries and CAM Rules tabs populate without a separate
      // user trip to the LeaseExpenseClassification page.
      setReextractStage("extracting_rules");
      try {
        await leaseRulePipelineService.generateLeaseExpenseRulesForLease({
          leaseId: lease.id,
          source: "extract_draft",
          force: false
        });
      } catch (ruleErr) {
        console.warn("[LeaseReview] draft expense rule extraction skipped:", ruleErr?.message || ruleErr);
      }

      const preservedSummary = manualFieldsPreservedCount + approvedFieldsPreservedCount;
      const preservedSuffix = preservedSummary > 0
        ? ` ${preservedSummary} reviewer-edited field${preservedSummary === 1 ? "" : "s"} preserved.`
        : "";
      if (newSourceBackedCount === 0 && newNonNullCount === 0) {
        const debugReason =
          extractionDebug?.mapping_failure_reason
          || extractionDebug?.top_20_missing_fields?.[0]?.reason
          || Object.keys(extractionDebug?.missing_by_reason || {})[0]
          || (Number(extractionDebug?.full_text_chars || 0) === 0 ? "no_text_extracted" : null)
          || "no_field_values";
        const debugCounts = [
          Number.isFinite(Number(extractionDebug?.full_text_chars))
            ? `${Number(extractionDebug.full_text_chars).toLocaleString()} text chars`
            : null,
          Number.isFinite(Number(extractionDebug?.pdf_page_count_total))
            ? `${Number(extractionDebug.pdf_page_count_total).toLocaleString()} PDF pages`
            : null,
          extractionDebug?.parser_source ? `parser: ${extractionDebug.parser_source}` : null,
        ].filter(Boolean).join(", ");
        toast.warning(
          `Extraction returned no field values (${debugReason}${debugCounts ? `; ${debugCounts}` : ""}). Check Extraction Debug for field trace and parser details.`,
        );
      } else {
        toast.success(
          `Lease re-extracted. ${newSourceBackedCount} source-backed field${newSourceBackedCount === 1 ? "" : "s"} from this run.${preservedSuffix}`,
        );
      }
      queryClient.invalidateQueries({ queryKey: ["lease", leaseId] });
      queryClient.invalidateQueries({ queryKey: ["uploaded_file_for_lease", sourceFileId] });
      queryClient.invalidateQueries({ queryKey: ["lease-expense-rule-summary", leaseId] });
      queryClient.invalidateQueries({ queryKey: ["lease-expense-rules-detail", leaseId] });
    } catch (err) {
      console.error("[LeaseReview] re-extract failed:", err);
      const isOverload = /compute resources|resources exhausted|504|timed out|timeout/i.test(err?.message || "");
      toast.error(
        isOverload
          ? "Extraction server is temporarily overloaded. Use 'Re-extract Lease' to retry manually when ready."
          : (err?.message || "Could not re-extract lease"),
      );
      // Record the failure so the auto-extract effect doesn't immediately
      // retry on the next page load. The user can trigger Re-extract Lease
      // manually once backend resources are available.
      try {
        sessionStorage.setItem(`lease_auto_extract_failed_${leaseId}`, String(Date.now()));
      } catch {
        // sessionStorage may be unavailable in some environments - ignore.
      }
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
      updateLeaseQueryCache(queryClient, leaseId, rejectedLease);
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
        templateId: 'generic_internal_notification',
        variables: {
          subject: `[Signature Requested] ${lease.tenant_name || "Lease"}`,
          message: `You have been asked to review and sign a lease for ${lease.tenant_name || "Unknown"}. ${signatureMessage ? `Message: ${signatureMessage}. ` : ""}Please open the lease review dashboard to sign.`
        }
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
            {summaryTenantName || "Unknown tenant"} -{" "}
            {totalSf ? `${Number(totalSf).toLocaleString()} SF` : "-"} --{" "}
            {getLeaseFieldLabel("lease_type", summaryLeaseType) || "Unknown type"}
          </p>
          <p className="mt-0.5 text-xs text-slate-400">
            Term: {commencementValue || "-"} to {expirationValue || "-"}
            {summaryLeaseDate ? ` -- Signed: ${summaryLeaseDate}` : ""}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge className={leaseStatus === "approved" ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-700"}>
              Status: {leaseStatus}
            </Badge>
            {lease.abstract_status && (
              <Badge className={lease.abstract_status === "approved" ? "bg-emerald-100 text-emerald-700" : "bg-blue-100 text-blue-700"}>
                Abstract: {lease.abstract_status}
                {lease.abstract_version ? ` -- v${lease.abstract_version}` : ""}
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
            disabled={reextracting || !resolvedSourceFileId}
            title={
              resolvedSourceFileId
                ? "Re-run the AI extraction on the source PDF and refresh values + evidence on this lease"
                : "No source file is linked to this lease. Use Extraction Debug -> Re-link Source Document first."
            }
          >
            {reextracting ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1 h-4 w-4" />}
            {reextracting
              ? reextractStage === "polling"
                ? "Waiting on extraction-"
                : reextractStage === "applying"
                  ? "Applying values..."
                  : reextractStage === "extracting_rules"
                    ? "Extracting expense rules..."
                    : "Re-extracting..."
              : "Re-extract Lease"}
          </Button>
          <Button
            variant="outline"
            onClick={() => navigate(createPageUrl("LeaseExpenseRules") + `?lease_id=${lease.id}`)}
          >
            Review Expense Rules
          </Button>
          <Button
            variant="outline"
            onClick={() => navigate(createPageUrl("LeaseExpenseClassification", { id: lease.id }))}
          >
            Expense Classification
          </Button>
          <Button variant="outline" onClick={() => window.print()}>
            <Printer className="mr-1 h-4 w-4" />
            Print
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

      {/* Post-approval banner: guides user to review extracted expense rules */}
      {showPostApprovalBanner && (
        <div className="mx-4 mt-3 flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm">
          <span className="text-amber-800">
            Lease approved. Expense rules are being extracted — review and approve them before running CAM calculations.{" "}
            <button
              className="font-medium underline"
              onClick={() => navigate(createPageUrl("LeaseExpenseRules") + `?lease_id=${lease.id}`)}
            >
              Review expense rules →
            </button>
          </span>
          <button
            className="ml-3 text-amber-400 hover:text-amber-600"
            onClick={() => setShowPostApprovalBanner(false)}
          >
            ✕
          </button>
        </div>
      )}

      {/* Source-file banner with inline file picker. Shows the ranked list
          of uploaded_files candidates the auto-link found in this org -
          one click links the lease, no UUID copying needed. */}
      {!resolvedSourceFileId && (
        <div className="space-y-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <div>
            <p className="font-semibold">No source file linked to this lease.</p>
            <p className="text-xs text-red-700">
              Extraction (Docling + Gemini) can't run and the Re-extract Lease button is disabled until you point this lease at the uploaded PDF.
              {autoLinkDebug ? (
                <span className="block mt-1 italic">
                  Auto-link scanned {autoLinkDebug.query_count} uploads ({autoLinkDebug.lease_like} lease-shape), top score {autoLinkDebug.top_score} for "{autoLinkDebug.top_candidate || "-"}" against tenant "{autoLinkDebug.tenant || "-"}". If you see duplicates below, they're re-uploads of the same file - picking the most recent (top of the list) is safe. The UUID is just an internal identifier; you don't need to memorize it.
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
                        {c.reasons?.length ? ` -- ${c.reasons.join("+")}` : ""}
                        {" -- "}{c.status}
                        {" -- "}{c.updated_at ? new Date(c.updated_at).toLocaleString() : ""}
                        {" -- "}<code className="text-slate-400">{String(c.id).slice(0, 8)}-</code>
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
          {isSuperAdminUser && (
            <Button
              size="sm"
              variant="outline"
              className="border-red-300 bg-white text-red-700 hover:bg-red-100"
              onClick={() => setActiveTab("extraction_debug")}
            >
              Or paste a UUID manually (Extraction Debug)
            </Button>
          )}
        </div>
      )}

      {/* Document mismatch warning - shown when extracted fields conflict with stored lease data */}
      {documentMismatches.length > 0 && (
        <div className="rounded-xl border border-orange-200 bg-orange-50 px-4 py-3 text-sm text-orange-800">
          <p className="font-semibold mb-1">- Possible document mismatch - the uploaded file may not match this lease record.</p>
          <ul className="list-disc pl-4 space-y-0.5">
            {documentMismatches.map((m) => (
              <li key={m.field}>{m.detail}</li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-orange-600">Verify the correct document is linked before approving. Use <em>Re-link Source Document</em> if needed.</p>
        </div>
      )}

      {/* Assignment / amendment document notice */}
      {isAssignmentOnlyDocument && (
        <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-semibold mb-1">This document was detected as an Assignment / Amendment / Consent - not the full original lease.</p>
              <p>Assignment terms have been extracted and are ready to review. CAM, insurance, expense recovery, and operating expense fields require the original lease document.</p>
              <p className="mt-1 text-xs text-blue-600">If this is incorrect, click "This is a full lease" to dismiss this notice.</p>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 border-blue-300 bg-white text-blue-700 hover:bg-blue-50 text-xs"
              onClick={handleMarkAsFullLease}
              disabled={updateLeaseMutation.isPending}
            >
              This is a full lease
            </Button>
          </div>
        </div>
      )}

      {/* Stale payload guard */}
      {!isAssignmentOnlyDocument && isStalePayload && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          This Lease Review was generated by an older extractor. Re-extract required.
        </div>
      )}

      {/* Rule readiness banner - only for full leases */}
      {!isAssignmentOnlyDocument && !isStalePayload && (
        <div
          className={`rounded-xl border px-4 py-3 text-sm ${
            approvedRuleSet
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-amber-200 bg-amber-50 text-amber-800"
          }`}
        >
          {approvedRuleSet
            ? "Lease expense rules are approved. Approving the lease abstract will refresh lease-derived charges and CAM readiness."
            : (
              <span>
                Expense/CAM rule review is pending. You may approve the lease abstract now, but downstream recoveries/CAM will remain blocked until rules are approved.{" "}
                <Link to={createPageUrl("LeaseExpenseRules") + `?lease=${lease.id}`} className="underline font-medium">
                  Review rules on the Lease Expense Rules page
                </Link>
              </span>
            )}
        </div>
      )}

      {/* Extraction-in-progress banner - shown while auto-extract or re-extract is running */}
      {reextracting && (
        <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-4 text-sm text-blue-800">
          <div className="flex items-center gap-3">
            <Loader2 className="h-5 w-5 shrink-0 animate-spin text-blue-500" />
            <div>
              <p className="font-semibold">
                {reextractStage === "polling"
                  ? "Reading extracted data from the AI pipeline-"
                  : reextractStage === "applying"
                    ? "Applying extracted values to your lease-"
                    : "Extracting lease data from the uploaded document"}
              </p>
              <p className="mt-0.5 text-xs text-blue-600">
                This usually takes 30-60 seconds. The page will refresh automatically when complete. You don't need to do anything.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Extraction failed / no-data banner */}
      {!reextracting &&
        confidenceBuckets.high + confidenceBuckets.medium + confidenceBuckets.low + confidenceBuckets.unknown === 0 &&
        resolvedSourceFileId &&
        reviewCandidateRowsCount === 0 && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-4 text-sm text-red-800">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" />
            <div>
              <p className="font-semibold">No fields were auto-extracted</p>
              <p className="mt-1 text-xs text-red-600">
                The AI extraction backend is not configured or could not read this document, so no
                fields were populated automatically. You can still <strong>fill in all fields manually</strong> below
                and approve the abstract. To enable AI extraction, set{" "}
                <code>VERTEX_PROJECT_ID</code> and <code>GOOGLE_SERVICE_ACCOUNT_KEY</code> in your
                Supabase Edge Function secrets (for Vertex AI / Gemini Vision). Optionally set{" "}
                <code>DOCLING_API_URL</code> for structured document parsing. After updating secrets,
                redeploy the edge functions and click <strong>Re-extract Lease</strong> to retry.
              </p>
            </div>
          </div>
        </div>
      )}

      {!reextracting &&
        confidenceBuckets.high + confidenceBuckets.medium + confidenceBuckets.low + confidenceBuckets.unknown === 0 &&
        resolvedSourceFileId &&
        reviewCandidateRowsCount > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-4 text-sm text-amber-900">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
            <div>
              <p className="font-semibold">Extraction produced review-only fields</p>
              <p className="mt-1 text-xs text-amber-700">
                The source document was parsed, but the extracted values are missing high-confidence source evidence or require manual review.
                Use the tabs below to approve, edit, mark N/A, or re-extract after backend updates.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Confidence summary - 6 cards (hidden while extracting with no data yet) */}
      {(!reextracting || confidenceBuckets.high + confidenceBuckets.medium + confidenceBuckets.low + confidenceBuckets.unknown > 0) && (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Card className="border-emerald-200 bg-emerald-50">
          <CardContent className="p-3">
            <p className="text-[10px] font-semibold uppercase text-emerald-600">High (&gt;=90%)</p>
            <p className="text-2xl font-bold text-emerald-700">{confidenceBuckets.high}</p>
            <p className="text-[10px] text-emerald-500">Auto-populated</p>
          </CardContent>
        </Card>
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="p-3">
            <p className="text-[10px] font-semibold uppercase text-amber-600">Medium (75-89%)</p>
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
      )}

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="flex h-auto flex-wrap justify-start gap-1 border bg-white">
          {LEASE_REVIEW_TABS.map((tab) => {
            if (tab.key === "extraction_debug" && !isSuperAdminUser) return null;
            const tabFields = fieldsForTab[tab.key] || [];
            const extractedInTab = tabFields.filter((f) => isReviewRowDisplayable(f, { showMissing: false })).length;
            // Flag tabs that are inapplicable for assignment/amendment docs.
            // A tab is "not in this document" when: we're in assignment mode AND
            // every standard field in the tab is empty (no extracted value).
            const FULL_LEASE_ONLY_TABS = new Set(["cam_rules", "insurance", "expenses_recoveries"]);
            const tabHasAnyValue = tabFields.some((f) => {
              const v = f.normalized_value ?? f.value ?? readFieldValue(leaseFull, f.key);
              return v !== null && v !== undefined && v !== "";
            });
            const notInThisDoc = isAssignmentOnlyDocument && FULL_LEASE_ONLY_TABS.has(tab.key) && !tabHasAnyValue;

            return (
              <TabsTrigger
                key={tab.key}
                value={tab.key}
                className={`text-xs ${notInThisDoc ? "opacity-50" : ""}`}
                title={notInThisDoc ? "Fields in this section require the original lease" : undefined}
              >
                {tab.label}
                {notInThisDoc && (
                  <span className="ml-1 text-[9px] text-slate-400">-</span>
                )}
                {extractedInTab > 0 && !notInThisDoc && (
                  <span className="ml-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-200 px-1 text-[10px] font-semibold text-amber-900">
                    {extractedInTab}
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
              <SummaryStat label="Tenant" value={summaryTenantName || "-"} />
              <SummaryStat label="Lease Type" value={getLeaseFieldLabel("lease_type", summaryLeaseType) || "-"} />
              <SummaryStat
                label="Term (Commencement -> Expiration)"
                value={`${commencementValue || "-"} -> ${expirationValue || "-"}`}
              />
              <SummaryStat label="Lease Date (signed)" value={summaryLeaseDate || "-"} />
              <SummaryStat label="Monthly Rent" value={summaryMonthlyRent ? `$${Number(summaryMonthlyRent).toLocaleString()}` : "-"} />
              <SummaryStat label="Annual Rent" value={summaryAnnualRent ? `$${Number(summaryAnnualRent).toLocaleString()}` : "-"} />
              <SummaryStat label="Square Footage" value={totalSf ? `${Number(totalSf).toLocaleString()} SF` : "-"} />
            </CardContent>
          </Card>

          {/* Expense / CAM card */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Expense / CAM Readiness</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {coreMappingFailed && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-800">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <p className="text-xs">
                    Expense terms may have been detected, but core lease fields were not mapped.
                    These rows are held as coverage gaps for manual review and are not treated as
                    confirmed lease terms.
                  </p>
                </div>
              )}
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <SummaryStat
                  label="Lease Expense Terms Found"
                  value={String(effectiveExpenseTermsFound)}
                />
                <SummaryStat
                  label="Lease Expense Terms Approved"
                  value={String(ruleSetSummary?.expense?.approved ?? 0)}
                />
                <SummaryStat
                  label="CAM Terms Found"
                  value={String(effectiveCamTermsFound)}
                />
                <SummaryStat
                  label="CAM Terms Approved"
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
                  onClick={() => navigate(createPageUrl("LeaseExpenseRules") + `?lease_id=${lease.id}`)}
                >
                  Review Expense Rules
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => navigate(createPageUrl("LeaseExpenseClassification", { id: lease.id }))}
                >
                  Expense Classification
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

        {/* Field tabs - table-first per business section. */}
        {LEASE_REVIEW_TABS
          .filter((t) => !["summary", "rent_charges", "expenses_recoveries", "cam_rules", "clause_records", "critical_dates", "documents_exhibits", "budget_preview", "extraction_debug"].includes(t.key))
          .map((tab) => (
            <TabsContent key={tab.key} value={tab.key} className="mt-4 space-y-3">
              <div className="flex items-center justify-between">
                <FieldTableFilter
                  showMissing={showMissingByTab[tab.key] || false}
                  onToggle={(val) => setShowMissingByTab((prev) => ({ ...prev, [tab.key]: val }))}
                />
                <Button variant="outline" size="sm" className="h-7 text-xs"
                  onClick={() => { setCustomFieldDialog({ tabKey: tab.key }); setCustomFieldForm({ label: "", value: "", sourceText: "", sourcePage: "" }); }}>
                  + Add Custom Field
                </Button>
              </div>
              <FieldReviewTable
                fields={fieldsForTab[tab.key] || []}
                lease={leaseFull}
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
                showMissing={showMissingByTab[tab.key] || false}
                conflictKeys={conflictKeySet}
                crossFieldWarnings={crossFieldWarnings}
              />
            </TabsContent>
          ))}

        {/* Rent & Charges - single-value rent fields + generated rent rows.
            The rent_schedules table remains in the backend (rent projection,
            billing, etc. read from it); we just surface the rows here so
            reviewers see the schedule that approval will publish. */}
        <TabsContent value="rent_charges" className="mt-4 space-y-4">
          <div className="flex items-center justify-between">
            <FieldTableFilter
              showMissing={showMissingByTab.rent_charges || false}
              onToggle={(val) => setShowMissingByTab((prev) => ({ ...prev, rent_charges: val }))}
            />
            <Button variant="outline" size="sm" className="h-7 text-xs"
              onClick={() => { setCustomFieldDialog({ tabKey: "rent_charges" }); setCustomFieldForm({ label: "", value: "", sourceText: "", sourcePage: "" }); }}>
              + Add Custom Field
            </Button>
          </div>
          <FieldReviewTable
            fields={fieldsForTab.rent_charges || []}
            lease={leaseFull}
            fieldReviews={fieldReviews}
            onOpenDetail={(field) => openDrawer(field, "view")}
            onQuickAction={(field, action) => {
              if (action === "accept") handleAccept(field);
              else if (action === "edit") openDrawer(field, "edit");
              else if (action === "reject") handleReject(field);
              else if (action === "na") handleMarkNA(field);
              else if (action === "legal") handleNeedsLegal(field); else if (action === "manual") handleMarkManualRequired(field);
            }}
            showMissing={showMissingByTab.rent_charges || false}
            conflictKeys={conflictKeySet}
            crossFieldWarnings={crossFieldWarnings}
          />
          <RentScheduleTable leaseId={lease.id} />
        </TabsContent>

        {/* Expense Rules - single-value lease fields + repeatable rule rows. */}
        <TabsContent value="expenses_recoveries" className="mt-4 space-y-4">
          <div className="flex items-center justify-between">
            <FieldTableFilter
              showMissing={showMissingByTab.expenses_recoveries || false}
              onToggle={(val) => setShowMissingByTab((prev) => ({ ...prev, expenses_recoveries: val }))}
            />
            <Button variant="outline" size="sm" className="h-7 text-xs"
              onClick={() => { setCustomFieldDialog({ tabKey: "expenses_recoveries" }); setCustomFieldForm({ label: "", value: "", sourceText: "", sourcePage: "" }); }}>
              + Add Custom Field
            </Button>
          </div>
          <FieldReviewTable
            fields={fieldsForTab.expenses_recoveries || []}
            lease={leaseFull}
            fieldReviews={fieldReviews}
            onOpenDetail={(field) => openDrawer(field, "view")}
            onQuickAction={(field, action) => {
              if (action === "accept") handleAccept(field);
              else if (action === "edit") openDrawer(field, "edit");
              else if (action === "reject") handleReject(field);
              else if (action === "na") handleMarkNA(field);
              else if (action === "legal") handleNeedsLegal(field); else if (action === "manual") handleMarkManualRequired(field);
            }}
            showMissing={showMissingByTab.expenses_recoveries || false}
            conflictKeys={conflictKeySet}
            crossFieldWarnings={crossFieldWarnings}
          />
        </TabsContent>

        {/* CAM Rules - single-value CAM lease fields + repeatable CAM rules. */}
        <TabsContent value="cam_rules" className="mt-4 space-y-4">
          <div className="flex items-center justify-between">
            <FieldTableFilter
              showMissing={showMissingByTab.cam_rules || false}
              onToggle={(val) => setShowMissingByTab((prev) => ({ ...prev, cam_rules: val }))}
            />
            <Button variant="outline" size="sm" className="h-7 text-xs"
              onClick={() => { setCustomFieldDialog({ tabKey: "cam_rules" }); setCustomFieldForm({ label: "", value: "", sourceText: "", sourcePage: "" }); }}>
              + Add Custom Field
            </Button>
          </div>
          <FieldReviewTable
            fields={fieldsForTab.cam_rules || []}
            lease={leaseFull}
            fieldReviews={fieldReviews}
            onOpenDetail={(field) => openDrawer(field, "view")}
            onQuickAction={(field, action) => {
              if (action === "accept") handleAccept(field);
              else if (action === "edit") openDrawer(field, "edit");
              else if (action === "reject") handleReject(field);
              else if (action === "na") handleMarkNA(field);
              else if (action === "legal") handleNeedsLegal(field); else if (action === "manual") handleMarkManualRequired(field);
            }}
            showMissing={showMissingByTab.cam_rules || false}
            conflictKeys={conflictKeySet}
            crossFieldWarnings={crossFieldWarnings}
          />
        </TabsContent>

        {/* Clause Records - all meaningful lease clauses against a predefined checklist. */}
        <TabsContent value="clause_records" className="mt-4 space-y-3">
          <ClauseRecordsTable lease={lease} />
        </TabsContent>

        {/* Critical Dates - derived from approved abstract. */}
        <TabsContent value="critical_dates" className="mt-4 space-y-3">
          <CriticalDatesTable lease={leaseFull} />
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

        {/* Extraction Debug tab - superadmin only. */}
        {isSuperAdminUser && (
          <TabsContent value="extraction_debug" className="mt-4 space-y-3">
            <ExtractionDebugPanel lease={lease} />
          </TabsContent>
        )}
      </Tabs>

      {/* Side drawer for full field detail. */}
      {/* Add Custom Field dialog */}
      <Dialog open={!!customFieldDialog} onOpenChange={(open) => { if (!open) setCustomFieldDialog(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add Custom Field</DialogTitle>
            <DialogDescription>Add a field with a value and source reference from the lease document.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <Label className="text-xs mb-1 block">Field Name *</Label>
              <Input placeholder="e.g. Parking Spaces" value={customFieldForm.label}
                onChange={(e) => setCustomFieldForm((f) => ({ ...f, label: e.target.value }))} />
            </div>
            <div>
              <Label className="text-xs mb-1 block">Value</Label>
              <Input placeholder="e.g. 2 dedicated spaces" value={customFieldForm.value}
                onChange={(e) => setCustomFieldForm((f) => ({ ...f, value: e.target.value }))} />
            </div>
            <div>
              <Label className="text-xs mb-1 block">Source Text (verbatim from document)</Label>
              <Textarea placeholder="Paste the exact clause or sentence from the lease document" rows={3}
                value={customFieldForm.sourceText}
                onChange={(e) => setCustomFieldForm((f) => ({ ...f, sourceText: e.target.value }))} />
            </div>
            <div>
              <Label className="text-xs mb-1 block">Page Number</Label>
              <Input type="number" placeholder="e.g. 4" value={customFieldForm.sourcePage}
                onChange={(e) => setCustomFieldForm((f) => ({ ...f, sourcePage: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCustomFieldDialog(null)}>Cancel</Button>
            <Button onClick={handleAddCustomField} disabled={customFieldSaving}>
              {customFieldSaving ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              Add Field
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
        onSaveEdit={async (f, val, evidencePatch = {}) => {
          // Save edit persists the full drawer state: value + any evidence
          // fields the reviewer typed. Evidence fields that the reviewer
          // left blank arrive as `undefined` and are NOT written, so
          // pre-existing extractor evidence is preserved. Synchronous prep
          // runs inside the try block so any throw surfaces as a toast.
          try {
            const columnUpdates = {};
            if (!f.dynamic_document_item) {
              for (const column of resolveFieldColumns(f.key)) columnUpdates[column] = val;
            }
            if (f.key === "total_sf") columnUpdates.square_footage = val;
            const previousValue = readFieldValue(lease, f.key);
            const existingFieldRecord = lease.extraction_data?.fields?.[f.key] || {};
            const existingEvidenceRecord = lease.extraction_data?.field_evidence?.[f.key] || {};

            // Build the merged field record. Reviewer-provided evidence
            // overlays the existing extractor evidence; omitted fields
            // (undefined) fall through to whatever the extractor stamped.
            const mergedFieldRecord = {
              ...existingFieldRecord,
              value: val,
              manually_edited: true,
              edited_at: new Date().toISOString(),
              source: "manual",
              ...(evidencePatch.raw_value !== undefined ? { raw_value: evidencePatch.raw_value } : {}),
              ...(evidencePatch.source_page !== undefined
                ? { source_page: evidencePatch.source_page, page: evidencePatch.source_page, page_number: evidencePatch.source_page }
                : {}),
              ...(evidencePatch.source_text !== undefined
                ? {
                    source_text: evidencePatch.source_text,
                    exact_source_text: evidencePatch.source_text,
                    source_clause: evidencePatch.source_text,
                    snippet: evidencePatch.source_text,
                  }
                : {}),
              ...(evidencePatch.confidence !== undefined
                ? { confidence_score: evidencePatch.confidence, confidence: evidencePatch.confidence }
                : {}),
              ...(evidencePatch.extraction_status !== undefined
                ? { extraction_status: evidencePatch.extraction_status }
                : {}),
            };

            // Mirror the same evidence shape under field_evidence (the
            // separate map review-approve / Re-extract write to).
            const mergedEvidenceRecord = {
              ...existingEvidenceRecord,
              ...(evidencePatch.raw_value !== undefined ? { raw_value: evidencePatch.raw_value } : {}),
              ...(evidencePatch.source_page !== undefined ? { source_page: evidencePatch.source_page, page_number: evidencePatch.source_page } : {}),
              ...(evidencePatch.source_text !== undefined
                ? { source_text: evidencePatch.source_text, exact_source_text: evidencePatch.source_text, source_clause: evidencePatch.source_text }
                : {}),
              ...(evidencePatch.extraction_status !== undefined ? { extraction_status: evidencePatch.extraction_status } : {}),
            };

            // Confidence map (0-100 ints) mirrored separately so the
            // existing confidence resolver also sees the manual value.
            const nextConfidenceScores = evidencePatch.confidence !== undefined
              ? {
                  ...(lease.extraction_data?.confidence_scores || {}),
                  [f.key]: evidencePatch.confidence,
                }
              : (lease.extraction_data?.confidence_scores || undefined);

            await updateLeaseMutation.mutateAsync({
              id: lease.id,
              data: {
                ...columnUpdates,
                extraction_data: {
                  ...(lease.extraction_data || {}),
                  fields: {
                    ...(lease.extraction_data?.fields || {}),
                    [f.key]: mergedFieldRecord,
                  },
                  field_evidence: {
                    ...(lease.extraction_data?.field_evidence || {}),
                    [f.key]: mergedEvidenceRecord,
                  },
                  ...(nextConfidenceScores ? { confidence_scores: nextConfidenceScores } : {}),
                },
              },
            });
            try {
              await persistFieldAction({
                field: f,
                status: REVIEW_STATUSES.EDITED,
                value: val,
                previousReview: { value: previousValue, status: fieldReviews[f.key]?.status },
              });
            } catch (auditErr) {
              console.warn("[LeaseReview] persistFieldAction non-fatal failure on edit:", auditErr?.message || auditErr);
            }
            toast.success(`Updated ${f.label}`);
          } catch (err) {
            console.error("[LeaseReview] onSaveEdit failed:", err);
            toast.error(err?.message || `Could not save ${f.label}`);
          }
        }}
        onViewInDocument={() => drawerField && viewInDocument(drawerField)}
        onSaveEvidence={async (f, evidencePatch) => {
          // Reviewer-corrected evidence. Lands in extraction_data.field_evidence
          // and (mirrored) in extraction_data.fields so every downstream reader
          // sees the same shape the extractor would have produced.
          try {
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

            const fieldPatch = {
              ...cleanPatch,
              confidence: confValue,
              manually_edited_evidence: true,
              edited_at: new Date().toISOString(),
            };
            // update_lease_extraction_field's field_value area only accepts
            // field/field_evidence/confidence_score patch keys, and merges
            // (not replaces) them onto the existing fields[key]/
            // field_evidence[key] server-side. confidence_score is omitted
            // entirely when null so confidence_scores[key] is left untouched
            // (matching the prior direct-write behavior).
            await updateLeaseExtractionField({
              leaseId: lease.id,
              fieldArea: "field_value",
              action: "field_evidence_edit",
              fieldKey: f.key,
              patch: {
                field: fieldPatch,
                field_evidence: cleanPatch,
                ...(confValue != null ? { confidence_score: confValue } : {}),
              },
            });
            const nextExtraction = {
              ...(lease.extraction_data || {}),
              fields: {
                ...(lease.extraction_data?.fields || {}),
                [f.key]: { ...(prevField || {}), ...fieldPatch },
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
            // Seed the cache with the new extraction_data immediately so the
            // drawer / table re-render before the invalidation refetch
            // round-trips. Previously only invalidateQueries fired here,
            // which made the UI lag behind the actual save and looked like
            // "Save Evidence isn't reflecting".
            updateLeaseQueryCache(queryClient, leaseId, { extraction_data: nextExtraction });
            // No client-side logAudit here — update_lease_extraction_field
            // already writes the canonical audit row with
            // action='field_evidence_edit' server-side. Keeping both would
            // produce two differently-shaped entries for the same edit.
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

      {/* Sticky bottom action bar - once the abstract is approved we collapse
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
                  - Lease abstract approved
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
                  disabled={reextracting || !resolvedSourceFileId}
                  className="border-blue-300 text-blue-700 hover:bg-blue-50"
                  title="Re-run AI extraction - next approval will create a new version"
                >
                  {reextracting ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1 h-4 w-4" />}
                  {reextracting ? "Re-extracting..." : "Re-extract Lease"}
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className="text-xs text-slate-500">
                {canApprove ? (
                  <span className="text-emerald-700">All checks passed. You can approve the lease abstract.</span>
                ) : (
                  <div className="space-y-0.5">
                    {approvalBlockers.map((b) => (
                      <div key={b.kind} className="text-amber-700">
                        <span className="font-semibold">Approval blocked: {b.title}</span>
                        {b.detail && (
                          <span className="ml-1 text-amber-600"> — {b.detail}</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  onClick={() => setShowReextractConfirm(true)}
                  disabled={reextracting || !resolvedSourceFileId}
                  className="border-blue-300 text-blue-700 hover:bg-blue-50"
                  title={
                    resolvedSourceFileId
                      ? "Re-run AI extraction on the source PDF"
                      : "No source file linked. Use Extraction Debug -> Re-link first."
                  }
                >
                  {reextracting ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1 h-4 w-4" />}
                  {reextracting ? "Re-extracting..." : "Re-extract Lease"}
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
                      approvalBlockers.forEach((b) =>
                        toast.error(b.title, { description: b.detail, duration: 7000 })
                      );
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
                {editingField ? String(readFieldValue(lease, editingField.key) ?? "-") : ""}
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
            <DialogDescription asChild>
              <div>
                <div className="mb-4 mt-2 rounded bg-blue-50 p-3 text-sm text-blue-900 shadow-sm border border-blue-100 text-left">
                  <p className="font-semibold mb-1">Bulk Approval Summary</p>
                  <ul className="list-disc pl-4 space-y-0.5">
                    {bulkEvaluation.eligibleFields.length > 0 && (
                      <li><strong>{bulkEvaluation.eligibleFields.length}</strong> extracted fields will be auto-approved.</li>
                    )}
                    {(bulkEvaluation.autoNaFields || []).length > 0 && (
                      <li><strong>{(bulkEvaluation.autoNaFields || []).length}</strong> optional empty fields will be marked N/A.</li>
                    )}
                    {bulkEvaluation.optionalUnresolved.length > 0 && (
                      <li><strong>{bulkEvaluation.optionalUnresolved.length}</strong> optional fields remain unresolved.</li>
                    )}
                    <li>Rejected fields stay rejected. Expense Rules approval remains separate.</li>
                  </ul>
                </div>
                <p className="mb-2 text-sm text-slate-500 text-left">
                  Approval converts this draft into the official lease abstract. Downstream modules 
                  (Expenses, CAM, Budget, Billing) will only read from the approved abstract.
                </p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <div className="mb-3 rounded-lg bg-slate-50 p-3">
            <p className="text-sm font-medium text-slate-700">Lease Summary</p>
            <p className="text-xs text-slate-500">
              {lease.tenant_name} -- {getLeaseFieldLabel("lease_type", lease.lease_type) || "-"} --{" "}
              {commencementValue || "-"} to {expirationValue || "-"}
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
              <li>Source file: <code>{resolvedSourceFileId || "(none)"}</code></li>
              <li>Takes ~30-60 seconds. Don't close the page while it's running.</li>
            </ul>
          </div>
          <DialogFooter className="mt-3">
            <Button variant="outline" onClick={() => setShowReextractConfirm(false)} disabled={reextracting}>
              Cancel
            </Button>
            <Button
              className="bg-blue-600 hover:bg-blue-700"
              onClick={handleReextractLease}
              disabled={reextracting || !resolvedSourceFileId}
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
                      {s.name} ({s.role?.replace("_", " ")}) -- {s.email}
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

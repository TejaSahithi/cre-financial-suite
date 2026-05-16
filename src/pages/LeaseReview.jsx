import React, { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  ChevronDown,
  Check,
  CheckCircle2,
  FileText,
  FileX,
  Gavel,
  Loader2,
  MinusCircle,
  Pencil,
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
} from "@/lib/leaseReviewSchema";
import { createPageUrl } from "@/utils";
import { invokeEdgeFunction } from "@/services/edgeFunctions";
import { supabase } from "@/services/supabaseClient";
import {
  approveLeaseAbstract,
  saveAbstractDraft,
  rejectLeaseAbstract,
} from "@/services/leaseAbstractService";

const documentService = createEntityService("Document");

const confidenceColor = (score) => {
  if (score == null) return "bg-slate-100 text-slate-500";
  if (score >= 90) return "bg-emerald-100 text-emerald-700";
  if (score >= 75) return "bg-amber-100 text-amber-700";
  return "bg-red-100 text-red-700";
};

export default function LeaseReview() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const urlParams = new URLSearchParams(location.search);
  const leaseId = urlParams.get("id");

  const { trigger: triggerCompute } = useComputeTrigger();

  // UI state
  const [activeTab, setActiveTab] = useState("summary");
  const [editingField, setEditingField] = useState(null); // schema field object
  const [editValue, setEditValue] = useState("");
  const [showSignature, setShowSignature] = useState(false);
  const [showApproval, setShowApproval] = useState(false);
  const [showReject, setShowReject] = useState(false);
  const [showSendBack, setShowSendBack] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);

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

  // Field review state — keyed by field key, initialized from extraction_data.
  const [fieldReviews, setFieldReviews] = useState({});

  // Lease query
  const { data: lease, isLoading } = useQuery({
    queryKey: ["lease", leaseId],
    queryFn: () => leaseService.filter({ id: leaseId }),
    enabled: !!leaseId,
    select: (data) => data?.[0],
  });

  // Hydrate field reviews from the lease record when it loads.
  useEffect(() => {
    if (!lease) return;
    const stored = lease.extraction_data?.field_reviews || {};
    setFieldReviews(stored);
  }, [lease]);

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
  const { data: approvedRuleSet } = useQuery({
    queryKey: ["lease-expense-rule-status", leaseId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("lease_expense_rule_sets")
        .select("id, status, approved_at")
        .eq("lease_id", leaseId)
        .eq("status", "approved")
        .order("approved_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data || null;
    },
    enabled: !!leaseId,
  });

  const updateLeaseMutation = useMutation({
    mutationFn: async ({ id, data }) => {
      const updated = await leaseService.update(id, data);
      return updated;
    },
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
  const requiredResolved = REQUIRED_FIELD_KEYS.every((key) => isResolvedReview(fieldReviews[key]));
  const totalFields = LEASE_REVIEW_FIELDS.length;
  const resolvedCount = LEASE_REVIEW_FIELDS.reduce(
    (acc, f) => acc + (isResolvedReview(fieldReviews[f.key]) ? 1 : 0),
    0,
  );

  const allConfidences = LEASE_REVIEW_FIELDS.map((f) => readFieldConfidence(lease, f.key)).filter(
    (c) => typeof c === "number",
  );
  const highConf = allConfidences.filter((c) => c >= 90).length;
  const medConf = allConfidences.filter((c) => c >= 75 && c < 90).length;
  const lowConf = allConfidences.filter((c) => c < 75).length;

  const validationChecks = [];
  if (lease.start_date && lease.end_date) {
    const startOk = new Date(lease.start_date) < new Date(lease.end_date);
    validationChecks.push({
      pass: startOk,
      label: "Start date < End date",
      detail: startOk ? `${lease.start_date} < ${lease.end_date}` : "End date is before start date",
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
    pass: lowConf === 0,
    label: "All confidence scores ≥ 75%",
    detail: lowConf === 0 ? "No low-confidence fields detected" : `${lowConf} low-confidence field(s)`,
  });
  validationChecks.push({
    pass: requiredResolved,
    label: "Required fields reviewed",
    detail: requiredResolved
      ? `All ${REQUIRED_FIELD_KEYS.length} required fields are resolved`
      : `${REQUIRED_FIELD_KEYS.length - REQUIRED_FIELD_KEYS.filter((k) => isResolvedReview(fieldReviews[k])).length} required field(s) pending review`,
  });
  const passCount = validationChecks.filter((v) => v.pass).length;

  const totalSf = lease.total_sf || lease.square_footage;

  // Stakeholder routing for the Request Signature dialog.
  const scopedStakeholders = stakeholders.filter(
    (s) => !s.property_id || !lease.property_id || s.property_id === lease.property_id,
  );
  const signatureRecipients = scopedStakeholders.filter((s) => s.email);

  // --- Field-action helpers -----------------------------------------------
  const setFieldStatus = (key, status, extraPayload = {}) => {
    const next = {
      ...fieldReviews,
      [key]: {
        ...(fieldReviews[key] || {}),
        status,
        reviewed_at: new Date().toISOString(),
        ...extraPayload,
      },
    };
    setFieldReviews(next);
  };

  const handleAccept = (field) => setFieldStatus(field.key, REVIEW_STATUSES.ACCEPTED);
  const handleReject = (field) => setFieldStatus(field.key, REVIEW_STATUSES.REJECTED);
  const handleMarkNA = (field) => setFieldStatus(field.key, REVIEW_STATUSES.N_A);
  const handleNeedsLegal = (field) => setFieldStatus(field.key, REVIEW_STATUSES.NEEDS_LEGAL);
  const handleResetField = (field) => {
    const next = { ...fieldReviews };
    delete next[field.key];
    setFieldReviews(next);
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

    // total_sf alias → square_footage column.
    const columnKey = key === "total_sf" ? "square_footage" : key;

    try {
      // Persist value: write to known lease column AND store in extraction_data.fields.
      const updatedLease = await updateLeaseMutation.mutateAsync({
        id: lease.id,
        data: {
          [columnKey]: val,
          extraction_data: {
            ...(lease.extraction_data || {}),
            fields: {
              ...(lease.extraction_data?.fields || {}),
              [key]: { value: val, manually_edited: true },
            },
          },
        },
      });
      // Mark field as EDITED in review state.
      const next = {
        ...fieldReviews,
        [key]: {
          ...(fieldReviews[key] || {}),
          status: REVIEW_STATUSES.EDITED,
          value: val,
          reviewed_at: new Date().toISOString(),
        },
      };
      setFieldReviews(next);

      // Side effects for rent/dates: recompute downstream lease-derived expenses.
      if (["cam_amount", "nnn_amount", "start_date", "end_date", "tenant_name"].includes(key)) {
        await expenseService.syncLeaseDerivedExpenses({ leases: [updatedLease] });
        queryClient.invalidateQueries({ queryKey: ["Expense"] });
      }
      toast.success(`Updated ${editingField.label}`);
      setEditingField(null);
    } catch {
      // toast handled by mutation onError
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
    if (!requiredResolved) {
      toast.error("Resolve all required fields before approving the lease abstract.");
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

    try {
      let resolvedDocumentUrl = approvalDocumentUrl || null;
      const sourceFileId = lease.extraction_data?.source_file_id || null;
      if (!resolvedDocumentUrl && sourceFileId && supabase) {
        const { data: uploadedFile } = await supabase
          .from("uploaded_files")
          .select("file_url")
          .eq("id", sourceFileId)
          .maybeSingle();
        resolvedDocumentUrl = uploadedFile?.file_url || null;
      }

      const approvedLease = await approveLeaseAbstract({
        lease,
        fieldReviews,
        approvedBy: approvalSignedBy,
        signedAt: approvalSignedAt,
        comments: approvalComments,
        documentUrl: resolvedDocumentUrl,
      });

      queryClient.invalidateQueries({ queryKey: ["lease", leaseId] });
      queryClient.invalidateQueries({ queryKey: ["leases"] });
      if (approvedLease?.property_id) {
        triggerCompute(
          "compute-lease",
          { property_id: approvedLease.property_id, fiscal_year: new Date().getFullYear() },
          { silent: true },
        ).catch(() => {});
      }

      await expenseService.syncLeaseDerivedExpenses({ leases: [approvedLease] });
      if (approvedRuleSet?.id) {
        const propertyExpenses = await expenseService.filter({ property_id: approvedLease.property_id });
        await expenseService.classifyExpenses({ expenses: propertyExpenses, leases: [approvedLease] });
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
          message: `Lease abstract v${approvedLease.abstract_version} for ${lease.tenant_name || "tenant"} approved. Signed by ${approvalSignedBy}.`,
          link: createPageUrl("LeaseReview", { id: lease.id }),
          priority: "normal",
        });
      } catch {
        /* non-fatal */
      }

      toast.success(`Lease abstract approved (v${approvedLease.abstract_version})`);
      setShowApproval(false);
    } catch (err) {
      console.error("[LeaseReview] approve failed:", err);
      toast.error(err?.message || "Could not approve lease abstract");
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

  const handleRejectDocument = async () => {
    if (!rejectReason.trim()) {
      toast.error("Please provide a rejection reason.");
      return;
    }
    try {
      await rejectLeaseAbstract({
        lease,
        reason: rejectReason,
        reviewer: lease?.signed_by || null,
      });
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

  // --- Render --------------------------------------------------------------
  const leaseStatus = lease.status || "draft";

  return (
    <div className="space-y-6 p-6 pb-32">
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
            <Badge className={requiredResolved ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-800"}>
              Required {REQUIRED_FIELD_KEYS.filter((k) => isResolvedReview(fieldReviews[k])).length} / {REQUIRED_FIELD_KEYS.length}
            </Badge>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
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

      {/* Confidence summary */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="border-emerald-200 bg-emerald-50">
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold uppercase text-emerald-600">High Confidence (≥90%)</p>
            <p className="text-2xl font-bold text-emerald-700">{highConf} fields</p>
            <p className="text-[10px] text-emerald-500">Auto-populated</p>
          </CardContent>
        </Card>
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold uppercase text-amber-600">Medium (75-89%)</p>
            <p className="text-2xl font-bold text-amber-700">{medConf} fields</p>
            <p className="text-[10px] text-amber-500">Flagged for review</p>
          </CardContent>
        </Card>
        <Card className="border-red-200 bg-red-50">
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold uppercase text-red-600">Low (&lt;75%)</p>
            <p className="text-2xl font-bold text-red-600">{lowConf} fields</p>
            <p className="text-[10px] text-red-400">Verify before approval</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold uppercase text-slate-500">Validation Checks</p>
            <p className="text-2xl font-bold text-slate-900">
              {passCount}/{validationChecks.length} Pass
            </p>
            <p className="text-[10px] text-amber-500">
              {validationChecks.length - passCount} warning(s)
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
              <SummaryStat label="Term" value={`${lease.start_date || "—"} → ${lease.end_date || "—"}`} />
              <SummaryStat label="Monthly Rent" value={lease.monthly_rent ? `$${Number(lease.monthly_rent).toLocaleString()}` : "—"} />
              <SummaryStat label="Annual Rent" value={lease.annual_rent ? `$${Number(lease.annual_rent).toLocaleString()}` : "—"} />
              <SummaryStat label="Square Footage" value={totalSf ? `${Number(totalSf).toLocaleString()} SF` : "—"} />
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
                <CardTitle className="text-base">Approval Gate</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <p className="text-slate-700">
                  The Approve Lease Abstract action is disabled until every required field has been
                  reviewed (accepted, edited, marked N/A, or manual_required).
                </p>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs font-semibold text-slate-700">Required fields</p>
                  <ul className="mt-2 space-y-1 text-xs">
                    {REQUIRED_FIELD_KEYS.map((key) => {
                      const field = LEASE_REVIEW_FIELDS.find((f) => f.key === key);
                      const review = fieldReviews[key];
                      const resolved = isResolvedReview(review);
                      return (
                        <li key={key} className="flex items-center justify-between gap-2">
                          <span className="text-slate-600">{field?.label || key}</span>
                          <Badge className={resolved ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-800"}>
                            {resolved ? REVIEW_STATUS_LABELS[review.status] : "Pending"}
                          </Badge>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Field tabs */}
        {LEASE_REVIEW_TABS.filter((t) => !["summary", "documents_exhibits", "budget_preview"].includes(t.key)).map((tab) => (
          <TabsContent key={tab.key} value={tab.key} className="mt-4 space-y-3">
            {(FIELDS_BY_TAB[tab.key] || []).map((field) => (
              <FieldReviewRow
                key={field.key}
                field={field}
                lease={lease}
                review={fieldReviews[field.key]}
                onAccept={() => handleAccept(field)}
                onEdit={() => openEdit(field)}
                onReject={() => handleReject(field)}
                onMarkNA={() => handleMarkNA(field)}
                onNeedsLegal={() => handleNeedsLegal(field)}
                onReset={() => handleResetField(field)}
              />
            ))}
          </TabsContent>
        ))}

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
              <SourceFileLink fileId={lease.extraction_data?.source_file_id} />
            </CardContent>
          </Card>
        </TabsContent>

        {/* Budget Preview tab */}
        <TabsContent value="budget_preview" className="mt-4 space-y-3">
          <BudgetPreviewCard lease={lease} />
        </TabsContent>
      </Tabs>

      {/* Sticky bottom action bar */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 px-6 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
          <div className="text-xs text-slate-500">
            {requiredResolved
              ? "All required fields are reviewed. You can approve the lease abstract."
              : `${REQUIRED_FIELD_KEYS.length - REQUIRED_FIELD_KEYS.filter((k) => isResolvedReview(fieldReviews[k])).length} required field(s) still need review.`}
          </div>
          <div className="flex flex-wrap items-center gap-2">
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
              className="bg-emerald-600 hover:bg-emerald-700"
              onClick={() => setShowApproval(true)}
              disabled={!requiredResolved}
            >
              <CheckCircle2 className="mr-1 h-4 w-4" />
              Approve Lease Abstract
            </Button>
          </div>
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
              {lease.start_date} to {lease.end_date}
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
              disabled={updateLeaseMutation.isPending}
            >
              {updateLeaseMutation.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
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
  onReset,
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

  const { rawValue, sourcePage, sourceText } = readFieldEvidence(lease, field.key);
  const confidence = readFieldConfidence(lease, field.key);
  const status = review?.status || REVIEW_STATUSES.PENDING;
  const required = field.required;
  const allowNA = field.allowNA !== false;
  const actionLabel = REVIEW_STATUS_LABELS[status] || "Review Action";

  return (
    <Card className={status === REVIEW_STATUSES.PENDING && required ? "border-amber-200" : ""}>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">
                {field.label}
                {required && <span className="ml-1 text-red-500">*</span>}
              </p>
              {confidence != null && (
                <Badge className={`text-[10px] ${confidenceColor(confidence)}`}>{confidence}%</Badge>
              )}
              <Badge className={`text-[10px] ${REVIEW_STATUS_STYLES[status]}`}>
                {REVIEW_STATUS_LABELS[status]}
              </Badge>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <p className="text-[10px] font-semibold uppercase text-slate-400">Normalized Value</p>
                <p className="text-sm font-medium text-slate-900">{display}</p>
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase text-slate-400">Raw Extracted</p>
                <p className="truncate text-sm text-slate-600">{rawValue ?? "—"}</p>
              </div>
            </div>
            {(sourcePage || sourceText) && (
              <details className="text-xs text-slate-500">
                <summary className="cursor-pointer text-slate-600 hover:text-slate-800">
                  Source {sourcePage ? `(p. ${sourcePage})` : ""}
                </summary>
                <p className="mt-1 rounded bg-slate-50 p-2 italic">{sourceText || "No source text captured."}</p>
              </details>
            )}
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

function SourceFileLink({ fileId }) {
  const { data } = useQuery({
    queryKey: ["uploaded-file-url", fileId],
    queryFn: async () => {
      if (!fileId) return null;
      const { data: row } = await supabase
        .from("uploaded_files")
        .select("file_url, file_name")
        .eq("id", fileId)
        .maybeSingle();
      return row;
    },
    enabled: !!fileId,
  });
  if (!fileId) return <p className="text-xs text-slate-500">No source file linked.</p>;
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

function BudgetPreviewCard({ lease }) {
  const monthly = useMemo(() => {
    const v = Number(lease.monthly_rent || (lease.annual_rent ? lease.annual_rent / 12 : 0));
    return Number.isFinite(v) ? v : 0;
  }, [lease.monthly_rent, lease.annual_rent]);

  const months = useMemo(() => {
    const out = [];
    if (!lease.start_date) return out;
    const start = new Date(lease.start_date);
    const escalation = Number(lease.escalation_rate || 0) / 100;
    for (let i = 0; i < 12; i++) {
      const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
      const yearsIn = Math.floor(i / 12);
      const stepRent = monthly * Math.pow(1 + escalation, yearsIn);
      out.push({ label: d.toLocaleDateString(undefined, { year: "numeric", month: "short" }), amount: stepRent });
    }
    return out;
  }, [lease.start_date, lease.escalation_rate, monthly]);

  if (!lease.start_date || !monthly) {
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

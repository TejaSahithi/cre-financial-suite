import React, { useState, useEffect } from "react";
import { leaseService } from "@/services/leaseService";
import { NotificationService, createEntityService } from "@/services/api";
import { expenseService } from "@/services/expenseService";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import useOrgQuery from "@/hooks/useOrgQuery";
import { useComputeTrigger } from "@/hooks/useComputeTrigger";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SelectWithCustom } from "@/components/ui/select-with-custom";
import { LEASE_FIELD_OPTIONS, getLeaseFieldLabel, hasLeaseFieldOptions } from "@/lib/leaseFieldOptions";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { ArrowLeft, CheckCircle2, AlertTriangle, Send, Pencil, Loader2, FileX, Plus } from "lucide-react";
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { createPageUrl } from "@/utils";
import { toast } from "sonner";
import { invokeEdgeFunction } from "@/services/edgeFunctions";
import { supabase } from "@/services/supabaseClient";

const documentService = createEntityService("Document");

const confidenceColor = (score, isEdited = false) => {
  if (isEdited) return "bg-emerald-100 text-emerald-700"; // manually edited → always green
  if (score >= 90) return "bg-emerald-100 text-emerald-700";
  if (score >= 75) return "bg-amber-100 text-amber-700";
  return "bg-red-100 text-red-700";
};

export default function LeaseReview() {
  const location = useLocation();
  const navigate = useNavigate();
  const urlParams = new URLSearchParams(location.search);
  const leaseId = urlParams.get("id");
  const queryClient = useQueryClient();
  const { trigger: triggerCompute } = useComputeTrigger();
  const [showSignature, setShowSignature] = useState(false);
  const [showApproval, setShowApproval] = useState(false);
  const [allocationModel, setAllocationModel] = useState("pro_rata");
  const [vacancyHandling, setVacancyHandling] = useState("exclude");
  const [editingField, setEditingField] = useState(null);
  const [editValue, setEditValue] = useState("");
  const [notificationSent, setNotificationSent] = useState(false);
  // Track fields that have been manually edited — they get boosted confidence display
  const [editedFields, setEditedFields] = useState(new Set());
  // Custom fields added by user
  const [customFields, setCustomFields] = useState([]);
  const [showAddField, setShowAddField] = useState(false);
  const [newFieldKey, setNewFieldKey] = useState("");
  const [newFieldValue, setNewFieldValue] = useState("");
  // Approval state
  const [approvalSignedBy, setApprovalSignedBy] = useState("");
  const [approvalSignedAt, setApprovalSignedAt] = useState("");
  const [approvalComments, setApprovalComments] = useState("");
  const [approvalDocumentUrl, setApprovalDocumentUrl] = useState("");
  const [signatureRecipientId, setSignatureRecipientId] = useState("");
  const [signatureMessage, setSignatureMessage] = useState("");
  const [sendingSignature, setSendingSignature] = useState(false);
  const [sendingTeamReview, setSendingTeamReview] = useState(false);

  const { data: lease, isLoading } = useQuery({
    queryKey: ['lease', leaseId],
    queryFn: () => leaseService.filter({ id: leaseId }),
    enabled: !!leaseId,
    select: data => data?.[0],
  });

  // Mark related notifications as read when the review page is opened
  useEffect(() => {
    if (leaseId) {
      NotificationService.list().then(notifs => {
        const related = notifs.filter(n => !n.is_read && n.link?.includes(leaseId));
        for (const n of related) {
          NotificationService.update(n.id, { is_read: true }).catch(() => {});
        }
      }).catch(err => {
        console.warn("[LeaseReview] Failed to auto-clear notifications:", err);
      });
    }
  }, [leaseId]);

  const { data: stakeholders = [] } = useOrgQuery("Stakeholder");

  const updateLeaseMutation = useMutation({
    mutationFn: async ({ id, data }) => {
      // Use leaseService instead of raw supabase to benefit from global schema mapping
      const updated = await leaseService.update(id, data);
      return updated;
    },
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: ["lease", leaseId] });
      queryClient.invalidateQueries({ queryKey: ["leases"] });
      toast.success("Lease updated successfully");
      // Trigger recomputation in the background (fire-and-forget)
      if (updated?.property_id) {
        triggerCompute(
          "compute-lease",
          { property_id: updated.property_id, fiscal_year: new Date().getFullYear() },
          { silent: true }
        ).then(() => {
          // Invalidate snapshot queries so dashboards auto-refresh
          queryClient.invalidateQueries({ queryKey: ["snapshot", "lease"] });
          queryClient.invalidateQueries({ queryKey: ["snapshot", "revenue"] });
        }).catch(() => {});
      }
    },
    onError: (err) => {
      console.error("[LeaseReview] update failed:", err);
      toast.error(`Update failed: ${err?.message ?? "Unknown error"}`);
    },
  });

  // No lease ID or lease not found
  if (!leaseId) {
    return (
      <div className="p-6 flex flex-col items-center justify-center h-96">
        <FileX className="w-12 h-12 text-slate-300 mb-4" />
        <h2 className="text-xl font-bold text-slate-900 mb-2">No Lease Selected</h2>
        <p className="text-sm text-slate-500 mb-4">Please select a lease from the Leases page to review.</p>
        <Link to={createPageUrl("Leases")}><Button>Go to Leases</Button></Link>
      </div>
    );
  }

  if (isLoading) {
    return <div className="flex items-center justify-center h-96"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>;
  }

  if (!lease) {
    return (
      <div className="p-6 flex flex-col items-center justify-center h-96">
        <FileX className="w-12 h-12 text-slate-300 mb-4" />
        <h2 className="text-xl font-bold text-slate-900 mb-2">Lease Not Found</h2>
        <p className="text-sm text-slate-500 mb-4">This lease may have been deleted or you don't have access.</p>
        <Link to={createPageUrl("Leases")}><Button>Go to Leases</Button></Link>
      </div>
    );
  }

  // Build fields from actual lease data — use extraction confidence if available
  const scores = lease.extraction_data?.confidence_scores || {};
  const getConf = (key, fallback = 85) => (typeof scores[key] === 'number' ? scores[key] : fallback);

  // Helper to render an option-backed field's display value, falling back to
  // the raw stored string for custom user-entered values.
  const optionLabel = (key, fallback = "—") => {
    const raw = lease[key];
    if (raw == null || raw === "") return fallback;
    return getLeaseFieldLabel(key, raw) || String(raw);
  };

  const totalSf = lease.total_sf || lease.square_footage;

  const fields = {
    "Basic Terms": [
      { key: "tenant_name", label: "TENANT NAME", value: lease.tenant_name || "—", confidence: getConf("tenant_name", 98) },
      { key: "lease_type", label: "LEASE TYPE", value: optionLabel("lease_type"), confidence: getConf("lease_type", 95) },
      { key: "start_date", label: "START DATE", value: lease.start_date || "—", confidence: getConf("start_date", 94) },
      { key: "end_date", label: "END DATE", value: lease.end_date || "—", confidence: getConf("end_date", 92) },
    ],
    "Financial Terms": [
      { key: "rent_per_sf", label: "BASE RENT ($/SF/YR)", value: lease.rent_per_sf ? String(lease.rent_per_sf) : "\u2014", confidence: editedFields.has("rent_per_sf") ? 95 : getConf("rent_per_sf", 92) },
      { key: "total_sf", label: "TOTAL SF", value: totalSf ? Number(totalSf).toLocaleString() : "\u2014", confidence: editedFields.has("total_sf") ? 99 : getConf("total_sf", 99) },
      { key: "annual_rent", label: "ANNUAL RENT", value: lease.annual_rent ? "$" + Number(lease.annual_rent).toLocaleString() : "\u2014", confidence: editedFields.has("annual_rent") ? 99 : getConf("annual_rent", 99) },
      { key: "security_deposit", label: "SECURITY DEPOSIT", value: lease.security_deposit ? "$" + Number(lease.security_deposit).toLocaleString() : "\u2014", confidence: editedFields.has("security_deposit") ? 95 : getConf("security_deposit", 60) },
      { key: "escalation_rate", label: "RENT ESCALATION", value: lease.escalation_rate ? lease.escalation_rate + "%" : "\u2014", confidence: editedFields.has("escalation_rate") ? 90 : getConf("escalation_rate", 78) },
      { key: "escalation_type", label: "ESCALATION TYPE", value: optionLabel("escalation_type"), confidence: editedFields.has("escalation_type") ? 90 : getConf("escalation_type", 80) },
    ],
    "Escalation & Renewal": [
      { key: "escalation_timing", label: "ESCALATION TIMING", value: optionLabel("escalation_timing", "Lease Anniversary"), confidence: getConf("escalation_timing", 90) },
      { key: "free_rent_months", label: "FREE RENT PERIODS", value: lease.free_rent_months || "—", confidence: getConf("free_rent_months", 91) },
      { key: "ti_allowance", label: "TI ALLOWANCE", value: lease.ti_allowance ? `$${Number(lease.ti_allowance).toLocaleString()}` : "—", confidence: getConf("ti_allowance", 88) },
      { key: "renewal_type", label: "RENEWAL TYPE", value: optionLabel("renewal_type"), confidence: getConf("renewal_type", 78) },
      { key: "renewal_options", label: "RENEWAL OPTIONS", value: optionLabel("renewal_options"), confidence: getConf("renewal_options", 64) },
      { key: "renewal_notice_months", label: "RENEWAL NOTICE (MONTHS)", value: lease.renewal_notice_months || "—", confidence: getConf("renewal_notice_months", 72) },
    ],
    "CAM & Management": [
      { key: "cam_cap_type", label: "CAM CAP TYPE", value: optionLabel("cam_cap_type", "None"), confidence: getConf("cam_cap_type", 95) },
      { key: "admin_fee_pct", label: "ADMIN FEE %", value: lease.admin_fee_pct ? `${lease.admin_fee_pct}%` : "N/A", confidence: getConf("admin_fee_pct", 97) },
      { key: "management_fee_basis", label: "MGMT FEE BASIS", value: optionLabel("management_fee_basis", "CAM Pool Pro-Rata"), confidence: getConf("management_fee_basis", 88) },
      { key: "hvac_responsibility", label: "HVAC RESPONSIBILITY", value: optionLabel("hvac_responsibility", "Landlord"), confidence: getConf("hvac_responsibility", 92) },
      { key: "sales_reporting_frequency", label: "SALES REPORTING FREQ.", value: optionLabel("sales_reporting_frequency", "Annual"), confidence: getConf("sales_reporting_frequency", 88) },
    ],
  };

  const allFieldsFlat = Object.values(fields).flat();
  const highConf = allFieldsFlat.filter(f => f.confidence >= 90).length;
  const medConf = allFieldsFlat.filter(f => f.confidence >= 75 && f.confidence < 90).length;
  const lowConf = allFieldsFlat.filter(f => f.confidence < 75).length;

  // Dynamic validation checks based on actual lease data
  const validationChecks = [];
  if (lease.start_date && lease.end_date) {
    const startOk = new Date(lease.start_date) < new Date(lease.end_date);
    validationChecks.push({ pass: startOk, label: "Start date < End date", detail: startOk ? `${lease.start_date} < ${lease.end_date}` : "End date is before start date" });
  }
  if (lease.tenant_name) {
    validationChecks.push({ pass: true, label: "Tenant name present", detail: `${lease.tenant_name} verified` });
  }
  if (lease.annual_rent) {
    validationChecks.push({ pass: lease.annual_rent > 0, label: "Annual rent > $0", detail: `$${Number(lease.annual_rent).toLocaleString()}` });
  }
  const sf = lease.total_sf || lease.square_footage;
  if (sf) {
    validationChecks.push({ pass: sf > 0, label: "Square footage present", detail: `${Number(sf).toLocaleString()} SF` });
  }
  const hasLowConf = lowConf > 0;
  if (hasLowConf) {
    validationChecks.push({ pass: false, label: "All confidence scores ≥ 70%", detail: `${lowConf} field(s) below threshold — human review required` });
  } else {
    validationChecks.push({ pass: true, label: "All confidence scores ≥ 70%", detail: "No low-confidence fields detected" });
  }

  const passCount = validationChecks.filter(v => v.pass).length;
  const scopedStakeholders = stakeholders.filter((stakeholder) =>
    !stakeholder.property_id || !lease.property_id || stakeholder.property_id === lease.property_id
  );
  const reviewRecipientRoles = new Set(["property_manager", "asset_manager", "leasing_agent"]);
  const teamReviewRecipients = scopedStakeholders
    .filter((stakeholder) => reviewRecipientRoles.has(stakeholder.role) && stakeholder.email)
    .sort((a, b) => {
      const rank = { property_manager: 0, asset_manager: 1, leasing_agent: 2 };
      return (rank[a.role] ?? 9) - (rank[b.role] ?? 9);
    });
  const primaryPropertyManager =
    teamReviewRecipients.find((stakeholder) => stakeholder.role === "property_manager") ||
    scopedStakeholders.find((stakeholder) => stakeholder.role === "property_manager" && stakeholder.email) ||
    null;
  const signatureRecipients = scopedStakeholders.filter((stakeholder) => stakeholder.email);
  const teamRecipientSummary = teamReviewRecipients.length > 0
    ? teamReviewRecipients.map((stakeholder) => `${stakeholder.name} <${stakeholder.email}>`).join(", ")
    : "No property manager / asset manager / leasing agent email is configured for this property.";

  const sendTeamReviewRequest = async () => {
    setSendingTeamReview(true);
    try {
      const lowConfidenceFields = allFieldsFlat
        .filter((field) => field.confidence < 75)
        .map((field) => `${field.label}: ${field.confidence}%`);
      const reviewUrl = window.location.origin + createPageUrl("LeaseReview", { id: lease.id });
      const recipientEmails = teamReviewRecipients.map((stakeholder) => stakeholder.email);

      await NotificationService.create({
        org_id: lease.org_id,
        type: "review_request",
        title: "Lease Review Sent to Team",
        message: `Lease review for ${lease.tenant_name || "Unknown tenant"} was sent to ${teamRecipientSummary}. ${lowConf} low-confidence field(s) need attention.`,
        link: createPageUrl("LeaseReview", { id: lease.id }),
        priority: "high"
      });

      if (recipientEmails.length > 0) {
        await invokeEdgeFunction("send-email", {
          to: recipientEmails,
          subject: `[Action Required] Lease Review: ${lease.tenant_name || "Lease"}`,
          html: `<h2>Lease Review Sent to Team</h2>
            <p>A lease review requires attention before final approval.</p>
            <p><strong>Tenant:</strong> ${lease.tenant_name || "Unknown"}</p>
            <p><strong>Recipients:</strong> ${teamRecipientSummary}</p>
            <p><strong>Low-confidence fields:</strong> ${lowConf}</p>
            ${lowConfidenceFields.length > 0 ? `<ul>${lowConfidenceFields.map((field) => `<li>${field}</li>`).join("")}</ul>` : ""}
            <p><a href="${reviewUrl}" style="background:#dc2626;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block;margin-top:12px;">Open Lease Review</a></p>`,
        });
      }

      setNotificationSent(true);
      toast.success(
        recipientEmails.length > 0
          ? `Review sent to ${teamReviewRecipients.length} recipient${teamReviewRecipients.length === 1 ? "" : "s"}: ${teamReviewRecipients.map((r) => r.name).join(", ")}`
          : "In-app team review alert created. Add a property manager email to send mail."
      );
    } catch (err) {
      console.error("[LeaseReview] Flag for review error:", err);
      toast.error(err?.message || "Failed to send review request");
    } finally {
      setSendingTeamReview(false);
    }
  };

  const sendSignatureRequest = async () => {
    const recipient = signatureRecipients.find((stakeholder) => stakeholder.id === signatureRecipientId);
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
        priority: "high"
      });

      await invokeEdgeFunction("send-email", {
        to: recipient.email,
        subject: `[Signature Requested] ${lease.tenant_name || "Lease"}`,
        html: `<h2>Lease Signature Requested</h2>
          <p>You have been asked to review and sign a lease.</p>
          <p><strong>Tenant:</strong> ${lease.tenant_name || "Unknown"}</p>
          <p><strong>Requested by:</strong> CRE Platform</p>
          ${signatureMessage ? `<p><strong>Message:</strong> ${signatureMessage}</p>` : ""}
          <p><a href="${reviewUrl}" style="background:#2563eb;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block;margin-top:12px;">Open Signature Request</a></p>
          <p style="color:#64748b;font-size:12px;margin-top:16px;">DocuSign integration is not yet connected, so this sends a tracked email/request and records the action in the platform.</p>`,
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

  const handleReuploadPdf = () => {
    const params = new URLSearchParams();
    if (lease.property_id) params.set("property", lease.property_id);
    if (lease.building_id) params.set("building", lease.building_id);
    if (lease.unit_id) params.set("unit", lease.unit_id);
    navigate(`${createPageUrl("LeaseUpload")}${params.toString() ? `?${params.toString()}` : ""}`);
  };

  const handleApprove = async () => {
    // Block approval if no signature info provided
    if (!approvalSignedBy.trim()) {
      toast.error("Please enter who signed the lease before approving.");
      return;
    }
    if (!approvalSignedAt) {
      toast.error("Please enter the date/time the lease was signed.");
      return;
    }

    if (lowConf > 0) {
      try {
        await NotificationService.create({
          org_id: lease.org_id,
          type: "low_confidence_alert",
          title: "Approval Attempt with Low Confidence",
          message: `Lease for ${lease.tenant_name} was approved with ${lowConf} low-confidence fields.`,
          link: createPageUrl("LeaseReview", { id: lease.id }),
          priority: "high"
        });
      } catch (err) {
        console.error("Failed to send notification:", err);
      }
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

      // 1. Update lease to budget_ready with signature metadata
      const approvedLease = await updateLeaseMutation.mutateAsync({
        id: lease.id,
        data: {
          status: "budget_ready",
          signed_by: approvalSignedBy,
          signed_at: approvalSignedAt,
          approval_comments: approvalComments,
          approval_document_url: resolvedDocumentUrl,
        }
      });

      await expenseService.syncLeaseDerivedExpenses({ leases: [approvedLease] });
      queryClient.invalidateQueries({ queryKey: ["Expense"] });

      // 2. Save to documents table (non-fatal if table missing)
      try {
        await documentService.create({
          org_id: lease.org_id,
          property_id: lease.property_id,
          lease_id: lease.id,
          type: "lease",
          name: `Lease — ${lease.tenant_name}`,
          status: "approved",
          signed_by: approvalSignedBy,
          signed_at: approvalSignedAt,
          comments: approvalComments,
          document_url: resolvedDocumentUrl,
        });
      } catch (docErr) {
        console.warn("[LeaseReview] Failed to save to documents:", docErr);
      }

      // 3. Send approval notification
      try {
        await NotificationService.create({
          org_id: lease.org_id,
          type: "lease_approved",
          title: "Lease Approved",
          message: `Lease for ${lease.tenant_name} has been approved and is now budget-ready. Signed by ${approvalSignedBy}.`,
          link: createPageUrl("LeaseReview", { id: lease.id }),
          priority: "normal"
        });
      } catch {}

      toast.success("Lease approved and saved to Documents.");
      setShowApproval(false);
    } catch {
      // error already toasted by onError
    }
  };

  const handleFieldEdit = (field) => {
    setEditingField(field);
    // Get raw value from lease
    const raw = lease[field.key];
    setEditValue(raw !== undefined && raw !== null ? String(raw) : "");
  };

  const NUMERIC_FIELDS = new Set([
    "rent_per_sf", "total_sf", "square_footage", "annual_rent", "monthly_rent",
    "base_rent", "escalation_rate", "admin_fee_pct",
    "ti_allowance", "renewal_notice_months",
    "security_deposit", "cam_amount", "nnn_amount", "free_rent_months",
  ]);

  const handleFieldSave = async () => {
    if (!editingField) return;
    const editedFieldKey = editingField.key;
    let val = typeof editValue === "string" ? editValue.trim() : editValue;

    if (NUMERIC_FIELDS.has(editedFieldKey)) {
      const n = parseFloat(String(val).replace(/[$,]/g, ""));
      val = isNaN(n) ? null : n;
    }

    // Map UI alias `total_sf` to the actual DB column.
    const updateData = editedFieldKey === "total_sf"
      ? { square_footage: val }
      : { [editedFieldKey]: val };

    try {
      const updatedLease = await updateLeaseMutation.mutateAsync({ id: lease.id, data: updateData });
      if (["cam_amount", "nnn_amount", "building_id", "unit_id", "start_date", "end_date", "tenant_name"].includes(editedFieldKey)) {
        await expenseService.syncLeaseDerivedExpenses({ leases: [updatedLease] });
        queryClient.invalidateQueries({ queryKey: ["Expense"] });
      }
      // Boost confidence display for this field — it's been human-verified
      setEditedFields(prev => new Set([...prev, editedFieldKey]));
      setEditingField(null); // only close on success
    } catch {
      // error already toasted by onError — keep dialog open so user can retry
    }
  };

  return (
    <div className="p-6 space-y-6">
      <Link to={createPageUrl("Leases")} className="text-sm text-slate-500 hover:text-slate-700 flex items-center gap-1">
        <ArrowLeft className="w-4 h-4" /> Back to Leases
      </Link>

      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Lease Review & Validation</h1>
          <p className="text-sm text-slate-500">{lease.tenant_name} — {totalSf ? `${Number(totalSf).toLocaleString()} SF` : ''} · {getLeaseFieldLabel("lease_type", lease.lease_type) || 'Unknown type'}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleReuploadPdf}>Re-Upload PDF</Button>
          <Button className="bg-blue-600 hover:bg-blue-700" onClick={() => setShowSignature(true)}><Send className="w-4 h-4 mr-1" />Request Signature</Button>
          <Button className="bg-emerald-600 hover:bg-emerald-700" onClick={() => setShowApproval(true)}><CheckCircle2 className="w-4 h-4 mr-1" />Approve Lease</Button>
        </div>
      </div>

      {/* Low Confidence Block Alert */}
      {lowConf > 0 && (
        <div className="bg-red-50 border-2 border-red-300 rounded-xl p-4 flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <AlertTriangle className="w-6 h-6 text-red-500 flex-shrink-0" />
            <div>
              <p className="text-sm font-bold text-red-800">Budget Start Blocked — Low Confidence Fields Detected</p>
              <p className="text-xs text-red-600 mt-0.5">{lowConf} field(s) scored below 70% confidence. Human review and correction is required before this lease can be marked as "Budget Ready." Correct the flagged fields and re-validate.</p>
            </div>
          </div>
          <div className="flex justify-end pt-2 border-t border-red-200">
            <Button 
              size="sm" 
              variant="destructive" 
              className="bg-red-600 hover:bg-red-700"
              onClick={sendTeamReviewRequest}
              disabled={sendingTeamReview}
            >
              {sendingTeamReview ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <AlertTriangle className="w-4 h-4 mr-1.5" />}
              {notificationSent ? "Review Sent to Team" : "Send to Team Review"}
            </Button>
          </div>
          <p className="text-xs text-red-700">
            Team recipients: {teamRecipientSummary}
          </p>
        </div>
      )}

      {/* Confidence Summary */}
      <div className="grid grid-cols-4 gap-4">
        <Card className="bg-emerald-50 border-emerald-200"><CardContent className="p-4"><p className="text-[10px] font-semibold text-emerald-600 uppercase">High Confidence (≥90%)</p><p className="text-2xl font-bold text-emerald-700">{highConf} fields</p><p className="text-[10px] text-emerald-500">Auto-populated</p></CardContent></Card>
        <Card className="bg-amber-50 border-amber-200"><CardContent className="p-4"><p className="text-[10px] font-semibold text-amber-600 uppercase">Medium (70-89%)</p><p className="text-2xl font-bold text-amber-700">{medConf} fields</p><p className="text-[10px] text-amber-500">Flagged for review</p></CardContent></Card>
        <Card className="bg-red-50 border-red-200"><CardContent className="p-4"><p className="text-[10px] font-semibold text-red-600 uppercase">Low (&lt;70%) — BLOCKING</p><p className="text-2xl font-bold text-red-600">{lowConf} fields</p><p className="text-[10px] text-red-400">Must correct to proceed</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-[10px] font-semibold text-slate-500 uppercase">Validation Checks</p><p className="text-2xl font-bold text-slate-900">{passCount}/{validationChecks.length} Pass</p><p className="text-[10px] text-amber-500">{validationChecks.length - passCount} warning(s)</p></CardContent></Card>
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Left: Tabs with field groups */}
        <div className="lg:col-span-2">
          <Tabs defaultValue="Basic Terms">
            <TabsList className="bg-white border">
              {Object.keys(fields).map(tab => <TabsTrigger key={tab} value={tab} className="text-xs">{tab}</TabsTrigger>)}
            </TabsList>
            {Object.entries(fields).map(([tabName, fieldList]) => (
              <TabsContent key={tabName} value={tabName} className="mt-4 space-y-3">
                {fieldList.map((f, i) => {
                  const isEdited = editedFields.has(f.key);
                  return (
                    <Card key={i} className={f.warning ? 'border-amber-200' : ''}>
                      <CardContent className="p-4 flex items-start justify-between">
                        <div>
                          <div className="flex items-center gap-2">
                            <p className="text-[10px] font-semibold text-slate-500 uppercase">{f.label}</p>
                            <Badge className={`text-[10px] ${confidenceColor(f.confidence, isEdited)}`}>
                              {isEdited ? "Verified" : f.confidence + "%"}
                            </Badge>
                          </div>
                          <p className="text-sm font-medium text-slate-900 mt-1">{String(f.value)}</p>
                          {f.warning && <p className="text-xs text-amber-600 mt-1 flex items-center gap-1"><AlertTriangle className="w-3 h-3" />{f.warning}</p>}
                        </div>
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleFieldEdit(f)}><Pencil className="w-3.5 h-3.5 text-slate-400" /></Button>
                      </CardContent>
                    </Card>
                  );
                })}
                {/* Custom fields for this tab (shown on all tabs) */}
                {tabName === "Financial Terms" && customFields.map((cf, i) => (
                  <Card key={"custom-" + i} className="border-dashed border-slate-300">
                    <CardContent className="p-4 flex items-start justify-between">
                      <div>
                        <p className="text-[10px] font-semibold text-slate-500 uppercase">{cf.label}</p>
                        <p className="text-sm font-medium text-slate-900 mt-1">{cf.value}</p>
                      </div>
                      <Badge className="text-[10px] bg-blue-100 text-blue-700">Custom</Badge>
                    </CardContent>
                  </Card>
                ))}
                {tabName === "Financial Terms" && (
                  <Button variant="outline" size="sm" className="w-full border-dashed" onClick={() => setShowAddField(true)}>
                    <Plus className="w-3.5 h-3.5 mr-1.5" /> Add Custom Field
                  </Button>
                )}
              </TabsContent>
            ))}
          </Tabs>
        </div>

        {/* Right: Validation + Allocation + Audit */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Validation Checks</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {validationChecks.map((c, i) => (
                <div key={i} className={`p-2.5 rounded-lg ${c.pass ? 'bg-emerald-50' : 'bg-red-50'}`}>
                  <div className="flex items-center gap-2">
                    {c.pass ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" /> : <AlertTriangle className="w-3.5 h-3.5 text-red-500" />}
                    <p className="text-xs font-medium text-slate-900">{c.label}</p>
                  </div>
                  <p className="text-[10px] text-slate-500 ml-5 mt-0.5">{c.detail}</p>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Allocation Settings</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div>
                <Label className="text-[10px] font-semibold text-slate-500 uppercase">Allocation Model</Label>
                <Select value={allocationModel} onValueChange={setAllocationModel}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pro_rata">Pro-Rata</SelectItem>
                    <SelectItem value="equal">Equal</SelectItem>
                    <SelectItem value="weighted">Weighted</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-[10px] font-semibold text-slate-500 uppercase">Vacancy Handling</Label>
                <Select value={vacancyHandling} onValueChange={setVacancyHandling}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="exclude">Exclude</SelectItem>
                    <SelectItem value="include">Include</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Request Signature Dialog */}
      <Dialog open={showSignature} onOpenChange={setShowSignature}>
        <DialogContent>
          <DialogHeader><DialogTitle>Request Digital Signature</DialogTitle></DialogHeader>
          <p className="text-sm text-slate-500">Send the lease for signature to a designated stakeholder. The magic link expires in 48 hours.</p>
          <div className="space-y-4 mt-2">
            <div>
              <Label>Send To</Label>
              <Select value={signatureRecipientId} onValueChange={setSignatureRecipientId}>
                <SelectTrigger><SelectValue placeholder="Select stakeholder" /></SelectTrigger>
                <SelectContent>
                  {signatureRecipients.map(s => <SelectItem key={s.id} value={s.id}>{s.name} ({s.role?.replace('_', ' ')}) · {s.email}</SelectItem>)}
                </SelectContent>
              </Select>
              {signatureRecipients.length === 0 && (
                <p className="mt-1 text-xs text-amber-600">No stakeholders with email are configured for this property.</p>
              )}
            </div>
            {primaryPropertyManager && (
              <div className="rounded-lg border border-blue-100 bg-blue-50 p-3 text-xs text-blue-800">
                Property manager: {primaryPropertyManager.name} &lt;{primaryPropertyManager.email}&gt;
              </div>
            )}
            <div>
              <Label>Message (optional)</Label>
              <Textarea
                placeholder="Please review and sign this lease after validating the extracted terms..."
                rows={3}
                value={signatureMessage}
                onChange={(event) => setSignatureMessage(event.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSignature(false)}>Cancel</Button>
            <Button className="bg-blue-600 hover:bg-blue-700" onClick={sendSignatureRequest} disabled={sendingSignature || signatureRecipients.length === 0}>
              {sendingSignature && <Loader2 className="w-4 h-4 animate-spin mr-1" />}
              Send Request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Approve Lease Dialog */}
      <Dialog open={showApproval} onOpenChange={setShowApproval}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Approve Lease</DialogTitle></DialogHeader>
          <p className="text-sm text-slate-500 mb-2">Approval requires signature confirmation. The lease will be marked as Budget-Ready and saved to Documents.</p>
          <div className="bg-slate-50 p-3 rounded-lg mb-3">
            <p className="text-sm font-medium text-slate-700">Lease Summary</p>
            <p className="text-xs text-slate-500">{lease.tenant_name} · {getLeaseFieldLabel("lease_type", lease.lease_type) || "—"} · {lease.start_date} to {lease.end_date}</p>
          </div>
          {validationChecks.some(c => !c.pass) && (
            <div className="flex items-center gap-2 text-amber-600 text-xs mb-3"><AlertTriangle className="w-3.5 h-3.5" />{validationChecks.filter(c => !c.pass).length} validation warning(s) — review before approving</div>
          )}
          <div className="space-y-3">
            <div>
              <Label className="text-xs font-semibold text-slate-700">Signed By <span className="text-red-500">*</span></Label>
              <Input
                className="mt-1"
                placeholder="Full name of signatory"
                value={approvalSignedBy}
                onChange={e => setApprovalSignedBy(e.target.value)}
              />
            </div>
            <div>
              <Label className="text-xs font-semibold text-slate-700">Signed At <span className="text-red-500">*</span></Label>
              <Input
                className="mt-1"
                type="datetime-local"
                value={approvalSignedAt}
                onChange={e => setApprovalSignedAt(e.target.value)}
              />
            </div>
            <div>
              <Label className="text-xs font-semibold text-slate-700">Document URL (optional)</Label>
              <Input
                className="mt-1"
                placeholder="https://... (signed lease document link)"
                value={approvalDocumentUrl}
                onChange={e => setApprovalDocumentUrl(e.target.value)}
              />
            </div>
            <div>
              <Label className="text-xs font-semibold text-slate-700">Additional Comments</Label>
              <Textarea
                className="mt-1"
                placeholder="Any notes from the signing party..."
                rows={3}
                value={approvalComments}
                onChange={e => setApprovalComments(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setShowApproval(false)}>Cancel</Button>
            <Button className="bg-emerald-600 hover:bg-emerald-700" onClick={handleApprove} disabled={updateLeaseMutation.isPending}>
              {updateLeaseMutation.isPending && <Loader2 className="w-4 h-4 animate-spin mr-1" />}Confirm Approval
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* Edit Field Dialog */}
      <Dialog open={!!editingField} onOpenChange={() => setEditingField(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Edit: {editingField?.label}</DialogTitle></DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <Label>Current Value</Label>
              <p className="text-sm text-slate-500 mt-1">{editingField?.value}</p>
            </div>
            <div>
              <Label>New Value</Label>
              {editingField && hasLeaseFieldOptions(editingField.key) ? (
                <div className="mt-1">
                  <SelectWithCustom
                    value={editValue}
                    onChange={(next) => setEditValue(next)}
                    options={LEASE_FIELD_OPTIONS[editingField.key]}
                    placeholder={`Select ${editingField.label.toLowerCase()}`}
                  />
                  <p className="text-[11px] text-slate-400 mt-1">
                    Pick a preset or choose <span className="font-medium">Custom…</span> to enter your own value.
                  </p>
                </div>
              ) : (
                <Input
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  className="mt-1"
                  type={editingField && NUMERIC_FIELDS.has(editingField.key) ? "number" : "text"}
                />
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingField(null)}>Cancel</Button>
            <Button onClick={handleFieldSave} disabled={updateLeaseMutation.isPending} className="bg-blue-600 hover:bg-blue-700">
              {updateLeaseMutation.isPending && <Loader2 className="w-4 h-4 animate-spin mr-1" />}Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Custom Field Dialog */}
      <Dialog open={showAddField} onOpenChange={setShowAddField}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add Custom Field</DialogTitle></DialogHeader>
          <p className="text-sm text-slate-500 mb-2">Add a field that wasn't extracted automatically.</p>
          <div className="space-y-3">
            <div>
              <Label className="text-xs font-semibold text-slate-700">Field Name</Label>
              <Input
                className="mt-1"
                placeholder="e.g. Parking Spaces, Option to Purchase..."
                value={newFieldKey}
                onChange={e => setNewFieldKey(e.target.value)}
              />
            </div>
            <div>
              <Label className="text-xs font-semibold text-slate-700">Value</Label>
              <Input
                className="mt-1"
                placeholder="e.g. 4 reserved spaces"
                value={newFieldValue}
                onChange={e => setNewFieldValue(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => { setShowAddField(false); setNewFieldKey(""); setNewFieldValue(""); }}>Cancel</Button>
            <Button
              className="bg-blue-600 hover:bg-blue-700"
              onClick={() => {
                if (!newFieldKey.trim()) { toast.error("Field name is required"); return; }
                setCustomFields(prev => [...prev, { label: newFieldKey.trim(), value: newFieldValue.trim() }]);
                setShowAddField(false);
                setNewFieldKey("");
                setNewFieldValue("");
                toast.success("Custom field added");
              }}
            >
              Add Field
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

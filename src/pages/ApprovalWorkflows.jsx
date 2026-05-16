/**
 * ApprovalWorkflows — Admin documentation of the approval gates wired
 * across the platform. Each stage links to the page where the approval
 * happens and shows what the gate enforces. Live counts surface how many
 * records are sitting at each stage so reviewers can see workload.
 */
import React from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  CheckCircle2,
  ClipboardCheck,
  FileText,
  Lock,
  Receipt,
  Settings,
  Workflow,
} from "lucide-react";
import PageHeader from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { createPageUrl } from "@/utils";
import { supabase } from "@/services/supabaseClient";

export default function ApprovalWorkflows() {
  const { data: counts = {} } = useQuery({
    queryKey: ["approval-workflow-counts"],
    queryFn: async () => {
      const result = { drafts: 0, pendingReview: 0, approvedAbstracts: 0, ruleSetsPending: 0, ruleSetsApproved: 0, camPending: 0, camApproved: 0 };
      const [
        leasesAbstractDrafts,
        leasesAbstractApproved,
        ruleSetsPending,
        ruleSetsApproved,
        camDraft,
        camApproved,
      ] = await Promise.all([
        supabase.from("leases").select("id", { count: "exact", head: true }).in("abstract_status", ["draft", "pending_review"]),
        supabase.from("leases").select("id", { count: "exact", head: true }).eq("abstract_status", "approved"),
        supabase.from("lease_expense_rule_sets").select("id", { count: "exact", head: true }).neq("status", "approved"),
        supabase.from("lease_expense_rule_sets").select("id", { count: "exact", head: true }).eq("status", "approved"),
        supabase.from("cam_profiles").select("id", { count: "exact", head: true }).neq("status", "approved"),
        supabase.from("cam_profiles").select("id", { count: "exact", head: true }).eq("status", "approved"),
      ]);
      result.drafts = leasesAbstractDrafts?.count ?? 0;
      result.approvedAbstracts = leasesAbstractApproved?.count ?? 0;
      result.ruleSetsPending = ruleSetsPending?.count ?? 0;
      result.ruleSetsApproved = ruleSetsApproved?.count ?? 0;
      result.camPending = camDraft?.count ?? 0;
      result.camApproved = camApproved?.count ?? 0;
      return result;
    },
  });

  const stages = [
    {
      label: "Lease Intake",
      icon: FileText,
      page: "LeaseUpload",
      description: "Document upload + automatic OCR / AI extraction. Produces an extraction draft, never final data.",
      enforces: "No business modules read from raw extraction.",
      badges: [],
    },
    {
      label: "Lease Review",
      icon: ClipboardCheck,
      page: "LeaseReview",
      description: "10-tab review of every extracted field. Per-field actions: Accept, Edit, Reject, Mark N/A, Needs Legal Review.",
      enforces: "Cannot Approve Lease Abstract until every required field is resolved (accepted, edited, marked N/A, or manual_required).",
      badges: [
        { label: `${counts.drafts ?? 0} draft / pending`, style: "bg-amber-100 text-amber-800" },
      ],
    },
    {
      label: "Approved Lease Abstract",
      icon: CheckCircle2,
      page: "Leases",
      description: "Approval freezes an immutable abstract_snapshot at the current version. Downstream modules consume only this snapshot.",
      enforces: "Snapshot is immutable per version. Edits create a new version on the next approval.",
      badges: [
        { label: `${counts.approvedAbstracts ?? 0} approved`, style: "bg-emerald-100 text-emerald-700" },
      ],
    },
    {
      label: "Lease Expense Rules",
      icon: Receipt,
      page: "LeaseExpenseRules",
      description: "Per-category responsibility / recovery / cap / admin-fee / gross-up rules extracted from the approved lease document.",
      enforces: "CAM and Recovery Budget only consume rule sets marked Approved.",
      badges: [
        { label: `${counts.ruleSetsPending ?? 0} pending`, style: "bg-amber-100 text-amber-800" },
        { label: `${counts.ruleSetsApproved ?? 0} approved`, style: "bg-emerald-100 text-emerald-700" },
      ],
    },
    {
      label: "CAM Setup",
      icon: Settings,
      page: "CAMSetup",
      description: "Per-lease CAM profile (tenant RSF, building RSF, pro-rata share, cap, admin fee, gross-up). Blocks approval when building RSF is missing.",
      enforces: "Profile in Manual Required state cannot be approved; CAM Calculation only runs against approved profiles.",
      badges: [
        { label: `${counts.camPending ?? 0} pending`, style: "bg-amber-100 text-amber-800" },
        { label: `${counts.camApproved ?? 0} approved`, style: "bg-emerald-100 text-emerald-700" },
      ],
    },
    {
      label: "Budget Approval",
      icon: ClipboardCheck,
      page: "BudgetDashboard",
      description: "Budget Studio reads only approved lease abstracts, approved expense rules, and approved CAM profiles. Budget versions move through Draft → Pending Approval → Approved → Locked.",
      enforces: "Budgets cannot be locked while inputs are unapproved.",
      badges: [],
    },
    {
      label: "Charge Schedule & Invoices",
      icon: Receipt,
      page: "Billing",
      description: "Generates tenant charges from approved abstract + approved CAM + approved recoverable expenses. Invoice Preview gates Approve / Hold / Generate.",
      enforces: "No invoices are generated from non-approved data.",
      badges: [],
    },
    {
      label: "Locked & Audit",
      icon: Lock,
      page: "AuditLog",
      description: "All approvals, edits, and rejections are recorded in audit_logs and lease_field_reviews for compliance retrieval.",
      enforces: "Audit history is read-only.",
      badges: [],
    },
  ];

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        icon={Workflow}
        title="Approval Workflows"
        subtitle="Documented gates from lease intake through billing"
        iconColor="from-purple-500 to-indigo-700"
      />

      <Card className="border-blue-200 bg-blue-50">
        <CardContent className="p-4 text-sm text-blue-800">
          <p className="font-medium">Approved-data discipline</p>
          <p className="text-xs">
            Every downstream module (Expenses, CAM, Budget, Billing, Reports) consumes only
            approved upstream records. The gates below cannot be bypassed; they are enforced in
            the UI <em>and</em> at the data layer (abstract_status / row_status / status columns).
          </p>
        </CardContent>
      </Card>

      <div className="space-y-3">
        {stages.map((stage, idx) => {
          const isLast = idx === stages.length - 1;
          return (
            <div key={stage.label} className="relative flex gap-3">
              <div className="flex flex-col items-center">
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-100 text-slate-600">
                  <stage.icon className="h-4 w-4" />
                </div>
                {!isLast && <div className="mt-1 h-full w-px flex-1 bg-slate-200" />}
              </div>
              <Card className="mb-2 flex-1">
                <CardHeader className="pb-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle className="text-base">
                      Stage {idx + 1}: {stage.label}
                    </CardTitle>
                    <div className="flex flex-wrap gap-1">
                      {stage.badges.map((b, bi) => (
                        <Badge key={bi} className={`text-[10px] ${b.style}`}>{b.label}</Badge>
                      ))}
                      <Link to={createPageUrl(stage.page)}>
                        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs">
                          Open <ArrowRight className="ml-1 h-3 w-3" />
                        </Button>
                      </Link>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-0 text-sm text-slate-600">
                  <p>{stage.description}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    <span className="font-semibold uppercase tracking-wide">Enforces:</span> {stage.enforces}
                  </p>
                </CardContent>
              </Card>
            </div>
          );
        })}
      </div>
    </div>
  );
}

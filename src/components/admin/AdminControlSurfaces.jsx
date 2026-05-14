import React, { useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  FileSearch,
  GitBranch,
  History,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { LEASE_REVIEW_FIELDS, LEASE_REVIEW_TABS } from "@/lib/leaseReviewSchema";
import { createPageUrl } from "@/utils";
import useOrgQuery from "@/hooks/useOrgQuery";
import { supabase } from "@/services/supabaseClient";

function humanize(value) {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function statusBadgeClass(status) {
  const key = String(status || "").toLowerCase();
  if (["approved", "ready", "active"].includes(key)) return "bg-emerald-100 text-emerald-700";
  if (["pending_review", "under_review", "review"].includes(key)) return "bg-amber-100 text-amber-800";
  if (["manual_required", "blocked"].includes(key)) return "bg-red-100 text-red-700";
  return "bg-slate-100 text-slate-700";
}

function formatTimestamp(value) {
  if (!value) return "-";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "-" : parsed.toLocaleString();
}

function FieldMappingRulesSurface() {
  const rows = useMemo(() => {
    return LEASE_REVIEW_FIELDS.map((field) => ({
      key: field.key,
      label: field.label,
      tab: LEASE_REVIEW_TABS.find((tab) => tab.key === field.tab)?.label || humanize(field.tab),
      type: field.type || "text",
      required: field.required ? "Required" : "Optional",
      sourcePriority:
        field.type === "date" || field.type === "currency"
          ? "Key/value table -> body clause -> title"
          : field.tab === "cam_rules" || field.tab === "expenses_recoveries"
            ? "Expense clause -> summary table -> custom field"
            : "Summary page -> body clause -> custom field",
      fallback:
        field.required
          ? "Manual required when confidence is low"
          : "Leave blank and surface in review",
    }));
  }, []);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Canonical Fields</div>
            <div className="mt-2 text-2xl font-bold text-slate-900">{rows.length}</div>
            <div className="text-xs text-slate-500">Mapped into the approved lease abstract</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Required Fields</div>
            <div className="mt-2 text-2xl font-bold text-slate-900">{rows.filter((row) => row.required === "Required").length}</div>
            <div className="text-xs text-slate-500">Block abstract approval if unresolved</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Review Tabs Covered</div>
            <div className="mt-2 text-2xl font-bold text-slate-900">{LEASE_REVIEW_TABS.length}</div>
            <div className="text-xs text-slate-500">Business review buckets for lease abstraction</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-lg">Field Mapping Rules</CardTitle>
          <p className="text-sm text-slate-500">
            Canonical field targets, source priority, and fallback behavior used by Lease Upload and Lease Review.
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-slate-50">
                <TableHead className="text-[11px] uppercase">Canonical Field</TableHead>
                <TableHead className="text-[11px] uppercase">Review Tab</TableHead>
                <TableHead className="text-[11px] uppercase">Type</TableHead>
                <TableHead className="text-[11px] uppercase">Required</TableHead>
                <TableHead className="text-[11px] uppercase">Source Priority</TableHead>
                <TableHead className="text-[11px] uppercase">Fallback Rule</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.key}>
                  <TableCell className="font-medium">{row.label}</TableCell>
                  <TableCell>{row.tab}</TableCell>
                  <TableCell>{humanize(row.type)}</TableCell>
                  <TableCell>
                    <Badge className={row.required === "Required" ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-700"}>
                      {row.required}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-slate-600">{row.sourcePriority}</TableCell>
                  <TableCell className="text-sm text-slate-600">{row.fallback}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function ApprovalWorkflowsSurface() {
  const { data: leases = [] } = useOrgQuery("Lease");
  const { data: budgets = [] } = useOrgQuery("Budget");
  const { data: recons = [] } = useOrgQuery("Reconciliation");

  const { data: camProfiles = [] } = useQuery({
    queryKey: ["admin-cam-profiles"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("cam_profiles")
        .select("id, status, lease_id");
      if (error) return [];
      return data || [];
    },
  });

  const metrics = useMemo(() => {
    const approvedAbstracts = leases.filter((lease) => String(lease.abstract_status || "").toLowerCase() === "approved").length;
    const pendingLeaseReview = leases.filter((lease) => {
      const abstract = String(lease.abstract_status || "").toLowerCase();
      const status = String(lease.status || "").toLowerCase();
      return ["draft", "pending_review", "under_review"].includes(abstract) || ["review_required", "draft"].includes(status);
    }).length;
    const camReady = camProfiles.filter((profile) => String(profile.status || "").toLowerCase() === "approved").length;
    const pendingBudgets = budgets.filter((budget) => !["approved", "locked"].includes(String(budget.status || "").toLowerCase())).length;
    const pendingRecons = recons.filter((recon) => String(recon.status || "").toLowerCase() !== "approved").length;
    return { approvedAbstracts, pendingLeaseReview, camReady, pendingBudgets, pendingRecons };
  }, [budgets, camProfiles, leases, recons]);

  const workflowRows = [
    {
      artifact: "Lease Abstract",
      stages: "Upload -> Lease Review -> Field approval -> Approved abstract",
      owner: "Lease Admin / Asset Manager",
      liveStatus: `${metrics.approvedAbstracts} approved, ${metrics.pendingLeaseReview} pending`,
      surface: "Lease Upload / Lease Review",
    },
    {
      artifact: "Lease Expense Rules",
      stages: "Extract rules -> Classify -> Approve rule set",
      owner: "Lease Admin / CAM Analyst",
      liveStatus: "Driven from approved workflow output",
      surface: "Expense Classification",
    },
    {
      artifact: "CAM Setup",
      stages: "Build CAM profile -> Validate -> Approve setup",
      owner: "CAM Analyst",
      liveStatus: `${metrics.camReady} ready`,
      surface: "CAM Setup",
    },
    {
      artifact: "Budget Draft",
      stages: "Generate -> Review -> Approve -> Lock",
      owner: "Finance / Controller",
      liveStatus: `${metrics.pendingBudgets} pending`,
      surface: "Budget Review",
    },
    {
      artifact: "Reconciliation",
      stages: "Compute -> Review -> Approve",
      owner: "CAM Analyst / Finance",
      liveStatus: `${metrics.pendingRecons} pending`,
      surface: "Reconciliation",
    },
  ];

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-4">
        {[
          { label: "Approved Abstracts", value: metrics.approvedAbstracts, tone: "bg-emerald-100 text-emerald-700" },
          { label: "Lease Reviews Pending", value: metrics.pendingLeaseReview, tone: "bg-amber-100 text-amber-800" },
          { label: "CAM Setups Ready", value: metrics.camReady, tone: "bg-blue-100 text-blue-700" },
          { label: "Budgets Pending", value: metrics.pendingBudgets, tone: "bg-violet-100 text-violet-700" },
        ].map((metric) => (
          <Card key={metric.label}>
            <CardContent className="p-4">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{metric.label}</div>
              <div className="mt-2 flex items-center gap-2">
                <span className="text-2xl font-bold text-slate-900">{metric.value}</span>
                <Badge className={metric.tone}>Live</Badge>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-lg">Approval Workflows</CardTitle>
          <p className="text-sm text-slate-500">
            Workflow stages across approved lease abstraction, CAM setup, budgets, and reconciliation.
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-slate-50">
                <TableHead className="text-[11px] uppercase">Artifact</TableHead>
                <TableHead className="text-[11px] uppercase">Stages</TableHead>
                <TableHead className="text-[11px] uppercase">Owner</TableHead>
                <TableHead className="text-[11px] uppercase">Live Status</TableHead>
                <TableHead className="text-[11px] uppercase">Surface</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {workflowRows.map((row) => (
                <TableRow key={row.artifact}>
                  <TableCell className="font-medium">{row.artifact}</TableCell>
                  <TableCell className="text-sm text-slate-600">{row.stages}</TableCell>
                  <TableCell>{row.owner}</TableCell>
                  <TableCell>{row.liveStatus}</TableCell>
                  <TableCell>{row.surface}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <Link to={createPageUrl("Workflows")}>
                Open Workflow Queue
                <ArrowRight className="ml-1 h-3.5 w-3.5" />
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to={createPageUrl("LeaseReview")}>
                Review Lease Approvals
                <ArrowRight className="ml-1 h-3.5 w-3.5" />
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function AuditLogSurface() {
  const { data: logs = [], isLoading } = useOrgQuery("AuditLog");
  const recentLogs = useMemo(() => (logs || []).slice(0, 12), [logs]);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Audit Records</div>
            <div className="mt-2 text-2xl font-bold text-slate-900">{logs.length}</div>
            <div className="text-xs text-slate-500">Org-scoped activity trail</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Approval Actions</div>
            <div className="mt-2 text-2xl font-bold text-slate-900">
              {logs.filter((log) => ["approve", "reject", "override"].includes(String(log.action || "").toLowerCase())).length}
            </div>
            <div className="text-xs text-slate-500">Recent governance-sensitive actions</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Latest Activity</div>
            <div className="mt-2 text-sm font-medium text-slate-900">{recentLogs[0]?.entity_type || "-"}</div>
            <div className="text-xs text-slate-500">{formatTimestamp(recentLogs[0]?.timestamp || recentLogs[0]?.created_date)}</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle className="text-lg">Embedded Audit Surface</CardTitle>
              <p className="text-sm text-slate-500">
                Recent audit events for approvals, uploads, edits, and workflow transitions.
              </p>
            </div>
            <Button asChild variant="outline" size="sm">
              <Link to={createPageUrl("AuditLog")}>
                Full Audit Log
                <ArrowRight className="ml-1 h-3.5 w-3.5" />
              </Link>
            </Button>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-slate-50">
                <TableHead className="text-[11px] uppercase">Timestamp</TableHead>
                <TableHead className="text-[11px] uppercase">User</TableHead>
                <TableHead className="text-[11px] uppercase">Action</TableHead>
                <TableHead className="text-[11px] uppercase">Entity</TableHead>
                <TableHead className="text-[11px] uppercase">Field</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-sm text-slate-400">Loading audit records...</TableCell>
                </TableRow>
              ) : recentLogs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-sm text-slate-400">No audit records found.</TableCell>
                </TableRow>
              ) : recentLogs.map((log) => (
                <TableRow key={log.id}>
                  <TableCell className="text-xs text-slate-500">{formatTimestamp(log.timestamp || log.created_date)}</TableCell>
                  <TableCell>{log.user_name || log.user_email || "System"}</TableCell>
                  <TableCell>
                    <Badge className={statusBadgeClass(log.action)}>{humanize(log.action)}</Badge>
                  </TableCell>
                  <TableCell>{log.entity_type || "-"}</TableCell>
                  <TableCell className="text-sm text-slate-600">{log.field_changed || "-"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

export default function AdminControlSurfaces({ tab }) {
  if (tab === "mapping_rules") {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <FileSearch className="h-4 w-4" />
          Lease field mapping and fallback behavior
        </div>
        <FieldMappingRulesSurface />
      </div>
    );
  }

  if (tab === "approval_workflows") {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <GitBranch className="h-4 w-4" />
          Cross-module approval queues and workflow ownership
        </div>
        <ApprovalWorkflowsSurface />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <History className="h-4 w-4" />
        Embedded audit visibility for admin reviewers
      </div>
      <AuditLogSurface />
    </div>
  );
}

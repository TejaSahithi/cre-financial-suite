import React, { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  CornerDownLeft,
  FileText,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { canApprove } from "@/lib/authorizationEngine";
import { useAuth } from "@/lib/AuthContext";
import useOrgId from "@/hooks/useOrgId";
import { recordWorkflowAction, WORKFLOW_STATUSES } from "@/services/approvalWorkflowEngine";
import { supabase } from "@/services/supabaseClient";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

const PENDING_STATUSES = new Set([
  WORKFLOW_STATUSES.SUBMITTED,
  WORKFLOW_STATUSES.UNDER_REVIEW,
  WORKFLOW_STATUSES.FINANCE_REVIEW,
  WORKFLOW_STATUSES.PENDING_APPROVAL,
  WORKFLOW_STATUSES.PARTIALLY_APPROVED,
  WORKFLOW_STATUSES.RESUBMITTED,
]);

const STATUS_STYLES = {
  SUBMITTED: "bg-blue-100 text-blue-700",
  UNDER_REVIEW: "bg-amber-100 text-amber-800",
  FINANCE_REVIEW: "bg-cyan-100 text-cyan-700",
  PENDING_APPROVAL: "bg-amber-100 text-amber-800",
  PARTIALLY_APPROVED: "bg-indigo-100 text-indigo-700",
  APPROVED: "bg-emerald-100 text-emerald-700",
  REJECTED: "bg-red-100 text-red-700",
  RETURNED_FOR_CHANGES: "bg-orange-100 text-orange-700",
  COMPLETED: "bg-emerald-100 text-emerald-700",
  CANCELLED: "bg-slate-100 text-slate-700",
};

function groupBy(items, key) {
  return items.reduce((acc, item) => {
    const value = item[key];
    if (!acc[value]) acc[value] = [];
    acc[value].push(item);
    return acc;
  }, {});
}

function formatCurrency(value) {
  const amount = Number(value || 0);
  return amount.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function formatDate(value) {
  if (!value) return "Not set";
  return new Date(value).toLocaleString();
}

function labelize(value) {
  return String(value || "unknown").replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
}

function schemaIsMissing(error) {
  const message = String(error?.message || "");
  return error?.code === "42P01" || error?.code === "PGRST116" || message.includes("does not exist") || message.includes("schema cache");
}

async function fetchApprovalInbox({ orgId, userId }) {
  if (!supabase || !orgId || orgId === "__none__") {
    return { workflows: [], stepsByWorkflow: {}, actionsByWorkflow: {}, delegations: [], schemaReady: Boolean(supabase) };
  }

  const { data: workflows, error } = await supabase
    .from("approval_workflow_instances")
    .select("*")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    if (schemaIsMissing(error)) {
      return { workflows: [], stepsByWorkflow: {}, actionsByWorkflow: {}, delegations: [], schemaReady: false, schemaError: error.message };
    }
    throw error;
  }

  const workflowIds = (workflows || []).map((workflow) => workflow.id);
  if (workflowIds.length === 0) {
    return { workflows: [], stepsByWorkflow: {}, actionsByWorkflow: {}, delegations: [], schemaReady: true };
  }

  const [stepsResult, actionsResult, delegationsResult] = await Promise.all([
    supabase
      .from("approval_workflow_steps")
      .select("*")
      .in("workflow_instance_id", workflowIds)
      .order("sequence_number", { ascending: true }),
    supabase
      .from("approval_actions")
      .select("*")
      .in("workflow_instance_id", workflowIds)
      .order("created_at", { ascending: true }),
    userId
      ? supabase
          .from("approval_delegations")
          .select("*")
          .eq("delegate_user_id", userId)
          .eq("org_id", orgId)
      : Promise.resolve({ data: [], error: null }),
  ]);

  const toleratedErrors = [stepsResult.error, actionsResult.error, delegationsResult.error].filter(Boolean);
  const missingSchemaError = toleratedErrors.find(schemaIsMissing);
  if (missingSchemaError) {
    return { workflows: [], stepsByWorkflow: {}, actionsByWorkflow: {}, delegations: [], schemaReady: false, schemaError: missingSchemaError.message };
  }
  if (toleratedErrors.length > 0) throw toleratedErrors[0];

  return {
    workflows: workflows || [],
    stepsByWorkflow: groupBy(stepsResult.data || [], "workflow_instance_id"),
    actionsByWorkflow: groupBy(actionsResult.data || [], "workflow_instance_id"),
    delegations: delegationsResult.data || [],
    schemaReady: true,
  };
}

function activeStepFor(workflow, steps = []) {
  return steps.find((step) => step.status === "ACTIVE") || steps.find((step) => step.stage_key === workflow.current_stage) || steps[0] || null;
}

function workflowForAuthorization(workflow, activeStep) {
  return {
    ...workflow,
    approval_type: workflow.workflow_type,
    requested_by: workflow.submitted_by,
    current_step: activeStep
      ? {
          ...activeStep,
          required_role: activeStep.approver_role,
          approver_user_id: activeStep.approver_user_id,
        }
      : null,
  };
}

function isActionableByUser({ workflow, activeStep, user, delegations }) {
  if (!PENDING_STATUSES.has(workflow.status)) return false;
  if (activeStep?.approver_user_id && activeStep.approver_user_id !== user?.id) return false;
  return canApprove(user, workflowForAuthorization(workflow, activeStep), { delegations });
}

function StatusBadge({ status }) {
  return (
    <Badge className={`${STATUS_STYLES[status] || "bg-slate-100 text-slate-700"} text-[10px]`}>
      {labelize(status)}
    </Badge>
  );
}

export default function Approvals() {
  const { user } = useAuth();
  const { orgId, loading } = useOrgId();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState("my");
  const [selectedWorkflow, setSelectedWorkflow] = useState(null);
  const [selectedAction, setSelectedAction] = useState(null);
  const [comments, setComments] = useState("");
  const [rejectionReason, setRejectionReason] = useState("");

  const inboxQuery = useQuery({
    queryKey: ["approval-inbox", orgId, user?.id],
    enabled: !loading && !!orgId && orgId !== "__none__",
    queryFn: () => fetchApprovalInbox({ orgId, userId: user?.id }),
  });

  const data = inboxQuery.data || { workflows: [], stepsByWorkflow: {}, actionsByWorkflow: {}, delegations: [], schemaReady: true };

  const enrichedWorkflows = useMemo(() => {
    return data.workflows.map((workflow) => {
      const steps = data.stepsByWorkflow[workflow.id] || [];
      const actions = data.actionsByWorkflow[workflow.id] || [];
      const activeStep = activeStepFor(workflow, steps);
      const actionable = isActionableByUser({ workflow, activeStep, user, delegations: data.delegations });
      return { ...workflow, steps, actions, activeStep, actionable };
    });
  }, [data.actionsByWorkflow, data.delegations, data.stepsByWorkflow, data.workflows, user]);

  const stats = useMemo(() => {
    const pending = enrichedWorkflows.filter((workflow) => PENDING_STATUSES.has(workflow.status));
    return {
      my: pending.filter((workflow) => workflow.actionable).length,
      pending: pending.length,
      approved: enrichedWorkflows.filter((workflow) => workflow.status === WORKFLOW_STATUSES.APPROVED || workflow.status === WORKFLOW_STATUSES.COMPLETED).length,
      rejected: enrichedWorkflows.filter((workflow) => workflow.status === WORKFLOW_STATUSES.REJECTED || workflow.status === WORKFLOW_STATUSES.RETURNED_FOR_CHANGES).length,
    };
  }, [enrichedWorkflows]);

  const rowsByTab = {
    my: enrichedWorkflows.filter((workflow) => workflow.actionable),
    submitted: enrichedWorkflows.filter((workflow) => workflow.submitted_by === user?.id),
    pending: enrichedWorkflows.filter((workflow) => PENDING_STATUSES.has(workflow.status)),
    closed: enrichedWorkflows.filter((workflow) => !PENDING_STATUSES.has(workflow.status)),
    all: enrichedWorkflows,
  };

  const actionMutation = useMutation({
    mutationFn: async () => {
      const workflow = selectedWorkflow;
      const activeStep = workflow?.activeStep;
      return recordWorkflowAction({
        workflow: workflowForAuthorization(workflow, activeStep),
        user,
        action: selectedAction,
        comments,
        rejectionReason,
        options: {
          delegations: data.delegations,
          metadata: {
            source: "approval_inbox",
            stage_key: activeStep?.stage_key || workflow?.current_stage || null,
          },
        },
      });
    },
    onSuccess: () => {
      toast.success(`Workflow ${labelize(selectedAction)} recorded.`);
      setSelectedWorkflow(null);
      setSelectedAction(null);
      setComments("");
      setRejectionReason("");
      queryClient.invalidateQueries({ queryKey: ["approval-inbox", orgId, user?.id] });
    },
    onError: (error) => toast.error(error?.message || "Could not record workflow action."),
  });

  const openActionDialog = (workflow, action) => {
    setSelectedWorkflow(workflow);
    setSelectedAction(action);
    setComments("");
    setRejectionReason("");
  };

  const currentRows = rowsByTab[activeTab] || [];
  const requiresReason = selectedAction === "reject" || selectedAction === "return_for_changes";
  const canSubmitAction = selectedAction === "approve" || (comments.trim().length > 0 && rejectionReason.trim().length > 0);

  return (
    <div className="min-h-screen bg-[var(--bg)] p-6">
      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-[28px] font-bold text-[var(--ink)]">Approval Inbox</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">Generic approval queue across expenses, budgets, leases, and CAM workflows.</p>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Card className="border-[var(--border-cre)] bg-[var(--surface)]">
            <CardContent className="p-3">
              <p className="text-[10px] font-bold uppercase text-[var(--muted)]">My Queue</p>
              <p className="text-xl font-bold tabular-nums">{stats.my}</p>
            </CardContent>
          </Card>
          <Card className="border-[var(--border-cre)] bg-[var(--surface)]">
            <CardContent className="p-3">
              <p className="text-[10px] font-bold uppercase text-[var(--muted)]">Pending</p>
              <p className="text-xl font-bold tabular-nums">{stats.pending}</p>
            </CardContent>
          </Card>
          <Card className="border-[var(--border-cre)] bg-[var(--surface)]">
            <CardContent className="p-3">
              <p className="text-[10px] font-bold uppercase text-[var(--muted)]">Approved</p>
              <p className="text-xl font-bold tabular-nums">{stats.approved}</p>
            </CardContent>
          </Card>
          <Card className="border-[var(--border-cre)] bg-[var(--surface)]">
            <CardContent className="p-3">
              <p className="text-[10px] font-bold uppercase text-[var(--muted)]">Returned</p>
              <p className="text-xl font-bold tabular-nums">{stats.rejected}</p>
            </CardContent>
          </Card>
        </div>
      </div>

      {!data.schemaReady && (
        <Card className="mb-4 border-amber-200 bg-amber-50">
          <CardContent className="flex items-start gap-3 p-4 text-sm text-amber-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <div>
              <p className="font-semibold">Approval workflow schema is not available in this environment.</p>
              <p className="text-xs">Apply the enterprise RBAC and approvals migration, then refresh this page.</p>
            </div>
          </CardContent>
        </Card>
      )}

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="my">My Approvals</TabsTrigger>
          <TabsTrigger value="submitted">Submitted by Me</TabsTrigger>
          <TabsTrigger value="pending">Pending</TabsTrigger>
          <TabsTrigger value="closed">Closed</TabsTrigger>
          <TabsTrigger value="all">All</TabsTrigger>
        </TabsList>

        <TabsContent value={activeTab} className="mt-4">
          <Card className="border-[var(--border-cre)] bg-[var(--surface)]">
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Workflow</TableHead>
                    <TableHead>Entity</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Stage</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Submitted</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {inboxQuery.isLoading ? (
                    <TableRow>
                      <TableCell colSpan={7} className="py-12 text-center text-[var(--muted)]">Loading approvals...</TableCell>
                    </TableRow>
                  ) : currentRows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="py-12 text-center text-[var(--muted)]">No approval workflows match this view.</TableCell>
                    </TableRow>
                  ) : (
                    currentRows.map((workflow) => (
                      <TableRow key={workflow.id}>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <FileText className="h-4 w-4 text-[var(--muted)]" />
                            <div>
                              <p className="font-semibold">{labelize(workflow.workflow_type)}</p>
                              <p className="text-[11px] text-[var(--muted)]">{workflow.id}</p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <p className="font-medium">{labelize(workflow.entity_type)}</p>
                          <p className="text-[11px] text-[var(--muted)]">{workflow.entity_id}</p>
                        </TableCell>
                        <TableCell className="font-mono">{formatCurrency(workflow.amount)}</TableCell>
                        <TableCell>
                          <p className="font-medium">{labelize(workflow.activeStep?.stage_key || workflow.current_stage)}</p>
                          <p className="text-[11px] text-[var(--muted)]">{workflow.activeStep?.approver_role ? labelize(workflow.activeStep.approver_role) : "Policy route"}</p>
                        </TableCell>
                        <TableCell><StatusBadge status={workflow.status} /></TableCell>
                        <TableCell>{formatDate(workflow.submitted_at || workflow.created_at)}</TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-2">
                            {workflow.actionable && (
                              <>
                                <Button size="sm" className="h-8 text-xs" onClick={() => openActionDialog(workflow, "approve")}>
                                  <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> Approve
                                </Button>
                                <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => openActionDialog(workflow, "return_for_changes")}>
                                  <CornerDownLeft className="mr-1 h-3.5 w-3.5" /> Return
                                </Button>
                                <Button size="sm" variant="outline" className="h-8 border-red-200 text-xs text-red-700 hover:bg-red-50" onClick={() => openActionDialog(workflow, "reject")}>
                                  <XCircle className="mr-1 h-3.5 w-3.5" /> Reject
                                </Button>
                              </>
                            )}
                            {!workflow.actionable && PENDING_STATUSES.has(workflow.status) && (
                              <Badge variant="outline" className="text-[10px] text-[var(--muted)]">
                                <ShieldCheck className="mr-1 h-3 w-3" /> Routed
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog open={Boolean(selectedWorkflow && selectedAction)} onOpenChange={(open) => !open && setSelectedWorkflow(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{labelize(selectedAction)} Workflow</DialogTitle>
            <DialogDescription>
              {selectedWorkflow ? `${labelize(selectedWorkflow.workflow_type)} ${selectedWorkflow.entity_id}` : ""}
            </DialogDescription>
          </DialogHeader>

          {selectedWorkflow && (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-md border border-[var(--border-cre)] p-3">
                  <p className="text-[10px] font-bold uppercase text-[var(--muted)]">Amount</p>
                  <p className="font-mono font-semibold">{formatCurrency(selectedWorkflow.amount)}</p>
                </div>
                <div className="rounded-md border border-[var(--border-cre)] p-3">
                  <p className="text-[10px] font-bold uppercase text-[var(--muted)]">Current Stage</p>
                  <p className="font-semibold">{labelize(selectedWorkflow.activeStep?.stage_key || selectedWorkflow.current_stage)}</p>
                </div>
                <div className="rounded-md border border-[var(--border-cre)] p-3">
                  <p className="text-[10px] font-bold uppercase text-[var(--muted)]">Status</p>
                  <StatusBadge status={selectedWorkflow.status} />
                </div>
              </div>

              {selectedWorkflow.steps.length > 0 && (
                <div>
                  <p className="mb-2 text-xs font-bold uppercase text-[var(--muted)]">Approval Chain</p>
                  <div className="space-y-2">
                    {selectedWorkflow.steps.map((step) => (
                      <div key={step.id || `${step.sequence_number}-${step.stage_key}`} className="flex items-center justify-between rounded-md border border-[var(--border-cre)] px-3 py-2 text-sm">
                        <div className="flex items-center gap-2">
                          <Clock className="h-4 w-4 text-[var(--muted)]" />
                          <span className="font-medium">{step.sequence_number}. {labelize(step.stage_key)}</span>
                        </div>
                        <Badge variant="outline" className="text-[10px]">{labelize(step.status)}</Badge>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {requiresReason && (
                <div>
                  <label className="text-xs font-bold uppercase text-[var(--muted)]" htmlFor="approval-reason">
                    Reason
                  </label>
                  <Textarea
                    id="approval-reason"
                    className="mt-1"
                    value={rejectionReason}
                    onChange={(event) => setRejectionReason(event.target.value)}
                    placeholder="Policy, data, or documentation reason"
                  />
                </div>
              )}
              <div>
                <label className="text-xs font-bold uppercase text-[var(--muted)]" htmlFor="approval-comments">
                  Comments{selectedAction === "approve" ? " Optional" : ""}
                </label>
                <Textarea
                  id="approval-comments"
                  className="mt-1"
                  value={comments}
                  onChange={(event) => setComments(event.target.value)}
                  placeholder="Reviewer comments"
                />
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setSelectedWorkflow(null)}>Cancel</Button>
            <Button onClick={() => actionMutation.mutate()} disabled={!canSubmitAction || actionMutation.isPending}>
              <ArrowRight className="mr-1 h-4 w-4" />
              Record Action
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

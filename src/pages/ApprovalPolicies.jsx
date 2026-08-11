import React, { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, ClipboardCheck, Plus, SlidersHorizontal, Trash2 } from "lucide-react";
import { DEFAULT_APPROVAL_THRESHOLDS } from "@/lib/authorizationEngine";
import useOrgId from "@/hooks/useOrgId";
import useOrgQuery from "@/hooks/useOrgQuery";
import {
  disableApprovalPolicy,
  listApprovalPolicies,
  upsertApprovalPolicy,
} from "@/services/approvalPolicyService";
import { isApprovalSchemaMissing } from "@/services/moduleApprovalWorkflowBridge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

const WORKFLOW_TYPES = ["expense", "budget", "lease", "cam"];
const SCOPE_TYPES = ["organization", "portfolio", "property"];

function defaultThresholdText(workflowType) {
  return JSON.stringify(DEFAULT_APPROVAL_THRESHOLDS[workflowType] || [], null, 2);
}

function labelize(value) {
  return String(value || "").replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatScope(policy, portfolios, properties) {
  if (policy.scope_type === "organization") return "Organization";
  if (policy.scope_type === "portfolio") {
    return portfolios.find((portfolio) => portfolio.id === policy.scope_id)?.name || policy.scope_id || "Portfolio";
  }
  if (policy.scope_type === "property") {
    return properties.find((property) => property.id === policy.scope_id)?.name || policy.scope_id || "Property";
  }
  return labelize(policy.scope_type);
}

function summarizeThresholds(thresholds = []) {
  if (!Array.isArray(thresholds) || thresholds.length === 0) return "No thresholds";
  return thresholds
    .map((threshold) => {
      const max = threshold.max_amount == null ? "unlimited" : `$${Number(threshold.max_amount).toLocaleString()}`;
      const min = `$${Number(threshold.min_amount || 0).toLocaleString()}`;
      const steps = (threshold.steps || []).map((step) => labelize(step.role || step.approver_role || step.action)).join(" -> ");
      return `${min} to ${max}: ${steps || "approval chain"}`;
    })
    .join("; ");
}

function initialForm() {
  return {
    workflowType: "expense",
    scopeType: "organization",
    scopeId: "",
    name: "",
    description: "",
    thresholdsText: defaultThresholdText("expense"),
    allowSelfApproval: false,
    requirePropertyOwnerApproval: false,
  };
}

export default function ApprovalPolicies() {
  const queryClient = useQueryClient();
  const { orgId, loading } = useOrgId();
  const { data: portfolios = [] } = useOrgQuery("Portfolio");
  const { data: properties = [] } = useOrgQuery("Property");
  const [form, setForm] = useState(initialForm);

  const policiesQuery = useQuery({
    queryKey: ["approval-policies", orgId],
    enabled: !loading && !!orgId && orgId !== "__none__",
    queryFn: async () => {
      try {
        return { policies: await listApprovalPolicies(orgId), schemaReady: true };
      } catch (error) {
        if (isApprovalSchemaMissing(error)) return { policies: [], schemaReady: false, schemaError: error.message };
        throw error;
      }
    },
  });

  const policies = policiesQuery.data?.policies || [];
  const schemaReady = policiesQuery.data?.schemaReady !== false;

  const scopeOptions = useMemo(() => {
    if (form.scopeType === "portfolio") return portfolios.map((item) => ({ value: item.id, label: item.name || item.id }));
    if (form.scopeType === "property") return properties.map((item) => ({ value: item.id, label: item.name || item.id }));
    return [];
  }, [form.scopeType, portfolios, properties]);

  const savePolicy = useMutation({
    mutationFn: async () => {
      const thresholds = JSON.parse(form.thresholdsText);
      return upsertApprovalPolicy({
        orgId,
        workflowType: form.workflowType,
        scopeType: form.scopeType,
        scopeId: form.scopeType === "organization" ? null : form.scopeId,
        name: form.name || `${labelize(form.scopeType)} ${labelize(form.workflowType)} Policy`,
        description: form.description,
        thresholds,
        allowSelfApproval: form.allowSelfApproval,
        requirePropertyOwnerApproval: form.requirePropertyOwnerApproval,
      });
    },
    onSuccess: () => {
      toast.success("Approval policy saved.");
      queryClient.invalidateQueries({ queryKey: ["approval-policies", orgId] });
    },
    onError: (error) => toast.error(error?.message || "Could not save approval policy."),
  });

  const disablePolicy = useMutation({
    mutationFn: (policyId) => disableApprovalPolicy({ orgId, policyId }),
    onSuccess: () => {
      toast.success("Approval policy disabled.");
      queryClient.invalidateQueries({ queryKey: ["approval-policies", orgId] });
    },
    onError: (error) => toast.error(error?.message || "Could not disable approval policy."),
  });

  const updateWorkflowType = (workflowType) => {
    setForm((current) => ({
      ...current,
      workflowType,
      thresholdsText: defaultThresholdText(workflowType),
    }));
  };

  const updateScopeType = (scopeType) => {
    setForm((current) => ({ ...current, scopeType, scopeId: "" }));
  };

  return (
    <div className="min-h-screen space-y-6 bg-[var(--bg)] p-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-[28px] font-bold text-[var(--ink)]">Approval Policies</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">Thresholds and precedence for generic approval workflows.</p>
        </div>
        <Badge className="w-fit bg-[var(--accent-soft)] text-[var(--accent)]">
          <SlidersHorizontal className="mr-1 h-3.5 w-3.5" /> Property overrides portfolio, portfolio overrides organization
        </Badge>
      </div>

      {!schemaReady && (
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="flex items-start gap-3 p-4 text-sm text-amber-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <div>
              <p className="font-semibold">Approval policy schema is not available in this environment.</p>
              <p className="text-xs">Apply the enterprise RBAC and approvals migration before saving policies.</p>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 xl:grid-cols-[420px_1fr]">
        <Card className="border-[var(--border-cre)] bg-[var(--surface)]">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Plus className="h-4 w-4" /> Policy Editor
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>Workflow</Label>
                <Select value={form.workflowType} onValueChange={updateWorkflowType}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {WORKFLOW_TYPES.map((type) => <SelectItem key={type} value={type}>{labelize(type)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Scope</Label>
                <Select value={form.scopeType} onValueChange={updateScopeType}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {SCOPE_TYPES.map((type) => <SelectItem key={type} value={type}>{labelize(type)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {form.scopeType !== "organization" && (
              <div>
                <Label>{labelize(form.scopeType)}</Label>
                <Select value={form.scopeId} onValueChange={(scopeId) => setForm((current) => ({ ...current, scopeId }))}>
                  <SelectTrigger><SelectValue placeholder={`Select ${form.scopeType}`} /></SelectTrigger>
                  <SelectContent>
                    {scopeOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div>
              <Label>Name</Label>
              <Input value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} placeholder="Regional expense policy" />
            </div>

            <div>
              <Label>Description</Label>
              <Input value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} placeholder="Optional" />
            </div>

            <div>
              <Label>Thresholds</Label>
              <Textarea
                className="min-h-[220px] font-mono text-xs"
                value={form.thresholdsText}
                onChange={(event) => setForm((current) => ({ ...current, thresholdsText: event.target.value }))}
              />
            </div>

            <Button
              className="w-full"
              disabled={!schemaReady || savePolicy.isPending || (form.scopeType !== "organization" && !form.scopeId)}
              onClick={() => savePolicy.mutate()}
            >
              <CheckCircle2 className="mr-2 h-4 w-4" /> Save Policy
            </Button>
          </CardContent>
        </Card>

        <Card className="border-[var(--border-cre)] bg-[var(--surface)]">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ClipboardCheck className="h-4 w-4" /> Active Policies
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Workflow</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Thresholds</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {policiesQuery.isLoading ? (
                  <TableRow><TableCell colSpan={5} className="py-12 text-center text-[var(--muted)]">Loading policies...</TableCell></TableRow>
                ) : policies.length === 0 ? (
                  <TableRow><TableCell colSpan={5} className="py-12 text-center text-[var(--muted)]">No active custom policies.</TableCell></TableRow>
                ) : (
                  policies.map((policy) => (
                    <TableRow key={policy.id || `${policy.workflow_type}-${policy.scope_type}-${policy.scope_id}`}>
                      <TableCell>
                        <p className="font-semibold">{policy.name}</p>
                        <p className="text-[11px] text-[var(--muted)]">{policy.description}</p>
                      </TableCell>
                      <TableCell><Badge variant="outline" className="text-[10px]">{labelize(policy.workflow_type)}</Badge></TableCell>
                      <TableCell>{formatScope(policy, portfolios, properties)}</TableCell>
                      <TableCell className="max-w-[420px] text-xs text-[var(--muted)]">{summarizeThresholds(policy.thresholds)}</TableCell>
                      <TableCell>
                        {policy.scope_type !== "system" && (
                          <Button variant="ghost" size="sm" className="text-red-700" onClick={() => disablePolicy.mutate(policy.id)}>
                            <Trash2 className="mr-1 h-3.5 w-3.5" /> Disable
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

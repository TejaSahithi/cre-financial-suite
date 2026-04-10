import React, { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Plus, Download, Mail, Loader2, CheckCircle2, X, Info } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
  Legend,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";

import { BudgetService } from "@/services/api";
import { invokeEdgeFunction } from "@/services/edgeFunctions";

import useOrgQuery from "@/hooks/useOrgQuery";
import { buildHierarchyScope, getScopeSubtitle, matchesHierarchyScope } from "@/lib/hierarchyScope";
import ScopeSelector from "@/components/ScopeSelector";
import PageHeader from "@/components/PageHeader";
import PipelineActions, { BUDGET_ACTIONS } from "@/components/PipelineActions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { createPageUrl } from "@/utils";

const CURRENCY_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const COMPACT_CURRENCY_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});

const PERCENT_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "percent",
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
});

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

function toNumber(value) {
  return Number(value) || 0;
}

function formatCurrency(value) {
  return CURRENCY_FORMATTER.format(toNumber(value));
}

function formatCompactCurrency(value) {
  return COMPACT_CURRENCY_FORMATTER.format(toNumber(value));
}

function formatPercent(value) {
  return PERCENT_FORMATTER.format(Number.isFinite(value) ? value : 0);
}

function getBudgetYear(budget) {
  return budget?.budget_year || budget?.fiscal_year || new Date().getFullYear();
}

function parseRecipientEmails(value) {
  return [...new Set(
    value
      .split(",")
      .map((email) => email.trim())
      .filter(Boolean)
  )];
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function invokeFunctionWithFreshSession(fnName, body) {
  return invokeEdgeFunction(fnName, body);
}

function buildBudgetEmailHtml({ budget, scopeLabel, customMessage, downloadUrl }) {
  const revenue = toNumber(budget?.total_revenue);
  const expenses = toNumber(budget?.total_expenses);
  const cam = toNumber(budget?.cam_total);
  const noi = toNumber(budget?.noi);
  const expenseRatio = revenue > 0 ? expenses / revenue : 0;
  const camShare = revenue > 0 ? cam / revenue : 0;

  return `
    <h1 style="margin-bottom: 8px;">${escapeHtml(budget?.name || "Budget Review")}</h1>
    <p style="margin: 0 0 20px; color: #64748b;">
      ${escapeHtml(scopeLabel)} budget update for FY ${escapeHtml(getBudgetYear(budget))}.
    </p>
    ${
      customMessage
        ? `<div style="margin-bottom: 20px; padding: 16px; border-radius: 12px; background: #eff6ff; color: #1e3a8a;"><strong>Message</strong><br/>${escapeHtml(customMessage).replace(/\n/g, "<br/>")}</div>`
        : ""
    }
    <table style="width: 100%; border-collapse: collapse; margin: 0 0 24px;">
      <tr>
        <td style="padding: 12px 0; border-bottom: 1px solid #e2e8f0; color: #64748b;">Total Revenue</td>
        <td style="padding: 12px 0; border-bottom: 1px solid #e2e8f0; text-align: right; font-weight: 700;">${formatCurrency(revenue)}</td>
      </tr>
      <tr>
        <td style="padding: 12px 0; border-bottom: 1px solid #e2e8f0; color: #64748b;">Total Expenses</td>
        <td style="padding: 12px 0; border-bottom: 1px solid #e2e8f0; text-align: right; font-weight: 700; color: #dc2626;">${formatCurrency(expenses)}</td>
      </tr>
      <tr>
        <td style="padding: 12px 0; border-bottom: 1px solid #e2e8f0; color: #64748b;">CAM</td>
        <td style="padding: 12px 0; border-bottom: 1px solid #e2e8f0; text-align: right; font-weight: 700; color: #2563eb;">${formatCurrency(cam)}</td>
      </tr>
      <tr>
        <td style="padding: 12px 0; border-bottom: 1px solid #e2e8f0; color: #64748b;">NOI</td>
        <td style="padding: 12px 0; border-bottom: 1px solid #e2e8f0; text-align: right; font-weight: 700; color: #059669;">${formatCurrency(noi)}</td>
      </tr>
      <tr>
        <td style="padding: 12px 0; color: #64748b;">Expense Ratio / CAM Share</td>
        <td style="padding: 12px 0; text-align: right; font-weight: 600;">${formatPercent(expenseRatio)} / ${formatPercent(camShare)}</td>
      </tr>
    </table>
    ${
      downloadUrl
        ? `<p style="margin: 0 0 8px;">A detailed export with budget summary, expense detail, revenue detail, lease schedules, and CAM support is ready for download.</p>
           <p style="margin: 0 0 24px;"><a href="${escapeHtml(downloadUrl)}" style="display: inline-block; padding: 12px 18px; border-radius: 10px; background: #1d4ed8; color: #ffffff; text-decoration: none; font-weight: 600;">Open Detailed Export</a></p>`
        : ""
    }
    ${
      budget?.ai_insights
        ? `<div style="padding: 16px; border-radius: 12px; background: #f8fafc; border: 1px solid #e2e8f0;"><strong>AI Insight</strong><br/>${escapeHtml(budget.ai_insights)}</div>`
        : ""
    }
  `;
}

function getBudgetScopeLabel(budget, scope) {
  const property = budget?.property_id ? scope.propertyById.get(budget.property_id) ?? null : null;
  const building = budget?.building_id ? scope.buildingById.get(budget.building_id) ?? null : null;
  const unit = budget?.unit_id ? scope.unitById.get(budget.unit_id) ?? null : null;
  return unit?.unit_number || unit?.unit_id_code || building?.name || property?.name || "Selected scope";
}

async function invalidateBudgetCaches(queryClient) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["Budget"] }),
    queryClient.invalidateQueries({ queryKey: ["budgets"] }),
    queryClient.invalidateQueries({ queryKey: ["Notification"] }),
  ]);
}

function EmailStakeholderDialog({ budget, trigger, scopeLabel, onSend }) {
  const [emails, setEmails] = useState("");
  const [message, setMessage] = useState("");
  const [open, setOpen] = useState(false);
  const [isSending, setIsSending] = useState(false);

  const handleSend = async () => {
    const recipients = parseRecipientEmails(emails);
    if (recipients.length === 0) {
      toast.error("Enter at least one stakeholder email address");
      return;
    }

    const invalidRecipients = recipients.filter((email) => !EMAIL_PATTERN.test(email));
    if (invalidRecipients.length > 0) {
      toast.error(`Invalid email address: ${invalidRecipients[0]}`);
      return;
    }

    setIsSending(true);
    try {
      await onSend({
        budget,
        recipients,
        message: message.trim(),
      });
      setEmails("");
      setMessage("");
      setOpen(false);
    } finally {
      setIsSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Email Budget to Stakeholders</DialogTitle>
          <DialogDescription>
            Send the current budget review for {scopeLabel} with a secure export link and your own notes.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="budget-email-recipients">Recipient Emails</Label>
            <Input
              id="budget-email-recipients"
              placeholder="asset.manager@example.com, investor@example.com"
              value={emails}
              onChange={(event) => setEmails(event.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="budget-email-message">Message</Label>
            <Textarea
              id="budget-email-message"
              placeholder="Please review the updated budget package before Friday's budget committee meeting."
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              rows={6}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={isSending}>
            Cancel
          </Button>
          <Button onClick={handleSend} className="bg-blue-600 hover:bg-blue-700" disabled={isSending}>
            {isSending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Mail className="mr-2 h-4 w-4" />}
            Send Budget Review
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BudgetInsights({ budget }) {
  const revenue = toNumber(budget?.total_revenue);
  const expenses = toNumber(budget?.total_expenses);
  const cam = toNumber(budget?.cam_total);
  const noi = toNumber(budget?.noi);
  const expenseRatio = revenue > 0 ? expenses / revenue : 0;
  const camShare = revenue > 0 ? cam / revenue : 0;

  const compositionData = [
    { name: "Revenue", value: revenue, color: "#0f766e" },
    { name: "Expenses", value: expenses, color: "#dc2626" },
    { name: "CAM", value: cam, color: "#2563eb" },
  ].filter((item) => item.value > 0);

  const comparisonData = [
    { name: "Revenue", value: revenue, fill: "#0f766e" },
    { name: "Expenses", value: expenses, fill: "#dc2626" },
    { name: "CAM", value: cam, fill: "#2563eb" },
    { name: "NOI", value: noi, fill: "#059669" },
  ];

  const metricCards = [
    {
      label: "Revenue Mix",
      value: formatPercent(revenue > 0 ? 1 : 0),
      subtext: `${formatCompactCurrency(revenue)} total`,
      tone: "text-teal-700",
      bg: "bg-teal-50",
    },
    {
      label: "Expense Ratio",
      value: formatPercent(expenseRatio),
      subtext: `${formatCompactCurrency(expenses)} of revenue`,
      tone: "text-rose-700",
      bg: "bg-rose-50",
    },
    {
      label: "CAM Share",
      value: formatPercent(camShare),
      subtext: `${formatCompactCurrency(cam)} recoverable`,
      tone: "text-blue-700",
      bg: "bg-blue-50",
    },
  ];

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-3">
        {metricCards.map((metric) => (
          <div key={metric.label} className={`rounded-2xl border border-slate-200 p-4 ${metric.bg}`}>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">{metric.label}</p>
            <p className={`mt-2 text-2xl font-bold ${metric.tone}`}>{metric.value}</p>
            <p className="mt-1 text-xs text-slate-600">{metric.subtext}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Financial Allocation</p>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={compositionData}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={64}
                  outerRadius={98}
                  paddingAngle={4}
                >
                  {compositionData.map((entry) => (
                    <Cell key={entry.name} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip formatter={(value) => formatCurrency(value)} />
                <Legend verticalAlign="bottom" height={32} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Budget Review Breakdown</p>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={comparisonData} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                <XAxis dataKey="name" tick={{ fontSize: 12, fill: "#64748b" }} axisLine={false} tickLine={false} />
                <YAxis
                  tick={{ fontSize: 11, fill: "#64748b" }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(value) => formatCompactCurrency(value)}
                />
                <Tooltip formatter={(value) => formatCurrency(value)} />
                <Bar dataKey="value" radius={[10, 10, 0, 0]}>
                  {comparisonData.map((entry) => (
                    <Cell key={entry.name} fill={entry.fill} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {budget?.ai_insights && (
        <div className="flex gap-3 rounded-2xl border border-blue-100 bg-blue-50/70 p-4">
          <div className="mt-0.5 rounded-full bg-blue-100 p-1.5">
            <Info className="h-4 w-4 text-blue-600" />
          </div>
          <div>
            <p className="mb-1 text-xs font-bold uppercase tracking-[0.14em] text-blue-900">AI Recommendation</p>
            <p className="text-sm leading-relaxed text-blue-800">{budget.ai_insights}</p>
          </div>
        </div>
      )}
    </div>
  );
}

export default function BudgetDashboard() {
  const location = useLocation();
  const [scopeProperty, setScopeProperty] = useState("all");
  const [scopeBuilding, setScopeBuilding] = useState("all");
  const [scopeUnit, setScopeUnit] = useState("all");
  const [selectedBudgetId, setSelectedBudgetId] = useState(null);

  const { data: budgets = [], isLoading } = useOrgQuery("Budget");
  const { data: properties = [] } = useOrgQuery("Property");
  const { data: buildings = [] } = useOrgQuery("Building");
  const { data: units = [] } = useOrgQuery("Unit");
  const { data: portfolios = [] } = useOrgQuery("Portfolio");

  const queryClient = useQueryClient();

  const updateMutation = useMutation({
    mutationFn: ({ id, ...data }) => BudgetService.update(id, data),
    onSuccess: async () => {
      await invalidateBudgetCaches(queryClient);
      toast.success("Budget status updated");
    },
    onError: (err) => {
      toast.error(`Failed to update budget: ${err.message}`);
    },
  });

  const handleStatusChange = (id, newStatus) => {
    updateMutation.mutate({ id, status: newStatus });
  };

  const handleDetailedExport = async (budget) => {
    if (!budget) return;

    const toastId = toast.loading("Preparing detailed financial export...");
    try {
      const data = await invokeFunctionWithFreshSession("export-data", {
        export_type: "budget",
        property_id: budget.property_id,
        fiscal_year: getBudgetYear(budget),
        format: "csv",
      });

      if (!data?.download_url) {
        throw new Error("Download URL not received");
      }

      window.open(data.download_url, "_blank", "noopener");
      toast.success("Detailed export ready", { id: toastId });
    } catch (err) {
      console.error("[BudgetDashboard] Detailed export failed:", err);
      toast.error(`Export failed: ${err.message}`, { id: toastId });
    }
  };

  const scope = useMemo(
    () =>
      buildHierarchyScope({
        search: location.search,
        portfolios,
        properties,
        buildings,
        units,
      }),
    [location.search, portfolios, properties, buildings, units]
  );

  useEffect(() => {
    setScopeProperty(scope.propertyId || "all");
    setScopeBuilding(scope.buildingId || "all");
    setScopeUnit(scope.unitId || "all");
  }, [scope.propertyId, scope.buildingId, scope.unitId]);

  const statusColors = {
    draft: "bg-slate-100 text-slate-600",
    ai_generated: "bg-blue-100 text-blue-700",
    under_review: "bg-red-100 text-red-700",
    reviewed: "bg-amber-100 text-amber-700",
    approved: "bg-emerald-100 text-emerald-700",
    signed: "bg-green-100 text-green-700",
    locked: "bg-slate-800 text-white",
  };

  const scopedBudgets = budgets.filter((budget) =>
    matchesHierarchyScope(budget, scope, {
      portfolioKey: "portfolio_id",
      propertyKey: "property_id",
      buildingKey: "building_id",
      unitKey: "unit_id",
    })
  );

  const visibleBudgets = scopedBudgets.filter((budget) => {
    if (scopeProperty !== "all" && budget.property_id !== scopeProperty) return false;
    if (scopeBuilding !== "all" && budget.building_id !== scopeBuilding) return false;
    if (scopeUnit !== "all" && budget.unit_id !== scopeUnit) return false;
    return true;
  });

  useEffect(() => {
    if (!visibleBudgets.length) {
      setSelectedBudgetId(null);
      return;
    }
    if (!selectedBudgetId || !visibleBudgets.some((budget) => budget.id === selectedBudgetId)) {
      setSelectedBudgetId(visibleBudgets[0].id);
    }
  }, [visibleBudgets, selectedBudgetId]);

  const selectedBudget = visibleBudgets.find((budget) => budget.id === selectedBudgetId) || visibleBudgets[0] || null;
  const selectedPropertyId = scopeProperty !== "all" ? scopeProperty : scope.propertyId || selectedBudget?.property_id || null;
  const selectedBudgetScopeLabel = selectedBudget ? getBudgetScopeLabel(selectedBudget, scope) : "Selected scope";

  const handleEmailStakeholders = async ({ budget, recipients, message }) => {
    const toastId = toast.loading("Sending budget review...");

    try {
      const exportData = await invokeFunctionWithFreshSession("export-data", {
        export_type: "budget",
        property_id: budget.property_id,
        fiscal_year: getBudgetYear(budget),
        format: "csv",
      });

      const downloadUrl = exportData?.download_url || "";
      const subject = `${budget.name} - FY ${getBudgetYear(budget)} Budget Review`;
      const html = buildBudgetEmailHtml({
        budget,
        scopeLabel: getBudgetScopeLabel(budget, scope),
        customMessage: message,
        downloadUrl,
      });

      await invokeFunctionWithFreshSession("send-email", {
        to: recipients,
        subject,
        html,
      });

      toast.success(`Budget review sent to ${recipients.length} stakeholder${recipients.length === 1 ? "" : "s"}`, { id: toastId });
    } catch (err) {
      console.error("[BudgetDashboard] Stakeholder email failed:", err);
      toast.error(`Email failed: ${err.message}`, { id: toastId });
      throw err;
    }
  };

  const subtitleScope = getScopeSubtitle(scope, {
    default: `${visibleBudgets.length} budgets across the active scope`,
    portfolio: (portfolio) => `${visibleBudgets.length} budgets in ${portfolio.name}`,
    property: (property) => `${visibleBudgets.length} budgets for ${property.name}`,
    building: (building) => `${visibleBudgets.length} budgets for ${building.name}`,
    unit: (unit) => `${visibleBudgets.length} budgets for ${unit.unit_number || unit.unit_id_code || "selected unit"}`,
    org: () => `${visibleBudgets.length} budgets in selected organization`,
  });

  return (
    <div className="space-y-6 p-6">
      <PageHeader title="Budget Dashboard" subtitle={subtitleScope}>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => handleDetailedExport(selectedBudget)} disabled={!selectedBudget}>
            <Download className="mr-2 h-4 w-4" />
            Export Budget
          </Button>
          <Link to={createPageUrl("CreateBudget") + location.search}>
            <Button className="bg-blue-600 hover:bg-blue-700">
              <Plus className="mr-2 h-4 w-4" />
              Create Budget
            </Button>
          </Link>
        </div>
      </PageHeader>

      {selectedPropertyId ? (
        <PipelineActions propertyId={selectedPropertyId} fiscalYear={new Date().getFullYear()} actions={BUDGET_ACTIONS} />
      ) : (
        <div className="text-xs text-slate-500">Select a property scope to run budget compute and export actions.</div>
      )}

      <ScopeSelector
        properties={scope.scopedProperties}
        buildings={scope.scopedBuildings}
        units={scope.scopedUnits}
        selectedProperty={scopeProperty}
        selectedBuilding={scopeBuilding}
        selectedUnit={scopeUnit}
        onPropertyChange={setScopeProperty}
        onBuildingChange={setScopeBuilding}
        onUnitChange={setScopeUnit}
      />

      {isLoading ? (
        <div className="flex h-64 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
        </div>
      ) : visibleBudgets.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center text-slate-400">
            <p>No budgets created yet for this scope</p>
            <Link to={createPageUrl("CreateBudget") + location.search}>
              <Button className="mt-4">Create First Budget</Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-3">
            {visibleBudgets.map((budget) => {
              const property = budget.property_id ? scope.propertyById.get(budget.property_id) ?? null : null;
              const building = budget.building_id ? scope.buildingById.get(budget.building_id) ?? null : null;
              const unit = budget.unit_id ? scope.unitById.get(budget.unit_id) ?? null : null;

              return (
                <Card
                  key={budget.id}
                  className={`cursor-pointer border-l-4 transition-shadow hover:shadow-md ${selectedBudget?.id === budget.id ? "border-l-blue-700" : "border-l-blue-500"}`}
                  onClick={() => setSelectedBudgetId(budget.id)}
                >
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-bold text-slate-900">{budget.name}</p>
                        <p className="text-xs text-slate-400">
                          {getBudgetYear(budget)} - {budget.generation_method?.replace("_", " ") || "manual"}
                        </p>
                        <p className="mt-1 text-[11px] text-slate-500">
                          {unit?.unit_number || unit?.unit_id_code || building?.name || property?.name || "Org scope"}
                        </p>
                      </div>
                      <Badge className={`${statusColors[budget.status] || "bg-slate-100 text-slate-600"} text-[10px] uppercase`}>
                        {budget.status?.replace("_", " ")}
                      </Badge>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-4 text-xs text-slate-500">
                      <span className="font-medium text-emerald-600">{formatCompactCurrency(budget.total_revenue)} Revenue</span>
                      <span className="font-medium text-red-500">{formatCompactCurrency(budget.total_expenses)} Expenses</span>
                      <span className="font-bold text-slate-900">{formatCompactCurrency(budget.noi)} NOI</span>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {selectedBudget && (
            <div className="lg:col-span-2">
              <Card>
                <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <CardTitle className="text-base">{selectedBudget.name}</CardTitle>
                    <p className="text-xs text-slate-400">
                      {getBudgetYear(selectedBudget)} - {selectedBudget.generation_method?.replace("_", " ") || "manual"}
                    </p>
                  </div>
                  <Badge className={`${statusColors[selectedBudget.status] || "bg-slate-100 text-slate-600"} uppercase text-[10px]`}>
                    {selectedBudget.status?.replace("_", " ")}
                  </Badge>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                    <div className="rounded-2xl bg-slate-50 p-4">
                      <p className="text-xs text-slate-500">Total Revenue</p>
                      <p className="text-xl font-bold text-slate-900">{formatCurrency(selectedBudget.total_revenue)}</p>
                    </div>
                    <div className="rounded-2xl bg-slate-50 p-4">
                      <p className="text-xs text-slate-500">Total Expenses</p>
                      <p className="text-xl font-bold text-red-600">{formatCurrency(selectedBudget.total_expenses)}</p>
                    </div>
                    <div className="rounded-2xl bg-slate-50 p-4">
                      <p className="text-xs text-slate-500">CAM Total</p>
                      <p className="text-xl font-bold text-blue-600">{formatCurrency(selectedBudget.cam_total)}</p>
                    </div>
                    <div className="rounded-2xl bg-slate-50 p-4">
                      <p className="text-xs text-slate-500">NOI</p>
                      <p className="text-xl font-bold text-emerald-600">{formatCurrency(selectedBudget.noi)}</p>
                    </div>
                  </div>

                  <BudgetInsights budget={selectedBudget} />

                  <div className="flex flex-wrap gap-3 pt-2">
                    {["draft", "ai_generated", "under_review", "reviewed"].includes(selectedBudget.status) && (
                      <Button
                        className="flex-1 bg-emerald-600 hover:bg-emerald-700"
                        onClick={() => handleStatusChange(selectedBudget.id, "approved")}
                        disabled={updateMutation.isPending}
                      >
                        {updateMutation.isPending ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <CheckCircle2 className="mr-2 h-4 w-4" />
                        )}
                        Approve Budget
                      </Button>
                    )}
                    {!["approved", "locked", "signed"].includes(selectedBudget.status) && (
                      <Button
                        variant="outline"
                        className="border-red-200 text-red-500 hover:bg-red-50"
                        onClick={() => handleStatusChange(selectedBudget.id, "draft")}
                        disabled={updateMutation.isPending}
                      >
                        <X className="mr-2 h-4 w-4" />
                        Reject
                      </Button>
                    )}
                  </div>

                  <div className="flex flex-col gap-3 sm:flex-row">
                    <Button variant="outline" className="flex-1" onClick={() => handleDetailedExport(selectedBudget)}>
                      <Download className="mr-2 h-4 w-4" />
                      Download Detailed Export
                    </Button>
                    <EmailStakeholderDialog
                      budget={selectedBudget}
                      scopeLabel={selectedBudgetScopeLabel}
                      onSend={handleEmailStakeholders}
                      trigger={
                        <Button variant="outline" className="flex-1">
                          <Mail className="mr-2 h-4 w-4" />
                          Email to Stakeholders
                        </Button>
                      }
                    />
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

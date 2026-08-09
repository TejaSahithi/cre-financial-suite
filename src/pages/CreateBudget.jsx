import React, { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { FileText, Zap, TrendingUp, ArrowRight, Loader2, CheckCircle2, Lock, X, MessageSquare, AlertTriangle, XCircle } from "lucide-react";

import { UnitService, BuildingService, PropertyService, LeaseService, BudgetService, PortfolioService } from "@/services/api";
import { supabase } from "@/services/supabaseClient";
import { buildHierarchyScope } from "@/lib/hierarchyScope";
import { createPageUrl } from "@/utils";
import ScenarioPlanner from "@/components/ScenarioPlanner";
import FileUploader from "@/components/FileUploader";
import { invokeEdgeFunction } from "@/services/edgeFunctions";
import { toast } from "sonner";
import BudgetPreviewTabs from "@/components/budget/BudgetPreviewTabs";
import BudgetPlanningPanel from "@/components/budget/BudgetPlanningPanel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import useOrgQuery from "@/hooks/useOrgQuery";
import { checkBudgetReadiness } from "@/services/budgetReadinessService";

function buildDefaultForm(scope) {
  return {
    name: "",
    budget_year: new Date().getFullYear(),
    scope: scope.unitId ? "unit" : scope.buildingId ? "building" : "property",
    period: "annual",
    portfolio_id: scope.portfolioId || "",
    property_id: scope.propertyId || "",
    building_id: scope.buildingId || "",
    unit_id: scope.unitId || "",
  };
}

function normalizeBudgetNotificationRecipients(stakeholders, propertyId) {
  return [...new Set(
    stakeholders
      .filter((stakeholder) =>
        stakeholder?.email &&
        stakeholder.notify_budget_approval !== false &&
        (!stakeholder.property_id || !propertyId || stakeholder.property_id === propertyId)
      )
      .map((stakeholder) => stakeholder.email.trim().toLowerCase())
      .filter(Boolean)
  )];
}

async function invalidateBudgetCaches(queryClient) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["Budget"] }),
    queryClient.invalidateQueries({ queryKey: ["budgets"] }),
    queryClient.invalidateQueries({ queryKey: ["budgets-manage"] }),
    queryClient.invalidateQueries({ queryKey: ["Notification"] }),
  ]);
}

export default function CreateBudget() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [method, setMethod] = useState("lease_driven");
  const [generating, setGenerating] = useState(false);
  const [selectedBudgetId, setSelectedBudgetId] = useState(null);
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [rejectComment, setRejectComment] = useState("");
  const [rejectTargetId, setRejectTargetId] = useState(null);
  const [historicalFileIds, setHistoricalFileIds] = useState([]);
  const [generateWithoutCam, setGenerateWithoutCam] = useState(true);

  const { orgId } = useOrgQuery("Budget");
  const { data: stakeholders = [] } = useOrgQuery("Stakeholder");

  const { data: portfolios = [] } = useQuery({ queryKey: ["cb-portfolios"], queryFn: () => PortfolioService.list() });
  const { data: properties = [] } = useQuery({ queryKey: ["cb-properties"], queryFn: () => PropertyService.list() });
  const { data: buildings = [] } = useQuery({ queryKey: ["cb-buildings"], queryFn: () => BuildingService.list() });
  const { data: units = [] } = useQuery({ queryKey: ["cb-units"], queryFn: () => UnitService.list() });
  const { data: leases = [] } = useQuery({ queryKey: ["leases-budget"], queryFn: () => LeaseService.list() });
  const { data: budgets = [] } = useQuery({ queryKey: ["budgets-manage"], queryFn: () => BudgetService.list("-created_date") });

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

  const [form, setForm] = useState(() => buildDefaultForm(scope));

  useEffect(() => {
    setForm((current) => ({
      ...current,
      portfolio_id: scope.portfolioId || current.portfolio_id || "",
      property_id: scope.propertyId || current.property_id || "",
      building_id: scope.buildingId || current.building_id || "",
      unit_id: scope.unitId || current.unit_id || "",
      scope: scope.unitId ? "unit" : scope.buildingId ? "building" : current.scope || "property",
    }));
  }, [scope.portfolioId, scope.propertyId, scope.buildingId, scope.unitId]);

  // The official/persisted budget is created entirely server-side by
  // compute-budget (gated, audited, snapshot-versioned) instead of a direct
  // client-side insert via the Budget entity service. compute-budget requires
  // revenue and expense computation_snapshots to exist for the property +
  // fiscal year, so those are triggered first — mirroring how
  // _shared/compute-orchestrator.ts already dispatches compute-revenue/
  // compute-expense/compute-budget together elsewhere in the app, just
  // wired into this manual "Generate Budget" action too.
  const createMutation = useMutation({
    mutationFn: async ({ scope, portfolioId, propertyId, buildingId, unitId, fiscalYear, period, allowGenerateWithoutCam, aiInsights }) => {
      // compute-revenue/compute-expense remain property-level-only engines
      // (they have no building/unit granular calculation logic) — this is a
      // documented limitation, not something this PR changes. compute-budget
      // itself computes scope-filtered building/unit totals directly from
      // the raw leases/expenses/revenues rows; these two calls only ensure
      // the property-wide readiness snapshots exist.
      await invokeEdgeFunction("compute-revenue", { property_id: propertyId, fiscal_year: fiscalYear });
      await invokeEdgeFunction("compute-expense", { property_id: propertyId, fiscal_year: fiscalYear });
      return invokeEdgeFunction("compute-budget", {
        action: "generate",
        scope,
        portfolio_id: portfolioId || undefined,
        property_id: propertyId || undefined,
        building_id: buildingId || undefined,
        unit_id: unitId || undefined,
        fiscal_year: fiscalYear,
        period,
        allow_generate_without_cam: allowGenerateWithoutCam,
        ai_insights: aiInsights || null,
      });
    },
    onSuccess: () => navigate(createPageUrl("BudgetDashboard") + location.search),
    onError: (error) => {
      toast.error(error?.message || "Failed to generate budget");
    },
  });

  // All budget status transitions (approve, lock, mark_reviewed, reject) are
  // server-owned via compute-budget, which enforces each transition's
  // precondition (e.g. "must be reviewed before approving", "cannot reject
  // an approved/locked/signed budget") instead of a client-side check.
  // compute-budget looks budgets up by (org, scope, scope_id, budget_year)
  // rather than property_id alone, so the full scope identity of the
  // target budget row travels with every action, not just its property_id.
  const computeBudgetActionMutation = useMutation({
    // budget_id is the primary identifier (hardening PR) — the scope
    // fields still travel alongside it as a cross-check, so a stale/wrong
    // budget object in client state is rejected instead of silently acting
    // on whatever budget_id happens to resolve to.
    mutationFn: ({ action, budget, fiscalYear, reason }) =>
      invokeEdgeFunction("compute-budget", {
        action,
        budget_id: budget?.id,
        scope: budget?.scope,
        portfolio_id: budget?.portfolio_id || undefined,
        property_id: budget?.property_id || undefined,
        building_id: budget?.building_id || undefined,
        unit_id: budget?.unit_id || undefined,
        fiscal_year: fiscalYear,
        reason,
      }),
    onSuccess: async () => {
      await invalidateBudgetCaches(queryClient);
    },
    onError: (error) => {
      toast.error(error?.message || "Failed to update budget status");
    },
  });

  const filteredBuildings = form.property_id ? scope.scopedBuildings.filter((building) => building.property_id === form.property_id) : scope.scopedBuildings;
  const filteredUnits = form.building_id
    ? scope.scopedUnits.filter((unit) => unit.building_id === form.building_id)
    : form.property_id
      ? scope.scopedUnits.filter((unit) => unit.property_id === form.property_id)
      : scope.scopedUnits;

  const scopeLeases = leases.filter((lease) => {
    if (form.property_id && lease.property_id !== form.property_id) return false;
    if (form.unit_id && lease.unit_id !== form.unit_id) return false;
    if (form.building_id) {
      const leaseUnit = lease.unit_id ? scope.unitById.get(lease.unit_id) ?? null : null;
      if (leaseUnit?.building_id !== form.building_id) return false;
    }
    return true;
  });

  const selectedProperty = properties.find((property) => property.id === form.property_id);
  const selectedBuilding = buildings.find((building) => building.id === form.building_id);
  const selectedUnit = units.find((unit) => unit.id === form.unit_id);
  const { data: readiness, isLoading: readinessLoading } = useQuery({
    queryKey: ["budget-readiness", form.property_id, form.budget_year, orgId],
    queryFn: () =>
      checkBudgetReadiness(supabase, {
        propertyId: form.property_id,
        fiscalYear: form.budget_year,
        orgId,
      }),
    enabled: !!form.property_id && !!orgId,
    staleTime: 30_000,
  });

  const latestCamSnapshot = readiness?.meta?.camSnapshot ?? null;

  const handleGenerate = async () => {
    if (!form.name.trim()) {
      toast.error("Please enter a budget name.");
      return;
    }
    if (!form.property_id) {
      toast.error("Please select a property.");
      return;
    }
    if (form.scope === "building" && !form.building_id) {
      toast.error("Please select a building.");
      return;
    }
    if (form.scope === "unit" && !form.unit_id) {
      toast.error("Please select a unit.");
      return;
    }
    if (form.period !== "annual") {
      toast.error("Only annual budgets are supported today — quarterly/monthly budgeting is not yet available.");
      return;
    }

    setGenerating(true);
    try {
      const writableOrgId = orgId || null;
      if (!writableOrgId) {
        toast.error("No organization selected. Select an organization before creating a budget.");
        return;
      }

      const scopeLabel =
        selectedUnit
          ? `Unit ${selectedUnit.unit_number || selectedUnit.unit_id_code || selectedUnit.id}`
          : selectedBuilding
            ? `Building ${selectedBuilding.name || selectedBuilding.id}`
            : selectedProperty
              ? selectedProperty.name
              : form.name || "Property";

      let aiData = null;
      if (method !== "manual") {
        try {
          const { data: session } = await supabase.auth.getSession();
          const token = session?.session?.access_token;
          const { data: result, error } = await supabase.functions.invoke("generate-budget", {
            body: {
              scope_label: scopeLabel,
              budget_year: form.budget_year,
              scope: form.scope,
              period: form.period,
              method,
              leases: scopeLeases.map((lease) => ({ tenant_name: lease.tenant_name, annual_rent: lease.annual_rent })),
              historical_file_ids: method === "historical_ai" ? historicalFileIds : [],
            },
            ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
          });
          if (error) {
            console.error("[CreateBudget] generate-budget error:", error);
            toast.warning("AI insights preview failed — the budget will still be computed from actual lease/expense/CAM data. " + (error.message || ""));
          } else if (result?.error) {
            console.error("[CreateBudget] generate-budget returned error:", result);
            toast.warning("AI insights preview failed — the budget will still be computed from actual lease/expense/CAM data. " + (result.message || ""));
          } else if (result) {
            aiData = result;
          }
        } catch (aiError) {
          console.error("[CreateBudget] generate-budget exception:", aiError);
          toast.warning("AI insights preview failed — the budget will still be computed from actual lease/expense/CAM data.");
        }
      }

      createMutation.mutate({
        scope: form.scope,
        // portfolio_id is intentionally NOT sent here even though the form
        // tracks one — compute-budget inherits it from the property record
        // itself when omitted (see assertValidBudgetScopeHierarchy) and
        // will hard-reject a mismatched value. form.portfolio_id can go
        // stale when switching between properties in different portfolios
        // (it doesn't always clear on property change), so sending it would
        // risk a spurious "wrong portfolio" rejection for a value the user
        // never actually chose. Letting the server derive it avoids that
        // footgun entirely.
        propertyId: form.property_id,
        buildingId: form.scope === "building" ? form.building_id : null,
        unitId: form.scope === "unit" ? form.unit_id : null,
        fiscalYear: form.budget_year,
        period: form.period,
        allowGenerateWithoutCam: generateWithoutCam || !latestCamSnapshot,
        aiInsights: aiData?.ai_insights || null,
      });
    } finally {
      setGenerating(false);
    }
  };

  const methods = [
    { id: "lease_driven", icon: FileText, label: "Lease-Driven", desc: "Auto-generated from your extracted lease data. Most accurate for portfolios with active leases." },
    { id: "manual", icon: Zap, label: "Manual + AI Assist", desc: "Enter key assumptions. AI fills gaps using market benchmarks and comparables." },
    { id: "historical_ai", icon: TrendingUp, label: "Historical + Market AI", desc: "Upload prior budgets/actuals. AI generates 4-5 scenarios with market trends, CPI, and forecasts." },
  ];

  const statuses = [
    { label: "Draft", color: "bg-slate-500" },
    { label: "AI Generated", color: "bg-blue-500" },
    { label: "Under Review", color: "bg-red-500" },
    { label: "Reviewed", color: "bg-amber-500" },
    { label: "Approved", color: "bg-emerald-500" },
    { label: "Signed", color: "bg-green-500" },
    { label: "Locked", color: "bg-slate-800" },
  ];

  const statusColors = {
    draft: "bg-slate-100 text-slate-600",
    ai_generated: "bg-blue-100 text-blue-700",
    under_review: "bg-red-100 text-red-700",
    reviewed: "bg-amber-100 text-amber-700",
    approved: "bg-emerald-100 text-emerald-700",
    signed: "bg-green-100 text-green-700",
    locked: "bg-slate-800 text-white",
  };

  // Keep selectedBudgetId in sync when budgets change
  const selectedBudget = budgets.find(b => b.id === selectedBudgetId) || budgets[0] || null;
  useEffect(() => {
    if (budgets.length > 0 && !budgets.find(b => b.id === selectedBudgetId)) {
      setSelectedBudgetId(budgets[0].id);
    }
  }, [budgets, selectedBudgetId]);

  // The in-app "Budget Sent Back for Rework" notification is already written
  // by the fn_on_budget_changed DB trigger when compute-budget's reject
  // action sets status='draft' + rejection_comment — this only needs to
  // handle the stakeholder email, not a second notifications row.
  const notifyStakeholdersOfRework = async (budget, comment) => {
    const recipients = normalizeBudgetNotificationRecipients(stakeholders, budget?.property_id);

    if (recipients.length === 0) {
      toast.info("Budget was sent back for rework. No stakeholder email recipients were configured.");
      return;
    }

    try {
      await invokeEdgeFunction("send-email", {
        to: recipients,
        templateId: 'generic_internal_notification',
        variables: {
          subject: `${budget?.name || "Budget"} requires rework`,
          message: `Budget "${budget?.name}" (FY ${budget?.budget_year || budget?.fiscal_year || "current"}) needs updates before approval. Reviewer comments: ${comment}. Open Budget Studio to view details.`
        }
      });
      toast.success(`Rework notes sent to ${recipients.length} stakeholder${recipients.length === 1 ? "" : "s"}`);
    } catch (error) {
      console.error("[CreateBudget] Failed to email stakeholders:", error);
      toast.warning("Budget was sent back for rework, but stakeholder email delivery failed.");
    }
  };

  const handleReviewed = async (budget) => {
    if (!budget) return;

    try {
      await computeBudgetActionMutation.mutateAsync({
        action: "mark_reviewed",
        budget,
        fiscalYear: budget.budget_year || budget.fiscal_year,
      });
      toast.success(`"${budget.name}" marked as reviewed`);
    } catch (error) {
      console.error("[CreateBudget] Failed to mark budget as reviewed:", error);
    }
  };

  const handleReject = (budgetId) => {
    setRejectTargetId(budgetId);
    setRejectComment("");
    setRejectDialogOpen(true);
  };

  const handleRejectConfirm = async () => {
    if (!rejectTargetId) return;
    const budget = budgets.find(b => b.id === rejectTargetId);
    const comment = rejectComment.trim();

    try {
      await computeBudgetActionMutation.mutateAsync({
        action: "reject",
        budget,
        fiscalYear: budget?.budget_year || budget?.fiscal_year,
        reason: comment,
      });

      toast.success("Budget rejected and sent back for rework");
      await notifyStakeholdersOfRework(budget, comment);
      setRejectDialogOpen(false);
      setRejectComment("");
      setRejectTargetId(null);
    } catch (error) {
      console.error("[CreateBudget] Failed to reject budget:", error);
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs text-slate-400 mb-1">CAM Engine › Budget Studio</p>
          <h1 className="text-[28px] font-bold text-slate-900 flex items-center gap-2">
            <Zap className="w-6 h-6 text-blue-600" />
            Budget Studio
          </h1>
          <p className="text-sm text-slate-500 mt-1">Generate budgets 3 ways. Full review, approval, digital signing, locking workflow. Downloadable as Excel/CSV.</p>
        </div>
        <Link to={createPageUrl("Reconciliation") + location.search}>
          <Button variant="outline" size="sm">
            Actuals & Recon
            <ArrowRight className="w-4 h-4 ml-1" />
          </Button>
        </Link>
      </div>

      <div className="flex gap-2 flex-wrap">
        {statuses.map((status) => (
          <Badge key={status.label} className={`${status.color} text-white text-[10px]`}>
            {status.label === "Locked" && <Lock className="w-2.5 h-2.5 mr-1" />}
            {status.label}
          </Badge>
        ))}
      </div>

      <Tabs defaultValue="generate">
        <TabsList className="bg-white border">
          <TabsTrigger value="generate">Generate Budget</TabsTrigger>
          <TabsTrigger value="preview">Preview from Approved Data</TabsTrigger>
          <TabsTrigger value="manage">Manage Budgets ({budgets.length})</TabsTrigger>
          <TabsTrigger value="scenarios">Scenario Planning</TabsTrigger>
          <TabsTrigger value="planning">Next-Year Plan</TabsTrigger>
        </TabsList>

        <TabsContent value="preview" className="mt-4">
          <BudgetPreviewTabs
            propertyId={form.property_id || scope.propertyId || null}
            budgetYear={form.budget_year}
          />
        </TabsContent>

        <TabsContent value="generate" className="mt-4 space-y-6">
          <div className="grid md:grid-cols-3 gap-4">
            {methods.map((option) => (
              <button
                key={option.id}
                onClick={() => setMethod(option.id)}
                className={`p-6 rounded-xl border-2 text-left transition-all ${method === option.id ? "border-blue-600 bg-blue-50" : "border-slate-200 bg-white hover:border-slate-300"}`}
              >
                <div className="flex items-start justify-between mb-3">
                  <option.icon className={`w-6 h-6 ${method === option.id ? "text-blue-600" : "text-slate-400"}`} />
                  {method === option.id && <CheckCircle2 className="w-5 h-5 text-emerald-500" />}
                </div>
                <h3 className="text-sm font-bold text-slate-900">{option.label}</h3>
                <p className="text-xs text-slate-500 mt-1.5 leading-relaxed">{option.desc}</p>
              </button>
            ))}
          </div>

          <Card>
            <CardContent className="p-6 space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div>
                  <Label className="text-xs">Budget Name</Label>
                  <Input value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} placeholder="e.g. HCC 2026 Budget" />
                </div>
                <div>
                  <Label className="text-xs">Budget Year</Label>
                  <Input type="number" value={form.budget_year} onChange={(event) => setForm((current) => ({ ...current, budget_year: parseInt(event.target.value, 10) || current.budget_year }))} />
                </div>
                <div>
                  <Label className="text-xs">Scope</Label>
                  <Select
                    value={form.scope}
                    onValueChange={(value) =>
                      setForm((current) => ({
                        ...current,
                        scope: value,
                        building_id: value === "property" ? "" : current.building_id,
                        unit_id: value === "unit" ? current.unit_id : "",
                      }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="property">Property</SelectItem>
                      <SelectItem value="building">Building</SelectItem>
                      <SelectItem value="unit">Unit</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">Period</Label>
                  <Select value={form.period} onValueChange={(value) => setForm((current) => ({ ...current, period: value }))}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="annual">Annual</SelectItem>
                      {/* Quarterly/monthly are disabled, not removed: the
                          calculation engine only ever produces one annual
                          aggregate today (see compute-budget's period
                          contract, _shared/budget-scope.ts). Selecting them
                          used to silently do nothing but get discarded
                          before the budget was persisted; disabling them
                          here makes that limitation visible instead of
                          letting the request fail server-side with no
                          context. */}
                      <SelectItem value="quarterly" disabled>Quarterly (not yet supported)</SelectItem>
                      <SelectItem value="monthly" disabled>Monthly (not yet supported)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <Label className="text-xs">Property *</Label>
                  <Select
                    value={form.property_id}
                    onValueChange={(value) =>
                      setForm((current) => ({
                        ...current,
                        property_id: value,
                        portfolio_id: scope.propertyById.get(value)?.portfolio_id || current.portfolio_id || "",
                        building_id: "",
                        unit_id: "",
                      }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select a property" />
                    </SelectTrigger>
                    <SelectContent>
                      {scope.scopedProperties.map((property) => (
                        <SelectItem key={property.id} value={property.id}>
                          {property.name} {property.city ? `(${property.city}, ${property.state})` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {(form.scope === "building" || form.scope === "unit") && (
                  <div>
                    <Label className="text-xs">Building {form.scope === "building" ? "*" : ""}</Label>
                    <Select value={form.building_id || "__none__"} onValueChange={(value) => setForm((current) => ({ ...current, building_id: value === "__none__" ? "" : value, unit_id: "" }))}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a building" />
                      </SelectTrigger>
                      <SelectContent>
                        {filteredBuildings.length === 0 ? (
                          <SelectItem value="__none__" disabled>
                            No buildings found
                          </SelectItem>
                        ) : (
                          filteredBuildings.map((building) => (
                            <SelectItem key={building.id} value={building.id}>
                              {building.name} ({((building.total_sf || building.total_sqft || 0) / 1000).toFixed(0)}K SF)
                            </SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {form.scope === "unit" && (
                  <div>
                    <Label className="text-xs">Unit *</Label>
                    <Select value={form.unit_id || "__none__"} onValueChange={(value) => setForm((current) => ({ ...current, unit_id: value === "__none__" ? "" : value }))}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a unit" />
                      </SelectTrigger>
                      <SelectContent>
                        {filteredUnits.length === 0 ? (
                          <SelectItem value="__none__" disabled>
                            No units found
                          </SelectItem>
                        ) : (
                          filteredUnits.map((unit) => (
                            <SelectItem key={unit.id} value={unit.id}>
                              {unit.unit_number || unit.unit_id_code || unit.id} — {(unit.square_feet || unit.square_footage || 0).toLocaleString()} SF
                            </SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>

              {method === "lease_driven" && scopeLeases.length > 0 && (
                <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3">
                  <p className="text-sm font-medium text-emerald-700 mb-1">✓ {scopeLeases.length} lease{scopeLeases.length > 1 ? "s" : ""} found for selected scope</p>
                  <p className="text-xs text-emerald-600">{scopeLeases.map((lease) => `${lease.tenant_name} — $${lease.annual_rent?.toLocaleString()}/yr`).join("  ·  ")}</p>
                </div>
              )}

              {method === "lease_driven" && form.property_id && scopeLeases.length === 0 && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                  <p className="text-sm font-medium text-amber-700">No leases found for selected scope — AI will use market benchmarks instead</p>
                </div>
              )}

              <div className={`rounded-lg border p-3 text-sm ${latestCamSnapshot ? "bg-emerald-50 border-emerald-200 text-emerald-800" : "bg-slate-50 border-slate-200 text-slate-600"}`}>
                {latestCamSnapshot
                  ? `CAM snapshot ready from ${new Date(latestCamSnapshot.computed_at).toLocaleString()}. Budget generation will use CAM recovery inputs.`
                  : "No CAM snapshot found for this property and year. Budget will be created without CAM recovery projections — you can run CAM Calculations later and update the budget."}
              </div>

              <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
                The budget uses lease data for rent and obligation terms, approved expense data for operating cost history, and CAM snapshots for recovery projections.
              </div>

              {method === "historical_ai" && (
                <Card className="bg-slate-50 border-dashed">
                  <CardContent className="p-4">
                    <p className="text-sm font-medium text-slate-700 mb-2">Upload Historical Budget or Actuals (optional)</p>
                    <div className="mt-2 max-w-sm">
                      <FileUploader
                        orgId={orgId}
                        propertyId={form.property_id}
                        defaultFileType="budgets"
                        allowedFileTypes={["budgets", "expenses", "revenue"]}
                        multiple
                        accept=".csv,.pdf,.xls,.xlsx"
                        onUploadComplete={(data) => {
                          const results = Array.isArray(data) ? data : data ? [data] : [];
                          const ids = results.map((result) => result?.file_id).filter(Boolean);
                          setHistoricalFileIds((current) => Array.from(new Set([...current, ...ids])));
                          const uploadCount = ids.length || results.length || 1;
                          toast.success(`${uploadCount} historical file${uploadCount === 1 ? "" : "s"} queued for AI processing.`);
                        }}
                      />
                    </div>
                    <p className="text-[10px] text-slate-400 mt-3">AI will generate 4 scenarios: Conservative, Moderate, Optimistic, Market-Adjusted — each with explanation.</p>
                  </CardContent>
                </Card>
              )}

              {form.property_id && (
                <BudgetReadinessChecklist checks={readiness?.checks} isLoading={readinessLoading} />
              )}

              <Button
                onClick={handleGenerate}
                disabled={generating || !form.name || !form.property_id || readiness?.hasBlockers === true}
                className="bg-blue-600 hover:bg-blue-700"
                title={readiness?.hasBlockers ? "Resolve blockers above before generating" : undefined}
              >
                {generating ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Zap className="w-4 h-4 mr-2" />}
                Generate Budget
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="scenarios" className="mt-4">
          <ScenarioPlanner
            baseRevenue={budgets[0]?.total_revenue || 0}
            baseExpenses={budgets[0]?.total_expenses || 0}
            baseOccupancy={85}
            baseRentPerSF={25}
            totalSF={50000}
          />
        </TabsContent>

        <TabsContent value="manage" className="mt-4">
          {budgets.length === 0 ? (
            <Card>
              <CardContent className="p-8 text-center text-slate-400">No budgets created yet</CardContent>
            </Card>
          ) : (
            <div className="grid lg:grid-cols-3 gap-6">
              <div className="space-y-3">
                {budgets.map((budget) => (
                  <Card
                    key={budget.id}
                    className={`cursor-pointer hover:shadow-md transition-shadow border-l-4 ${selectedBudget?.id === budget.id ? "border-l-blue-700 ring-1 ring-blue-200" : "border-l-blue-500"}`}
                    onClick={() => setSelectedBudgetId(budget.id)}
                  >
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between">
                        <div>
                          <p className="text-sm font-bold text-slate-900">{budget.name}</p>
                          <p className="text-xs text-slate-400">{budget.budget_year} · {budget.generation_method?.replace("_", " ")}</p>
                        </div>
                        <Badge className={`${statusColors[budget.status] || "bg-slate-100"} text-[10px] uppercase`}>
                          {budget.status?.replace("_", " ")}
                        </Badge>
                      </div>
                      <div className="flex gap-4 mt-3 text-xs">
                        <span className="text-emerald-600 font-medium">${((budget.total_revenue || 0) / 1000).toFixed(0)}K Revenue</span>
                        <span className="text-red-500 font-medium">${((budget.total_expenses || 0) / 1000).toFixed(0)}K Expenses</span>
                        <span className="font-bold text-slate-900">${((budget.noi || 0) / 1000).toFixed(0)}K NOI</span>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
              {selectedBudget && (
                <div className="lg:col-span-2">
                  <Card>
                    <CardHeader className="flex flex-row items-center justify-between">
                      <div>
                        <CardTitle className="text-base">{selectedBudget.name}</CardTitle>
                        <p className="text-xs text-slate-400">{selectedBudget.budget_year} · {selectedBudget.generation_method?.replace("_", " ")}</p>
                      </div>
                      <Badge className={`${statusColors[selectedBudget.status] || "bg-slate-100"} uppercase text-[10px]`}>
                        {selectedBudget.status?.replace("_", " ")}
                      </Badge>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                        <div className="p-4 bg-slate-50 rounded-xl">
                          <p className="text-xs text-slate-500">Total Revenue</p>
                          <p className="text-xl font-bold">${(selectedBudget.total_revenue || 0).toLocaleString()}</p>
                        </div>
                        <div className="p-4 bg-slate-50 rounded-xl">
                          <p className="text-xs text-slate-500">Total Expenses</p>
                          <p className="text-xl font-bold text-red-600">${(selectedBudget.total_expenses || 0).toLocaleString()}</p>
                        </div>
                        <div className="p-4 bg-slate-50 rounded-xl">
                          <p className="text-xs text-slate-500">CAM Total</p>
                          <p className="text-xl font-bold text-blue-600">${(selectedBudget.cam_total || 0).toLocaleString()}</p>
                        </div>
                        <div className="p-4 bg-slate-50 rounded-xl">
                          <p className="text-xs text-slate-500">NOI</p>
                          <p className="text-xl font-bold text-emerald-600">${(selectedBudget.noi || 0).toLocaleString()}</p>
                        </div>
                      </div>
                      {selectedBudget.ai_insights && (
                        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
                          <p className="text-xs font-semibold text-amber-700 mb-1">AI Insights</p>
                          <p className="text-sm text-amber-800">{selectedBudget.ai_insights}</p>
                        </div>
                      )}
                      {selectedBudget.rejection_comment && (
                        <div className="bg-red-50 border border-red-200 rounded-xl p-4">
                          <p className="text-xs font-semibold text-red-700 mb-1">Latest Rework Comments</p>
                          <p className="text-sm text-red-800 whitespace-pre-wrap">{selectedBudget.rejection_comment}</p>
                        </div>
                      )}
                      <div className="flex gap-3 mt-6 pt-4 border-t border-slate-100">
                        {["draft", "ai_generated", "under_review"].includes(selectedBudget.status) && (
                          <Button
                            className="flex-1 bg-amber-500 hover:bg-amber-600"
                            disabled={computeBudgetActionMutation.isPending}
                            onClick={() => handleReviewed(selectedBudget)}
                          >
                            {computeBudgetActionMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <CheckCircle2 className="w-4 h-4 mr-2" />}
                            Mark as Reviewed
                          </Button>
                        )}
                        {["reviewed"].includes(selectedBudget.status) && (
                          <Button
                            className="flex-1 bg-emerald-600 hover:bg-emerald-700"
                            disabled={computeBudgetActionMutation.isPending}
                            onClick={() => computeBudgetActionMutation.mutate({ action: "approve", budget: selectedBudget, fiscalYear: selectedBudget.budget_year || selectedBudget.fiscal_year })}
                          >
                            <CheckCircle2 className="w-4 h-4 mr-2" />
                            Approve Budget
                          </Button>
                        )}
                        {["approved"].includes(selectedBudget.status) && (
                          <Button
                            className="flex-1 bg-slate-800 hover:bg-slate-900"
                            disabled={computeBudgetActionMutation.isPending}
                            onClick={() => computeBudgetActionMutation.mutate({ action: "lock", budget: selectedBudget, fiscalYear: selectedBudget.budget_year || selectedBudget.fiscal_year })}
                          >
                            <Lock className="w-4 h-4 mr-2" />
                            Lock Budget
                          </Button>
                        )}
                        {!["approved", "locked", "signed"].includes(selectedBudget.status) && (
                          <Button variant="outline" className="text-red-500 border-red-200 hover:bg-red-50" onClick={() => handleReject(selectedBudget.id)}>
                            <X className="w-4 h-4 mr-2" />
                            Reject / Rework
                          </Button>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                </div>
              )}
            </div>
          )}

          {/* Rejection Dialog */}
          <Dialog open={rejectDialogOpen} onOpenChange={setRejectDialogOpen}>
            <DialogContent className="sm:max-w-lg">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <MessageSquare className="w-5 h-5 text-red-500" />
                  Reject & Send Back for Rework
                </DialogTitle>
                <DialogDescription>
                  Provide comments explaining why this budget is being rejected. The budget will be set back to Draft status and stakeholders will be notified.
                </DialogDescription>
              </DialogHeader>
              <div className="py-4 space-y-3">
                <div>
                  <Label className="text-xs font-semibold">Budget</Label>
                  <p className="text-sm text-slate-700 mt-0.5">{budgets.find(b => b.id === rejectTargetId)?.name || "—"}</p>
                </div>
                <div>
                  <Label htmlFor="reject-comment" className="text-xs font-semibold">Rejection Comments *</Label>
                  <Textarea
                    id="reject-comment"
                    placeholder="e.g. Expense projections for insurance are too low based on renewal quotes. Please revise Section 3 with updated vendor estimates."
                    value={rejectComment}
                    onChange={(e) => setRejectComment(e.target.value)}
                    rows={5}
                    className="mt-1"
                  />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setRejectDialogOpen(false)}>Cancel</Button>
                <Button
                  className="bg-red-600 hover:bg-red-700 text-white"
                  disabled={!rejectComment.trim() || computeBudgetActionMutation.isPending}
                  onClick={handleRejectConfirm}
                >
                  {computeBudgetActionMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <X className="w-4 h-4 mr-2" />}
                  Reject & Notify Stakeholders
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </TabsContent>

        {/* Phase 4A: Next-Year Planning Budget — assembles Phase 3A expense
            basis + Phase 3B CAM estimate + revenue baseline into a draft
            budget via planning_source mode on compute-budget. */}
        <TabsContent value="planning" className="mt-4">
          <BudgetPlanningPanel
            propertyId={form.property_id || scope.propertyId || null}
            fiscalYear={form.budget_year}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function BudgetReadinessChecklist({ checks, isLoading }) {
  if (isLoading) {
    return (
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-400 animate-pulse">
        Checking budget readiness...
      </div>
    );
  }
  if (!checks?.length) return null;

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-1.5">
      <p className="text-xs font-semibold text-slate-600 mb-2">Budget Readiness</p>
      {checks.map((check) => {
        const icon =
          check.status === "pass" ? (
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
          ) : check.status === "fail" ? (
            <XCircle className="w-3.5 h-3.5 text-red-500 shrink-0" />
          ) : (
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
          );
        return (
          <div key={check.id} className="flex items-center gap-2 text-xs">
            {icon}
            <span className="text-slate-700">{check.label}</span>
            <span className="text-slate-400 ml-auto truncate max-w-[40%] text-right">{check.message}</span>
          </div>
        );
      })}
    </div>
  );
}

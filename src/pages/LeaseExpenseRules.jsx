/**
 * LeaseExpenseRules — portfolio-wide view of lease expense rules extracted
 * from approved leases. The single-lease editor remains
 * LeaseExpenseClassification; this page is the cross-lease audit and
 * approval surface backed by the existing rule-set tables.
 *
 * Rule rows come from lease_expense_rule_sets → lease_expense_rules →
 * lease_expense_values + lease_expense_rule_clauses via
 * leaseExpenseRuleService.loadRuleSets(). Per-row actions write back via
 * supabase directly so this page does not depend on the heavier draft/save
 * cycle in leaseExpenseRuleService.
 */
import React, { useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  Calculator,
  Check,
  Loader2,
  MinusCircle,
  Pencil,
  Receipt,
  Send,
  X,
} from "lucide-react";
import PageHeader from "@/components/PageHeader";
import ScopeSelector from "@/components/ScopeSelector";
import useOrgQuery from "@/hooks/useOrgQuery";
import {
  buildHierarchyScope,
  getScopeSubtitle,
  matchesHierarchyScope,
} from "@/lib/hierarchyScope";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { leaseExpenseRuleService } from "@/services/leaseExpenseRuleService";
import { supabase } from "@/services/supabaseClient";
import { createPageUrl } from "@/utils";

const ROW_STATUS_STYLE = {
  mapped: "bg-emerald-100 text-emerald-700",
  manually_added: "bg-blue-100 text-blue-700",
  needs_review: "bg-amber-100 text-amber-800",
  uncertain: "bg-amber-100 text-amber-800",
  unmapped: "bg-slate-100 text-slate-700",
  missing_value: "bg-red-100 text-red-700",
};

const ROW_STATUS_LABEL = {
  mapped: "Approved",
  manually_added: "Manually Added",
  needs_review: "Needs Review",
  uncertain: "Uncertain",
  unmapped: "Unmapped",
  missing_value: "Missing Value",
};

export default function LeaseExpenseRules() {
  const location = useLocation();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("all"); // all | recoverable | excluded | needs_review | approved
  const [search, setSearch] = useState("");

  const { data: leases = [] } = useOrgQuery("Lease");
  const { data: portfolios = [] } = useOrgQuery("Portfolio");
  const { data: properties = [] } = useOrgQuery("Property");
  const { data: buildings = [] } = useOrgQuery("Building");
  const { data: units = [] } = useOrgQuery("Unit");

  const { data: categories = [] } = useQuery({
    queryKey: ["expense-categories"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("expense_categories")
        .select("id, category_name, subcategory_name, normalized_key");
      if (error) {
        console.warn("[LeaseExpenseRules] categories query failed:", error.message);
        return [];
      }
      return data || [];
    },
  });

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

  const [scopeProperty, setScopeProperty] = useState(scope.propertyId || "all");
  const [scopeBuilding, setScopeBuilding] = useState(scope.buildingId || "all");
  const [scopeUnit, setScopeUnit] = useState(scope.unitId || "all");

  const scopedLeases = useMemo(
    () =>
      leases.filter((lease) =>
        matchesHierarchyScope(lease, scope, { propertyKey: "property_id", unitKey: "unit_id" }),
      ),
    [leases, scope]
  );

  const selectorFilteredLeases = scopedLeases.filter((lease) => {
    const unit = lease.unit_id ? scope.unitById.get(lease.unit_id) ?? null : null;
    const buildingId = unit?.building_id || null;
    if (scopeProperty !== "all" && lease.property_id !== scopeProperty) return false;
    if (scopeBuilding !== "all" && buildingId !== scopeBuilding) return false;
    if (scopeUnit !== "all" && lease.unit_id !== scopeUnit) return false;
    return true;
  });

  const leaseIds = selectorFilteredLeases.map((l) => l.id);

  const { data: ruleSetsByLease = [], isLoading } = useQuery({
    queryKey: ["lease-expense-rule-sets", leaseIds.join(",")],
    queryFn: () => leaseExpenseRuleService.loadRuleSets(leaseIds),
    enabled: leaseIds.length > 0,
  });

  const leaseById = useMemo(() => {
    const m = new Map();
    for (const l of leases) m.set(l.id, l);
    return m;
  }, [leases]);

  const categoryById = useMemo(() => {
    const m = new Map();
    for (const c of categories) m.set(c.id, c);
    return m;
  }, [categories]);

  const flattenedRows = useMemo(() => {
    const rows = [];
    for (const entry of ruleSetsByLease) {
      const lease = leaseById.get(entry.leaseId);
      const property = lease?.property_id ? scope.propertyById.get(lease.property_id) ?? null : null;
      for (const rule of entry.rules || []) {
        const category = rule.expense_category_id ? categoryById.get(rule.expense_category_id) : null;
        rows.push({
          rule,
          ruleSet: entry.ruleSet,
          lease,
          property,
          category,
        });
      }
    }
    return rows;
  }, [ruleSetsByLease, leaseById, categoryById, scope]);

  const filteredRows = flattenedRows.filter(({ rule, lease }) => {
    if (search) {
      const haystack = [
        lease?.tenant_name,
        rule.category_name,
        rule.subcategory_name,
        rule.notes,
        rule.source,
      ]
        .filter(Boolean)
        .map((v) => String(v).toLowerCase());
      if (!haystack.some((s) => s.includes(search.toLowerCase()))) return false;
    }
    if (statusFilter === "all") return true;
    if (statusFilter === "recoverable") return rule.is_recoverable && !rule.is_excluded;
    if (statusFilter === "excluded") return rule.is_excluded;
    if (statusFilter === "needs_review") return rule.row_status === "needs_review" || rule.row_status === "uncertain";
    if (statusFilter === "approved") return rule.row_status === "mapped" || rule.row_status === "manually_added";
    return true;
  });

  const counts = useMemo(() => {
    const c = {
      all: flattenedRows.length,
      recoverable: 0,
      excluded: 0,
      needs_review: 0,
      approved: 0,
    };
    for (const { rule } of flattenedRows) {
      if (rule.is_recoverable && !rule.is_excluded) c.recoverable += 1;
      if (rule.is_excluded) c.excluded += 1;
      if (rule.row_status === "needs_review" || rule.row_status === "uncertain") c.needs_review += 1;
      if (rule.row_status === "mapped" || rule.row_status === "manually_added") c.approved += 1;
    }
    return c;
  }, [flattenedRows]);

  // Direct rule updates — bypass the heavier saveRuleSet pipeline for per-row
  // actions. This is safe because we only flip status/recoverable/excluded
  // and the service layer will reconcile on the next saveRuleSet call.
  const updateRuleMutation = useMutation({
    mutationFn: async ({ ruleId, patch }) => {
      const { data, error } = await supabase
        .from("lease_expense_rules")
        .update(patch)
        .eq("id", ruleId)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["lease-expense-rule-sets"] });
    },
    onError: (err) => toast.error(err?.message || "Could not update rule"),
  });

  const approveRule = (rule) =>
    updateRuleMutation.mutateAsync({
      ruleId: rule.id,
      patch: { row_status: "mapped", is_excluded: false },
    }).then(() => toast.success("Rule approved"));

  const rejectRule = (rule) =>
    updateRuleMutation.mutateAsync({
      ruleId: rule.id,
      patch: { row_status: "needs_review", is_recoverable: false, is_excluded: true },
    }).then(() => toast.success("Rule rejected"));

  const markNARule = (rule) =>
    updateRuleMutation.mutateAsync({
      ruleId: rule.id,
      patch: { row_status: "unmapped", is_excluded: true, is_recoverable: false },
    }).then(() => toast.success("Rule marked N/A"));

  const subtitle = getScopeSubtitle(scope, {
    default: `${filteredRows.length} lease expense rule${filteredRows.length === 1 ? "" : "s"}`,
  });

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        icon={Receipt}
        title="Lease Expense Rules"
        subtitle={subtitle}
        iconColor="from-amber-500 to-orange-600"
      />

      <Card className="border-blue-200 bg-blue-50">
        <CardContent className="flex items-start gap-2 p-4 text-sm text-blue-800">
          <AlertTriangle className="mt-0.5 h-4 w-4" />
          <div>
            <p className="font-medium">Rules vs. Actuals</p>
            <p className="text-xs">
              Lease expense rules come from the lease document (responsibilities, recovery method,
              caps, gross-up, etc.). Actual expense dollars come from invoices, imports, or
              accounting integrations — see{" "}
              <Link to={createPageUrl("Expenses")} className="underline">
                Actual Expenses
              </Link>
              . CAM Setup and Budget consume only approved rules.
            </p>
          </div>
        </CardContent>
      </Card>

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

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatCard label="All Rules" value={counts.all} />
        <StatCard label="Recoverable" value={counts.recoverable} accent="border-l-emerald-500 bg-emerald-50" />
        <StatCard label="Excluded" value={counts.excluded} accent="border-l-slate-400 bg-slate-50" />
        <StatCard label="Needs Review" value={counts.needs_review} accent="border-l-amber-500 bg-amber-50" />
        <StatCard label="Approved" value={counts.approved} accent="border-l-blue-500 bg-blue-50" />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Input
          className="max-w-sm"
          placeholder="Search tenant, category, clause..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Tabs value={statusFilter} onValueChange={setStatusFilter}>
          <TabsList className="bg-white border">
            <TabsTrigger value="all" className="text-xs">All ({counts.all})</TabsTrigger>
            <TabsTrigger value="recoverable" className="text-xs">Recoverable ({counts.recoverable})</TabsTrigger>
            <TabsTrigger value="excluded" className="text-xs">Excluded ({counts.excluded})</TabsTrigger>
            <TabsTrigger value="needs_review" className="text-xs">Needs Review ({counts.needs_review})</TabsTrigger>
            <TabsTrigger value="approved" className="text-xs">Approved ({counts.approved})</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <Card>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-slate-50">
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Lease</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Property</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Category</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Responsibility</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Recoverable</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Recovery Method</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Allocation</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Cap</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Admin Fee</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Gross-Up</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Source</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Status</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={13} className="py-12 text-center">
                    <Loader2 className="mx-auto h-5 w-5 animate-spin text-slate-400" />
                  </TableCell>
                </TableRow>
              ) : filteredRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={13} className="py-12 text-center text-sm text-slate-400">
                    No lease expense rules in this view. Approve a lease abstract and run rule
                    extraction to populate this list.
                  </TableCell>
                </TableRow>
              ) : (
                filteredRows.map(({ rule, ruleSet, lease, property, category }) => {
                  const responsibility = rule.is_excluded
                    ? "Tenant pays directly"
                    : rule.is_recoverable
                    ? "Landlord (recoverable)"
                    : "Landlord";
                  const recoveryMethod =
                    rule.frequency === "monthly"
                      ? "Monthly billing"
                      : rule.has_base_year
                      ? "Base year"
                      : rule.is_subject_to_cap
                      ? "Capped"
                      : rule.is_recoverable
                      ? "Annual pass-through"
                      : "—";
                  const clause = (rule.clauses || [])[0];
                  return (
                    <TableRow key={rule.id} className="align-top hover:bg-slate-50">
                      <TableCell className="text-sm font-medium text-slate-900">
                        {lease ? (
                          <Link
                            to={createPageUrl("LeaseExpenseClassification") + `?id=${lease.id}`}
                            className="text-blue-600 hover:text-blue-700"
                          >
                            {lease.tenant_name || lease.id.slice(0, 8)}
                          </Link>
                        ) : (
                          "—"
                        )}
                        <p className="text-[10px] text-slate-400">
                          Rule set v{ruleSet?.version} · {ruleSet?.status}
                        </p>
                      </TableCell>
                      <TableCell className="text-sm text-slate-600">{property?.name || "—"}</TableCell>
                      <TableCell className="text-sm">
                        <div className="font-medium text-slate-900">
                          {rule.category_name || category?.category_name || "—"}
                        </div>
                        {(rule.subcategory_name || category?.subcategory_name) && (
                          <div className="text-[10px] text-slate-500">
                            {rule.subcategory_name || category?.subcategory_name}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-slate-700">{responsibility}</TableCell>
                      <TableCell>
                        <Badge className={`text-[10px] ${rule.is_recoverable && !rule.is_excluded ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>
                          {rule.is_excluded ? "No" : rule.is_recoverable ? "Yes" : "No"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-slate-700">{recoveryMethod}</TableCell>
                      <TableCell className="text-sm text-slate-700">
                        {rule.is_recoverable ? "Pro-rata" : "—"}
                      </TableCell>
                      <TableCell className="text-sm text-slate-700">
                        {rule.is_subject_to_cap ? (rule.cap_percent ? `${rule.cap_percent}%` : "Yes") : "—"}
                      </TableCell>
                      <TableCell className="text-sm text-slate-700">
                        {rule.admin_fee_applicable ? (rule.admin_fee_percent ? `${rule.admin_fee_percent}%` : "Yes") : "—"}
                      </TableCell>
                      <TableCell className="text-sm text-slate-700">
                        {rule.gross_up_applicable ? (rule.gross_up_percent ? `${rule.gross_up_percent}%` : "Yes") : "—"}
                      </TableCell>
                      <TableCell className="max-w-[260px] text-xs text-slate-600">
                        {clause?.page_number ? (
                          <div>
                            <span className="font-semibold text-slate-500">p. {clause.page_number}</span>{" "}
                            <span className="italic">"{(clause.clause_text || "").slice(0, 140)}{clause.clause_text?.length > 140 ? "…" : ""}"</span>
                          </div>
                        ) : rule.source ? (
                          <span className="italic">"{String(rule.source).slice(0, 140)}{String(rule.source).length > 140 ? "…" : ""}"</span>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge className={`text-[10px] ${ROW_STATUS_STYLE[rule.row_status] || "bg-slate-100 text-slate-700"}`}>
                          {ROW_STATUS_LABEL[rule.row_status] || rule.row_status || "—"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs text-emerald-700 hover:text-emerald-800"
                            onClick={() => approveRule(rule)}
                            disabled={updateRuleMutation.isPending}
                          >
                            <Check className="mr-1 h-3.5 w-3.5" />
                            Approve
                          </Button>
                          {lease && (
                            <Link to={createPageUrl("LeaseExpenseClassification") + `?id=${lease.id}`}>
                              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs">
                                <Pencil className="mr-1 h-3.5 w-3.5" />
                                Edit
                              </Button>
                            </Link>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs text-red-700 hover:text-red-800"
                            onClick={() => rejectRule(rule)}
                            disabled={updateRuleMutation.isPending}
                          >
                            <X className="mr-1 h-3.5 w-3.5" />
                            Reject
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs text-slate-600"
                            onClick={() => markNARule(rule)}
                            disabled={updateRuleMutation.isPending}
                          >
                            <MinusCircle className="mr-1 h-3.5 w-3.5" />
                            N/A
                          </Button>
                          {lease?.property_id && (
                            <Link to={createPageUrl("CAMSetup") + `?property=${lease.property_id}`}>
                              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-blue-700 hover:text-blue-800">
                                <Send className="mr-1 h-3.5 w-3.5" />
                                Publish to CAM
                              </Button>
                            </Link>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </Card>

      <p className="text-xs text-slate-500">
        Looking for actual expense rows (invoices, imports, vendor bills)? Go to{" "}
        <Link to={createPageUrl("Expenses")} className="underline">Actual Expenses</Link>. Looking for
        CAM recovery setup? Go to <Link to={createPageUrl("CAMSetup")} className="underline">CAM Setup</Link>.
      </p>

      <Card className="border-slate-200 bg-slate-50">
        <CardContent className="flex flex-wrap items-center justify-between gap-2 p-4 text-sm">
          <span className="text-slate-600">
            <Calculator className="mr-1 inline h-4 w-4 text-slate-500" />
            Approved lease expense rules feed CAM Setup and Recovery Budget.
          </span>
          <Link to={createPageUrl("CAMDashboard")} className="text-blue-600 hover:text-blue-700">
            Go to CAM Dashboard →
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({ label, value, accent }) {
  return (
    <Card className={accent ? `border-l-4 ${accent}` : ""}>
      <CardContent className="p-4">
        <p className="text-2xl font-bold text-slate-900">{value}</p>
        <p className="text-xs font-medium text-slate-500">{label}</p>
      </CardContent>
    </Card>
  );
}

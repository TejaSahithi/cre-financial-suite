/**
 * BudgetPreviewTabs — read-only Revenue / Expense / Recovery previews
 * derived strictly from approved lease data, approved expense rules, and
 * approved CAM V2 recovery policies. Surfaced as a tab inside the Budget Studio's
 * Create Budget page so reviewers can sanity-check the inputs before
 * generating a budget draft.
 *
 * No writes here. The actual budget generation is handled by the existing
 * Generate Budget tab and downstream BudgetService.
 */
import React, { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Tabs,
  TabsContent,
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
import useOrgQuery from "@/hooks/useOrgQuery";
import { supabase } from "@/services/supabaseClient";

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function fmtCurrency(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return "—";
  return `$${Math.round(n).toLocaleString()}`;
}

function isApprovedLease(lease) {
  const abstract = String(lease?.abstract_status || "").toLowerCase();
  if (abstract === "approved") return true;
  // Legacy: rows that pre-date the abstract_status migration.
  return String(lease?.status || "").toLowerCase() === "approved";
}

function camInputAmount(row) {
  return Number(row?.eligible_amount ?? row?.actual_amount ?? row?.amount ?? 0) || 0;
}

function camInputYear(row, fallbackYear) {
  if (Number.isFinite(Number(row?.fiscal_year))) return Number(row.fiscal_year);
  const dateValue = row?.service_period_start || row?.service_period_end || row?.sent_to_cam_at || row?.created_at;
  if (!dateValue) return fallbackYear;
  const date = new Date(String(dateValue).length === 10 ? `${dateValue}T00:00:00` : dateValue);
  return Number.isNaN(date.getTime()) ? fallbackYear : date.getFullYear();
}

function camInputCategory(row) {
  return row?.category || "Other";
}

export default function BudgetPreviewTabs({ propertyId, budgetYear }) {
  const year = Number(budgetYear) || new Date().getFullYear();
  const { data: leases = [] } = useOrgQuery("Lease");

  // Approved leases scoped to the budget property.
  const approvedLeases = useMemo(() => {
    return (leases || []).filter((lease) => {
      if (!isApprovedLease(lease)) return false;
      if (propertyId && lease.property_id !== propertyId) return false;
      return true;
    });
  }, [leases, propertyId]);

  const leaseIds = approvedLeases.map((l) => l.id);

  // Recovery policies for approved leases — drives Recovery preview. Pro-rata
  // share lives on a CALCULATE_SHARE policy step's parameters, not a flat
  // column, since CAM V2 policies are materialized directly from approved
  // Lease Expense Rules.
  const { data: recoveryPolicies = [] } = useQuery({
    queryKey: ["budget-preview-recovery-policies", leaseIds.join(",")],
    queryFn: async () => {
      if (leaseIds.length === 0) return [];
      const { data, error } = await supabase
        .from("lease_recovery_policies")
        .select("id, lease_id, status, policy_type, lease_recovery_policy_steps(step_type, parameters)")
        .in("lease_id", leaseIds);
      if (error) {
        console.warn("[BudgetPreviewTabs] recovery policy query failed:", error.message);
        return [];
      }
      return data || [];
    },
    enabled: leaseIds.length > 0,
  });

  // Published CAM inputs only. Budget preview must not reinterpret raw
  // classifications as CAM recovery; classification decides eligibility,
  // explicit Send to CAM creates the published input consumed here.
  const { data: publishedCamInputs = [] } = useQuery({
    queryKey: ["budget-preview-published-cam-inputs", propertyId, year],
    queryFn: async () => {
      if (!propertyId) return [];
      const { data, error } = await supabase
        .from("cam_expense_inputs")
        .select("id, category, amount, actual_amount, eligible_amount, fiscal_year, service_period_start, service_period_end, sent_to_cam_at, created_at, publication_status, status")
        .eq("property_id", propertyId)
        .eq("publication_status", "published");
      if (error) {
        console.warn("[BudgetPreviewTabs] published CAM input query failed:", error.message);
        return [];
      }
      return (data || []).filter((row) => camInputYear(row, year) === year);
    },
    enabled: !!propertyId,
  });

  const revenueRows = useMemo(() => {
    return approvedLeases.map((lease) => {
      const monthlyRent = Number(lease.monthly_rent || (lease.annual_rent ? lease.annual_rent / 12 : 0)) || 0;
      const escalation = Number(lease.escalation_rate || 0) / 100;
      const months = MONTHS.map((label) => {
        // Apply escalation once per year crossing past Jan if lease anniversary
        // falls inside the budget year. Conservative: no escalation in preview
        // unless the budget year is past the start.
        const startYear = lease.start_date ? new Date(lease.start_date).getFullYear() : year;
        const yearsIn = Math.max(0, year - startYear);
        return {
          label,
          rent: monthlyRent * Math.pow(1 + escalation, yearsIn),
        };
      });
      const total = months.reduce((sum, m) => sum + m.rent, 0);
      return { lease, monthlyRent, escalation, months, total };
    });
  }, [approvedLeases, year]);

  const totalRevenue = revenueRows.reduce((sum, r) => sum + r.total, 0);

  const expenseRows = useMemo(() => {
    // Group published CAM inputs by category to seed the CAM expense budget baseline.
    const grouped = new Map();
    for (const e of publishedCamInputs) {
      const key = camInputCategory(e);
      const existing = grouped.get(key) || { category: key, recoverable: 0, nonRecoverable: 0, total: 0 };
      const amount = camInputAmount(e);
      existing.total += amount;
      existing.recoverable += amount;
      grouped.set(key, existing);
    }
    return [...grouped.values()].sort((a, b) => b.total - a.total);
  }, [publishedCamInputs]);

  const totalExpense = expenseRows.reduce((sum, r) => sum + r.total, 0);
  const totalRecoverableExpense = expenseRows.reduce((sum, r) => sum + r.recoverable, 0);

  const recoveryRows = useMemo(() => {
    // A lease may have multiple policies (multi-pool, or draft/superseded
    // history) — prefer the approved one(s); take the first CALCULATE_SHARE
    // step's tenant_share_percent as the representative pro-rata figure, a
    // single flat percentage per lease for this estimate-only preview.
    const policiesByLease = new Map();
    for (const policy of recoveryPolicies) {
      const list = policiesByLease.get(policy.lease_id) || [];
      list.push(policy);
      policiesByLease.set(policy.lease_id, list);
    }
    return approvedLeases.map((lease) => {
      const policies = policiesByLease.get(lease.id) || [];
      const policy = policies.find((p) => p.status === "approved") || policies[0] || null;
      const shareStep = policy?.lease_recovery_policy_steps?.find((s) => s.step_type === "CALCULATE_SHARE") || null;
      const proRata = shareStep?.parameters?.tenant_share_percent != null ? Number(shareStep.parameters.tenant_share_percent) / 100 : null;
      // Recovery preview applies tenant pro-rata share to the property's
      // total recoverable expense baseline, regardless of policy approval
      // state — only the readiness badge below gates on approval.
      const annualRecovery = proRata != null ? totalRecoverableExpense * proRata : null;
      const recoveryMethod = policy?.policy_type || (proRata != null ? "Pro-rata" : "—");
      const policyReady = policy?.status === "approved";
      return {
        lease,
        policy,
        proRata,
        annualRecovery,
        monthlyRecovery: annualRecovery != null ? annualRecovery / 12 : null,
        recoveryMethod,
        profileReady: policyReady,
      };
    });
  }, [approvedLeases, recoveryPolicies, totalRecoverableExpense]);

  const totalAnnualRecovery = recoveryRows.reduce((sum, r) => sum + (r.annualRecovery || 0), 0);

  return (
    <div className="space-y-4">
      <Card className="border-blue-200 bg-blue-50">
        <CardContent className="p-4 text-sm text-blue-800">
          <p className="font-medium">Preview reads approved data only</p>
          <p className="text-xs">
            Revenue comes from approved lease abstracts. Expense baseline comes from published CAM inputs for the property. Recovery uses approved CAM Setup profiles. None of these
            tables are edited from this page — use the upstream review pages to make corrections.
          </p>
        </CardContent>
      </Card>

      <Tabs defaultValue="revenue">
        <TabsList className="bg-white border">
          <TabsTrigger value="revenue" className="text-xs">Revenue Budget</TabsTrigger>
          <TabsTrigger value="expense" className="text-xs">Expense Budget</TabsTrigger>
          <TabsTrigger value="recovery" className="text-xs">Recovery Budget</TabsTrigger>
        </TabsList>

        <TabsContent value="revenue" className="mt-4 space-y-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Revenue Budget — FY {year}</CardTitle>
              <p className="text-xs text-slate-500">
                Generated from {approvedLeases.length} approved lease abstract(s){propertyId ? " for this property" : ""}.
                Total projected revenue: <span className="font-semibold text-slate-900">{fmtCurrency(totalRevenue)}</span>.
              </p>
            </CardHeader>
            <CardContent>
              {revenueRows.length === 0 ? (
                <p className="py-6 text-center text-sm text-slate-500">
                  No approved leases yet{propertyId ? " for this property" : ""}. Approve lease abstracts to populate revenue.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-slate-50">
                        <TableHead className="text-[10px] uppercase">Tenant</TableHead>
                        <TableHead className="text-[10px] uppercase">Lease Type</TableHead>
                        <TableHead className="text-right text-[10px] uppercase">Monthly Rent</TableHead>
                        <TableHead className="text-right text-[10px] uppercase">Escalation</TableHead>
                        <TableHead className="text-right text-[10px] uppercase">Annual Revenue</TableHead>
                        <TableHead className="text-[10px] uppercase">Source</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {revenueRows.map(({ lease, monthlyRent, escalation, total }) => (
                        <TableRow key={lease.id}>
                          <TableCell className="text-sm font-medium">{lease.tenant_name || "—"}</TableCell>
                          <TableCell className="text-sm text-slate-600">{lease.lease_type || "—"}</TableCell>
                          <TableCell className="text-right text-sm font-mono">{fmtCurrency(monthlyRent)}</TableCell>
                          <TableCell className="text-right text-sm">{escalation ? `${(escalation * 100).toFixed(2)}%` : "—"}</TableCell>
                          <TableCell className="text-right text-sm font-mono">{fmtCurrency(total)}</TableCell>
                          <TableCell>
                            <Badge className="text-[10px] bg-emerald-100 text-emerald-700">
                              Approved Lease v{lease.abstract_version || 1}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="expense" className="mt-4 space-y-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Expense Budget — FY {year}</CardTitle>
              <p className="text-xs text-slate-500">
                Baseline grouped by category from {publishedCamInputs.length} published CAM input record(s). Total: <span className="font-semibold text-slate-900">{fmtCurrency(totalExpense)}</span> ·
                Recoverable: <span className="font-semibold text-slate-900">{fmtCurrency(totalRecoverableExpense)}</span>.
              </p>
            </CardHeader>
            <CardContent>
              {!propertyId ? (
                <p className="py-6 text-center text-sm text-slate-500">
                  Select a property to see the expense budget baseline.
                </p>
              ) : expenseRows.length === 0 ? (
                <p className="py-6 text-center text-sm text-slate-500">
                  No published CAM inputs for FY {year}. Finalize classifications and explicitly send eligible rows to CAM before budgeting.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-slate-50">
                        <TableHead className="text-[10px] uppercase">Category</TableHead>
                        <TableHead className="text-right text-[10px] uppercase">Recoverable</TableHead>
                        <TableHead className="text-right text-[10px] uppercase">Non-Recoverable</TableHead>
                        <TableHead className="text-right text-[10px] uppercase">Total</TableHead>
                        <TableHead className="text-[10px] uppercase">Source</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {expenseRows.map((row) => (
                        <TableRow key={row.category}>
                          <TableCell className="text-sm font-medium">{row.category}</TableCell>
                          <TableCell className="text-right text-sm font-mono">{fmtCurrency(row.recoverable)}</TableCell>
                          <TableCell className="text-right text-sm font-mono">{fmtCurrency(row.nonRecoverable)}</TableCell>
                          <TableCell className="text-right text-sm font-mono">{fmtCurrency(row.total)}</TableCell>
                          <TableCell>
                            <Badge className="text-[10px] bg-blue-100 text-blue-700">Published CAM Input</Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="recovery" className="mt-4 space-y-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Recovery Budget — FY {year}</CardTitle>
              <p className="text-xs text-slate-500">
                Tenant recoveries projected from approved CAM profiles x published CAM input
                baseline. Annual total:{" "}
                <span className="font-semibold text-slate-900">{fmtCurrency(totalAnnualRecovery)}</span>.
              </p>
            </CardHeader>
            <CardContent>
              {recoveryRows.length === 0 ? (
                <p className="py-6 text-center text-sm text-slate-500">
                  No approved leases yet. Approve lease abstracts to populate recovery rows.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-slate-50">
                        <TableHead className="text-[10px] uppercase">Tenant</TableHead>
                        <TableHead className="text-[10px] uppercase">Recovery Method</TableHead>
                        <TableHead className="text-right text-[10px] uppercase">Pro-Rata</TableHead>
                        <TableHead className="text-right text-[10px] uppercase">Annual Recovery</TableHead>
                        <TableHead className="text-right text-[10px] uppercase">Monthly Recovery</TableHead>
                        <TableHead className="text-[10px] uppercase">CAM Setup Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {recoveryRows.map(({ lease, recoveryMethod, proRata, annualRecovery, monthlyRecovery, policy, profileReady }) => (
                        <TableRow key={lease.id}>
                          <TableCell className="text-sm font-medium">{lease.tenant_name || "—"}</TableCell>
                          <TableCell className="text-sm text-slate-600">{recoveryMethod}</TableCell>
                          <TableCell className="text-right text-sm">
                            {proRata != null ? `${(proRata * 100).toFixed(2)}%` : "—"}
                          </TableCell>
                          <TableCell className="text-right text-sm font-mono">
                            {annualRecovery != null ? fmtCurrency(annualRecovery) : "—"}
                          </TableCell>
                          <TableCell className="text-right text-sm font-mono">
                            {monthlyRecovery != null ? fmtCurrency(monthlyRecovery) : "—"}
                          </TableCell>
                          <TableCell>
                            <Badge
                              className={`text-[10px] ${
                                profileReady
                                  ? "bg-emerald-100 text-emerald-700"
                                  : policy
                                  ? "bg-amber-100 text-amber-800"
                                  : "bg-slate-100 text-slate-600"
                              }`}
                            >
                              {profileReady ? "Approved" : policy?.status || "No policy"}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

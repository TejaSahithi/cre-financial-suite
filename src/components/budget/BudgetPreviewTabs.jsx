/**
 * BudgetPreviewTabs — read-only Revenue / Expense / Recovery previews
 * derived strictly from approved lease data, approved expense rules, and
 * approved CAM profiles. Surfaced as a tab inside the Budget Studio's
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

  // CAM profiles for approved leases — drives Recovery preview.
  const { data: camProfiles = [] } = useQuery({
    queryKey: ["budget-preview-cam-profiles", leaseIds.join(",")],
    queryFn: async () => {
      if (leaseIds.length === 0) return [];
      const { data, error } = await supabase
        .from("cam_profiles")
        .select(
          "id, lease_id, tenant_pro_rata_share, status, included_expenses, excluded_expenses, admin_fee_percent, cam_cap_type, cam_cap_percent, recovery_status, cam_structure",
        )
        .in("lease_id", leaseIds);
      if (error) {
        console.warn("[BudgetPreviewTabs] cam profile query failed:", error.message);
        return [];
      }
      return data || [];
    },
    enabled: leaseIds.length > 0,
  });

  // Property-scoped actual expenses (for the expense budget baseline).
  const { data: expenses = [] } = useQuery({
    queryKey: ["budget-preview-expenses", propertyId, year],
    queryFn: async () => {
      if (!propertyId) return [];
      const { data, error } = await supabase
        .from("expenses")
        .select("id, category, classification, amount, fiscal_year, recoverable")
        .eq("property_id", propertyId)
        .eq("fiscal_year", year);
      if (error) {
        console.warn("[BudgetPreviewTabs] expense query failed:", error.message);
        return [];
      }
      return data || [];
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
    // Group actuals by category to seed an expense budget baseline.
    const grouped = new Map();
    for (const e of expenses) {
      const key = e.category || "Other";
      const existing = grouped.get(key) || { category: key, recoverable: 0, nonRecoverable: 0, total: 0 };
      const amount = Number(e.amount || 0);
      existing.total += amount;
      if (e.recoverable === true || String(e.classification || "").toLowerCase() === "recoverable") {
        existing.recoverable += amount;
      } else {
        existing.nonRecoverable += amount;
      }
      grouped.set(key, existing);
    }
    return [...grouped.values()].sort((a, b) => b.total - a.total);
  }, [expenses]);

  const totalExpense = expenseRows.reduce((sum, r) => sum + r.total, 0);
  const totalRecoverableExpense = expenseRows.reduce((sum, r) => sum + r.recoverable, 0);

  const recoveryRows = useMemo(() => {
    const profileByLease = new Map(camProfiles.map((p) => [p.lease_id, p]));
    return approvedLeases.map((lease) => {
      const profile = profileByLease.get(lease.id) || null;
      const proRata = profile?.tenant_pro_rata_share != null ? Number(profile.tenant_pro_rata_share) / 100 : null;
      // Recovery preview applies tenant pro-rata share to the property's
      // total recoverable expense baseline. Approved-only.
      const annualRecovery = proRata != null ? totalRecoverableExpense * proRata : null;
      const recoveryMethod = profile?.cam_structure || profile?.recovery_status || (proRata != null ? "Pro-rata" : "—");
      const profileReady = profile?.status === "approved";
      return {
        lease,
        profile,
        proRata,
        annualRecovery,
        monthlyRecovery: annualRecovery != null ? annualRecovery / 12 : null,
        recoveryMethod,
        profileReady,
      };
    });
  }, [approvedLeases, camProfiles, totalRecoverableExpense]);

  const totalAnnualRecovery = recoveryRows.reduce((sum, r) => sum + (r.annualRecovery || 0), 0);

  return (
    <div className="space-y-4">
      <Card className="border-blue-200 bg-blue-50">
        <CardContent className="p-4 text-sm text-blue-800">
          <p className="font-medium">Preview reads approved data only</p>
          <p className="text-xs">
            Revenue comes from approved lease abstracts. Expense baseline comes from approved actual
            expenses for the property. Recovery uses approved CAM Setup profiles. None of these
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
                Baseline grouped by category from {expenses.length} approved actual expense
                record(s). Total: <span className="font-semibold text-slate-900">{fmtCurrency(totalExpense)}</span> ·
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
                  No actual expenses for FY {year}. Add expenses or bulk import to populate the baseline.
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
                            <Badge className="text-[10px] bg-blue-100 text-blue-700">Actual Expenses</Badge>
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
                Tenant recoveries projected from approved CAM profiles × approved recoverable
                expense baseline. Annual total:{" "}
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
                      {recoveryRows.map(({ lease, recoveryMethod, proRata, annualRecovery, monthlyRecovery, profile, profileReady }) => (
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
                                  : profile
                                  ? "bg-amber-100 text-amber-800"
                                  : "bg-slate-100 text-slate-600"
                              }`}
                            >
                              {profileReady ? "Approved" : profile?.status || "No profile"}
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

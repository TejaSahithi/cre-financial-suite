import React, { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { supabase } from "@/services/supabaseClient";
import { createPageUrl } from "@/utils";
import { ArrowUpRight, Loader2 } from "lucide-react";

const dollars = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return n === 0 ? "$0" : `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
};

function formatDate(value) {
  if (!value) return "—";
  return String(value).slice(0, 10);
}

// ─── Rent Schedule ────────────────────────────────────────────────────
export function RentScheduleTable({ leaseId }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["rent-schedule-rows", leaseId],
    enabled: !!leaseId && !!supabase,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rent_schedules")
        .select("*")
        .eq("lease_id", leaseId)
        .order("period_start", { ascending: true });
      if (error) throw error;
      return data || [];
    },
    retry: false,
  });

  const rows = data || [];
  const tableMissing = error && /does not exist|rent_schedules/i.test(error?.message || "");

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 pb-2">
        <div>
          <CardTitle className="text-base">Rent Schedule</CardTitle>
          <p className="text-xs text-slate-500">
            Approved rent rows feed Rent Projection and Billing. Source: <code>rent_schedules</code>.
          </p>
        </div>
        <Badge className="bg-slate-100 text-slate-700">{rows.length} rows</Badge>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading rent schedule…
          </div>
        ) : tableMissing ? (
          <p className="text-sm text-amber-700">
            rent_schedules table is not present in this environment. Approve the lease to generate rows.
          </p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-slate-500">
            No approved rent schedule rows yet. Approving the lease abstract will generate them.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-slate-200">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Period</TableHead>
                  <TableHead className="text-xs">Row Type</TableHead>
                  <TableHead className="text-xs">Phase</TableHead>
                  <TableHead className="text-xs text-right">Monthly</TableHead>
                  <TableHead className="text-xs text-right">Annual</TableHead>
                  <TableHead className="text-xs text-right">$/SF</TableHead>
                  <TableHead className="text-xs">Escalation</TableHead>
                  <TableHead className="text-xs">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="text-xs">
                      {formatDate(row.period_start)} → {formatDate(row.period_end)}
                    </TableCell>
                    <TableCell className="text-xs">{row.row_type}</TableCell>
                    <TableCell className="text-xs">
                      <Badge className="bg-slate-100 text-[10px] text-slate-700">{row.phase}</Badge>
                    </TableCell>
                    <TableCell className="text-right text-xs">{dollars(row.monthly_amount)}</TableCell>
                    <TableCell className="text-right text-xs">{dollars(row.annual_amount)}</TableCell>
                    <TableCell className="text-right text-xs">
                      {row.rent_per_sf ? dollars(row.rent_per_sf) : "—"}
                    </TableCell>
                    <TableCell className="text-xs">
                      {row.escalation_type
                        ? `${row.escalation_type}${row.escalation_rate != null ? ` @ ${row.escalation_rate}%` : ""}`
                        : "—"}
                    </TableCell>
                    <TableCell className="text-xs">
                      <Badge
                        className={`text-[10px] ${
                          row.status === "approved"
                            ? "bg-emerald-100 text-emerald-700"
                            : "bg-slate-100 text-slate-700"
                        }`}
                      >
                        {row.status}
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
  );
}

// ─── Expense Rules / CAM Rules ────────────────────────────────────────
function useLeaseExpenseRules(leaseId) {
  return useQuery({
    queryKey: ["lease-expense-rules-detail", leaseId],
    enabled: !!leaseId && !!supabase,
    queryFn: async () => {
      const { data: sets, error: setsErr } = await supabase
        .from("lease_expense_rule_sets")
        .select("id, status, version, approved_at")
        .eq("lease_id", leaseId)
        .neq("status", "archived")
        .order("version", { ascending: false })
        .limit(1);
      if (setsErr) throw setsErr;
      const ruleSet = sets?.[0] || null;
      if (!ruleSet) return { ruleSet: null, rules: [] };
      const { data: rules, error: rulesErr } = await supabase
        .from("lease_expense_rules")
        .select("*, expense_categories:expense_category_id (category_name, subcategory_name)")
        .eq("rule_set_id", ruleSet.id);
      if (rulesErr) throw rulesErr;
      return { ruleSet, rules: rules || [] };
    },
    retry: false,
  });
}

function isCamRule(rule) {
  return Boolean(
    rule?.gross_up_applicable || rule?.is_subject_to_cap || rule?.cap_type || rule?.admin_fee_applicable,
  );
}

function ExpenseRuleSubsetTable({ leaseId, kind }) {
  const navigate = useNavigate();
  const { data, isLoading, error } = useLeaseExpenseRules(leaseId);
  const ruleSet = data?.ruleSet || null;
  const rules = useMemo(() => {
    const all = data?.rules || [];
    return kind === "cam" ? all.filter(isCamRule) : all.filter((r) => !isCamRule(r));
  }, [data, kind]);
  const title = kind === "cam" ? "CAM Rules" : "Expense Rules";
  const tableMissing = error && /lease_expense/i.test(error?.message || "");

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 pb-2">
        <div>
          <CardTitle className="text-base">{title}</CardTitle>
          <p className="text-xs text-slate-500">
            Source: <code>lease_expense_rules</code>
            {ruleSet ? ` · v${ruleSet.version} · ${ruleSet.status}` : " · no rule set yet"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge className="bg-slate-100 text-slate-700">{rules.length}</Badge>
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate(createPageUrl("LeaseExpenseClassification", { id: leaseId }))}
          >
            <ArrowUpRight className="mr-1 h-3.5 w-3.5" />
            Review {kind === "cam" ? "CAM" : "Expense"} Rules
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : tableMissing ? (
          <p className="text-sm text-amber-700">
            lease_expense_rules table is not available in this environment.
          </p>
        ) : rules.length === 0 ? (
          <p className="text-sm text-slate-500">
            No {kind === "cam" ? "CAM" : "expense"} rules extracted yet. Run the Expense Rules workflow.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-slate-200">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Category</TableHead>
                  <TableHead className="text-xs">Status</TableHead>
                  <TableHead className="text-xs">Recoverable</TableHead>
                  {kind === "cam" && <TableHead className="text-xs">Cap</TableHead>}
                  {kind === "cam" && <TableHead className="text-xs">Admin Fee</TableHead>}
                  {kind === "cam" && <TableHead className="text-xs">Gross-up</TableHead>}
                  <TableHead className="text-xs text-right">Confidence</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rules.map((rule) => (
                  <TableRow key={rule.id}>
                    <TableCell className="text-xs font-medium text-slate-700">
                      {rule.expense_categories?.subcategory_name || rule.expense_categories?.category_name || rule.expense_category_id}
                    </TableCell>
                    <TableCell className="text-xs">
                      <Badge className="bg-slate-100 text-[10px] text-slate-700">{rule.row_status || "needs_review"}</Badge>
                    </TableCell>
                    <TableCell className="text-xs">{rule.is_recoverable ? "Yes" : rule.is_excluded ? "Excluded" : "No"}</TableCell>
                    {kind === "cam" && (
                      <TableCell className="text-xs">
                        {rule.is_subject_to_cap ? `${rule.cap_type || ""} ${rule.cap_value ?? ""}` : "—"}
                      </TableCell>
                    )}
                    {kind === "cam" && (
                      <TableCell className="text-xs">
                        {rule.admin_fee_applicable ? `${rule.admin_fee_percent ?? 0}%` : "—"}
                      </TableCell>
                    )}
                    {kind === "cam" && (
                      <TableCell className="text-xs">{rule.gross_up_applicable ? "Yes" : "—"}</TableCell>
                    )}
                    <TableCell className="text-right text-xs">
                      {rule.confidence != null ? `${Math.round(Number(rule.confidence))}%` : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function ExpenseRulesTable({ leaseId }) {
  return <ExpenseRuleSubsetTable leaseId={leaseId} kind="expense" />;
}

export function CamRulesTable({ leaseId }) {
  return <ExpenseRuleSubsetTable leaseId={leaseId} kind="cam" />;
}

// ─── Critical Dates ───────────────────────────────────────────────────
export function CriticalDatesTable({ lease }) {
  const rows = [
    { label: "Lease Date (signed)", value: lease?.lease_date },
    { label: "Commencement Date", value: lease?.commencement_date || lease?.start_date },
    { label: "Rent Commencement Date", value: lease?.rent_commencement_date },
    { label: "Expiration Date", value: lease?.expiration_date || lease?.end_date },
    { label: "Renewal Notice (months)", value: lease?.renewal_notice_months },
    { label: "Termination Notice (months)", value: lease?.termination_notice_months },
    { label: "Option Exercise Deadline", value: lease?.option_exercise_deadline },
  ].filter((row) => row.value !== undefined && row.value !== null && row.value !== "");

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Critical Dates</CardTitle>
        <p className="text-xs text-slate-500">
          Derived from the lease abstract. Used by Critical Dates module and Billing.
        </p>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-slate-500">No critical dates captured yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-slate-200">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Date Field</TableHead>
                  <TableHead className="text-xs">Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.label}>
                    <TableCell className="text-xs text-slate-700">{row.label}</TableCell>
                    <TableCell className="text-xs font-medium text-slate-900">{formatDate(row.value)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

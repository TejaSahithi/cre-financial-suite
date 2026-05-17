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

// Predefined enterprise rule checklists. When the extractor returns zero
// rules, we still render a row per category so reviewers know what _should_
// be captured from lease language even when no dollar amount exists.
const PREDEFINED_EXPENSE_CATEGORIES = [
  "Real Estate Taxes",
  "Insurance",
  "Utilities — Electric",
  "Utilities — Gas",
  "Utilities — Water / Sewer",
  "Trash / Janitorial",
  "Repairs & Maintenance",
  "HVAC Maintenance",
  "Landscaping",
  "Snow Removal",
  "Security",
  "Property Management",
  "Capital Expenditures",
  "Legal / Professional Fees",
];

const PREDEFINED_CAM_CATEGORIES = [
  "CAM Pool (general)",
  "Gross-up Provision",
  "Cap (Cumulative / Non-cumulative)",
  "Admin Fee",
  "Management Fee",
  "Base Year",
  "Expense Stop",
  "Controllable vs Non-controllable split",
  "Exclusions from CAM",
];

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
          <div className="space-y-2">
            <p className="text-sm text-slate-500">
              No {kind === "cam" ? "CAM" : "expense"} rules extracted yet. The checklist below shows what should be captured from lease language — open “Review {kind === "cam" ? "CAM" : "Expense"} Rules” to extract rules even when no dollar amount is present.
            </p>
            <div className="overflow-x-auto rounded-md border border-slate-200">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Category</TableHead>
                    <TableHead className="w-[140px] text-xs">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(kind === "cam" ? PREDEFINED_CAM_CATEGORIES : PREDEFINED_EXPENSE_CATEGORIES).map((cat) => (
                    <TableRow key={cat}>
                      <TableCell className="text-xs text-slate-700">{cat}</TableCell>
                      <TableCell>
                        <Badge className="bg-amber-50 text-[10px] text-amber-700">Not Found</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
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

// ─── Clause Records ───────────────────────────────────────────────────
// Reads from `lease_clauses` (populated by review-approve from the workflow
// output). Falls back to extraction_data.lease_clauses on the lease record
// when the table isn't present. Always renders the predefined clause
// checklist so reviewers see what _should_ be captured even when extraction
// didn't return a value.
const STANDARD_CLAUSE_TYPES = [
  { key: "use_clause", label: "Use / Permitted Use" },
  { key: "rent_clause", label: "Rent & Escalation" },
  { key: "security_deposit", label: "Security Deposit" },
  { key: "expense_recovery", label: "Operating Expense Recovery" },
  { key: "cam_clause", label: "CAM / Recoveries" },
  { key: "insurance", label: "Insurance Requirements" },
  { key: "indemnification", label: "Indemnification" },
  { key: "default_remedies", label: "Default & Remedies" },
  { key: "late_fees", label: "Late Fees" },
  { key: "renewal_option", label: "Renewal Option" },
  { key: "termination", label: "Termination / Early Out" },
  { key: "assignment_subletting", label: "Assignment & Subletting" },
  { key: "repairs_maintenance", label: "Repairs & Maintenance" },
  { key: "alterations", label: "Alterations / Improvements" },
  { key: "holdover", label: "Holdover" },
  { key: "subordination", label: "Subordination / SNDA" },
  { key: "notices", label: "Notices" },
  { key: "estoppel", label: "Estoppel Certificates" },
  { key: "broker_commission", label: "Broker / Commission" },
  { key: "guaranty", label: "Guaranty" },
];

export function ClauseRecordsTable({ lease }) {
  const leaseId = lease?.id;
  const { data: dbClauses, isLoading, error } = useQuery({
    queryKey: ["lease-clauses", leaseId],
    enabled: !!leaseId && !!supabase,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("lease_clauses")
        .select("id, clause_type, clause_title, clause_text, source_page, confidence_score, structured_fields_json")
        .eq("lease_id", leaseId)
        .order("clause_type", { ascending: true });
      if (error) throw error;
      return data || [];
    },
    retry: false,
  });

  const tableMissing = error && /lease_clauses/i.test(error?.message || "");

  // Combine DB rows with extraction_data fallback so we never lose extracted
  // clause text just because the table isn't deployed yet.
  const fallbackClauses = useMemo(() => {
    const fromWorkflow = lease?.extraction_data?.workflow_output?.lease_clauses;
    const fromTopLevel = lease?.extraction_data?.lease_clauses;
    const list = Array.isArray(fromWorkflow) ? fromWorkflow : Array.isArray(fromTopLevel) ? fromTopLevel : [];
    return list.map((c, idx) => ({
      id: `extract-${idx}`,
      clause_type: c.clause_type,
      clause_title: c.clause_title,
      clause_text: c.clause_text,
      source_page: c.source_page,
      confidence_score: c.confidence_score,
    }));
  }, [lease]);

  const allClauses = useMemo(() => {
    if (Array.isArray(dbClauses) && dbClauses.length > 0) return dbClauses;
    return fallbackClauses;
  }, [dbClauses, fallbackClauses]);

  // Build the checklist: every standard clause type is shown; any extracted
  // clause types beyond the standard set are appended at the end.
  const checklist = useMemo(() => {
    const byType = new Map();
    for (const clause of allClauses) {
      const key = String(clause.clause_type || "unknown").toLowerCase();
      if (!byType.has(key)) byType.set(key, []);
      byType.get(key).push(clause);
    }
    const rows = STANDARD_CLAUSE_TYPES.map((standard) => ({
      ...standard,
      clauses: byType.get(standard.key) || [],
    }));
    for (const [type, clauses] of byType.entries()) {
      if (!STANDARD_CLAUSE_TYPES.some((s) => s.key === type)) {
        rows.push({ key: type, label: type.replace(/_/g, " "), clauses, extra: true });
      }
    }
    return rows;
  }, [allClauses]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 pb-2">
        <div>
          <CardTitle className="text-base">Clause Records</CardTitle>
          <p className="text-xs text-slate-500">
            All meaningful lease clauses captured for review. Source: <code>lease_clauses</code>.
          </p>
        </div>
        <Badge className="bg-slate-100 text-slate-700">
          {allClauses.length} / {STANDARD_CLAUSE_TYPES.length} captured
        </Badge>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading clauses…
          </div>
        ) : tableMissing && allClauses.length === 0 ? (
          <p className="text-sm text-amber-700">
            lease_clauses table not present in this environment. Extracted clauses will appear once the migration is applied.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-slate-200">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[220px] text-xs">Clause Type</TableHead>
                  <TableHead className="text-xs">Title</TableHead>
                  <TableHead className="text-xs">Excerpt</TableHead>
                  <TableHead className="w-[60px] text-xs">Page</TableHead>
                  <TableHead className="w-[100px] text-xs">Confidence</TableHead>
                  <TableHead className="w-[120px] text-xs">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {checklist.map((row) =>
                  row.clauses.length === 0 ? (
                    <TableRow key={row.key}>
                      <TableCell className="text-xs font-medium text-slate-700">
                        {row.label}
                      </TableCell>
                      <TableCell colSpan={4} className="text-xs italic text-slate-500">
                        No clause captured for this type yet.
                      </TableCell>
                      <TableCell>
                        <Badge className="bg-amber-50 text-[10px] text-amber-700">Not Found</Badge>
                      </TableCell>
                    </TableRow>
                  ) : (
                    row.clauses.map((clause) => {
                      const score = Number(clause.confidence_score);
                      const conf = Number.isFinite(score) ? score : null;
                      return (
                        <TableRow key={clause.id}>
                          <TableCell className="text-xs font-medium text-slate-700">{row.label}</TableCell>
                          <TableCell className="text-xs text-slate-700">{clause.clause_title || "—"}</TableCell>
                          <TableCell className="max-w-[420px] truncate text-xs italic text-slate-500" title={clause.clause_text || ""}>
                            {clause.clause_text || "—"}
                          </TableCell>
                          <TableCell className="text-xs">{clause.source_page ?? "—"}</TableCell>
                          <TableCell className="text-xs">
                            {conf == null
                              ? <Badge className="bg-slate-100 text-[10px] text-slate-600">Unknown</Badge>
                              : <Badge className="bg-emerald-50 text-[10px] text-emerald-700">{Math.round(conf <= 1 ? conf * 100 : conf)}%</Badge>}
                          </TableCell>
                          <TableCell>
                            <Badge className="bg-emerald-50 text-[10px] text-emerald-700">Extracted</Badge>
                          </TableCell>
                        </TableRow>
                      );
                    })
                  ),
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Critical Dates ───────────────────────────────────────────────────
export function CriticalDatesTable({ lease }) {
  // Predefined enterprise checklist — every row is always shown. Missing
  // values surface as "Not Found" so reviewers know what's outstanding
  // rather than silently dropping the row.
  const rows = [
    { label: "Lease Date (signed)", value: lease?.lease_date },
    { label: "Commencement Date", value: lease?.commencement_date || lease?.start_date },
    { label: "Rent Commencement Date", value: lease?.rent_commencement_date },
    { label: "Expiration Date", value: lease?.expiration_date || lease?.end_date },
    { label: "Renewal Notice (months)", value: lease?.renewal_notice_months },
    { label: "Termination Notice (months)", value: lease?.termination_notice_months },
    { label: "Option Exercise Deadline", value: lease?.option_exercise_deadline },
  ];
  const captured = rows.filter((r) => r.value != null && r.value !== "").length;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 pb-2">
        <div>
          <CardTitle className="text-base">Critical Dates</CardTitle>
          <p className="text-xs text-slate-500">
            Predefined date checklist. Used by Critical Dates module and Billing.
          </p>
        </div>
        <Badge className="bg-slate-100 text-slate-700">{captured} / {rows.length} captured</Badge>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto rounded-md border border-slate-200">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Date Field</TableHead>
                <TableHead className="text-xs">Value</TableHead>
                <TableHead className="w-[120px] text-xs">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const present = row.value != null && row.value !== "";
                return (
                  <TableRow key={row.label}>
                    <TableCell className="text-xs text-slate-700">{row.label}</TableCell>
                    <TableCell className="text-xs font-medium text-slate-900">
                      {present ? formatDate(row.value) : "—"}
                    </TableCell>
                    <TableCell>
                      <Badge className={`text-[10px] ${present ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
                        {present ? "Captured" : "Not Found"}
                      </Badge>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

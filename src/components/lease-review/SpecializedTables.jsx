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
import { leaseExpenseRuleService } from "@/services/leaseExpenseRuleService";
import {
  getRuleGroupLabel,
  isCamTaxonomyRule,
  normalizeLeaseExpenseRule,
} from "@/services/utils/leaseExpenseRuleTaxonomy";
import { createPageUrl } from "@/utils";
import { ArrowUpRight, Loader2 } from "lucide-react";
import {
  hasValidSourceEvidence,
  normalizeClauseType,
  readFieldEvidence,
  readFieldValue,
  resolveSourceTextQuality,
} from "@/lib/leaseReviewSchema";
import { computeFallbackClauseRows } from "@/lib/leaseReviewFieldNormalizer";

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
function cleanDocumentItemSource(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (/^(llm extracted|extracted|manual_review|not found|unknown|n\/a|na|null)$/i.test(text)) return null;
  if (text.toLowerCase().includes("derived from")) return null;
  if (/^[a-z][a-z0-9_]*_[a-z0-9_]*\s*:\s*/i.test(text)) return null;
  if (/^[a-z][a-z0-9_]{2,60}$/i.test(text)) return null;
  return text;
}

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
function useLeaseExpenseRules(leaseOrId) {
  const lease = leaseOrId && typeof leaseOrId === "object" ? leaseOrId : null;
  const leaseId = lease?.id || leaseOrId;

  return useQuery({
    queryKey: ["lease-expense-rules-detail", leaseId, lease?.extraction_data?.workflow_output?.expense_rules?.length || 0],
    enabled: !!leaseId && !!supabase,
    queryFn: () => leaseExpenseRuleService.loadRuleSet(leaseId, {
      lease,
      includeWorkflowFallback: true,
    }),
    retry: false,
  });
}

const PREDEFINED_EXPENSE_CATEGORIES = [
  "Base Rent / Additional Rent",
  "Taxes",
  "Insurance",
  "Utilities",
  "Repairs and Maintenance",
  "Services",
  "Capital Expenses",
  "Exclusions / Non-Recoverable Items",
  "Other Tenant Charges",
];

const PREDEFINED_CAM_CATEGORIES = [
  "CAM / Operating Expenses",
  "Allocation Rules",
  "Expense Notices / Deadlines",
  "Gross-up Provision",
  "Expense Cap",
  "Admin / Management Fee",
  "Reconciliation / True-up",
  "Audit Rights",
];

function formatRuleConfidence(rule) {
  const value = rule.confidence_score ?? rule.confidence;
  if (value == null) return "-";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "-";
  return String(Math.round(numeric <= 1 ? numeric * 100 : numeric)) + "%";
}

function formatRecoverable(rule) {
  if (rule.recoverable === true) return "Yes";
  if (rule.recoverable === false) return "No";
  return leaseExpenseRuleService.getRecoverableDecision(rule) || "unknown";
}

function SourceTextCell({ rule }) {
  const text = rule.source_text || rule.exact_source_text || rule.source_clause || rule.source;
  if (!text) return <span className="text-slate-400">No lease clause found.</span>;
  return (
    <span className="block max-w-[420px] whitespace-normal text-xs leading-snug text-slate-600">
      {String(text).replace(/\s+/g, " ").trim()}
    </span>
  );
}

export function selectLeaseReviewExpenseRuleRows(rules = [], kind = "expense") {
  const normalized = (rules || []).map(normalizeLeaseExpenseRule);
  return kind === "cam"
    ? normalized.filter(isCamTaxonomyRule)
    : normalized.filter((rule) => !isCamTaxonomyRule(rule));
}

function ExpenseRuleSubsetTable({ leaseId, lease, kind }) {
  const navigate = useNavigate();
  const effectiveLease = lease || (leaseId ? { id: leaseId } : null);
  const effectiveLeaseId = effectiveLease?.id || leaseId;
  const { data, isLoading, error } = useLeaseExpenseRules(effectiveLease);
  const ruleSet = data?.ruleSet || null;
  const rules = useMemo(() => selectLeaseReviewExpenseRuleRows(data?.rules || [], kind), [data, kind]);
  const title = kind === "cam" ? "CAM Rules" : "Expense Rules";
  const tableMissing = error && /lease_expense/i.test(error?.message || "");
  const checklist = kind === "cam" ? PREDEFINED_CAM_CATEGORIES : PREDEFINED_EXPENSE_CATEGORIES;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 pb-2">
        <div>
          <CardTitle className="text-base">{title}</CardTitle>
          <p className="text-xs text-slate-500">
            Source: <code>{ruleSet?.is_fallback ? "workflow_output.expense_rules" : "lease_expense_rules"}</code>
            {ruleSet ? " - v" + ruleSet.version + " - " + ruleSet.status : " - no rule set yet"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge className="bg-slate-100 text-slate-700">{rules.length}</Badge>
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate(createPageUrl("LeaseExpenseRules") + "?lease=" + effectiveLeaseId)}
          >
            <ArrowUpRight className="mr-1 h-3.5 w-3.5" />
            Review {kind === "cam" ? "CAM Rules" : "Lease Expense Rules"}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading...
          </div>
        ) : tableMissing ? (
          <p className="text-sm text-amber-700">
            lease_expense_rules table is not available in this environment.
          </p>
        ) : rules.length === 0 ? (
          <div className="space-y-2">
            <p className="text-sm text-slate-500">No lease clause found.</p>
            <div className="overflow-x-auto rounded-md border border-slate-200">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Category</TableHead>
                    <TableHead className="w-[170px] text-xs">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {checklist.map((cat) => (
                    <TableRow key={cat}>
                      <TableCell className="text-xs text-slate-700">{cat}</TableCell>
                      <TableCell>
                        <Badge className="bg-amber-50 text-[10px] text-amber-700">No lease clause found.</Badge>
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
                  <TableHead className="text-xs">Group</TableHead>
                  <TableHead className="text-xs">Rule</TableHead>
                  <TableHead className="text-xs">Status</TableHead>
                  <TableHead className="text-xs">Responsible</TableHead>
                  <TableHead className="text-xs">Recoverable</TableHead>
                  <TableHead className="text-xs">Page</TableHead>
                  <TableHead className="text-xs">Source Text</TableHead>
                  <TableHead className="text-xs text-right">Confidence</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rules.map((rule) => (
                  <TableRow key={rule.id || rule.rule_key || rule.rule_group + "-" + (rule.source_text || "")}>
                    <TableCell className="text-xs text-slate-700">{getRuleGroupLabel(rule)}</TableCell>
                    <TableCell className="text-xs font-medium text-slate-700">
                      {rule.normalized_rule || rule.subcategory_name || rule.category_name || rule.expense_category || "Expense rule"}
                    </TableCell>
                    <TableCell className="text-xs">
                      <Badge className="bg-slate-100 text-[10px] text-slate-700">{rule.review_status || rule.status || "needs_review"}</Badge>
                    </TableCell>
                    <TableCell className="text-xs">{rule.responsible_party || "unknown"}</TableCell>
                    <TableCell className="text-xs">{formatRecoverable(rule)}</TableCell>
                    <TableCell className="text-xs">{rule.source_page || "-"}</TableCell>
                    <TableCell><SourceTextCell rule={rule} /></TableCell>
                    <TableCell className="text-right text-xs">{formatRuleConfidence(rule)}</TableCell>
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

export function ExpenseRulesTable({ leaseId, lease }) {
  return <ExpenseRuleSubsetTable leaseId={leaseId} lease={lease} kind="expense" />;
}

export function CamRulesTable({ leaseId, lease }) {
  return <ExpenseRuleSubsetTable leaseId={leaseId} lease={lease} kind="cam" />;
}

// --- Clause Records ---------------------------------------------------
const STANDARD_CLAUSE_TYPES = [
  { key: "use_permitted_use", label: "Use / Permitted Use" },
  { key: "rent_clause", label: "Rent & Escalation" },
  { key: "security_deposit", label: "Security Deposit" },
  { key: "operating_expense_recovery", label: "Operating Expense Recovery" },
  { key: "cam_recoveries", label: "CAM / Recoveries" },
  { key: "insurance_requirements", label: "Insurance Requirements" },
  { key: "indemnification", label: "Indemnification" },
  { key: "defaults_remedies", label: "Default & Remedies" },
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
  // clause text just because the table isn't deployed yet. The union logic
  // itself now lives in computeFallbackClauseRows() (leaseReviewFieldNormalizer.js)
  // — shared with the debug panel's clause count so the two can't disagree —
  // ported verbatim here, not reimplemented.
  const fallbackClauses = useMemo(() => computeFallbackClauseRows(lease), [lease]);

  const allClauses = useMemo(() => {
    const sourceBackedFallbacks = fallbackClauses.filter((clause) => cleanDocumentItemSource(clause.clause_text));
    const discovered = sourceBackedFallbacks.filter((clause) => clause.is_document_item);
    const sourceBackedDbClauses = Array.isArray(dbClauses)
      ? dbClauses.filter((clause) => cleanDocumentItemSource(clause.clause_text))
      : [];
    if (sourceBackedDbClauses.length > 0) return [...sourceBackedDbClauses, ...discovered];
    return sourceBackedFallbacks;
  }, [dbClauses, fallbackClauses]);

  // Build the checklist: every standard clause type is shown; any extracted
  // clause types beyond the standard set are appended at the end.
  const checklist = useMemo(() => {
    const byType = new Map();
    for (const clause of allClauses) {
      const key = normalizeClauseType(clause.clause_type);
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
  //
  // Use readFieldValue so we always get the latest extracted value from
  // extraction_data.fields (which is populated during review) rather than
  // the top-level lease columns (which may be stale or not yet written
  // until the abstract is approved).
  const leaseDate = readFieldValue(lease, "lease_date") ?? lease?.lease_date;
  const commencement =
    readFieldValue(lease, "commencement_date") ??
    lease?.commencement_date ??
    lease?.start_date;
  const expiration =
    readFieldValue(lease, "expiration_date") ??
    lease?.expiration_date ??
    lease?.end_date;

  // Date sanity flags so the table can surface "Conflict" inline rather than
  // showing a green "Captured" badge for an obviously broken date.
  const flags = {};
  if (commencement && expiration) {
    const startMs = new Date(commencement).getTime();
    const endMs = new Date(expiration).getTime();
    if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
      if (endMs <= startMs) {
        flags.expiration_date = "Expiration is on or before commencement";
      } else {
        const days = Math.round((endMs - startMs) / 86400000);
        if (days < 30) flags.expiration_date = `Term is only ${days} day(s) - verify year`;
      }
    }
  }
  if (leaseDate && commencement && new Date(leaseDate).toDateString() === new Date(commencement).toDateString()) {
    flags.commencement_date = "Same as lease signing date - verify";
  }

  const dateEvidence = (key, value) => {
    const evidence = readFieldEvidence(lease, key);
    const sourceTextQuality = resolveSourceTextQuality({
      value,
      sourceText: evidence.sourceText,
      sourcePage: evidence.sourcePage,
      extractionStatus: evidence.extractionStatus,
      evidenceType: evidence.evidenceType,
      sourceTextQuality: evidence.sourceTextQuality,
      sourceFieldKeys: evidence.sourceFieldKeys,
      derivationTrace: evidence.derivationTrace,
    });
    return {
      ...evidence,
      sourceTextQuality,
      hasValidSource: hasValidSourceEvidence({
        value,
        ...evidence,
        sourceTextQuality,
      }),
    };
  };

  const rows = [
    { key: "lease_date", label: "Lease Date (signed)", value: leaseDate },
    { key: "commencement_date", label: "Commencement Date", value: commencement },
    {
      key: "rent_commencement_date",
      label: "Rent Commencement Date",
      value:
        readFieldValue(lease, "rent_commencement_date") ??
        lease?.rent_commencement_date,
    },
    { key: "expiration_date", label: "Expiration Date", value: expiration },
    {
      key: "renewal_notice_months",
      label: "Renewal Notice (months)",
      value:
        readFieldValue(lease, "renewal_notice_months") ??
        lease?.renewal_notice_months,
    },
    {
      key: "termination_notice_months",
      label: "Termination Notice (months)",
      value:
        readFieldValue(lease, "termination_notice_months") ??
        lease?.termination_notice_months,
    },
    {
      key: "option_exercise_deadline",
      label: "Option Exercise Deadline",
      value:
        readFieldValue(lease, "option_exercise_deadline") ??
        lease?.option_exercise_deadline,
    },
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
                const evidence = dateEvidence(row.key, row.value);
                const conflict = flags[row.key] || null;
                const needsReview = present && (
                  !evidence.hasValidSource ||
                  evidence.sourceTextQuality === "derived" ||
                  evidence.sourceTextQuality === "inferred" ||
                  evidence.requiresReview
                );
                let badgeClass = "bg-amber-50 text-amber-700";
                let badgeText = "Not Found";
                if (present && conflict) {
                  badgeClass = "bg-red-100 text-red-700";
                  badgeText = "Conflict";
                } else if (needsReview) {
                  badgeClass = "bg-purple-50 text-purple-700";
                  badgeText = "Manual Review";
                } else if (present) {
                  badgeClass = "bg-emerald-50 text-emerald-700";
                  badgeText = "Captured";
                }
                return (
                  <TableRow key={row.label} className={conflict ? "bg-red-50/40" : ""}>
                    <TableCell className="text-xs text-slate-700">{row.label}</TableCell>
                    <TableCell className="text-xs font-medium text-slate-900">
                      {present ? formatDate(row.value) : "—"}
                      {conflict && (
                        <div className="text-[10px] font-normal text-red-700">{conflict}</div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge className={`text-[10px] ${badgeClass}`}>{badgeText}</Badge>
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

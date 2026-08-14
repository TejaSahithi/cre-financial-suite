import React from "react";
import { Link, useLocation } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  CheckCircle2,
  ClipboardCheck,
  FileText,
  Gauge,
  UserCheck,
  X,
  RefreshCw,
  ShieldCheck,
  Wrench,
} from "lucide-react";

import PageHeader from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import useOrgQuery from "@/hooks/useOrgQuery";
import { useAssistantPageContext } from "@/assistant/useAssistantContext";
import { createPageUrl } from "@/utils";
import { supabase } from "@/services/supabaseClient";
import { buildClientCapabilityReadiness } from "@/services/utils/clientCapabilityReadiness";
import { buildAutomationExceptionInbox } from "@/services/utils/automationExceptionsInbox";
import {
  generateLeaseObligationOccurrences,
  listLeaseChargeReadModel,
  listOperationalDomainRows,
  runFinancialControls,
  runOperationalReviewCommand,
} from "@/services/leaseFinancialOperationsService";

const STATUS_STYLES = {
  automated: "bg-emerald-100 text-emerald-700 border-emerald-200",
  needs_review: "bg-amber-100 text-amber-800 border-amber-200",
  partial: "bg-blue-100 text-blue-700 border-blue-200",
  blocked: "bg-red-100 text-red-700 border-red-200",
  not_started: "bg-slate-100 text-slate-700 border-slate-200",
};

const STATUS_LABELS = {
  automated: "Automated",
  needs_review: "Needs Review",
  partial: "Partial",
  blocked: "Blocked",
  not_started: "Not Started",
};

function fmtCurrency(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "$0";
  return num.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function fmtDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

function fmtPercent(value) {
  if (value == null || !Number.isFinite(Number(value))) return "-";
  return `${Number(value).toFixed(1)}%`;
}

function fmtCoverageLimits(limits) {
  if (!limits || typeof limits !== "object") return "limits not recorded";
  const entries = Object.entries(limits).filter(([, value]) => value != null && value !== "");
  if (entries.length === 0) return "limits not recorded";
  return entries.map(([key, value]) => `${key.replace(/_/g, " ")}: ${fmtCurrency(value)}`).join(", ");
}

function coiRequirementSource(row) {
  const evidence = row?.evidence && typeof row.evidence === "object" ? row.evidence : {};
  if (evidence.insurance_requirement || evidence.lease_insurance_requirement || evidence.requirement) return "lease-required terms captured with evidence";
  return "lease-required terms resolved from approved abstract on approval";
}

async function fetchOrgTable(tableName, orgId, select = "*") {
  if (!supabase || orgId === "__none__") return [];
  try {
    let query = supabase.from(tableName).select(select).limit(750);
    if (orgId) query = query.eq("org_id", orgId);
    const { data, error } = await query;
    if (error) {
      console.warn(`[AutomationReadiness] ${tableName} unavailable:`, error.message);
      return [];
    }
    return data || [];
  } catch (error) {
    console.warn(`[AutomationReadiness] ${tableName} failed:`, error);
    return [];
  }
}

function StatusBadge({ status }) {
  return (
    <Badge variant="outline" className={`text-[11px] font-semibold ${STATUS_STYLES[status] || STATUS_STYLES.not_started}`}>
      {STATUS_LABELS[status] || status}
    </Badge>
  );
}

function ProgressBar({ value }) {
  const width = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    <div className="h-2 w-full rounded bg-slate-100 overflow-hidden">
      <div className="h-full bg-blue-600" style={{ width: `${width}%` }} />
    </div>
  );
}

function SummaryMetric({ label, value, icon: Icon, tone }) {
  return (
    <Card>
      <CardContent className="p-4 flex items-center gap-3">
        <div className={`w-10 h-10 rounded-[8px] flex items-center justify-center ${tone}`}>
          <Icon className="w-5 h-5" />
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase text-slate-500">{label}</p>
          <p className="text-xl font-bold text-slate-900">{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function CapabilityRow({ item }) {
  return (
    <TableRow>
      <TableCell className="align-top">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-slate-900">{item.title}</span>
            <Badge variant="outline" className="text-[10px]">{item.priority}</Badge>
          </div>
          <p className="text-xs text-slate-500">{item.nextAction}</p>
        </div>
      </TableCell>
      <TableCell className="align-top"><StatusBadge status={item.status} /></TableCell>
      <TableCell className="align-top min-w-40">
        <div className="flex items-center gap-2">
          <ProgressBar value={item.coverage} />
          <span className="w-10 text-right text-xs font-semibold text-slate-600">{item.coverage}%</span>
        </div>
      </TableCell>
      <TableCell className="align-top text-right font-mono text-sm">{item.done}/{item.total}</TableCell>
      <TableCell className="align-top text-right">
        {item.blockers > 0 ? (
          <span className="font-semibold text-amber-700">{item.blockers}</span>
        ) : (
          <CheckCircle2 className="ml-auto h-4 w-4 text-emerald-500" />
        )}
      </TableCell>
      <TableCell className="align-top text-xs text-slate-500">
        {(item.evidence || []).map((line) => <div key={line}>{line}</div>)}
      </TableCell>
    </TableRow>
  );
}

function ControlRows({ controls }) {
  const rows = [
    ...(controls?.overBudget || []).map((row) => ({ ...row, label: "Category variance" })),
    ...(controls?.unbudgetedExpenses || []).map((row) => ({ ...row, label: "Unbudgeted expense" })),
    ...(controls?.missingRecurring || []).map((row) => ({
      ...row,
      label: "Missing recurring invoice",
      actual: row.actualCount,
      budget: row.expectedCount,
      variance: row.missingCount,
      variancePercent: null,
    })),
  ].slice(0, 12);

  if (rows.length === 0) {
    return (
      <div className="p-4 text-sm text-slate-500">
        No financial control exceptions were found from the currently loaded data.
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow className="bg-slate-50">
          <TableHead className="text-[11px]">CONTROL</TableHead>
          <TableHead className="text-[11px]">CATEGORY</TableHead>
          <TableHead className="text-[11px] text-right">BUDGET / EXPECTED</TableHead>
          <TableHead className="text-[11px] text-right">ACTUAL</TableHead>
          <TableHead className="text-[11px] text-right">VARIANCE</TableHead>
          <TableHead className="text-[11px] text-right">%</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, index) => (
          <TableRow key={`${row.code}-${row.category}-${index}`}>
            <TableCell><Badge variant="outline" className="text-[10px]">{row.code}</Badge></TableCell>
            <TableCell className="font-medium capitalize">{String(row.category || "").replace(/_/g, " ")}</TableCell>
            <TableCell className="text-right font-mono">{row.code === "EXPECTED_INVOICE_MISSING" ? row.budget : fmtCurrency(row.budget)}</TableCell>
            <TableCell className="text-right font-mono">{row.code === "EXPECTED_INVOICE_MISSING" ? row.actual : fmtCurrency(row.actual)}</TableCell>
            <TableCell className="text-right font-mono text-amber-700">{row.code === "EXPECTED_INVOICE_MISSING" ? row.variance : fmtCurrency(row.variance)}</TableCell>
            <TableCell className="text-right">{fmtPercent(row.variancePercent)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}


function countBlocking(rows) {
  return (rows || []).filter((row) => ["blocked", "overdue", "pending_review", "needs_review", "open"].includes(String(row.status || "").toLowerCase())).length;
}

function OperationalDomainTable({ domains }) {
  return (
    <Table>
      <TableHeader>
        <TableRow className="bg-slate-50">
          <TableHead className="text-[11px]">DOMAIN</TableHead>
          <TableHead className="text-[11px] text-right">ROWS</TableHead>
          <TableHead className="text-[11px] text-right">BLOCKERS</TableHead>
          <TableHead className="text-[11px]">LATEST STATUS</TableHead>
          <TableHead className="text-[11px]">SOURCE OF TRUTH</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {domains.map((domain) => {
          const latest = domain.rows?.[0] || null;
          const blockers = countBlocking(domain.rows);
          return (
            <TableRow key={domain.id}>
              <TableCell className="font-semibold text-slate-900">{domain.label}</TableCell>
              <TableCell className="text-right font-mono">{domain.rows.length}</TableCell>
              <TableCell className="text-right font-mono text-amber-700">{blockers}</TableCell>
              <TableCell>
                <Badge variant="outline" className="text-[10px]">
                  {latest?.status || (domain.rows.length ? "stored" : "empty")}
                </Badge>
              </TableCell>
              <TableCell className="text-xs text-slate-500">{domain.table}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function DueObligationRows({ rows }) {
  const visibleRows = (rows || [])
    .filter((row) => ["open", "overdue", "active", "pending_review"].includes(String(row.status || "").toLowerCase()))
    .sort((a, b) => String(a.due_date || "").localeCompare(String(b.due_date || "")))
    .slice(0, 12);

  if (visibleRows.length === 0) {
    return <div className="p-4 text-sm text-slate-500">No open due or overdue obligation occurrences are stored.</div>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow className="bg-slate-50">
          <TableHead className="text-[11px]">STATUS</TableHead>
          <TableHead className="text-[11px]">DUE DATE</TableHead>
          <TableHead className="text-[11px]">LEASE</TableHead>
          <TableHead className="text-[11px]">PROPERTY</TableHead>
          <TableHead className="text-[11px]">NOTIFICATION POLICY</TableHead>
          <TableHead className="text-[11px]">IDEMPOTENCY</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {visibleRows.map((row) => (
          <TableRow key={row.id || row.idempotency_key}>
            <TableCell>
              <Badge variant="outline" className={`text-[10px] ${String(row.status).toLowerCase() === "overdue" ? "border-red-200 bg-red-50 text-red-700" : ""}`}>
                {row.status || "open"}
              </Badge>
            </TableCell>
            <TableCell className="font-mono text-sm">{row.due_date || "-"}</TableCell>
            <TableCell className="font-mono text-xs text-slate-600">{row.lease_id || "-"}</TableCell>
            <TableCell className="font-mono text-xs text-slate-600">{row.property_id || "-"}</TableCell>
            <TableCell className="text-xs text-slate-600">{row.notification_policy || "internal_only"}</TableCell>
            <TableCell className="font-mono text-[11px] text-slate-500">{row.idempotency_key || "-"}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
const REVIEW_STATUSES = new Set(["draft", "pending_review", "submitted", "needs_review", "open", "acknowledged", "assigned", "blocked", "overdue", "expired", "rejected"]);
const TERMINAL_REVIEW_STATUSES = new Set(["approved", "verified", "resolved", "dismissed", "satisfied", "waived", "cancelled", "canceled", "completed", "superseded"]);

function reviewRows(rows) {
  return (rows || []).filter((row) => {
    const status = String(row.status || "").toLowerCase();
    return REVIEW_STATUSES.has(status) && !TERMINAL_REVIEW_STATUSES.has(status);
  });
}

function QueueSummary({ items, activeQueue, onSelect }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-5 gap-3">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => onSelect(item.id)}
          className={`rounded-[8px] border p-4 text-left transition ${activeQueue === item.id ? "border-blue-500 bg-blue-50" : "border-slate-200 bg-white hover:border-blue-200"}`}
        >
          <div className="text-[11px] font-semibold uppercase text-slate-500">{item.label}</div>
          <div className="mt-2 text-2xl font-bold text-slate-900">{item.count}</div>
        </button>
      ))}
    </div>
  );
}

function ShortId({ value }) {
  if (!value) return <span>-</span>;
  return <span className="font-mono text-[11px] text-slate-500">{String(value).slice(0, 8)}</span>;
}

function CommandButton({ children, command, payload, icon: Icon, variant = "outline", disabled, onCommand }) {
  return (
    <Button
      type="button"
      size="sm"
      variant={variant}
      className="h-8 gap-1"
      disabled={disabled}
      onClick={() => onCommand(command, payload)}
    >
      {Icon && <Icon className="h-3.5 w-3.5" />}
      {children}
    </Button>
  );
}

function FilterSelect({ label, value, options, onChange }) {
  return (
    <label className="space-y-1 text-xs font-semibold text-slate-600">
      <span>{label}</span>
      <select
        className="h-9 w-full rounded-[8px] border border-slate-200 bg-white px-3 text-sm font-normal text-slate-900"
        value={value || "all"}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

function severityClass(severity) {
  if (severity === "critical") return "border-red-200 bg-red-50 text-red-700";
  if (severity === "high") return "border-amber-200 bg-amber-50 text-amber-700";
  if (severity === "medium") return "border-blue-200 bg-blue-50 text-blue-700";
  return "border-slate-200 bg-slate-50 text-slate-600";
}

function InboxFilters({ filters, inbox, properties, onChange }) {
  const setFilter = (key, value) => onChange({ ...filters, [key]: value });
  const propertyOptions = [
    { value: "all", label: "All properties" },
    ...(properties || []).map((property) => ({ value: property.id, label: property.name || property.property_name || property.id })),
  ];
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-5">
      <FilterSelect label="Property" value={filters.propertyId} options={propertyOptions} onChange={(value) => setFilter("propertyId", value)} />
      <FilterSelect label="Domain" value={filters.domain} options={[{ value: "all", label: "All domains" }, ...inbox.filterOptions.domains.map((item) => ({ value: item.id, label: item.label }))]} onChange={(value) => setFilter("domain", value)} />
      <FilterSelect label="Severity" value={filters.severity} options={[{ value: "all", label: "All severities" }, ...inbox.filterOptions.severities.map((value) => ({ value, label: value }))]} onChange={(value) => setFilter("severity", value)} />
      <FilterSelect label="Status" value={filters.status} options={[{ value: "all", label: "All statuses" }, ...inbox.filterOptions.statuses.map((value) => ({ value, label: value }))]} onChange={(value) => setFilter("status", value)} />
      <FilterSelect label="Assignee" value={filters.assignee} options={[{ value: "all", label: "All assignees" }, ...inbox.filterOptions.assignees.map((value) => ({ value, label: value }))]} onChange={(value) => setFilter("assignee", value)} />
    </div>
  );
}

function InboxActionButtons({ item, onCommand, disabled }) {
  const row = item.sourceRow || {};
  const status = String(item.status || row.status || "").toLowerCase();
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <Link to={item.actionUrl}>
        <Button type="button" size="sm" variant="outline" className="h-8 gap-1">
          <ArrowUpRight className="h-3.5 w-3.5" />
          Open
        </Button>
      </Link>
      {item.domain === "tenant-sales" && ["draft", "rejected", "needs_review"].includes(status) && (
        <CommandButton command="submitSalesReport" payload={{ report_id: row.id }} onCommand={onCommand} disabled={disabled}>Submit</CommandButton>
      )}
      {item.domain === "tenant-sales" && ["pending_review", "submitted"].includes(status) && (
        <>
          <CommandButton command="approveSalesReport" payload={{ report_id: row.id }} icon={Check} onCommand={onCommand} disabled={disabled}>Approve</CommandButton>
          <CommandButton command="rejectSalesReport" payload={{ report_id: row.id, reasonRequired: true }} icon={X} onCommand={onCommand} disabled={disabled}>Reject</CommandButton>
        </>
      )}
      {item.domain === "financial-controls" && !["resolved", "dismissed"].includes(status) && (
        <>
          <CommandButton command="acknowledgeFinding" payload={{ finding_id: row.id }} onCommand={onCommand} disabled={disabled}>Ack</CommandButton>
          <CommandButton command="assignFinding" payload={{ finding_id: row.id, assigneeRequired: true }} onCommand={onCommand} disabled={disabled}>Assign</CommandButton>
          {row.policy_blocks && <CommandButton command="overrideFindingPolicyDecision" payload={{ finding_id: row.id, reasonRequired: true }} icon={ShieldCheck} onCommand={onCommand} disabled={disabled}>Override</CommandButton>}
          <CommandButton command="resolveFinding" payload={{ finding_id: row.id, reasonRequired: true }} icon={Check} onCommand={onCommand} disabled={disabled}>Resolve</CommandButton>
          <CommandButton command="dismissFinding" payload={{ finding_id: row.id, reasonRequired: true }} icon={X} onCommand={onCommand} disabled={disabled}>Dismiss</CommandButton>
        </>
      )}
      {item.domain === "coi" && !["approved", "active"].includes(status) && (
        <>
          <CommandButton command="approveCoi" payload={{ coi_document_id: row.id }} icon={Check} onCommand={onCommand} disabled={disabled}>Approve</CommandButton>
          <CommandButton command="rejectCoi" payload={{ coi_document_id: row.id, reasonRequired: true }} icon={X} onCommand={onCommand} disabled={disabled}>Reject</CommandButton>
        </>
      )}
      {item.domain === "vendor-credentials" && !["verified", "approved", "active"].includes(status) && (
        <CommandButton command="verifyVendorCredential" payload={{ credential_id: row.id }} icon={UserCheck} onCommand={onCommand} disabled={disabled}>Verify</CommandButton>
      )}
      {item.domain === "vendor-credentials" && ["verified", "approved", "active"].includes(status) && (
        <CommandButton command="revokeVendorCredential" payload={{ credential_id: row.id, reasonRequired: true }} icon={X} onCommand={onCommand} disabled={disabled}>Revoke</CommandButton>
      )}
      {item.domain === "obligations" && (
        <>
          <CommandButton command="satisfyObligation" payload={{ occurrence_id: row.id }} icon={Check} onCommand={onCommand} disabled={disabled}>Satisfy</CommandButton>
          <CommandButton command="waiveObligation" payload={{ occurrence_id: row.id, reasonRequired: true }} icon={X} onCommand={onCommand} disabled={disabled}>Waive</CommandButton>
        </>
      )}
    </div>
  );
}

function AutomationInboxRows({ items, onCommand, commandPending }) {
  if (!items.length) {
    return <div className="p-4 text-sm text-slate-500">No open persisted exceptions match the selected filters.</div>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow className="bg-slate-50">
          <TableHead className="text-[11px]">SEVERITY</TableHead>
          <TableHead className="text-[11px]">DOMAIN / TITLE</TableHead>
          <TableHead className="text-[11px]">ENTITY</TableHead>
          <TableHead className="text-[11px]">STATUS</TableHead>
          <TableHead className="text-[11px]">DUE</TableHead>
          <TableHead className="text-[11px]">ASSIGNEE</TableHead>
          <TableHead className="text-[11px] text-right">ACTIONS</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => (
          <TableRow key={item.id}>
            <TableCell><Badge variant="outline" className={`text-[10px] ${severityClass(item.severity)}`}>{item.severity}</Badge></TableCell>
            <TableCell className="align-top">
              <div className="font-semibold text-slate-900">{item.title}</div>
              <div className="text-xs text-slate-500">{item.domainLabel} / {item.category}</div>
              <div className="mt-1 text-[11px] text-slate-500">{item.description}</div>
            </TableCell>
            <TableCell className="align-top text-xs text-slate-500">
              <div>{item.entityReference || "-"}</div>
              <div className="font-mono text-[11px]">{item.sourceTable}:{String(item.sourceRecordId || "-").slice(0, 8)}</div>
            </TableCell>
            <TableCell><Badge variant="outline" className="text-[10px]">{item.status}</Badge></TableCell>
            <TableCell className="font-mono text-xs">{item.dueDate || "-"}</TableCell>
            <TableCell className="text-xs text-slate-500">{item.assignee || "unassigned"}</TableCell>
            <TableCell className="text-right"><InboxActionButtons item={item} onCommand={onCommand} disabled={commandPending} /></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
function OperationalReviewRows({ queueId, rows, onCommand, commandPending }) {
  const visibleRows = reviewRows(rows).slice(0, 15);
  if (visibleRows.length === 0) {
    return <div className="p-4 text-sm text-slate-500">No persisted records need action in this queue.</div>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow className="bg-slate-50">
          <TableHead className="text-[11px]">STATUS</TableHead>
          <TableHead className="text-[11px]">RECORD</TableHead>
          <TableHead className="text-[11px]">CONTEXT</TableHead>
          <TableHead className="text-[11px] text-right">AMOUNT / DATE</TableHead>
          <TableHead className="text-[11px] text-right">ACTIONS</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {visibleRows.map((row) => {
          const status = String(row.status || "").toLowerCase();
          const commonDisabled = commandPending;
          return (
            <TableRow key={row.id || row.idempotency_key}>
              <TableCell>
                <Badge variant="outline" className="text-[10px]">{row.status || "open"}</Badge>
              </TableCell>
              <TableCell>
                <div className="font-semibold text-slate-900">
                  {queueId === "sales" && `${row.period_start || "-"} to ${row.period_end || "-"}`}
                  {queueId === "findings" && `${row.code || "Finding"}`}
                  {queueId === "coi" && `${row.insurer || "COI Document"}`}
                  {queueId === "vendors" && `${row.credential_type || "Credential"}`}
                  {queueId === "obligations" && `${row.due_date || "Obligation"}`}
                </div>
                <ShortId value={row.id} />
              </TableCell>
              <TableCell className="text-xs text-slate-500">
                {queueId === "sales" && <div>Lease <ShortId value={row.lease_id} /></div>}
                {queueId === "findings" && (
                  <div className="space-y-1">
                    <div>{row.category || "uncategorized"} / {row.severity || "medium"}</div>
                    <div className="flex flex-wrap gap-1">
                      <Badge variant="outline" className={`text-[10px] ${row.policy_blocks ? "border-red-200 bg-red-50 text-red-700" : ""}`}>{row.policy_action || row.policy_decision_snapshot?.reason || "NO POLICY"}</Badge>
                    </div>
                    {row.policy_decision_snapshot?.reason && <div>{row.policy_decision_snapshot.reason}</div>}
                    {row.override_reason && <div>Override: {row.override_reason}</div>}
                  </div>
                )}
                {queueId === "coi" && (
                  <div className="space-y-1">
                    <div>Lease <ShortId value={row.lease_id} /></div>
                    <div>Certificate facts: {fmtCoverageLimits(row.coverage_limits)}; AI {Array.isArray(row.additional_insureds) && row.additional_insureds.length > 0 ? "yes" : "no"}; waiver {row.waiver_of_subrogation ? "yes" : "no"}</div>
                    <div>Lease terms: {coiRequirementSource(row)}</div>
                  </div>
                )}
                {queueId === "vendors" && <div>{row.service_type || "service"} {row.jurisdiction ? `/ ${row.jurisdiction}` : ""}</div>}
                {queueId === "obligations" && <div>{row.notification_policy || "internal_only"}</div>}
              </TableCell>
              <TableCell className="text-right font-mono text-sm">
                {queueId === "sales" && fmtCurrency(row.net_reportable_sales ?? row.gross_sales_amount)}
                {queueId === "findings" && fmtCurrency(row.variance_amount)}
                {queueId === "coi" && (row.expiration_date || "-")}
                {queueId === "vendors" && (row.expiration_date || "-")}
                {queueId === "obligations" && (row.due_date || "-")}
              </TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end gap-2">
                  {queueId === "sales" && ["draft", "rejected", "needs_review"].includes(status) && (
                    <CommandButton command="submitSalesReport" payload={{ report_id: row.id }} onCommand={onCommand} disabled={commonDisabled}>Submit</CommandButton>
                  )}
                  {queueId === "sales" && ["pending_review", "submitted"].includes(status) && (
                    <>
                      <CommandButton command="approveSalesReport" payload={{ report_id: row.id }} icon={Check} onCommand={onCommand} disabled={commonDisabled}>Approve</CommandButton>
                      <CommandButton command="rejectSalesReport" payload={{ report_id: row.id, reasonRequired: true }} icon={X} onCommand={onCommand} disabled={commonDisabled}>Reject</CommandButton>
                    </>
                  )}
                  {queueId === "findings" && ["open", "blocked", "pending_review", "active"].includes(status) && (
                    <CommandButton command="acknowledgeFinding" payload={{ finding_id: row.id }} onCommand={onCommand} disabled={commonDisabled}>Ack</CommandButton>
                  )}
                  {queueId === "findings" && !["resolved", "dismissed"].includes(status) && (
                    <>
                      <CommandButton command="assignFinding" payload={{ finding_id: row.id, assigneeRequired: true }} onCommand={onCommand} disabled={commonDisabled}>Assign</CommandButton>
                      {row.policy_blocks && (
                        <CommandButton command="overrideFindingPolicyDecision" payload={{ finding_id: row.id, reasonRequired: true }} icon={ShieldCheck} onCommand={onCommand} disabled={commonDisabled}>Override</CommandButton>
                      )}
                      <CommandButton command="resolveFinding" payload={{ finding_id: row.id, reasonRequired: true }} icon={Check} onCommand={onCommand} disabled={commonDisabled}>Resolve</CommandButton>
                      <CommandButton command="dismissFinding" payload={{ finding_id: row.id, reasonRequired: true }} icon={X} onCommand={onCommand} disabled={commonDisabled}>Dismiss</CommandButton>
                    </>
                  )}
                  {queueId === "coi" && (
                    <>
                      <CommandButton command="approveCoi" payload={{ coi_document_id: row.id }} icon={Check} onCommand={onCommand} disabled={commonDisabled}>Approve</CommandButton>
                      <CommandButton command="rejectCoi" payload={{ coi_document_id: row.id, reasonRequired: true }} icon={X} onCommand={onCommand} disabled={commonDisabled}>Reject</CommandButton>
                    </>
                  )}
                  {queueId === "vendors" && !["verified", "approved", "active"].includes(status) && (
                    <CommandButton command="verifyVendorCredential" payload={{ credential_id: row.id }} icon={UserCheck} onCommand={onCommand} disabled={commonDisabled}>Verify</CommandButton>
                  )}
                  {queueId === "vendors" && ["verified", "approved", "active"].includes(status) && (
                    <CommandButton command="revokeVendorCredential" payload={{ credential_id: row.id, reasonRequired: true }} icon={X} onCommand={onCommand} disabled={commonDisabled}>Revoke</CommandButton>
                  )}
                  {queueId === "obligations" && (
                    <>
                      <CommandButton command="satisfyObligation" payload={{ occurrence_id: row.id }} icon={Check} onCommand={onCommand} disabled={commonDisabled}>Satisfy</CommandButton>
                      <CommandButton command="waiveObligation" payload={{ occurrence_id: row.id, reasonRequired: true }} icon={X} onCommand={onCommand} disabled={commonDisabled}>Waive</CommandButton>
                    </>
                  )}
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
function ReferenceObservationRows({ rows, selections }) {
  const visibleRows = (rows || []).slice(0, 12);
  if (visibleRows.length === 0) {
    return <div className="p-4 text-sm text-slate-500">No persisted reference observations are available.</div>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow className="bg-slate-50">
          <TableHead className="text-[11px]">PROVIDER</TableHead>
          <TableHead className="text-[11px]">SERIES</TableHead>
          <TableHead className="text-[11px]">PERIOD</TableHead>
          <TableHead className="text-[11px] text-right">VALUE</TableHead>
          <TableHead className="text-[11px]">STATUS</TableHead>
          <TableHead className="text-[11px]">APPROVAL</TableHead>
          <TableHead className="text-[11px]">SOURCE</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {visibleRows.map((row) => (
          <TableRow key={row.id || `${row.provider}-${row.series_id}-${row.period}`}>
            <TableCell className="font-semibold uppercase text-slate-900">{row.provider || "-"}</TableCell>
            <TableCell>
              <div className="font-mono text-xs text-slate-900">{row.series_id || "-"}</div>
              {row.evidence?.approved_series_selection_id && (
                <div className="mt-1 text-[11px] text-slate-500">{row.evidence.display_name || `Selection ${row.evidence.approved_series_selection_id}`}</div>
              )}
            </TableCell>
            <TableCell className="font-mono text-sm">{row.period || "-"}</TableCell>
            <TableCell className="text-right font-mono">{row.value ?? "-"}</TableCell>
            <TableCell>
              <Badge variant="outline" className="text-[10px]">{row.status || "stored"}</Badge>
            </TableCell>
            <TableCell className="text-xs text-slate-500">
              <div>{fmtDateTime(row.approved_at)}</div>
              {row.approved_by && <div className="font-mono text-[11px]">{row.approved_by}</div>}
            </TableCell>
            <TableCell className="text-xs text-slate-500">
              {row.source_url ? (
                <a className="inline-flex items-center gap-1 text-blue-700 hover:underline" href={row.source_url} target="_blank" rel="noreferrer">
                  Source <ArrowUpRight className="h-3 w-3" />
                </a>
              ) : "-"}
              {row.retrieved_at && <div className="mt-1">Retrieved {fmtDateTime(row.retrieved_at)}</div>}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
function addDaysIso(days) {
  const value = new Date();
  value.setDate(value.getDate() + days);
  return value.toISOString().slice(0, 10);
}
export default function AutomationReadiness() {
  const location = useLocation();
  const fiscalYear = new Date().getFullYear();
  useAssistantPageContext({ page: "AutomationReadiness", route: location.pathname + location.search, fiscalYear });

  const leasesQuery = useOrgQuery("Lease");
  const expensesQuery = useOrgQuery("Expense");
  const budgetsQuery = useOrgQuery("Budget");
  const camRunsQuery = useOrgQuery("CAMCalculation");
  const documentsQuery = useOrgQuery("Document");
  const vendorsQuery = useOrgQuery("Vendor");
  const notificationsQuery = useOrgQuery("Notification");
  const propertiesQuery = useOrgQuery("Property");
  const queryClient = useQueryClient();
  const orgId = leasesQuery.orgId;
  const [activeQueue, setActiveQueue] = React.useState("sales");
  const [inboxFilters, setInboxFilters] = React.useState({ propertyId: "all", domain: "all", severity: "all", status: "all", assignee: "all" });

  const commandMutation = useMutation({
    mutationFn: ({ command, payload }) => runOperationalReviewCommand(command, payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["automation-operational-rows", orgId] }),
  });

  const handleReviewCommand = React.useCallback((command, payload = {}) => {
    const nextPayload = { ...payload };
    if (nextPayload.reasonRequired) {
      const reason = window.prompt("Reason");
      if (!reason) return;
      nextPayload.reason = reason;
      delete nextPayload.reasonRequired;
    }
    if (nextPayload.assigneeRequired) {
      const assignee = window.prompt("Assignee");
      if (!assignee) return;
      nextPayload.assignee = assignee;
      delete nextPayload.assigneeRequired;
    }
    commandMutation.mutate({ command, payload: nextPayload });
  }, [commandMutation]);

  const { data: expenseRules = [] } = useQuery({
    queryKey: ["automation-readiness-expense-rules", orgId],
    enabled: !leasesQuery.orgLoading,
    queryFn: () => fetchOrgTable("lease_expense_rules", orgId),
  });
  const { data: rentSchedules = [] } = useQuery({
    queryKey: ["automation-readiness-rent-schedules", orgId],
    enabled: !leasesQuery.orgLoading,
    queryFn: () => fetchOrgTable("rent_schedules", orgId, "id,lease_id,status,row_type,period_start,period_end,monthly_amount,annual_amount"),
  });
  const { data: criticalDates = [] } = useQuery({
    queryKey: ["automation-readiness-critical-dates", orgId],
    enabled: !leasesQuery.orgLoading,
    queryFn: () => fetchOrgTable("lease_critical_dates", orgId),
  });
  const { data: operationalRows = {}, isLoading: operationalLoading } = useQuery({
    queryKey: ["automation-operational-rows", orgId],
    enabled: !leasesQuery.orgLoading,
    queryFn: async () => {
      const tables = [
        ["percentageRent", "percentage_rent_calculations"],
        ["salesReports", "tenant_sales_reports"],
        ["obligations", "lease_obligations"],
        ["occurrences", "lease_obligation_occurrences"],
        ["referenceSeries", "reference_series_selections"],
        ["referenceData", "reference_observations"],
        ["coi", "coi_documents"],
        ["vendorCredentials", "vendor_credentials"],
        ["financialControls", "financial_control_findings"],
        ["leaseCharges", "lease_charge_calculations"],
        ["cpiRentProposals", "cpi_rent_adjustment_proposals"],
        ["tenantReconciliations", "tenant_reconciliations"],
      ];
      const entries = await Promise.all(tables.map(async ([key, table]) => [
        key,
        await listOperationalDomainRows(table, { orgId, limit: 100 }),
      ]));
      const rows = Object.fromEntries(entries);
      try {
        rows.leaseChargeReadModel = await listLeaseChargeReadModel({ orgId, limit: 100 });
      } catch (error) {
        console.warn("[AutomationReadiness] lease_charge_read_model unavailable:", error?.message || error);
        rows.leaseChargeReadModel = rows.leaseCharges || [];
      }
      return rows;
    },
  });

  const inbox = React.useMemo(() => buildAutomationExceptionInbox(operationalRows, { filters: inboxFilters, asOfDate: addDaysIso(0) }), [operationalRows, inboxFilters]);

  const readiness = React.useMemo(() => buildClientCapabilityReadiness({
    leases: leasesQuery.data,
    expenseRules,
    expenses: expensesQuery.data,
    budgets: budgetsQuery.data,
    camRuns: camRunsQuery.data,
    criticalDates,
    documents: documentsQuery.data,
    vendors: vendorsQuery.data,
    notifications: notificationsQuery.data,
    rentSchedules,
    fiscalYear,
  }), [
    leasesQuery.data,
    expenseRules,
    expensesQuery.data,
    budgetsQuery.data,
    camRunsQuery.data,
    criticalDates,
    documentsQuery.data,
    vendorsQuery.data,
    notificationsQuery.data,
    rentSchedules,
    fiscalYear,
  ]);

  const runControlsMutation = useMutation({
    mutationFn: () => runFinancialControls({
      propertyId: propertiesQuery.data?.[0]?.id,
      fiscalYear,
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["automation-operational-rows", orgId] }),
  });

  const generateOccurrencesMutation = useMutation({
    mutationFn: () => generateLeaseObligationOccurrences({
      windowStart: addDaysIso(0),
      windowEnd: addDaysIso(60),
      asOfDate: addDaysIso(0),
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["automation-operational-rows", orgId] }),
  });

  const operationalDomains = [
    { id: "percentage-rent", label: "Percentage Rent", table: "percentage_rent_calculations", rows: operationalRows.percentageRent || [] },
    { id: "tenant-sales", label: "Tenant Sales Reporting", table: "tenant_sales_reports", rows: operationalRows.salesReports || [] },
    { id: "obligations", label: "Lease Obligations", table: "lease_obligations", rows: operationalRows.obligations || [] },
    { id: "occurrences", label: "Obligation Occurrences", table: "lease_obligation_occurrences", rows: operationalRows.occurrences || [] },
    { id: "reference-series", label: "CPI / Reference Series", table: "reference_series_selections", rows: operationalRows.referenceSeries || [] },
    { id: "reference-data", label: "CPI / Reference Observations", table: "reference_observations", rows: operationalRows.referenceData || [] },
    { id: "coi", label: "COI Compliance", table: "coi_documents", rows: operationalRows.coi || [] },
    { id: "vendors", label: "Vendor Eligibility", table: "vendor_credentials", rows: operationalRows.vendorCredentials || [] },
    { id: "controls", label: "Financial Controls", table: "financial_control_findings", rows: operationalRows.financialControls || [] },
    { id: "lease-charges", label: "Management Fee / Lease Charges", table: "lease_charge_calculations", rows: operationalRows.leaseCharges || [] },
    { id: "cpi-rent", label: "CPI Rent Proposals", table: "cpi_rent_adjustment_proposals", rows: operationalRows.cpiRentProposals || [] },
    { id: "tenant-reconciliations", label: "Tenant Reconciliations", table: "tenant_reconciliations", rows: operationalRows.tenantReconciliations || [] },
  ];
  const queueItems = [
    { id: "sales", label: "Gross Sales Reports", count: reviewRows(operationalRows.salesReports).length, rows: operationalRows.salesReports || [] },
    { id: "findings", label: "Financial Findings", count: reviewRows(operationalRows.financialControls).length, rows: operationalRows.financialControls || [] },
    { id: "coi", label: "COI Compliance", count: reviewRows(operationalRows.coi).length, rows: operationalRows.coi || [] },
    { id: "vendors", label: "Vendor Credentials", count: reviewRows(operationalRows.vendorCredentials).length, rows: operationalRows.vendorCredentials || [] },
    { id: "obligations", label: "Overdue Obligations", count: reviewRows(operationalRows.occurrences).length, rows: operationalRows.occurrences || [] },
    { id: "tenant-reconciliations", label: "Tenant Reconciliations", count: reviewRows(operationalRows.tenantReconciliations).length, rows: operationalRows.tenantReconciliations || [] },
  ];
  const activeQueueItem = queueItems.find((item) => item.id === activeQueue) || queueItems[0];
  const loading = [
    leasesQuery,
    expensesQuery,
    budgetsQuery,
    camRunsQuery,
    documentsQuery,
    vendorsQuery,
    notificationsQuery,
    propertiesQuery,
  ].some((query) => query.isLoading || query.orgLoading);

  return (
    <div className="p-4 lg:p-6 space-y-5">
      <PageHeader
        icon={Gauge}
        title="Automation & Exceptions"
        subtitle="Persisted operational state across lease review, rent, CAM, budget, controls, CPI, obligations, COI, vendors, and onboarding."
      >
        <Link to={createPageUrl("BudgetReadiness")}>
          <Button variant="outline" size="sm" className="gap-2">
            <ClipboardCheck className="w-4 h-4" />
            Budget Readiness
          </Button>
        </Link>
        <Link to={createPageUrl("LeaseExpenseRules")}>
          <Button variant="outline" size="sm" className="gap-2">
            <ArrowUpRight className="w-4 h-4" />
            Expense Rules
          </Button>
        </Link>
      </PageHeader>

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        <SummaryMetric label="Average Coverage" value={`${readiness.summary.averageCoverage}%`} icon={Gauge} tone="bg-blue-50 text-blue-600" />
        <SummaryMetric label="Automated Areas" value={readiness.summary.automated} icon={CheckCircle2} tone="bg-emerald-50 text-emerald-600" />
        <SummaryMetric label="Needs Review" value={readiness.summary.needsReview} icon={AlertTriangle} tone="bg-amber-50 text-amber-600" />
        <SummaryMetric label="Partial / Roadmap" value={readiness.summary.partial} icon={Wrench} tone="bg-slate-50 text-slate-600" />
      </div>

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        <SummaryMetric label="Critical Inbox" value={inbox.summary.critical} icon={AlertTriangle} tone="bg-red-50 text-red-600" />
        <SummaryMetric label="Overdue" value={inbox.summary.overdue} icon={RefreshCw} tone="bg-amber-50 text-amber-700" />
        <SummaryMetric label="Needs Review" value={inbox.summary.needsReview} icon={ClipboardCheck} tone="bg-blue-50 text-blue-600" />
        <SummaryMetric label="Blocked" value={inbox.summary.blocked} icon={ShieldCheck} tone="bg-slate-100 text-slate-700" />
      </div>

      <Card>
        <CardHeader className="pb-3 flex flex-row items-center justify-between gap-3">
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-blue-600" />
            Cross-Domain Inbox
          </CardTitle>
          {commandMutation.isPending && <Badge variant="outline" className="text-[10px]">Saving</Badge>}
        </CardHeader>
        <CardContent className="space-y-4">
          <InboxFilters filters={inboxFilters} inbox={inbox} properties={propertiesQuery.data || []} onChange={setInboxFilters} />
          <QueueSummary items={[{ id: "all", label: "All Open", count: inbox.summary.total }, ...inbox.domainCounts]} activeQueue={inboxFilters.domain || "all"} onSelect={(domain) => setInboxFilters((current) => ({ ...current, domain }))} />
          <div className="rounded-[8px] border border-slate-200 overflow-hidden">
            {operationalLoading ? (
              <div className="p-4 text-sm text-slate-500">Loading cross-domain inbox...</div>
            ) : (
              <AutomationInboxRows items={inbox.filteredItems} onCommand={handleReviewCommand} commandPending={commandMutation.isPending} />
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <ClipboardCheck className="w-4 h-4 text-blue-600" />
            Needs Review
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <QueueSummary items={queueItems} activeQueue={activeQueue} onSelect={setActiveQueue} />
          <div className="rounded-[8px] border border-slate-200 overflow-hidden">
            <div className="flex items-center justify-between border-b bg-slate-50 px-4 py-3">
              <div>
                <div className="text-sm font-semibold text-slate-900">{activeQueueItem.label}</div>
                <div className="text-xs text-slate-500">{activeQueueItem.count} open</div>
              </div>
              {commandMutation.isPending && <Badge variant="outline" className="text-[10px]">Saving</Badge>}
            </div>
            {operationalLoading ? (
              <div className="p-4 text-sm text-slate-500">Loading operational queue...</div>
            ) : (
              <OperationalReviewRows
                queueId={activeQueueItem.id}
                rows={activeQueueItem.rows}
                onCommand={handleReviewCommand}
                commandPending={commandMutation.isPending}
              />
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3 flex flex-row items-center justify-between gap-3">
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-blue-600" />
            Automation & Exceptions
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              disabled={generateOccurrencesMutation.isPending}
              onClick={() => generateOccurrencesMutation.mutate()}
            >
              <RefreshCw className="w-4 h-4" />
              Generate obligations
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              disabled={!propertiesQuery.data?.[0]?.id || runControlsMutation.isPending}
              onClick={() => runControlsMutation.mutate()}
            >
              <RefreshCw className="w-4 h-4" />
              Run controls
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {operationalLoading ? (
            <div className="p-4 text-sm text-slate-500">Loading operational state...</div>
          ) : (
            <OperationalDomainTable domains={operationalDomains} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-600" />
            Due / Overdue Obligations
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {operationalLoading ? (
            <div className="p-4 text-sm text-slate-500">Loading obligation occurrences...</div>
          ) : (
            <DueObligationRows rows={operationalRows.occurrences || []} />
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-blue-600" />
            Major Client Capability Coverage
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-4 text-sm text-slate-500">Loading readiness signals...</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-50">
                  <TableHead className="text-[11px]">CAPABILITY</TableHead>
                  <TableHead className="text-[11px]">STATUS</TableHead>
                  <TableHead className="text-[11px]">COVERAGE</TableHead>
                  <TableHead className="text-[11px] text-right">DONE</TableHead>
                  <TableHead className="text-[11px] text-right">BLOCKERS</TableHead>
                  <TableHead className="text-[11px]">EVIDENCE</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {readiness.capabilities.map((item) => <CapabilityRow key={item.id} item={item} />)}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Gauge className="w-4 h-4 text-blue-600" />
            CPI / Reference Observations
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {operationalLoading ? (
            <div className="p-4 text-sm text-slate-500">Loading reference observations...</div>
          ) : (
            <ReferenceObservationRows rows={operationalRows.referenceData || []} selections={operationalRows.referenceSeries || []} />
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <FileText className="w-4 h-4 text-blue-600" />
            Financial Controls Lite
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ControlRows controls={readiness.controls.controls} />
        </CardContent>
      </Card>
    </div>
  );
}




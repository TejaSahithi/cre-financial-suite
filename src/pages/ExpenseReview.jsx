import React, { useEffect, useMemo, useState } from "react";
import { useAssistantPageContext } from "@/assistant/useAssistantContext";
import { Link, useLocation } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightCircle, CheckCircle2, ChevronDown, ClipboardCheck, Download, Eye, FileText, Loader2, MoreHorizontal, RefreshCw, Search, ShieldAlert } from "lucide-react";
import { toast } from "sonner";

import MetricCard from "@/components/MetricCard";
import PageHeader from "@/components/PageHeader";
import ScopeSelector from "@/components/ScopeSelector";
import SendForApprovalButton from "@/components/approvals/SendForApprovalButton";
import useOrgQuery from "@/hooks/useOrgQuery";
import { buildHierarchyScope, getScopeSubtitle, matchesHierarchyScope } from "@/lib/hierarchyScope";
import { resolveTenantForExpense } from "@/lib/tenantResolver";
import { expenseService } from "@/services/expenseService";
import { resolveExpenseClassificationCondition } from "@/services/expenseClassificationWorkflowService";
import { createNotificationsForEvent } from "@/services/notificationService";
import { supabase } from "@/services/supabaseClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { createPageUrl } from "@/utils";
import {
  buildExpenseReviewReportRows,
  buildExpenseReviewUiRow,
  calculateExpenseReviewTieOut,
  canSendExpenseReviewRowToCam,
  filterFinalizedExpenseReviewRows,
  getExpenseReviewExceptionCounts,
  isExpenseReviewException,
  isExpenseReviewOutsideCamFinalized,
} from "@/components/expense-review/utils/expenseReviewUiContract";

// Expense Review's frozen scope is outside-CAM only -- Pooled CAM and Direct
// Recovery are CAM routes, managed on Lease Expense Classification / CAM.
const FINALIZED_FILTERS = [
  { value: "all", label: "All Outside CAM" },
  { value: "direct_bill", label: "Direct Bill" },
  { value: "tenant_direct", label: "Tenant Direct" },
  { value: "included_in_rent", label: "Included in Rent" },
  { value: "nonrecoverable", label: "Nonrecoverable" },
];

function formatCurrency(value, options = {}) {
  return Number(value || 0).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: options.compact ? 0 : 2,
    maximumFractionDigits: options.compact ? 0 : 2,
  });
}

function formatDate(value) {
  if (!value) return "-";
  const text = String(value);
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const parsed = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    : new Date(value);
  if (Number.isNaN(parsed.getTime())) return text;
  return parsed.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function compactScope(parts) {
  return parts.filter((part) => part && part !== "-").join(" / ") || "Unscoped";
}

function v1BadgeClassName(tone) {
  if (tone === "emerald") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (tone === "blue") return "border-blue-200 bg-blue-50 text-blue-700";
  if (tone === "indigo") return "border-blue-200 bg-blue-50 text-blue-700";
  if (tone === "amber") return "border-amber-200 bg-amber-50 text-amber-800";
  if (tone === "red") return "border-red-200 bg-red-50 text-red-700";
  return "border-slate-200 bg-slate-50 text-slate-700";
}

function downloadBlob(content, filename, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

function buildReportFilename(extension) {
  return `expense-review-v1-${new Date().toISOString().slice(0, 10)}.${extension}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function exportExcel(rows) {
  const reportRows = buildExpenseReviewReportRows(rows);
  if (!reportRows.length) return toast.info("No finalized expenses to export.");
  const XLSX = await import("xlsx");
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(reportRows), "Finalized Expenses");
  XLSX.writeFile(workbook, buildReportFilename("xlsx"));
}

async function exportPdf(rows, tieOut) {
  const reportRows = buildExpenseReviewReportRows(rows);
  if (!reportRows.length) return toast.info("No finalized expenses to export.");
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "letter" });
  let y = 36;
  doc.setFontSize(14);
  doc.text("Expense Review V1 - Finalized Expenses", 36, y);
  y += 22;
  doc.setFontSize(9);
  doc.text(`Total Finalized (Outside CAM): ${formatCurrency(tieOut.totalFinalized)}   Rows: ${tieOut.rows}   Direct Bill: ${formatCurrency(tieOut.directBill)}   Tenant Direct: ${formatCurrency(tieOut.tenantDirect)}   Included in Rent: ${formatCurrency(tieOut.includedInRent)}   Nonrecoverable: ${formatCurrency(tieOut.nonrecoverable)}`, 36, y);
  y += 20;
  const columns = ["Date", "Vendor", "Property", "Tenant", "Category", "Amount", "Decision", "CAM Status"];
  const widths = [62, 110, 120, 110, 105, 70, 92, 92];
  doc.setFontSize(7);
  columns.forEach((column, index) => doc.text(column, 36 + widths.slice(0, index).reduce((sum, width) => sum + width, 0), y));
  y += 12;
  reportRows.slice(0, 120).forEach((row) => {
    if (y > 560) {
      doc.addPage();
      y = 36;
    }
    const values = [row.Date, row.Vendor, row.Property, row.Tenant, row.Category, formatCurrency(row.Amount, { compact: true }), row.Decision, row["CAM Status"]];
    values.forEach((value, index) => {
      const x = 36 + widths.slice(0, index).reduce((sum, width) => sum + width, 0);
      doc.text(String(value || "-").slice(0, index === 4 ? 20 : 24), x, y, { maxWidth: widths[index] - 6 });
    });
    y += 12;
  });
  doc.save(buildReportFilename("pdf"));
}

function exportWord(rows, tieOut) {
  const reportRows = buildExpenseReviewReportRows(rows);
  if (!reportRows.length) return toast.info("No finalized expenses to export.");
  const headers = Object.keys(reportRows[0]);
  const htmlRows = reportRows.map((row) => `<tr>${headers.map((header) => `<td>${escapeHtml(row[header])}</td>`).join("")}</tr>`).join("");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Expense Review V1</title><style>body{font-family:Arial,sans-serif;color:#111827}table{border-collapse:collapse;width:100%;font-size:10pt}th,td{border:1px solid #cbd5e1;padding:5px;text-align:left}th{background:#f1f5f9}</style></head><body><h1>Expense Review V1 - Finalized Expenses (Outside CAM)</h1><p>Total Finalized: ${formatCurrency(tieOut.totalFinalized)} | Rows: ${tieOut.rows} | Direct Bill: ${formatCurrency(tieOut.directBill)} | Tenant Direct: ${formatCurrency(tieOut.tenantDirect)} | Included in Rent: ${formatCurrency(tieOut.includedInRent)} | Nonrecoverable: ${formatCurrency(tieOut.nonrecoverable)}</p><table><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${htmlRows}</tbody></table></body></html>`;
  downloadBlob(html, buildReportFilename("doc"), "application/msword;charset=utf-8");
}

export default function ExpenseReview() {
  const location = useLocation();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [finalizedFilter, setFinalizedFilter] = useState("all");
  const [scopeProperty, setScopeProperty] = useState("all");
  const [scopeBuilding, setScopeBuilding] = useState("all");
  const [scopeUnit, setScopeUnit] = useState("all");
  const [detailRow, setDetailRow] = useState(null);

  const { data: leases = [], orgId } = useOrgQuery("Lease");
  const { data: properties = [] } = useOrgQuery("Property");
  const { data: allBuildings = [] } = useOrgQuery("Building");
  const { data: allUnits = [] } = useOrgQuery("Unit");
  const { data: portfolios = [] } = useOrgQuery("Portfolio");
  const { data: tenants = [] } = useOrgQuery("Tenant");
  const { data: actualExpenseRecords = [] } = useOrgQuery("Expense");

  const scope = useMemo(
    () => buildHierarchyScope({ search: location.search, portfolios, properties, buildings: allBuildings, units: allUnits }),
    [location.search, portfolios, properties, allBuildings, allUnits]
  );

  useEffect(() => {
    setScopeProperty(scope.propertyId || "all");
    setScopeBuilding(scope.buildingId || "all");
    setScopeUnit(scope.unitId || "all");
  }, [scope.propertyId, scope.buildingId, scope.unitId]);

  useAssistantPageContext({
    page: "ExpenseReview",
    entities: { propertyId: scope.propertyId || undefined, portfolioId: scope.portfolioId || undefined },
  });

  const scopedLeases = useMemo(() => leases.filter((lease) => {
    if (!matchesHierarchyScope(lease, scope, { portfolioKey: "portfolio_id", propertyKey: "property_id", buildingKey: "building_id", unitKey: "unit_id" })) return false;
    if (scopeProperty !== "all" && lease.property_id !== scopeProperty) return false;
    if (scopeBuilding !== "all" && lease.building_id && lease.building_id !== scopeBuilding) return false;
    if (scopeUnit !== "all" && lease.unit_id && lease.unit_id !== scopeUnit) return false;
    return true;
  }), [leases, scope, scopeProperty, scopeBuilding, scopeUnit]);

  const classificationScope = useMemo(() => ({
    property_id: scopeProperty !== "all" ? scopeProperty : "all",
    building_id: scopeBuilding !== "all" ? scopeBuilding : "all",
    unit_id: scopeUnit !== "all" ? scopeUnit : "all",
  }), [scopeProperty, scopeBuilding, scopeUnit]);

  const resolverScope = useMemo(() => ({
    property_id: scopeProperty,
    building_id: scopeBuilding,
    unit_id: scopeUnit,
    lease_id: "all",
    tenant_id: "all",
    fiscal_year: new Date().getFullYear(),
  }), [scopeProperty, scopeBuilding, scopeUnit]);

  const { data: scopedClassifications = [], isLoading: isLoadingClassifications } = useQuery({
    queryKey: ["expense-review-classifications", scopeProperty, scopeBuilding, scopeUnit],
    queryFn: () => expenseService.listExpenseClassificationsForScope(classificationScope),
  });

  const actualExpenseById = useMemo(
    () => new Map((actualExpenseRecords || []).map((expense) => [expense.id, expense])),
    [actualExpenseRecords]
  );

  const reviewRows = useMemo(() => scopedClassifications
    .filter((row) => (row.actual_expense_id || row.expense_id) && row.row_type !== "rule_missing_actual")
    .map((row) => {
      const expenseId = row.actual_expense_id || row.expense_id;
      const actualExpense = actualExpenseById.get(expenseId) || {};
      const actualExpenseCategoryId = actualExpense.expense_category_id || actualExpense.category_id || actualExpense.canonical_category_id || null;
      const effectiveRow = {
        ...actualExpense,
        ...row,
        property_id: row.property_id || actualExpense.property_id || null,
        building_id: row.building_id || actualExpense.building_id || null,
        unit_id: row.unit_id || actualExpense.unit_id || null,
        lease_id: row.lease_id || actualExpense.lease_id || null,
        tenant_id: row.tenant_id || actualExpense.tenant_id || null,
      };
      const property = effectiveRow.property_id ? scope.propertyById.get(effectiveRow.property_id) ?? null : null;
      const building = effectiveRow.building_id ? scope.buildingById.get(effectiveRow.building_id) ?? null : null;
      const unit = effectiveRow.unit_id ? scope.unitById.get(effectiveRow.unit_id) ?? null : null;
      const tenantResolution = resolveTenantForExpense(effectiveRow, { leases, units: allUnits, tenants });
      return {
        ...row,
        id: row.id,
        expense_id: expenseId,
        actual_expense_id: expenseId,
        amount: Number(row.amount ?? actualExpense.amount ?? 0),
        category: row.category || actualExpense.category || null,
        expense_category_id: actualExpenseCategoryId || row.expense_category_id || null,
        actual_expense_category_id: actualExpenseCategoryId,
        classification_expense_category_id: row.expense_category_id || null,
        expense_subcategory: row.subcategory || actualExpense.subcategory || actualExpense.expense_subcategory || null,
        description: row.description || actualExpense.description || null,
        service_period_start: row.service_period_start || actualExpense.service_period_start || actualExpense.expense_date || actualExpense.date || null,
        service_period_end: row.service_period_end || actualExpense.service_period_end || actualExpense.expense_date || actualExpense.date || null,
        property_id: effectiveRow.property_id,
        building_id: effectiveRow.building_id,
        unit_id: effectiveRow.unit_id,
        property_name: property?.name || row.property_name || actualExpense.property_name || null,
        building_name: building?.name || row.building_name || actualExpense.building_name || null,
        unit_name: unit?.unit_number || unit?.unit_id_code || row.unit_name || actualExpense.unit_name || null,
        tenant_name: row.tenant_name || actualExpense.tenant_name || tenantResolution.tenant?.name || null,
        vendor_name: row.vendor_name || actualExpense.vendor_name || actualExpense.vendor || null,
        vendor: row.vendor || actualExpense.vendor || actualExpense.vendor_name || null,
        lease_id: effectiveRow.lease_id || tenantResolution.lease?.id || null,
        tenant_id: effectiveRow.tenant_id || tenantResolution.tenant?.id || null,
        recovery_rule_id: row.lease_expense_rule_id || row.recovery_rule_id || null,
        evidence_text: row.evidence_text || row.recovery_reason || row.notes || null,
      };
    }), [scopedClassifications, actualExpenseById, scope.propertyById, scope.buildingById, scope.unitById, leases, allUnits, tenants]);

  const finalizedBaseRows = useMemo(() => reviewRows.filter((row) => isExpenseReviewOutsideCamFinalized(row)), [reviewRows]);
  const finalizedClassificationIds = useMemo(() => finalizedBaseRows.map((expense) => expense.id).filter(Boolean), [finalizedBaseRows]);

  const { data: publishedCamInputs = [], isLoading: isLoadingCamInputs } = useQuery({
    queryKey: ["expense-review-published-cam-inputs", finalizedClassificationIds.join("|")],
    queryFn: async () => {
      if (finalizedClassificationIds.length === 0) return [];
      const { data, error } = await supabase
        .from("cam_expense_inputs")
        .select("id, classification_result_id, actual_expense_id, amount, eligible_amount, actual_amount, status, publication_status, sent_to_cam_at, recovery_method, cam_input_type, input_type, allocation_basis")
        .in("classification_result_id", finalizedClassificationIds)
        .eq("publication_status", "published");
      if (error) {
        console.warn("[ExpenseReview] published CAM input query failed:", error.message);
        return [];
      }
      return data || [];
    },
    enabled: finalizedClassificationIds.length > 0,
  });

  const publishedCamInputByClassificationId = useMemo(() => {
    const map = new Map();
    for (const row of publishedCamInputs) {
      if (row?.classification_result_id) map.set(row.classification_result_id, row);
    }
    return map;
  }, [publishedCamInputs]);

  const exceptionRows = useMemo(() => reviewRows.filter((row) => isExpenseReviewException(row)).map((row) => buildExpenseReviewUiRow(row)), [reviewRows]);
  const finalizedRows = useMemo(() => finalizedBaseRows.map((row) => buildExpenseReviewUiRow(row, { publishedInput: publishedCamInputByClassificationId.get(row.id) })), [finalizedBaseRows, publishedCamInputByClassificationId]);
  const exceptionCounts = useMemo(() => getExpenseReviewExceptionCounts(exceptionRows), [exceptionRows]);
  const finalizedSummary = useMemo(() => calculateExpenseReviewTieOut(finalizedRows, publishedCamInputByClassificationId), [finalizedRows, publishedCamInputByClassificationId]);

  const visibleFinalizedRows = useMemo(() => {
    const filtered = filterFinalizedExpenseReviewRows(finalizedRows, finalizedFilter);
    if (!search.trim()) return filtered;
    const needle = search.trim().toLowerCase();
    return filtered.filter((expense) => [
      expense.property_name, expense.building_name, expense.unit_name, expense.tenant_name,
      expense.vendor_name, expense.vendor, expense.category, expense.expense_subcategory,
      expense.description, expense.evidence_text, expense.v1Decision?.label, expense.v1CamStatus?.label,
    ].filter(Boolean).join(" ").toLowerCase().includes(needle));
  }, [finalizedRows, finalizedFilter, search]);

  const subtitle = getScopeSubtitle(scope, {
    default: `${finalizedSummary.rows} finalized expense classifications totaling ${formatCurrency(finalizedSummary.totalFinalized)} in scope`,
    portfolio: (portfolio) => `${finalizedSummary.rows} finalized expense classifications totaling ${formatCurrency(finalizedSummary.totalFinalized)} in ${portfolio.name}`,
    property: (property) => `${finalizedSummary.rows} finalized expense classifications totaling ${formatCurrency(finalizedSummary.totalFinalized)} for ${property.name}`,
    building: (building) => `${finalizedSummary.rows} finalized expense classifications totaling ${formatCurrency(finalizedSummary.totalFinalized)} for ${building.name}`,
    unit: (unit) => `${finalizedSummary.rows} finalized expense classifications totaling ${formatCurrency(finalizedSummary.totalFinalized)} for ${unit.unit_number || unit.unit_id_code || "selected unit"}`,
    org: () => `${finalizedSummary.rows} finalized expense classifications totaling ${formatCurrency(finalizedSummary.totalFinalized)} across the organization`,
  });
  const approvalProperty = scopeProperty !== "all"
    ? properties.find((property) => property.id === scopeProperty)
    : null;
  const expenseApprovalLabel = approvalProperty?.name
    ? `${approvalProperty.name} Expense Review`
    : "Expense Review";
  const expenseApprovalEntityId = (scopeProperty !== "all" && scopeProperty) || orgId;

  const invalidateReviewQueries = () => {
    queryClient.invalidateQueries({ queryKey: ["expense-review-classifications"] });
    queryClient.invalidateQueries({ queryKey: ["expense-review-published-cam-inputs"] });
    queryClient.invalidateQueries({ queryKey: ["expense-recoverability-workspace"] });
    queryClient.invalidateQueries({ queryKey: ["expense-recoverability-diagnostics"] });
    queryClient.invalidateQueries({ queryKey: ["Expense"] });
    queryClient.invalidateQueries({ queryKey: ["cam-overview-expenses"] });
    queryClient.invalidateQueries({ queryKey: ["cam_expense_inputs_published"] });
  };

  const runClassificationMutation = useMutation({
    mutationFn: () => expenseService.runExpenseClassification(resolverScope),
    onSuccess: () => {
      toast.success("Classification resolver refreshed");
      invalidateReviewQueries();
    },
    onError: (error) => toast.error(error?.message || "Classification run failed"),
  });

  const resolveConditionMutation = useMutation({
    mutationFn: async (row) => {
      const wantsRecoverable = window.confirm(`Resolve the condition on "${row.vendor_name || row.vendor || row.category || "this expense"}".\n\nOK = Recoverable\nCancel = Nonrecoverable`);
      const resolution = wantsRecoverable ? "recoverable" : "non_recoverable";
      const reason = window.prompt(`Reason for marking this expense ${resolution.replace("_", " ")}:`);
      if (!reason || !reason.trim()) throw new Error("A reason is required to resolve a conditional expense.");
      return resolveExpenseClassificationCondition({ classificationId: row.id, resolution, reason: reason.trim() });
    },
    onSuccess: () => {
      toast.success("Condition resolved. Rerun Classification to refresh the route if needed.");
      invalidateReviewQueries();
    },
    onError: (error) => toast.error(error?.message || "Could not resolve condition"),
  });

  const sendToCamMutation = useMutation({
    mutationFn: async (row) => {
      const publishedInput = publishedCamInputByClassificationId.get(row.id);
      if (!canSendExpenseReviewRowToCam(row, publishedInput)) throw new Error("Only finalized Pooled CAM and Direct Recovery rows that are ready to publish can be sent to CAM.");
      const reason = window.prompt("Reason for publishing this finalized classification to CAM:", "Published from Expense Review V1 after finalized classification");
      if (!reason || !reason.trim()) throw new Error("A reason is required to send an expense to CAM.");
      return expenseService.sendClassificationToCam(row, { reason: reason.trim() });
    },
    onSuccess: (_result, row) => {
      if (row?.org_id) {
        createNotificationsForEvent({
          org_id: row.org_id,
          event_type: "cam.eligible",
          entity_type: "expense",
          entity_id: row.expense_id || row.actual_expense_id || row.id,
          entity_label: row.vendor_name || row.vendor || row.category || "CAM Eligible Expense",
          portfolio_id: row.portfolio_id || null,
          property_id: row.property_id || (scopeProperty !== "all" ? scopeProperty : null),
          action_url: createPageUrl("ExpenseReview"),
          metadata: {
            source: "expense_review_send_to_cam",
            classification_id: row.id,
          },
        }).catch((error) => {
          console.warn("[ExpenseReview] cam.eligible notification failed:", error?.message || error);
        });
      }
      toast.success("Sent to CAM using the existing publication workflow");
      invalidateReviewQueries();
    },
    onError: (error) => toast.error(error?.message || "Could not send to CAM"),
  });

  return (
    <div className="p-4 lg:p-6 space-y-5">
      <PageHeader icon={ClipboardCheck} title="Expense Review" subtitle={subtitle} iconColor="from-slate-900 to-slate-700">
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => runClassificationMutation.mutate()} disabled={runClassificationMutation.isPending}>
            {runClassificationMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            Run Classification
          </Button>
          <Link to={createPageUrl("LeaseExpenseClassification")}>
            <Button variant="outline" size="sm"><FileText className="mr-2 h-4 w-4" />Expense Classification</Button>
          </Link>
        </div>
      </PageHeader>

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

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <MetricCard label="Total Finalized" value={formatCurrency(finalizedSummary.totalFinalized)} sub="outside-CAM routes only" />
        <MetricCard label="Rows" value={finalizedSummary.rows} sub="finalized classifications" />
        <MetricCard label="Direct Bill" value={formatCurrency(finalizedSummary.directBill)} sub="route to billing" />
        <MetricCard label="Tenant Direct" value={formatCurrency(finalizedSummary.tenantDirect)} sub="tenant pays vendor" />
        <MetricCard label="Included in Rent / Nonrecoverable" value={formatCurrency(finalizedSummary.includedInRent + finalizedSummary.nonrecoverable)} sub="no separate recovery" />
      </div>

      <Card className={finalizedSummary.tieOutOk ? "border-emerald-200 bg-emerald-50/60" : "border-red-200 bg-red-50/70"}>
        <CardContent className="flex flex-col gap-2 py-4 text-sm lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-start gap-2">
            {finalizedSummary.tieOutOk ? <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-600" /> : <ShieldAlert className="mt-0.5 h-4 w-4 text-red-600" />}
            <div>
              <p className={finalizedSummary.tieOutOk ? "font-semibold text-emerald-800" : "font-semibold text-red-800"}>{finalizedSummary.tieOutOk ? "Financial Tie-Out Complete" : "Financial Tie-Out Mismatch"}</p>
              <p className="text-xs text-slate-600">Total Finalized Expense Amount = Direct Bill + Tenant Direct + Included in Rent + Nonrecoverable. Pooled CAM and Direct Recovery are managed on Lease Expense Classification / CAM, not here.</p>
            </div>
          </div>
          <div className="text-xs text-slate-600 lg:text-right">
            <div>Route total: {formatCurrency(finalizedSummary.routeTotal)}</div>
            <div>Exception queue dollars are separate: {formatCurrency(exceptionCounts.amount)}</div>
          </div>
        </CardContent>
      </Card>

      <Card className="border-amber-200">
        <CardHeader className="flex flex-row items-start justify-between gap-3 pb-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base"><ShieldAlert className="h-4 w-4 text-amber-600" />Exception Queue</CardTitle>
            <p className="mt-1 text-xs text-slate-500">Expenses that require a human decision before classification can be finalized. Resolve the missing information or policy condition below. Finalizing does not automatically publish an expense to CAM.</p>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Badge className="bg-amber-100 text-amber-800 text-[10px] uppercase">{exceptionCounts.missingInformation} Missing Information</Badge>
            <Badge className="bg-amber-100 text-amber-800 text-[10px] uppercase">{exceptionCounts.conditional} Conditional</Badge>
            <Badge className="bg-red-100 text-red-700 text-[10px] uppercase">{exceptionCounts.policyConflict} Policy Conflict</Badge>
            <Badge className="bg-slate-200 text-slate-700 text-[10px] uppercase">{exceptionCounts.otherReview} Other Review</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <ExceptionQueueTable
            rows={exceptionRows}
            isLoading={isLoadingClassifications}
            onOpenDetail={setDetailRow}
            onResolveCondition={(row) => resolveConditionMutation.mutate(row)}
            isResolving={resolveConditionMutation.isPending}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <CardTitle className="text-base">Finalized Expenses</CardTitle>
              <p className="mt-1 text-xs text-slate-500">Finalized outside-CAM classifications for the selected scope: Direct Bill, Tenant Direct, Included in Rent, and Nonrecoverable. Pooled CAM and Direct Recovery routes are managed on Lease Expense Classification / CAM.</p>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" disabled={visibleFinalizedRows.length === 0}><Download className="mr-2 h-4 w-4" />Export Report<ChevronDown className="ml-2 h-4 w-4" /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-slate-500">Finalized rows only</DropdownMenuLabel>
                <DropdownMenuItem onClick={() => exportExcel(visibleFinalizedRows)}>Excel</DropdownMenuItem>
                <DropdownMenuItem onClick={() => exportPdf(visibleFinalizedRows, finalizedSummary)}>PDF</DropdownMenuItem>
                <DropdownMenuItem onClick={() => exportWord(visibleFinalizedRows, finalizedSummary)}>Word</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap gap-2">
              {FINALIZED_FILTERS.map((filter) => (
                <Button key={filter.value} type="button" variant={finalizedFilter === filter.value ? "default" : "outline"} size="sm" className={finalizedFilter === filter.value ? "bg-slate-900 hover:bg-slate-800" : ""} onClick={() => setFinalizedFilter(filter.value)}>
                  {filter.label}
                </Button>
              ))}
            </div>
            <div className="relative w-full max-w-sm">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search finalized expenses..." className="pl-9" />
            </div>
          </div>
          <FinalizedExpensesTable rows={visibleFinalizedRows} isLoading={isLoadingClassifications || isLoadingCamInputs} filter={finalizedFilter} onOpenDetail={setDetailRow} onSendToCam={(row) => sendToCamMutation.mutate(row)} isSendingToCam={sendToCamMutation.isPending} />
        </CardContent>
      </Card>

      <div className="flex justify-end border-t border-slate-200 pt-4">
        <SendForApprovalButton
          orgId={orgId}
          eventType="expense.final_approval_required"
          entityType="expense"
          entityId={expenseApprovalEntityId}
          entityLabel={expenseApprovalLabel}
          portfolioId={scope.portfolioId || null}
          propertyId={scopeProperty !== "all" ? scopeProperty : scope.propertyId || null}
          actionUrl={createPageUrl("ExpenseReview") + location.search}
          disabled={!expenseApprovalEntityId || orgId === "__none__" || finalizedSummary.rows === 0}
          metadata={{
            source: "expense_review_manual_send_for_approval",
            finalized_rows: finalizedSummary.rows,
            finalized_total: finalizedSummary.totalFinalized,
          }}
        />
      </div>

      <ExpenseReviewDetailDrawer row={detailRow} open={Boolean(detailRow)} onOpenChange={(open) => !open && setDetailRow(null)} />
    </div>
  );
}

function ExceptionQueueTable({ rows, isLoading, onOpenDetail, onResolveCondition, isResolving }) {
  if (isLoading) return <LoadingState label="Loading exceptions..." />;
  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-emerald-200 bg-emerald-50 px-4 py-6 text-center text-sm text-emerald-800">
        <CheckCircle2 className="mx-auto mb-2 h-5 w-5" />
        <div className="font-medium">No classification exceptions for this scope.</div>
        <div className="mt-1 text-xs text-emerald-700">New exceptions will appear here when an approved expense requires missing information, conditional review, or policy resolution.</div>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border border-slate-200">
      <Table>
        <TableHeader className="bg-slate-50">
          <TableRow>
            <TableHead className="text-[10px] uppercase">Expense</TableHead>
            <TableHead className="text-[10px] uppercase">Scope</TableHead>
            <TableHead className="text-[10px] uppercase text-right">Amount</TableHead>
            <TableHead className="text-[10px] uppercase">Issue</TableHead>
            <TableHead className="text-[10px] uppercase">Policy Evidence</TableHead>
            <TableHead className="text-[10px] uppercase">Required Decision</TableHead>
            <TableHead className="text-[10px] uppercase text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id} className="hover:bg-slate-50">
              <TableCell className="min-w-[210px] text-xs">
                <div className="font-medium text-slate-900">{row.category || "Needs Category"}</div>
                <div className="mt-1 text-slate-500">{formatDate(row.service_period_start || row.service_period_end || row.classified_at)}</div>
                <div className="text-slate-500">{row.vendor_name || row.vendor || "Vendor not specified"}</div>
              </TableCell>
              <TableCell className="min-w-[220px] text-xs text-slate-600">
                <div>{compactScope([row.property_name, row.building_name, row.unit_name])}</div>
                {row.tenant_name && <div className="mt-1 text-slate-500">{row.tenant_name}</div>}
              </TableCell>
              <TableCell className="text-right text-xs font-semibold tabular-nums">{formatCurrency(row.amount)}</TableCell>
              <TableCell><Badge variant="outline" className={`text-[10px] font-semibold ${v1BadgeClassName(row.v1Issue?.tone)}`}>{row.v1Issue?.label || "Review required"}</Badge></TableCell>
              <TableCell><Badge variant="outline" className={`text-[10px] font-semibold ${v1BadgeClassName(row.v1PolicyEvidence?.tone)}`}>{row.v1PolicyEvidence?.label || "Reviewed Override"}</Badge></TableCell>
              <TableCell className="text-xs font-medium text-slate-700">{row.v1Issue?.requiredDecision || "Review Classification"}</TableCell>
              <TableCell className="text-right"><ExceptionAction row={row} onOpenDetail={onOpenDetail} onResolveCondition={onResolveCondition} isResolving={isResolving} /></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function ExceptionAction({ row, onOpenDetail, onResolveCondition, isResolving }) {
  const issue = row.v1Issue?.decision;
  if (["needs_category", "needs_scope", "needs_service_period", "needs_tenant_lease"].includes(issue)) {
    return (
      <div className="flex items-center justify-end gap-1">
        <Link to={createPageUrl("Expenses", { expense_id: row.actual_expense_id || row.expense_id })}>
          <Button size="sm" variant="outline" className="h-8 text-xs">{row.v1Issue.requiredDecision}</Button>
        </Link>
        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => onOpenDetail(row)} title="View details"><Eye className="h-4 w-4" /></Button>
      </div>
    );
  }
  if (issue === "conditional_review") {
    return (
      <div className="flex items-center justify-end gap-1">
        <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => onResolveCondition(row)} disabled={isResolving}>{isResolving ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}Resolve Condition</Button>
        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => onOpenDetail(row)} title="View details"><Eye className="h-4 w-4" /></Button>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-end gap-1">
      <Link to={createPageUrl("LeaseExpenseClassification", { expense_id: row.actual_expense_id || row.expense_id, lease_id: row.lease_id })}>
        <Button size="sm" variant="outline" className="h-8 text-xs">{row.v1Issue?.requiredDecision || "Review Classification"}</Button>
      </Link>
      <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => onOpenDetail(row)} title="View details"><Eye className="h-4 w-4" /></Button>
    </div>
  );
}

function FinalizedExpensesTable({ rows, isLoading, filter, onOpenDetail, onSendToCam, isSendingToCam }) {
  if (isLoading) return <LoadingState label="Loading finalized expenses..." />;
  if (rows.length === 0) return <FinalizedEmptyState filter={filter} />;

  return (
    <div className="overflow-x-auto rounded-md border border-slate-200">
      <Table>
        <TableHeader className="bg-slate-50">
          <TableRow>
            <TableHead className="text-[10px] uppercase">Expense</TableHead>
            <TableHead className="text-[10px] uppercase">Scope</TableHead>
            <TableHead className="text-[10px] uppercase">Vendor / Tenant</TableHead>
            <TableHead className="text-[10px] uppercase text-right">Amount</TableHead>
            <TableHead className="text-[10px] uppercase">Decision</TableHead>
            <TableHead className="text-[10px] uppercase">CAM Status</TableHead>
            <TableHead className="text-[10px] uppercase">Finalized</TableHead>
            <TableHead className="text-[10px] uppercase">Source / Evidence</TableHead>
            <TableHead className="text-[10px] uppercase text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id} className="hover:bg-slate-50">
              <TableCell className="min-w-[190px] text-xs"><div className="font-medium text-slate-900">{row.category || "Expense"}</div><div className="mt-1 text-slate-500">{formatDate(row.service_period_start || row.service_period_end || row.classified_at)}</div></TableCell>
              <TableCell className="min-w-[190px] text-xs text-slate-600">{compactScope([row.property_name, row.building_name, row.unit_name])}</TableCell>
              <TableCell className="min-w-[160px] text-xs text-slate-600"><div>{row.vendor_name || row.vendor || "Vendor not specified"}</div>{row.tenant_name && <div className="mt-1 text-slate-500">{row.tenant_name}</div>}</TableCell>
              <TableCell className="text-right text-xs font-semibold tabular-nums">{formatCurrency(row.amount)}</TableCell>
              <TableCell><Badge variant="outline" className={`text-[10px] font-semibold ${v1BadgeClassName(row.v1Decision?.tone)}`}>{row.v1Decision?.label}</Badge></TableCell>
              <TableCell className="max-w-[170px]" title={row.v1CamStatus?.reason || ""}>
                <Badge variant="outline" className={`text-[10px] font-semibold ${v1BadgeClassName(row.v1CamStatus?.tone)}`}>{row.v1CamStatus?.label}</Badge>
                {row.v1CamStatus?.label === "Blocked" && <div className="mt-1 text-[10px] text-red-700">{row.v1CamStatus.reason}</div>}
              </TableCell>
              <TableCell className="text-xs text-slate-600">{formatDate(row.finalized_at || row.reviewed_at || row.updated_at)}</TableCell>
              <TableCell className="max-w-[220px] text-xs text-slate-600"><Badge variant="outline" className={`mb-1 text-[10px] font-semibold ${v1BadgeClassName(row.v1PolicyEvidence?.tone)}`}>{row.v1PolicyEvidence?.label}</Badge><div className="truncate" title={row.evidence_text || row.recovery_reason || ""}>{row.evidence_text || row.recovery_reason || "-"}</div></TableCell>
              <TableCell className="text-right"><FinalizedActions row={row} onOpenDetail={onOpenDetail} onSendToCam={onSendToCam} isSendingToCam={isSendingToCam} /></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function FinalizedActions({ row, onOpenDetail, onSendToCam, isSendingToCam }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="h-8 w-8 hover:bg-slate-100"><MoreHorizontal className="h-4 w-4 text-slate-500" /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem onClick={() => onOpenDetail(row)}><Eye className="mr-2 h-4 w-4 text-slate-500" />Details</DropdownMenuItem>
        <DropdownMenuItem asChild><Link to={createPageUrl("Expenses", { expense_id: row.actual_expense_id || row.expense_id })}><FileText className="mr-2 h-4 w-4 text-slate-500" />View Actual Expense</Link></DropdownMenuItem>
        {row.v1CanSendToCam && <><DropdownMenuSeparator /><DropdownMenuItem onClick={() => onSendToCam(row)} disabled={isSendingToCam}><ArrowRightCircle className="mr-2 h-4 w-4 text-blue-600" />Send to CAM</DropdownMenuItem></>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LoadingState({ label }) {
  return <div className="flex items-center justify-center gap-2 rounded-md border border-slate-200 py-10 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />{label}</div>;
}

function FinalizedEmptyState({ filter }) {
  const message = filter === "all"
    ? "No finalized outside-CAM expense classifications for this scope."
    : `No finalized ${filter.replace(/_/g, " ")} expenses for this scope.`;
  return <div className="rounded-md border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm text-slate-600">{message}</div>;
}

function ExpenseReviewDetailDrawer({ row, open, onOpenChange }) {
  if (!row) return null;
  const diagnostics = {
    resolver_code: row.exception_type || row.classification_status || null,
    policy_ids: { lease_expense_rule_id: row.lease_expense_rule_id || null, recovery_rule_id: row.recovery_rule_id || null },
    condition_evaluation: { condition_resolved: row.condition_resolved ?? null, condition_result: row.condition_result || null },
    match_score: row.confidence_score ?? null,
    scope_evaluation: { property_id: row.property_id || null, building_id: row.building_id || null, unit_id: row.unit_id || null, lease_id: row.lease_id || null, tenant_id: row.tenant_id || null },
    classification_version: row.classification_key || null,
    publication_id: row.sent_to_cam_at ? row.id : null,
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{row.category || row.vendor_name || row.vendor || "Expense classification"}</SheetTitle>
          <SheetDescription>Expense Review V1 details, evidence, CAM state, and audit context.</SheetDescription>
        </SheetHeader>
        <div className="mt-6 space-y-5">
          <DetailSection title="Expense" items={[
            ["Date", formatDate(row.service_period_start || row.service_period_end || row.classified_at)],
            ["Vendor", row.vendor_name || row.vendor || "-"],
            ["Category", row.category || "Needs Category"],
            ["Subcategory", row.expense_subcategory || "-"],
            ["Amount", formatCurrency(row.amount)],
            ["Description", row.description || "-"],
          ]} />
          <DetailSection title="Classification" items={[
            ["Decision", row.v1Decision?.label || "-"],
            ["CAM Status", row.v1CamStatus?.label || "-"],
            ["CAM Blocking Reason", row.v1CamStatus?.label === "Blocked" ? row.v1CamStatus.reason : "-"],
            ["Policy Evidence", row.v1PolicyEvidence?.label || "-"],
            ["Issue", row.v1Issue?.decision !== "resolved" ? row.v1Issue?.label : "-"],
            ["Required Decision", row.v1Issue?.decision !== "resolved" ? row.v1Issue?.requiredDecision : "-"],
          ]} />
          <DetailSection title="Scope" items={[
            ["Property", row.property_name || row.property_id || "-"],
            ["Building / Unit", compactScope([row.building_name, row.unit_name])],
            ["Tenant / Lease", compactScope([row.tenant_name, row.lease_id])],
            ["Service Period", compactScope([formatDate(row.service_period_start), formatDate(row.service_period_end)])],
          ]} />
          <DetailSection title="Policy And CAM" items={[
            ["Recovery Policy ID", row.lease_expense_rule_id || row.recovery_rule_id || "-"],
            ["Rule Source", row.rule_source || "-"],
            ["CAM Eligible", row.cam_eligible || "-"],
            ["CAM Source", row.cam_source || "-"],
            ["CAM Input Type", row.cam_input_type || "-"],
            ["Sent To CAM", row.sent_to_cam ? "Yes" : "No"],
            ["Sent To CAM At", formatDate(row.sent_to_cam_at)],
          ]} />
          <DetailSection title="Evidence" items={[
            ["Evidence", row.evidence_text || "-"],
            ["Recovery Reason", row.recovery_reason || "-"],
            ["Notes", row.notes || "-"],
          ]} />
          <DetailSection title="Audit" items={[
            ["Classified", formatDate(row.classified_at)],
            ["Reviewed", formatDate(row.reviewed_at)],
            ["Finalized", formatDate(row.finalized_at)],
            ["Updated", formatDate(row.updated_at)],
            ["Accounting Status", row.approved_status || "-"],
          ]} />
          <details className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs">
            <summary className="cursor-pointer font-semibold text-slate-700">Show classification diagnostics</summary>
            <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-white p-3 text-[11px] text-slate-700">{JSON.stringify(diagnostics, null, 2)}</pre>
          </details>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function DetailSection({ title, items }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">{title}</h3>
      <div className="rounded-md border border-slate-200">
        {items.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[150px_1fr] gap-3 border-b border-slate-100 px-3 py-2 text-xs last:border-b-0">
            <div className="font-medium text-slate-500">{label}</div>
            <div className="break-words text-slate-800">{value || "-"}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

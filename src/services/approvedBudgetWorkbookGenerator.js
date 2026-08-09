/**
 * approvedBudgetWorkbookGenerator.js
 *
 * Phase 5A: Approved Annual Budget Workbook Generator (Frontend Presentation)
 *
 * Renders a clean 9-sheet Excel workbook (.xlsx) using SheetJS (`xlsx`) from a
 * normalized server payload produced by the `export-data` edge function.
 *
 * The server edge function owns all auth, scope checks, snapshot lineage loading,
 * and financial tie-out assertions. This module handles presentation only:
 *   - Sheet 1: Executive Summary
 *   - Sheet 2: Operating Expense Budget
 *   - Sheet 3: Revenue Budget
 *   - Sheet 4: CAM Recovery Budget
 *   - Sheet 5: Tenant CAM Estimates
 *   - Sheet 6: Monthly Budget
 *   - Sheet 7: Budget Variance
 *   - Sheet 8: Assumptions & Overrides
 *   - Sheet 9: Approval & Audit
 *
 * Watermarking: Locked budgets export as `<Property>_FY<Year>_Approved_Budget.xlsx`.
 * Unlocked/draft budgets export as `<Property>_FY<Year>_DRAFT_Budget.xlsx` with a
 * prominent "DRAFT - UNAPPROVED" banner on every sheet.
 */

import * as XLSX from "xlsx";
import { invokeEdgeFunction } from "@/services/edgeFunctions";
import { toast } from "sonner";

// ─── Formatters & Helpers ───────────────────────────────────────────────────

function fmtNum(val) {
  const n = Number(val);
  return Number.isFinite(n) ? n : 0;
}

function sanitizeFilename(str) {
  return String(str || "").replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_");
}

function autoFitColumns(ws, rows) {
  if (!rows || !rows.length) return;
  const colWidths = [];
  rows.forEach((row) => {
    row.forEach((cell, colIdx) => {
      const len = cell != null ? String(cell).length : 0;
      colWidths[colIdx] = Math.max(colWidths[colIdx] || 10, Math.min(len + 3, 50));
    });
  });
  ws["!cols"] = colWidths.map((w) => ({ wch: w }));
}

// ─── Main Export Service Function ───────────────────────────────────────────

export async function generateApprovedBudgetWorkbook({ budgetId }) {
  if (!budgetId) {
    toast.error("Budget ID is required for export.");
    return;
  }

  const toastId = toast.loading("Requesting approved budget export from server...");

  try {
    // 1. Request normalized server payload from export-data edge function
    const response = await invokeEdgeFunction("export-data", {
      export_type: "approved_budget_workbook",
      budget_id: budgetId,
    });

    if (response?.error) {
      throw new Error(response.message || "Failed to fetch approved budget export payload");
    }

    const payload = response.payload;
    if (!payload || !payload.budget) {
      throw new Error("Invalid export payload returned from server");
    }

    toast.loading("Generating 9-sheet Excel workbook...", { id: toastId });

    const b = payload.budget;
    const p = payload.property;
    const isLocked = Boolean(b.is_locked);
    const lineItems = payload.line_items || [];
    const expBasis = payload.expense_basis || {};
    const camEst = payload.cam_estimate || {};
    const revBase = payload.revenue_baseline || {};
    const snapshotIds = payload.source_snapshot_ids || {};

    const wb = XLSX.utils.book_new();

    const watermarkHeader = isLocked ? null : ["*** DRAFT - UNAPPROVED BUDGET (FOR PREVIEW ONLY) ***"];

    // ── SHEET 1: Executive Summary ──────────────────────────────────────────
    const sheet1Rows = [];
    if (watermarkHeader) sheet1Rows.push(watermarkHeader);
    sheet1Rows.push(["EXECUTIVE SUMMARY — ANNUAL PROPERTY BUDGET"]);
    sheet1Rows.push(["Property Name:", p.name || b.property_id]);
    sheet1Rows.push(["Fiscal Year:", b.fiscal_year]);
    sheet1Rows.push(["Budget Status:", isLocked ? "Approved & Locked" : b.status]);
    sheet1Rows.push(["Scope:", b.scope]);
    sheet1Rows.push(["Total Building SF:", p.total_sqft ? p.total_sqft.toLocaleString() : "—"]);
    sheet1Rows.push([]);
    sheet1Rows.push(["APPROVAL & GOVERNANCE"]);
    sheet1Rows.push(["Approved By:", b.approver_name || "—"]);
    sheet1Rows.push(["Approver Role:", b.approver_role || "—"]);
    sheet1Rows.push(["Approval Timestamp:", b.approved_at ? new Date(b.approved_at).toLocaleString() : "—"]);
    sheet1Rows.push(["Approval Comment:", b.approval_comment || "—"]);
    sheet1Rows.push(["Version Hash:", b.version_hash || "—"]);
    sheet1Rows.push([]);
    sheet1Rows.push(["FINANCIAL SUMMARY", "FY " + b.fiscal_year + " APPROVED"]);
    sheet1Rows.push(["Total Gross Revenue", fmtNum(b.total_revenue)]);
    sheet1Rows.push(["Total Operating Expenses", fmtNum(b.total_expenses)]);
    sheet1Rows.push(["Estimated Tenant CAM Recovery", fmtNum(b.cam_total)]);
    sheet1Rows.push(["Net Operating Income (NOI)", fmtNum(b.noi)]);

    const ws1 = XLSX.utils.aoa_to_sheet(sheet1Rows);
    autoFitColumns(ws1, sheet1Rows);
    XLSX.utils.book_append_sheet(wb, ws1, "Executive Summary");

    // ── SHEET 2: Operating Expense Budget ───────────────────────────────────
    const sheet2Rows = [];
    if (watermarkHeader) sheet2Rows.push(watermarkHeader);
    sheet2Rows.push(["OPERATING EXPENSE BUDGET — CATEGORY BREAKDOWN"]);
    sheet2Rows.push([
      "Category", "Baseline Type", "Prior Year Actual", "Current YTD Actual",
      "Current Year Forecast", "Baseline Amount", "Growth %", "Manual Override",
      "Approved Annual Budget", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
    ]);

    const expCategories = expBasis.categories || [];
    expCategories.forEach((cat) => {
      const m = cat.monthly_budget || Array(12).fill(fmtNum(cat.annual_budget) / 12);
      sheet2Rows.push([
        cat.category_label || cat.normalized_key || "Other",
        cat.baseline_type || "—",
        fmtNum(cat.prior_year_actual),
        fmtNum(cat.current_year_ytd_actual),
        fmtNum(cat.current_year_forecast),
        fmtNum(cat.baseline_amount),
        cat.assumption?.value != null ? cat.assumption.value + "%" : "0%",
        cat.override?.amount != null ? fmtNum(cat.override.amount) : "—",
        fmtNum(cat.annual_budget),
        ...m.map(fmtNum)
      ]);
    });
    sheet2Rows.push([
      "TOTAL OPERATING EXPENSES", "", "", "", "", "", "", "",
      fmtNum(b.total_expenses),
      ...(expBasis.totals?.monthly_budget_total?.map(fmtNum) || Array(12).fill(fmtNum(b.total_expenses) / 12))
    ]);

    const ws2 = XLSX.utils.aoa_to_sheet(sheet2Rows);
    autoFitColumns(ws2, sheet2Rows);
    XLSX.utils.book_append_sheet(wb, ws2, "Operating Expense Budget");

    // ── SHEET 3: Revenue Budget ─────────────────────────────────────────────
    const sheet3Rows = [];
    if (watermarkHeader) sheet3Rows.push(watermarkHeader);
    sheet3Rows.push(["REVENUE BUDGET"]);
    sheet3Rows.push(["Revenue Line Type", "Annual Budget", "Source"]);

    const revLines = lineItems.filter((li) => li.line_type === "revenue");
    if (revLines.length > 0) {
      revLines.forEach((li) => {
        sheet3Rows.push([
          li.category?.replace("_", " ").toUpperCase(),
          fmtNum(li.amount),
          li.notes || li.source_type || "Revenue Snapshot"
        ]);
      });
    } else {
      const revSummary = revBase.summary?.revenue_by_type || {};
      sheet3Rows.push(["Base Rent", fmtNum(revSummary.base_rent), "Approved Leases"]);
      sheet3Rows.push(["Estimated CAM Recovery (Phase 3B)", fmtNum(b.cam_total), "Phase 3B Planning Engine"]);
      sheet3Rows.push(["Other Income", fmtNum(revSummary.other_income), "Revenues Table"]);
    }
    sheet3Rows.push(["TOTAL REVENUE", fmtNum(b.total_revenue), "Authoritative Total"]);

    const ws3 = XLSX.utils.aoa_to_sheet(sheet3Rows);
    autoFitColumns(ws3, sheet3Rows);
    XLSX.utils.book_append_sheet(wb, ws3, "Revenue Budget");

    // ── SHEET 4: CAM Recovery Budget ────────────────────────────────────────
    const sheet4Rows = [];
    if (watermarkHeader) sheet4Rows.push(watermarkHeader);
    sheet4Rows.push(["CAM RECOVERY BUDGET — PROPERTY PLANNING SUMMARY"]);
    const camPropSummary = camEst.property_summary || {};
    sheet4Rows.push(["Budgeted Operating Expense Basis:", fmtNum(camPropSummary.budgeted_operating_expenses || b.total_expenses)]);
    sheet4Rows.push(["Recoverable Expense Basis:", fmtNum(camPropSummary.budgeted_recoverable_expense_basis)]);
    sheet4Rows.push(["Estimated Tenant CAM Recoveries:", fmtNum(camPropSummary.estimated_tenant_recoveries || b.cam_total)]);
    sheet4Rows.push(["Owner Non-Recoverable Share:", fmtNum(camPropSummary.estimated_owner_nonrecoverable_share)]);

    const ws4 = XLSX.utils.aoa_to_sheet(sheet4Rows);
    autoFitColumns(ws4, sheet4Rows);
    XLSX.utils.book_append_sheet(wb, ws4, "CAM Recovery Budget");

    // ── SHEET 5: Tenant CAM Estimates ───────────────────────────────────────
    const sheet5Rows = [];
    if (watermarkHeader) sheet5Rows.push(watermarkHeader);
    sheet5Rows.push(["TENANT CAM RECOVERY ESTIMATES (PHASE 3B)"]);
    sheet5Rows.push([
      "Tenant Name", "Lease ID", "Premises RSF", "Pro Rata Share %",
      "Annual Estimated CAM", "Recovery Method", "Cap / Base Year Notes"
    ]);

    const tenantRecs = camEst.tenant_recoveries || camEst.tenants || [];
    tenantRecs.forEach((t) => {
      sheet5Rows.push([
        t.tenant_name || t.lease_id || "Tenant",
        t.lease_id || "—",
        fmtNum(t.square_footage || t.tenant_rsf),
        t.pro_rata_share != null ? (fmtNum(t.pro_rata_share) * 100).toFixed(2) + "%" : "—",
        fmtNum(t.estimated_annual_recovery || t.annual_recovery),
        t.calculation_method || "Pro Rata Share",
        t.notes || t.cap_type || "Standard"
      ]);
    });
    sheet5Rows.push([
      "TOTAL TENANT CAM RECOVERIES", "", "", "",
      fmtNum(camPropSummary.estimated_tenant_recoveries || b.cam_total), "", ""
    ]);

    const ws5 = XLSX.utils.aoa_to_sheet(sheet5Rows);
    autoFitColumns(ws5, sheet5Rows);
    XLSX.utils.book_append_sheet(wb, ws5, "Tenant CAM Estimates");

    // ── SHEET 6: Monthly Budget ─────────────────────────────────────────────
    const sheet6Rows = [];
    if (watermarkHeader) sheet6Rows.push(watermarkHeader);
    sheet6Rows.push(["MONTHLY BUDGET PROJECTION"]);

    const monthlyRev = revBase.monthly_projections || [];
    const monthlyBaseRent = monthlyRev.map((m) => fmtNum(m.base_rent));
    const monthlyOther = monthlyRev.map((m) => fmtNum(m.other_income));
    const monthlyCamRec = Array(12).fill(fmtNum(b.cam_total) / 12);
    const monthlyExp = expBasis.totals?.monthly_budget_total || Array(12).fill(fmtNum(b.total_expenses) / 12);

    const monthlyTotalRev = Array(12).fill(0).map((_, i) =>
      (monthlyBaseRent[i] || 0) + (monthlyOther[i] || 0) + (monthlyCamRec[i] || 0)
    );
    const monthlyNoi = Array(12).fill(0).map((_, i) =>
      monthlyTotalRev[i] - (monthlyExp[i] || 0)
    );

    sheet6Rows.push(["Line Item", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Annual Total"]);
    sheet6Rows.push(["Base Rent", ...monthlyBaseRent.map(fmtNum), fmtNum(monthlyBaseRent.reduce((a, b) => a + b, 0))]);
    sheet6Rows.push(["Other Income", ...monthlyOther.map(fmtNum), fmtNum(monthlyOther.reduce((a, b) => a + b, 0))]);
    sheet6Rows.push(["Est. CAM Recovery (Phase 3B)", ...monthlyCamRec.map(fmtNum), fmtNum(b.cam_total)]);
    sheet6Rows.push(["TOTAL REVENUE", ...monthlyTotalRev.map(fmtNum), fmtNum(b.total_revenue)]);
    sheet6Rows.push(["TOTAL EXPENSES", ...monthlyExp.map(fmtNum), fmtNum(b.total_expenses)]);
    sheet6Rows.push(["NET OPERATING INCOME (NOI)", ...monthlyNoi.map(fmtNum), fmtNum(b.noi)]);

    const ws6 = XLSX.utils.aoa_to_sheet(sheet6Rows);
    autoFitColumns(ws6, sheet6Rows);
    XLSX.utils.book_append_sheet(wb, ws6, "Monthly Budget");

    // ── SHEET 7: Budget Variance ────────────────────────────────────────────
    const sheet7Rows = [];
    if (watermarkHeader) sheet7Rows.push(watermarkHeader);
    sheet7Rows.push(["EXPENSE BUDGET VARIANCE ANALYSIS"]);
    sheet7Rows.push(["Category", "Prior Year Actual", "Current Forecast", "Approved Budget", "Dollar Variance", "% Variance"]);

    expCategories.forEach((cat) => {
      const prior = fmtNum(cat.prior_year_actual);
      const budgetAmt = fmtNum(cat.annual_budget);
      const diff = budgetAmt - prior;
      const pct = prior > 0 ? ((diff / prior) * 100).toFixed(1) + "%" : "—";
      sheet7Rows.push([
        cat.category_label || cat.normalized_key || "Other",
        prior,
        fmtNum(cat.current_year_forecast),
        budgetAmt,
        diff,
        pct
      ]);
    });

    const ws7 = XLSX.utils.aoa_to_sheet(sheet7Rows);
    autoFitColumns(ws7, sheet7Rows);
    XLSX.utils.book_append_sheet(wb, ws7, "Budget Variance");

    // ── SHEET 8: Assumptions & Overrides ───────────────────────────────────
    const sheet8Rows = [];
    if (watermarkHeader) sheet8Rows.push(watermarkHeader);
    sheet8Rows.push(["PLANNING ASSUMPTIONS & MANUAL OVERRIDES (PHASE 3A)"]);
    sheet8Rows.push([
      "Category", "Baseline Type", "Baseline Amount", "Growth %",
      "Assumption Reason", "Calculated Budget", "Override Amount",
      "Override Reason", "Recorded By", "Timestamp"
    ]);

    expCategories.forEach((cat) => {
      sheet8Rows.push([
        cat.category_label || cat.normalized_key || "Other",
        cat.baseline_type || "—",
        fmtNum(cat.baseline_amount),
        cat.assumption?.value != null ? cat.assumption.value + "%" : "0%",
        cat.assumption?.reason || "—",
        fmtNum(cat.calculated_annual_budget || cat.annual_budget),
        cat.override?.amount != null ? fmtNum(cat.override.amount) : "—",
        cat.override?.reason || "—",
        cat.override?.actor_email || cat.assumption?.actor_email || "—",
        cat.override?.overridden_at || cat.assumption?.recorded_at || "—"
      ]);
    });

    const ws8 = XLSX.utils.aoa_to_sheet(sheet8Rows);
    autoFitColumns(ws8, sheet8Rows);
    XLSX.utils.book_append_sheet(wb, ws8, "Assumptions & Overrides");

    // ── SHEET 9: Approval & Audit ───────────────────────────────────────────
    const sheet9Rows = [];
    if (watermarkHeader) sheet9Rows.push(watermarkHeader);
    sheet9Rows.push(["APPROVAL & SYSTEM AUDIT LOG"]);
    sheet9Rows.push(["Parameter", "Value"]);
    sheet9Rows.push(["Budget ID:", b.id]);
    sheet9Rows.push(["Property Name:", p.name]);
    sheet9Rows.push(["Fiscal Year:", b.fiscal_year]);
    sheet9Rows.push(["Generation Method:", b.generation_method || "planning"]);
    sheet9Rows.push(["Budget Status:", isLocked ? "Approved & Locked" : b.status]);
    sheet9Rows.push(["Reviewed By:", b.reviewer_name || "—"]);
    sheet9Rows.push(["Reviewed At:", b.reviewed_at ? new Date(b.reviewed_at).toLocaleString() : "—"]);
    sheet9Rows.push(["Approved By:", b.approver_name || "—"]);
    sheet9Rows.push(["Approver Role:", b.approver_role || "—"]);
    sheet9Rows.push(["Approved At:", b.approved_at ? new Date(b.approved_at).toLocaleString() : "—"]);
    sheet9Rows.push(["Approval Comment:", b.approval_comment || "—"]);
    sheet9Rows.push(["Locked At:", b.locked_at ? new Date(b.locked_at).toLocaleString() : "—"]);
    sheet9Rows.push(["Version Hash:", b.version_hash || "—"]);
    sheet9Rows.push([]);
    sheet9Rows.push(["FROZEN SOURCE SNAPSHOT LINEAGE"]);
    sheet9Rows.push(["Phase 3A Expense Basis Snapshot ID:", snapshotIds.budget_basis || "—"]);
    sheet9Rows.push(["Phase 3B CAM Estimate Snapshot ID:", snapshotIds.budget_cam_estimate || "—"]);
    sheet9Rows.push(["Revenue Engine Snapshot ID:", snapshotIds.revenue || "—"]);
    sheet9Rows.push([]);
    sheet9Rows.push(["GOVERNANCE DISCLAIMER"]);
    sheet9Rows.push([
      "This workbook represents the approved and locked financial version identified above. " +
      "Subsequent changes to leases, expenses, CAM runs, or planning snapshots are not reflected unless a new budget version is separately approved."
    ]);

    const ws9 = XLSX.utils.aoa_to_sheet(sheet9Rows);
    autoFitColumns(ws9, sheet9Rows);
    XLSX.utils.book_append_sheet(wb, ws9, "Approval & Audit");

    // ── Generate File Download ──────────────────────────────────────────────
    const filename = `${sanitizeFilename(p.name)}_FY${b.fiscal_year}_${isLocked ? "Approved" : "DRAFT"}_Budget.xlsx`;
    XLSX.writeFile(wb, filename);

    toast.success(`Exported ${filename} successfully.`, { id: toastId });
  } catch (err) {
    console.error("[generateApprovedBudgetWorkbook] Error:", err);
    toast.error(`Workbook export failed: ${err.message}`, { id: toastId });
  }
}

import React from "react";
import { Link } from "react-router-dom";
import {
  Check,
  MinusCircle,
  MoreVertical,
  Pencil,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TableCell, TableRow } from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { approvedLeaseFieldValue } from "@/lib/approvedLeaseSnapshot";
import { createPageUrl } from "@/utils";
import {
  getRuleValidation,
  getOperationalResponsibility,
  getSourcePage,
  getRuleSourceText,
  getExactSourceText,
  getCoverageGapLabel,
  humanizeToken,
  formatTriState,
  formatConfidence,
  truncate,
  getDisplayCamPublishStatus,
  resolveRuleApprovalStatusDisplay,
} from "./utils/leaseExpenseRulesHelpers";
import { deriveFindingCoverageDecision } from "./utils/expenseFindingCoverage";

function coverageBadgeClass(value, kind) {
  const normalized = String(value || "").toLowerCase();
  if (kind === "actual") {
    if (normalized === "yes") return "bg-emerald-100 text-emerald-700";
    if (normalized === "conditional") return "bg-amber-100 text-amber-800";
    return "bg-slate-100 text-slate-600";
  }
  if (normalized.includes("not eligible")) return "bg-slate-100 text-slate-600";
  if (normalized.includes("eligible") || normalized.includes("approved")) return "bg-emerald-100 text-emerald-700";
  if (normalized.includes("conditional") || normalized.includes("direct recovery")) return "bg-amber-100 text-amber-800";
  if (normalized.includes("evidence")) return "bg-blue-100 text-blue-700";
  return "bg-slate-100 text-slate-600";
}

export default function RuleTableRow({
  rule,
  ruleSet,
  lease,
  property,
  category,
  displayMode,
  isUpdating,
  isSelected = false,
  canSelect = false,
  camPolicyStatus = null,
  isHighlighted = false,
  onSelectChange,
  onApprove,
  onReject,
  onMarkNA,
  onEdit,
}) {
  const validation = getRuleValidation(rule);
  const coverage = rule?._coverage || deriveFindingCoverageDecision(rule);
  const recoverableDecision = validation.recoverableFromTenant;
  const camEligibleDecision = validation.camEligible;
  const paymentTreatment = validation.paymentTreatment;
  const responsibility = getOperationalResponsibility(rule);
  const recoveryMethod = validation.recoveryMethod;
  const allocationBasis = validation.allocationBasis;
  const capDisplay = rule.is_subject_to_cap || rule.cap_percent != null || rule.cap_type || rule.cap_amount != null
    ? [
        rule.cap_type || "",
        rule.cap_percent != null ? `${rule.cap_percent}%` : null,
        rule.cap_amount != null ? `$${Number(rule.cap_amount).toLocaleString()}` : null,
        rule.cap_value != null && rule.cap_amount == null ? String(rule.cap_value) : null,
      ].filter(Boolean).join(" ") || "-"
    : "-";
  const sourcePage = getSourcePage(rule);
  const sourceText = getRuleSourceText(rule) || getExactSourceText(rule) || "-";
  const amountSummary = [
    rule.estimated_annual_amount != null ? `$${Number(rule.estimated_annual_amount).toLocaleString()}/yr` : null,
    rule.estimated_monthly_amount != null ? `$${Number(rule.estimated_monthly_amount).toLocaleString()}/mo` : null,
    rule.tenant_share_percent != null ? `${rule.tenant_share_percent}% share` : null,
    capDisplay !== "-" ? `Cap: ${capDisplay}` : null,
    rule.admin_fee_applicable ? `Admin: ${rule.admin_fee_percent ? `${rule.admin_fee_percent}%` : "yes"}` : null,
    rule.gross_up_applicable || rule.gross_up_percent != null
      ? `Gross-up: ${rule.gross_up_percent != null ? `${rule.gross_up_percent}%` : "yes"}`
      : null,
  ].filter(Boolean).join(" · ");
  const billingSummary = [
    rule.billing_frequency || rule.frequency || null,
    rule.reconciliation_required ? "Reconcile" : "No reconcile",
  ].filter(Boolean).join(" · ");
  const statusSummary = [
    humanizeToken(rule.review_status || "Pending"),
    humanizeToken(rule.approval_status || rule.row_status || "Needs Review"),
    formatConfidence(rule.confidence_score),
  ].filter(Boolean).join(" · ");

  const tenantDisplayName =
    approvedLeaseFieldValue(lease, ["tenant_name", "tenant", "tenant_legal_name", "lessee"]) ||
    lease?.tenant_name ||
    lease?.tenant?.name ||
    lease?.approved_fields?.tenant_name?.value ||
    lease?.tenant_legal_name ||
    (lease?.id ? `Lease #${lease.id.slice(0, 8)}` : "-");

  return (
    <TableRow className={isHighlighted ? "align-top bg-amber-50 ring-1 ring-amber-300" : "align-top hover:bg-slate-50"}>
      <TableCell className="text-center align-middle">
        <input
          type="checkbox"
          className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
          checked={isSelected}
          disabled={!canSelect || isUpdating}
          onChange={(event) => onSelectChange?.(event.target.checked)}
          aria-label="Select lease expense rule"
        />
      </TableCell>
      <TableCell className="text-sm font-medium text-slate-900">
        {lease ? (
          <Link
            to={createPageUrl("LeaseReview", { id: lease.id })}
            className="text-blue-600 hover:text-blue-700 font-semibold"
          >
            {tenantDisplayName}
          </Link>
        ) : (
          "-"
        )}
        <p className="text-[10px] text-slate-400">
          {rule?._findingOnly ? "Raw finding - not materialized" : `Rule set v${ruleSet?.version} - ${ruleSet?.status}`}
        </p>
        {displayMode === "gaps" && (
          <Badge className="bg-amber-100 text-amber-800 text-[9px] px-1 py-0 h-4 mt-1">
            {rule?._findingOnly ? "Not materialized" : getCoverageGapLabel(rule)}
          </Badge>
        )}
        {rule._is_fallback && (
          <Badge className="bg-amber-100 text-amber-800 text-[9px] px-1 py-0 h-4 mt-1">
            Not persisted
          </Badge>
        )}
      </TableCell>
      <TableCell className="text-sm text-slate-600">{property?.name || "-"}</TableCell>
      <TableCell className="text-sm">
        <div className="font-medium text-slate-900">
          {rule.category_name || rule.expense_category || category?.category_name || "-"}
        </div>
        <div className="mt-1 text-[11px] text-slate-500">
          {rule.expense_subcategory || rule.subcategory_name || category?.subcategory_name || humanizeToken(rule.rule_type) || "General"}
        </div>
      </TableCell>
      <TableCell className="max-w-[280px] text-xs text-slate-700">
        <div>{humanizeToken(paymentTreatment)}</div>
        <div className="mt-1 text-slate-500">
          {validation.includedInBaseRent ? "Included in rent" : "Separate charge / obligation"}
        </div>
        <Badge className={`mt-2 text-[10px] ${coverageBadgeClass(coverage.expenseTreatment)}`}>
          {coverage.expenseTreatment}
        </Badge>
      </TableCell>
      <TableCell className="text-sm text-slate-700">{humanizeToken(responsibility)}</TableCell>
      <TableCell>
        <Badge className={`text-[10px] ${["yes", "conditional"].includes(recoverableDecision) && !rule.is_excluded ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>
          {formatTriState(recoverableDecision)}
        </Badge>
      </TableCell>
      <TableCell>
        <Badge className={`text-[10px] ${["yes", "conditional"].includes(camEligibleDecision) ? "bg-sky-100 text-sky-700" : "bg-slate-100 text-slate-600"}`}>
          {formatTriState(camEligibleDecision)}
        </Badge>
        <Badge className={`mt-1 block w-fit text-[10px] ${coverageBadgeClass(coverage.camParticipation)}`}>
          {coverage.camParticipation}
        </Badge>
      </TableCell>
      <TableCell>
        <Badge className={`text-[10px] ${coverageBadgeClass(coverage.actualExpenseExpected, "actual")}`}>
          {humanizeToken(coverage.actualExpenseExpected)}
        </Badge>
      </TableCell>
      <TableCell className="text-sm text-slate-700">
        <div>{humanizeToken(recoveryMethod)}</div>
        <div className="mt-1 text-[11px] text-slate-500">{allocationBasis ? humanizeToken(allocationBasis) : "-"}</div>
      </TableCell>
      <TableCell className="max-w-[260px] text-sm text-slate-700">
        {amountSummary || "-"}
      </TableCell>
      <TableCell className="text-sm text-slate-700">{billingSummary || "-"}</TableCell>
      <TableCell className="max-w-[320px]">
        <div className="mb-1 flex flex-wrap gap-1">
          {(() => {
            const approvalDisplay = resolveRuleApprovalStatusDisplay(rule);
            const toneClass =
              approvalDisplay.tone === "emerald" ? "bg-emerald-100 text-emerald-700"
              : approvalDisplay.tone === "red" ? "bg-red-100 text-red-700"
              : approvalDisplay.tone === "amber" ? "bg-amber-100 text-amber-800"
              : "bg-slate-100 text-slate-600";
            return (
              <Badge className={`text-[10px] ${toneClass}`} title={statusSummary}>
                {approvalDisplay.label}
              </Badge>
            );
          })()}
        </div>
        {(() => {
          const camPublishStatus = getDisplayCamPublishStatus(rule, validation, displayMode);
          const toneClass =
            camPublishStatus.tone === "emerald" ? "bg-emerald-100 text-emerald-700"
            : camPublishStatus.tone === "amber" ? "bg-amber-100 text-amber-800"
            : "bg-slate-100 text-slate-600";
          return (
            <Badge
              className={`text-[10px] whitespace-normal text-left leading-tight ${toneClass}`}
              title={camPublishStatus.label}
            >
              {camPublishStatus.label}
            </Badge>
          );
        })()}
        {camPolicyStatus && (
          <Badge
            className={`mt-1 text-[10px] whitespace-normal text-left leading-tight ${
              camPolicyStatus.tone === "emerald" ? "bg-emerald-100 text-emerald-700"
              : camPolicyStatus.tone === "amber" ? "bg-amber-100 text-amber-800"
              : camPolicyStatus.tone === "red" ? "bg-red-100 text-red-700"
              : "bg-slate-100 text-slate-600"
            }`}
            title="Whether this approved rule has a materialized CAM recovery policy"
          >
            {camPolicyStatus.label}
          </Badge>
        )}
        <div className="mt-2 text-xs text-slate-600">
          {sourcePage ? <span className="mr-2 font-medium">p. {sourcePage}</span> : null}
          {sourceText && sourceText !== "-" ? <span className="italic">"{truncate(sourceText)}"</span> : "-"}
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          <Badge className={`text-[10px] ${coverageBadgeClass(coverage.contractStatus)}`}>
            {coverage.contractStatus}
          </Badge>
          <Badge className={`text-[10px] ${coverageBadgeClass(coverage.materialization)}`} title={coverage.reason}>
            {coverage.materialization}
          </Badge>
        </div>
      </TableCell>
      <TableCell>
        {rule?._findingOnly ? (
          <span className="text-xs text-slate-500" title={coverage.reason}>
            Evidence only
          </span>
        ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0"
              disabled={isUpdating}
              aria-label="Rule actions"
            >
              <MoreVertical className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-slate-500">
              Review
            </DropdownMenuLabel>
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault();
                onApprove(rule, lease);
              }}
              className="text-emerald-700 focus:text-emerald-800"
            >
              <Check className="mr-2 h-3.5 w-3.5" />
              Approve rule
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault();
                onReject(rule, lease);
              }}
              className="text-red-700 focus:text-red-800"
            >
              <X className="mr-2 h-3.5 w-3.5" />
              Reject rule
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault();
                onMarkNA(rule, lease);
              }}
              className="text-slate-700"
            >
              <MinusCircle className="mr-2 h-3.5 w-3.5" />
              Mark N/A
            </DropdownMenuItem>
            {lease ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-slate-500">
                  Edit
                </DropdownMenuLabel>
                <DropdownMenuItem
                  onSelect={(event) => {
                    event.preventDefault();
                    onEdit({ rule, lease, property, category, ruleSet });
                  }}
                >
                  <Pencil className="mr-2 h-3.5 w-3.5" />
                  Edit rule details
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
        )}
      </TableCell>
    </TableRow>
  );
}

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
} from "./utils/leaseExpenseRulesHelpers";

export default function RuleTableRow({
  rule,
  ruleSet,
  lease,
  property,
  category,
  displayMode,
  isUpdating,
  onApprove,
  onReject,
  onMarkNA,
  onEdit,
}) {
  const validation = getRuleValidation(rule);
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

  return (
    <TableRow className="align-top hover:bg-slate-50">
      <TableCell className="text-sm font-medium text-slate-900">
        {lease ? (
          <Link
            to={createPageUrl("LeaseReview", { id: lease.id })}
            className="text-blue-600 hover:text-blue-700"
          >
            {lease.tenant_name || lease.id.slice(0, 8)}
          </Link>
        ) : (
          "-"
        )}
        <p className="text-[10px] text-slate-400">
          Rule set v{ruleSet?.version} - {ruleSet?.status}
        </p>
        {displayMode === "gaps" && (
          <Badge className="bg-amber-100 text-amber-800 text-[9px] px-1 py-0 h-4 mt-1">
            {getCoverageGapLabel(rule)}
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
          <Badge className={`text-[10px] ${
            String(rule.approval_status || rule.row_status).toLowerCase() === "approved"
              ? "bg-emerald-100 text-emerald-700"
              : "bg-amber-100 text-amber-800"
          }`}>
            {statusSummary}
          </Badge>
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
        <div className="mt-2 text-xs text-slate-600">
          {sourcePage ? <span className="mr-2 font-medium">p. {sourcePage}</span> : null}
          {sourceText && sourceText !== "-" ? <span className="italic">"{truncate(sourceText)}"</span> : "-"}
        </div>
      </TableCell>
      <TableCell>
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
      </TableCell>
    </TableRow>
  );
}

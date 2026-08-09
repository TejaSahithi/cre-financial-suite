import React from "react";
import { Link } from "react-router-dom";
import {
  Check,
  Info,
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
  getSourcePage,
  getRuleSourceText,
  getExactSourceText,
  getCoverageGapLabel,
  humanizeToken,
  truncate,
  getSimplifiedRuleView,
  getContractStatus,
} from "./utils/leaseExpenseRulesHelpers";

const TONE_CLASS = {
  emerald: "bg-emerald-100 text-emerald-700",
  red: "bg-red-100 text-red-700",
  amber: "bg-amber-100 text-amber-800",
  sky: "bg-sky-100 text-sky-700",
  slate: "bg-slate-100 text-slate-600",
};

const TREATMENT_TONE = {
  pooled_recovery: "emerald",
  direct_recovery: "emerald",
  direct_bill: "sky",
  tenant_direct: "slate",
  included_in_rent: "slate",
  compliance_only: "slate",
  nonrecoverable: "slate",
  conditional: "amber",
};

const CAM_TONE = { eligible: "emerald", conditional: "amber", not_applicable: "slate", blocked: "red" };
const ACTUAL_EXPENSE_TONE = { yes: "emerald", conditional: "amber", no: "slate" };

/**
 * Nine business columns only (checkbox + Actions aside) — every technical
 * field that used to live here (responsibility, cap, share, base year,
 * billing frequency, scope, policy version, full evidence, audit history)
 * now lives in the detail drawer (onOpenDetail). Presentation only: the
 * badges below are straight labels over getSimplifiedRuleView()/
 * getContractStatus(), which themselves sit on top of the existing
 * deriveNormalizedContractModel()/deriveRuleDecision() engine — no
 * financial or approval logic changed.
 */
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
  onOpenDetail,
}) {
  const view = getSimplifiedRuleView(rule);
  const contractStatus = getContractStatus(rule);
  const sourcePage = getSourcePage(rule);
  const sourceText = getRuleSourceText(rule) || getExactSourceText(rule) || "-";

  const tenantDisplayName =
    approvedLeaseFieldValue(lease, ["tenant_name", "tenant", "tenant_legal_name", "lessee"]) ||
    lease?.tenant_name ||
    lease?.tenant?.name ||
    lease?.approved_fields?.tenant_name?.value ||
    lease?.tenant_legal_name ||
    (lease?.id ? `Lease #${lease.id.slice(0, 8)}` : "-");

  const openDetail = () => onOpenDetail?.({ rule, ruleSet, lease, property, category, camPolicyStatus });

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

      {/* 1. Tenant / Lease */}
      <TableCell className="text-sm font-medium text-slate-900">
        {lease ? (
          <Link to={createPageUrl("LeaseReview", { id: lease.id })} className="text-blue-600 hover:text-blue-700 font-semibold">
            {tenantDisplayName}
          </Link>
        ) : (
          "-"
        )}
        {property?.name && <p className="mt-0.5 text-[11px] text-slate-400">{property.name}</p>}
        {rule?._findingOnly && (
          <Badge className="bg-amber-100 text-amber-800 text-[9px] px-1 py-0 h-4 mt-1">Not materialized</Badge>
        )}
        {displayMode === "gaps" && !rule?._findingOnly && (
          <Badge className="bg-amber-100 text-amber-800 text-[9px] px-1 py-0 h-4 mt-1">{getCoverageGapLabel(rule)}</Badge>
        )}
      </TableCell>

      {/* 2. Category */}
      <TableCell className="text-sm">
        <div className="font-medium text-slate-900">
          {rule.category_name || rule.expense_category || category?.category_name || "-"}
        </div>
        <div className="mt-1 text-[11px] text-slate-500">
          {rule.expense_subcategory || rule.subcategory_name || category?.subcategory_name || "General"}
        </div>
      </TableCell>

      {/* 3. Treatment */}
      <TableCell>
        <Badge className={`text-[10px] ${TONE_CLASS[TREATMENT_TONE[view.treatment]] || TONE_CLASS.slate}`}>
          {view.treatmentLabel}
        </Badge>
      </TableCell>

      {/* 4. Recovery Method */}
      <TableCell className="text-sm text-slate-700">
        {humanizeToken(rule.recovery_method) || "-"}
      </TableCell>

      {/* 5. CAM */}
      <TableCell>
        <Badge className={`text-[10px] ${TONE_CLASS[CAM_TONE[view.cam]] || TONE_CLASS.slate}`}>
          {view.camLabel}
        </Badge>
      </TableCell>

      {/* 6. Actual Expense */}
      <TableCell>
        <Badge className={`text-[10px] ${TONE_CLASS[ACTUAL_EXPENSE_TONE[view.actualExpense]] || TONE_CLASS.slate}`}>
          {view.actualExpenseLabel}
        </Badge>
      </TableCell>

      {/* 7. Contract Status */}
      <TableCell>
        <Badge className={`text-[10px] ${TONE_CLASS[contractStatus.tone] || TONE_CLASS.slate}`}>
          {contractStatus.label}
        </Badge>
      </TableCell>

      {/* 8. Evidence */}
      <TableCell className="max-w-[260px] text-xs text-slate-600">
        {sourcePage ? <span className="mr-2 font-medium">p. {sourcePage}</span> : null}
        {sourceText && sourceText !== "-" ? <span className="italic">&ldquo;{truncate(sourceText, 100)}&rdquo;</span> : "-"}
      </TableCell>

      {/* 9. Actions */}
      <TableCell>
        <div className="flex items-center gap-0.5">
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={openDetail} aria-label="View rule details">
            <Info className="h-3.5 w-3.5 text-slate-500" />
          </Button>
          {rule?._findingOnly ? null : (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="ghost" className="h-7 w-7 p-0" disabled={isUpdating} aria-label="Rule actions">
                  <MoreVertical className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-slate-500">Review</DropdownMenuLabel>
                <DropdownMenuItem
                  onSelect={(event) => { event.preventDefault(); onApprove(rule, lease); }}
                  className="text-emerald-700 focus:text-emerald-800"
                >
                  <Check className="mr-2 h-3.5 w-3.5" />
                  Approve rule
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={(event) => { event.preventDefault(); onReject(rule, lease); }}
                  className="text-red-700 focus:text-red-800"
                >
                  <X className="mr-2 h-3.5 w-3.5" />
                  Reject rule
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={(event) => { event.preventDefault(); onMarkNA(rule, lease); }}
                  className="text-slate-700"
                >
                  <MinusCircle className="mr-2 h-3.5 w-3.5" />
                  Mark N/A
                </DropdownMenuItem>
                {lease ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-slate-500">Edit</DropdownMenuLabel>
                    <DropdownMenuItem onSelect={(event) => { event.preventDefault(); onEdit({ rule, lease, property, category, ruleSet }); }}>
                      <Pencil className="mr-2 h-3.5 w-3.5" />
                      Edit rule details
                    </DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

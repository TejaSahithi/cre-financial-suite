import React from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Check, Edit2, FileSearch, X } from "lucide-react";

function formatConfidence(value) {
  if (value == null) return "-";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "-";
  return `${Math.round(numeric <= 1 ? numeric * 100 : numeric)}%`;
}

function getStatusBadge(rule) {
  if (rule?.review_status === "reviewed" && rule?.approval_status === "approved") {
    return <Badge className="bg-emerald-100 text-emerald-800">Approved</Badge>;
  }
  if (rule?.review_status === "needs_review" || rule?.row_status === "uncertain" || rule?.row_status === "needs_review") {
    return <Badge className="bg-amber-100 text-amber-800">Needs Review</Badge>;
  }
  switch (rule?.row_status) {
    case "mapped":
      return <Badge className="bg-emerald-100 text-emerald-800">Mapped</Badge>;
    case "unmapped":
      return <Badge variant="outline" className="text-slate-500">Unmapped</Badge>;
    case "missing_value":
      return <Badge className="bg-rose-100 text-rose-800 border-rose-200">Missing Value</Badge>;
    case "not_mentioned":
      return <Badge variant="secondary" className="text-slate-500">Not Mentioned</Badge>;
    default:
      return <Badge variant="outline">Unknown</Badge>;
  }
}

function renderBooleanIcon(value) {
  if (value === true) return <Check className="w-4 h-4 text-emerald-600" />;
  if (value === false) return <X className="w-4 h-4 text-rose-600" />;
  return <span className="text-slate-300">-</span>;
}

export default function ExpenseClassificationTable({ categories, rules, onEditRule, onViewEvidence }) {
  return (
    <div className="border rounded-md overflow-hidden bg-white">
      <Table>
        <TableHeader className="bg-slate-50">
          <TableRow>
            <TableHead>Category</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-center">Included In Base Rent</TableHead>
            <TableHead className="text-center">Recoverable</TableHead>
            <TableHead>Recovery Method</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead>Cap / Base Year</TableHead>
            <TableHead>Evidence</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {categories.map((category) => {
            const rule = rules.find((item) => item.expense_category_id === category.id) || {};
            const displayValue = rule.final_value ?? rule.manual_value ?? rule.extracted_value;
            const needsReview = rule.review_status === "needs_review" || rule.row_status === "uncertain" || rule.row_status === "needs_review";

            return (
              <TableRow
                key={category.id}
                className={needsReview ? "bg-amber-50/30" : rule.row_status === "missing_value" ? "bg-rose-50/50 border-l-4 border-l-rose-500" : ""}
              >
                <TableCell className="font-medium">
                  {category.category_name}
                  {category.subcategory_name && <span className="text-slate-500 text-sm ml-2">({category.subcategory_name})</span>}
                </TableCell>
                <TableCell>{getStatusBadge(rule)}</TableCell>
                <TableCell className="text-center">
                  {renderBooleanIcon(typeof rule.included_in_base_rent === "boolean" ? rule.included_in_base_rent : null)}
                </TableCell>
                <TableCell className="text-center">{renderBooleanIcon(rule.is_recoverable ?? rule.recoverable_from_tenant)}</TableCell>
                <TableCell className="text-sm text-slate-700">
                  {rule.recovery_method || "-"}
                </TableCell>
                <TableCell className="text-right font-mono">
                  {displayValue != null && displayValue !== "" ? `$${Number(displayValue).toLocaleString()}` : <span className="text-slate-300">-</span>}
                </TableCell>
                <TableCell>
                  {rule.is_subject_to_cap && (rule.cap_value || rule.cap_amount || rule.cap_percent) && (
                    <Badge variant="outline" className="mr-2 border-blue-200 text-blue-700 bg-blue-50">
                      Cap: {[rule.cap_type, rule.cap_percent != null ? `${rule.cap_percent}%` : null, rule.cap_amount ?? rule.cap_value].filter(Boolean).join(" ")}
                    </Badge>
                  )}
                  {(rule.has_base_year || rule.base_year || rule.base_year_amount) && (
                    <Badge variant="outline" className="border-sky-200 text-sky-700 bg-sky-50">
                      Base Year: {rule.base_year || rule.base_year_type || rule.base_year_amount}
                    </Badge>
                  )}
                  {!rule.is_subject_to_cap && !rule.has_base_year && !rule.base_year && !rule.base_year_amount && (
                    <span className="text-slate-300">-</span>
                  )}
                </TableCell>
                <TableCell className="text-xs text-slate-700">
                  <div>{formatConfidence(rule.confidence_score ?? rule.confidence)}</div>
                  <div className="mt-1 text-slate-500">{rule.extraction_status || "-"}</div>
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0"
                      onClick={() => onViewEvidence(category, rule)}
                      title="View AI Evidence"
                    >
                      <FileSearch className={`w-4 h-4 ${needsReview ? "text-amber-500" : "text-slate-400 hover:text-blue-600"}`} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0"
                      onClick={() => onEditRule(category, rule)}
                      title="Edit Mapping"
                    >
                      <Edit2 className="w-4 h-4 text-slate-400 hover:text-blue-600" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
          {categories.length === 0 && (
            <TableRow>
              <TableCell colSpan={9} className="text-center py-8 text-slate-500">
                No expense categories found.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}

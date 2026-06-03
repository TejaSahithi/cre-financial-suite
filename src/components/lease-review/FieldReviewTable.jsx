import React from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Check,
  ChevronDown,
  Eye,
  Gavel,
  HelpCircle,
  MinusCircle,
  Pencil,
  X,
} from "lucide-react";
import {
  REVIEW_STATUSES,
  readFieldEvidence,
  readFieldValue,
} from "@/lib/leaseReviewSchema";
import { getLeaseFieldLabel, hasLeaseFieldOptions } from "@/lib/leaseFieldOptions";

const displayValue = (field, value) => {
  if (value == null || value === "") return "—";
  if (field.type === "currency" && !Number.isNaN(Number(value))) {
    return `$${Number(value).toLocaleString()}`;
  }
  if (field.type === "select" && hasLeaseFieldOptions(field.options || field.key)) {
    return getLeaseFieldLabel(field.options || field.key, value) || String(value);
  }
  if (field.type === "boolean") {
    return value === true || value === "true" || value === "yes" ? "Yes" : "No";
  }
  return String(value);
};

function truncate(text, max = 120) {
  if (!text) return "—";
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export default function FieldReviewTable({
  fields,
  lease,
  fieldReviews,
  onOpenDetail,
  onQuickAction,
}) {
  if (!fields || fields.length === 0) {
    return (
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
        No fields in this section.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[200px] text-xs">Field</TableHead>
            <TableHead className="w-[200px] text-xs">Normalized</TableHead>
            <TableHead className="text-xs">Exact Source Text</TableHead>
            <TableHead className="w-[180px] text-xs text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {fields.map((field) => {
            const review = fieldReviews?.[field.key];
            const status = review?.status || REVIEW_STATUSES.PENDING;
            const value = readFieldValue(lease, field.key);
            const evidence = readFieldEvidence(lease, field.key);
            const { sourceText } = evidence;
            const required = field.required;
            const rowClass = status === REVIEW_STATUSES.PENDING && required
              ? "bg-amber-50/40 hover:bg-amber-50/70"
              : status === REVIEW_STATUSES.REJECTED
                ? "bg-red-50/30 hover:bg-red-50/60"
                : "";

            return (
              <TableRow
                key={field.key}
                className={`${rowClass} cursor-pointer`}
                onClick={() => onOpenDetail(field)}
              >
                <TableCell className="text-xs">
                  <div className="flex items-center gap-1 font-medium text-slate-700">
                    {field.label}
                    {required && <span className="text-red-500">*</span>}
                  </div>
                </TableCell>
                <TableCell className="text-xs">
                  {value == null || value === "" ? (
                    <span className="text-slate-400">—</span>
                  ) : (
                    <span className="font-semibold text-slate-900">{displayValue(field, value)}</span>
                  )}
                </TableCell>
                <TableCell className="text-xs italic text-slate-500" title={sourceText ?? ""}>
                  {truncate(sourceText, 120)}
                </TableCell>
                <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm" className="h-7 text-xs">
                        Actions
                        <ChevronDown className="ml-1 h-3.5 w-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-48">
                      <DropdownMenuItem onSelect={() => onOpenDetail(field)}>
                        <Eye className="mr-2 h-3.5 w-3.5 text-slate-500" />
                        Open detail
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => onQuickAction(field, "edit")}>
                        <Pencil className="mr-2 h-3.5 w-3.5 text-blue-600" />
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={() => onQuickAction(field, "accept")}>
                        <Check className="mr-2 h-3.5 w-3.5 text-emerald-600" />
                        Accept
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => onQuickAction(field, "reject")}>
                        <X className="mr-2 h-3.5 w-3.5 text-red-600" />
                        Reject
                      </DropdownMenuItem>
                      {field.allowNA !== false && (
                        <DropdownMenuItem onSelect={() => onQuickAction(field, "na")}>
                          <MinusCircle className="mr-2 h-3.5 w-3.5 text-slate-600" />
                          Mark N/A
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem onSelect={() => onQuickAction(field, "manual")}>
                        <HelpCircle className="mr-2 h-3.5 w-3.5 text-amber-600" />
                        Manual Required
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => onQuickAction(field, "legal")}>
                        <Gavel className="mr-2 h-3.5 w-3.5 text-purple-600" />
                        Needs Legal
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

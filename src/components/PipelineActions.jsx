import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Calculator, Download, Loader2, CheckCircle, Lock, FileSearch } from "lucide-react";
import { toast } from "sonner";
import { invokeEdgeFunction } from "@/services/edgeFunctions";

// ---------------------------------------------------------------------------
// Icon lookup maps string names from action configs to actual components
// ---------------------------------------------------------------------------
const ICON_MAP = {
  Calculator,
  Download,
  CheckCircle,
  Lock,
  Loader2,
  FileSearch,
};

// ---------------------------------------------------------------------------
// Pre-built action sets for each module
// ---------------------------------------------------------------------------
export const LEASE_ACTIONS = [
  { label: "Compute Rent Schedule", fn: "compute-lease", icon: "Calculator" },
  {
    label: "Export Rent Schedule",
    fn: "export-data",
    icon: "Download",
    extra: { export_type: "rent_schedule", format: "csv" },
  },
];

export const EXPENSE_ACTIONS = [
  { label: "Compute Expenses", fn: "compute-expense", icon: "Calculator" },
  {
    label: "Export Expenses",
    fn: "export-data",
    icon: "Download",
    extra: { export_type: "expenses", format: "csv" },
  },
];

export const CAM_ACTIONS = [
  { label: "Compute CAM", fn: "compute-cam", icon: "Calculator" },
  {
    label: "Export CAM",
    fn: "export-data",
    icon: "Download",
    extra: { export_type: "cam_calculation", format: "csv" },
  },
];

export const REVENUE_ACTIONS = [
  { label: "Compute Revenue", fn: "compute-revenue", icon: "Calculator" },
  {
    label: "Export Revenue",
    fn: "export-data",
    icon: "Download",
    extra: { export_type: "revenue", format: "csv" },
  },
];

export const BUDGET_ACTIONS = [
  { label: "Generate Budget", fn: "compute-budget", icon: "Calculator" },
  {
    label: "Approve Budget",
    fn: "compute-budget",
    icon: "CheckCircle",
    extra: { action: "approve" },
  },
  {
    label: "Lock Budget",
    fn: "compute-budget",
    icon: "Lock",
    extra: { action: "lock" },
  },
  {
    label: "Export Budget",
    fn: "export-data",
    icon: "Download",
    extra: { export_type: "budget", format: "csv" },
  },
];

export const RECONCILIATION_ACTIONS = [
  {
    label: "Run Reconciliation",
    fn: "compute-reconciliation",
    icon: "Calculator",
  },
  {
    label: "Export Reconciliation",
    fn: "export-data",
    icon: "Download",
    extra: { export_type: "reconciliation", format: "csv" },
  },
];

// ---------------------------------------------------------------------------
// PipelineActions component
// ---------------------------------------------------------------------------
export default function PipelineActions({
  propertyId,
  fiscalYear = new Date().getFullYear(),
  actions = [],
  onComplete,
  requireProperty = true,
  // Optional multi-level scope for engines that support it (e.g. compute-cam)
  scopeLevel,
  scopeId,
}) {
  const [loadingIndex, setLoadingIndex] = useState(null);

  // "all" or empty string means no property selected
  const resolvedPropertyId =
    propertyId && propertyId !== "all" ? propertyId : null;

  const handleAction = async (action, index) => {
    if (loadingIndex !== null) return; // block concurrent runs

    // Validate property_id BEFORE we waste a network round-trip
    if (requireProperty && !resolvedPropertyId) {
      toast.error(
        `${action.label} requires a property - pick one in the Scope selector first.`
      );
      return;
    }

    setLoadingIndex(index);

    try {
      const body = {
        property_id: resolvedPropertyId,
        fiscal_year: fiscalYear,
        ...(scopeLevel ? { scope_level: scopeLevel } : {}),
        ...(scopeId ? { scope_id: scopeId } : {}),
        ...(action.extra || {}),
      };

      const data = await invokeEdgeFunction(action.fn, body);

      // For export actions, auto-open the download link when provided
      if (data?.download_url) {
        window.open(data.download_url, "_blank", "noopener");
        toast.success(`${action.label} complete - download started.`);
        if (typeof onComplete === "function") onComplete(action, data);
        return;
      }

      const summary =
        data?.message ||
        data?.summary ||
        (data?.rows_affected != null
          ? `${data.rows_affected} rows processed`
          : "Completed successfully");

      toast.success(`${action.label}: ${summary}`);
      if (typeof onComplete === "function") onComplete(action, data);
    } catch (err) {
      toast.error(`${action.label} failed: ${err?.message || "Unexpected error"}`);
    } finally {
      setLoadingIndex(null);
    }
  };

  if (!actions.length) return null;

  const noProperty = requireProperty && !resolvedPropertyId;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {actions.map((action, idx) => {
        const IconComponent = ICON_MAP[action.icon] || Calculator;
        const isLoading = loadingIndex === idx;
        const isDisabled = loadingIndex !== null || noProperty;
        const title = noProperty
          ? "Select a property in the Scope selector first"
          : action.label;

        return (
          <Button
            key={`${action.fn}-${idx}`}
            variant={action.icon === "Download" ? "outline" : "default"}
            size="sm"
            disabled={isDisabled}
            onClick={() => handleAction(action, idx)}
            className="gap-1.5"
            title={title}
          >
            {isLoading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <IconComponent className="w-4 h-4" />
            )}
            {action.label}
          </Button>
        );
      })}
    </div>
  );
}

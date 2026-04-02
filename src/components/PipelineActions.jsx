import React, { useState } from "react";
import { supabase } from "@/services/supabaseClient";
import { Button } from "@/components/ui/button";
import { Calculator, Download, Loader2, CheckCircle, Lock, FileSearch } from "lucide-react";
import { toast } from "sonner";

// ---------------------------------------------------------------------------
// Icon lookup – maps string names from action configs to actual components
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
}) {
  const [loadingIndex, setLoadingIndex] = useState(null);

  const handleAction = async (action, index) => {
    if (loadingIndex !== null) return; // block concurrent runs
    setLoadingIndex(index);

    try {
      const body = {
        property_id: propertyId,
        fiscal_year: fiscalYear,
        ...(action.extra || {}),
      };

      const { data, error } = await supabase.functions.invoke(action.fn, {
        body,
      });

      if (error) {
        toast.error(
          `${action.label} failed: ${error.message || "Unknown error"}`
        );
        return;
      }

      // For export actions – auto-open the download link when provided
      if (data?.download_url) {
        window.open(data.download_url, "_blank", "noopener");
        toast.success(
          `${action.label} complete – download started.`
        );
        return;
      }

      // Build a short summary from the response
      const summary =
        data?.message ||
        data?.summary ||
        (data?.rows_affected != null
          ? `${data.rows_affected} rows processed`
          : "Completed successfully");

      toast.success(`${action.label}: ${summary}`);
    } catch (err) {
      toast.error(
        `${action.label} failed: ${err?.message || "Unexpected error"}`
      );
    } finally {
      setLoadingIndex(null);
    }
  };

  if (!actions.length) return null;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {actions.map((action, idx) => {
        const IconComponent = ICON_MAP[action.icon] || Calculator;
        const isLoading = loadingIndex === idx;
        const isDisabled = loadingIndex !== null;

        return (
          <Button
            key={`${action.fn}-${idx}`}
            variant={action.icon === "Download" ? "outline" : "default"}
            size="sm"
            disabled={isDisabled}
            onClick={() => handleAction(action, idx)}
            className="gap-1.5"
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

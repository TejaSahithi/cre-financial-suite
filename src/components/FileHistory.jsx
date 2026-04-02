import React, { useState, useEffect, useCallback } from "react";
import { supabase } from "@/services/supabaseClient";
import useOrgId from "@/hooks/useOrgId";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  FileText,
  RefreshCw,
  Loader2,
  CheckCircle,
  XCircle,
  Clock,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  RotateCcw,
} from "lucide-react";
import { toast } from "sonner";

// ---------------------------------------------------------------------------
// Status visual configuration
// ---------------------------------------------------------------------------
const STATUS_CONFIG = {
  uploaded: { color: "bg-blue-100 text-blue-700", icon: Clock },
  parsing: { color: "bg-yellow-100 text-yellow-700", icon: Loader2, spin: true },
  parsed: { color: "bg-green-100 text-green-700", icon: CheckCircle },
  validating: { color: "bg-yellow-100 text-yellow-700", icon: Loader2, spin: true },
  validated: { color: "bg-green-100 text-green-700", icon: CheckCircle },
  storing: { color: "bg-yellow-100 text-yellow-700", icon: Loader2, spin: true },
  stored: { color: "bg-emerald-100 text-emerald-700", icon: CheckCircle },
  processed: { color: "bg-emerald-100 text-emerald-700", icon: CheckCircle },
  failed: { color: "bg-red-100 text-red-700", icon: XCircle },
};

// The ordered pipeline stages are used to derive a progress percentage.
const PIPELINE_STAGES = [
  "uploaded",
  "parsing",
  "parsed",
  "validating",
  "validated",
  "storing",
  "stored",
  "processed",
];

const PAGE_SIZE = 20;

const MODULE_TYPES = [
  "all",
  "rent_roll",
  "expenses",
  "cam",
  "revenue",
  "budget",
  "reconciliation",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return a human-readable relative time string (e.g. "2 hours ago"). */
function relativeTime(dateStr) {
  if (!dateStr) return "";
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffSec = Math.floor((now - then) / 1000);

  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hr${diffHr > 1 ? "s" : ""} ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay} day${diffDay > 1 ? "s" : ""} ago`;
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Determine approximate progress percentage based on pipeline stage. */
function progressForStatus(status) {
  if (status === "failed") return 100;
  const idx = PIPELINE_STAGES.indexOf(status);
  if (idx === -1) return 0;
  return Math.round(((idx + 1) / PIPELINE_STAGES.length) * 100);
}

/** Return true if this status represents an in-progress stage. */
function isInProgress(status) {
  return ["parsing", "validating", "storing"].includes(status);
}

// ---------------------------------------------------------------------------
// FileHistory component
// ---------------------------------------------------------------------------
export default function FileHistory() {
  const { orgId, loading: orgLoading } = useOrgId();

  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [retryingId, setRetryingId] = useState(null);
  const [moduleFilter, setModuleFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [expandedErrorId, setExpandedErrorId] = useState(null);

  // -----------------------------------------------------------------------
  // Data fetching
  // -----------------------------------------------------------------------
  const fetchFiles = useCallback(
    async (silent = false) => {
      if (orgLoading) return;
      if (!silent) setLoading(true);
      else setRefreshing(true);

      try {
        const { data, error } = await supabase.functions.invoke(
          "pipeline-status",
          {
            body: {
              ...(orgId && orgId !== "__none__" ? { org_id: orgId } : {}),
            },
          }
        );

        if (error) {
          toast.error(`Failed to load files: ${error.message || "Unknown error"}`);
          return;
        }

        setFiles(Array.isArray(data) ? data : data?.files ?? []);
      } catch (err) {
        toast.error(`Failed to load files: ${err?.message || "Unexpected error"}`);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [orgId, orgLoading]
  );

  useEffect(() => {
    fetchFiles();
  }, [fetchFiles]);

  // Auto-refresh every 30 seconds when there are in-progress files
  useEffect(() => {
    const hasInProgress = files.some((f) => isInProgress(f.status));
    if (!hasInProgress) return;

    const interval = setInterval(() => fetchFiles(true), 30_000);
    return () => clearInterval(interval);
  }, [files, fetchFiles]);

  // -----------------------------------------------------------------------
  // Actions
  // -----------------------------------------------------------------------
  const handleRetry = async (fileId) => {
    setRetryingId(fileId);
    try {
      const { data, error } = await supabase.functions.invoke("parse-file", {
        body: { file_id: fileId },
      });

      if (error) {
        toast.error(`Retry failed: ${error.message || "Unknown error"}`);
        return;
      }

      toast.success(data?.message || "File reprocessing started");
      // Refresh list after a short delay to pick up the new status
      setTimeout(() => fetchFiles(true), 2000);
    } catch (err) {
      toast.error(`Retry failed: ${err?.message || "Unexpected error"}`);
    } finally {
      setRetryingId(null);
    }
  };

  // -----------------------------------------------------------------------
  // Filtering & pagination
  // -----------------------------------------------------------------------
  const filtered =
    moduleFilter === "all"
      ? files
      : files.filter((f) => f.module_type === moduleFilter);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageFiles = filtered.slice(
    (safePage - 1) * PAGE_SIZE,
    safePage * PAGE_SIZE
  );

  // Reset to page 1 when filter changes
  useEffect(() => {
    setPage(1);
  }, [moduleFilter]);

  // -----------------------------------------------------------------------
  // Render helpers
  // -----------------------------------------------------------------------
  const renderStatusBadge = (status) => {
    const cfg = STATUS_CONFIG[status] || {
      color: "bg-slate-100 text-slate-600",
      icon: AlertTriangle,
    };
    const Icon = cfg.icon;

    return (
      <Badge className={`${cfg.color} gap-1 text-[11px] font-medium border-0`}>
        <Icon
          className={`w-3 h-3 ${cfg.spin ? "animate-spin" : ""}`}
        />
        {status}
      </Badge>
    );
  };

  // -----------------------------------------------------------------------
  // Main render
  // -----------------------------------------------------------------------
  if (orgLoading || loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
          <span className="ml-2 text-sm text-slate-500">Loading file history...</span>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <FileText className="w-5 h-5 text-slate-600" />
            <CardTitle className="text-lg">File History</CardTitle>
            <span className="text-xs text-slate-400">
              {filtered.length} file{filtered.length !== 1 ? "s" : ""}
            </span>
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={() => fetchFiles(true)}
            disabled={refreshing}
            className="gap-1.5"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
        </div>

        {/* Module type filter tabs */}
        <Tabs
          value={moduleFilter}
          onValueChange={setModuleFilter}
          className="mt-3"
        >
          <TabsList className="flex-wrap h-auto gap-1">
            {MODULE_TYPES.map((type) => (
              <TabsTrigger key={type} value={type} className="text-xs capitalize">
                {type === "all" ? "All" : type.replace(/_/g, " ")}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </CardHeader>

      <CardContent>
        {pageFiles.length === 0 ? (
          <div className="text-center py-12 text-sm text-slate-400">
            No files found{moduleFilter !== "all" ? ` for ${moduleFilter.replace(/_/g, " ")}` : ""}.
          </div>
        ) : (
          <div className="border rounded-lg overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-50/60">
                  <TableHead className="text-xs">File Name</TableHead>
                  <TableHead className="text-xs">Type</TableHead>
                  <TableHead className="text-xs">Status</TableHead>
                  <TableHead className="text-xs text-right">Rows</TableHead>
                  <TableHead className="text-xs text-right">Valid</TableHead>
                  <TableHead className="text-xs text-right">Errors</TableHead>
                  <TableHead className="text-xs">Uploaded</TableHead>
                  <TableHead className="text-xs w-[80px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageFiles.map((file) => {
                  const isFailed = file.status === "failed";
                  const isExpanded = expandedErrorId === file.id;
                  const isRetrying = retryingId === file.id;

                  return (
                    <React.Fragment key={file.id}>
                      <TableRow
                        className={
                          isFailed ? "cursor-pointer hover:bg-red-50/40" : ""
                        }
                        onClick={() => {
                          if (isFailed) {
                            setExpandedErrorId(isExpanded ? null : file.id);
                          }
                        }}
                      >
                        <TableCell className="font-medium text-sm max-w-[200px] truncate">
                          {file.file_name || file.name || "Untitled"}
                        </TableCell>
                        <TableCell className="text-xs text-slate-500 capitalize">
                          {(file.module_type || file.type || "—").replace(/_/g, " ")}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-1">
                            {renderStatusBadge(file.status)}
                            {isInProgress(file.status) && (
                              <Progress
                                value={progressForStatus(file.status)}
                                className="h-1 w-20"
                              />
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums">
                          {file.total_rows ?? file.rows ?? "—"}
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums text-green-600">
                          {file.valid_rows ?? file.valid ?? "—"}
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums text-red-600">
                          {file.error_count ?? file.errors ?? "—"}
                        </TableCell>
                        <TableCell className="text-xs text-slate-500 whitespace-nowrap">
                          {relativeTime(file.uploaded_at || file.created_at)}
                        </TableCell>
                        <TableCell>
                          {isFailed && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 gap-1 text-xs"
                              disabled={isRetrying}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleRetry(file.id);
                              }}
                            >
                              {isRetrying ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : (
                                <RotateCcw className="w-3 h-3" />
                              )}
                              Retry
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>

                      {/* Expanded error detail row */}
                      {isFailed && isExpanded && (
                        <TableRow className="bg-red-50/50">
                          <TableCell colSpan={8}>
                            <div className="flex items-start gap-2 py-1 text-xs text-red-700">
                              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                              <span>
                                {file.error_message ||
                                  file.error ||
                                  "No error details available."}
                              </span>
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </React.Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-4 text-xs text-slate-500">
            <span>
              Page {safePage} of {totalPages} ({filtered.length} file
              {filtered.length !== 1 ? "s" : ""})
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                className="h-7 w-7 p-0"
                disabled={safePage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 w-7 p-0"
                disabled={safePage >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

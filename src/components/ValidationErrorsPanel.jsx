import React, { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AlertTriangle, ChevronDown, ChevronUp, Download } from "lucide-react";

/**
 * Displays a collapsible table of validation errors and provides a
 * "Download Error Report" button that exports the errors as CSV.
 *
 * @param {Object}   props
 * @param {Array}    props.errors  - Array of { row, field, message, type }
 */
export default function ValidationErrorsPanel({ errors = [] }) {
  const [collapsed, setCollapsed] = useState(false);

  if (!errors.length) return null;

  const handleDownload = () => {
    const header = "Row,Field,Type,Message";
    const rows = errors.map((e) => {
      const row = String(e.row ?? "");
      const field = String(e.field ?? "");
      const type = String(e.type ?? "");
      const message = `"${String(e.message ?? "").replace(/"/g, '""')}"`;
      return [row, field, type, message].join(",");
    });
    const csv = [header, ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "validation_errors.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card className="border-red-200">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-red-500" />
            <CardTitle className="text-base text-red-700">
              Validation Errors
            </CardTitle>
            <Badge className="bg-red-100 text-red-700 border-0 text-xs">
              {errors.length} {errors.length === 1 ? "error" : "errors"}
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-xs"
              onClick={handleDownload}
            >
              <Download className="w-3.5 h-3.5" />
              Download Error Report
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="gap-1 text-xs"
              onClick={() => setCollapsed((c) => !c)}
            >
              {collapsed ? (
                <>
                  <ChevronDown className="w-3.5 h-3.5" />
                  Show
                </>
              ) : (
                <>
                  <ChevronUp className="w-3.5 h-3.5" />
                  Hide
                </>
              )}
            </Button>
          </div>
        </div>
      </CardHeader>

      {!collapsed && (
        <CardContent className="pt-0">
          <div className="border rounded-lg overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="bg-red-50/60">
                  <TableHead className="text-xs w-16">Row</TableHead>
                  <TableHead className="text-xs">Field</TableHead>
                  <TableHead className="text-xs w-24">Type</TableHead>
                  <TableHead className="text-xs">Message</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {errors.map((err, idx) => (
                  <TableRow key={idx} className="hover:bg-red-50/30">
                    <TableCell className="text-xs tabular-nums font-mono">
                      {err.row ?? "—"}
                    </TableCell>
                    <TableCell className="text-xs font-medium">
                      {err.field ?? "—"}
                    </TableCell>
                    <TableCell>
                      <Badge
                        className={
                          err.type === "error"
                            ? "bg-red-100 text-red-700 border-0 text-[10px]"
                            : "bg-amber-100 text-amber-700 border-0 text-[10px]"
                        }
                      >
                        {err.type ?? "error"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-slate-600">
                      {err.message ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      )}
    </Card>
  );
}

import React, { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Upload, Download, CheckCircle2, Loader2, AlertCircle } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import * as parsers from "@/services/parsingEngine";
import { 
  BuildingService, 
  UnitService, 
  RevenueService, 
  ExpenseService, 
  PropertyService,
  LeaseService
} from "@/services/api";

const SERVICE_MAP = {
  building: BuildingService,
  unit: UnitService,
  revenue: RevenueService,
  expense: ExpenseService,
  property: PropertyService,
  lease: LeaseService
};

const PARSER_MAP = {
  building: parsers.parseBuildings,
  unit: parsers.parseUnits,
  revenue: parsers.parseRevenue,
  expense: parsers.parseExpenses,
  property: parsers.parseProperties,
  lease: parsers.parseLeases
};

export default function BulkImportModal({ isOpen, onClose, moduleType, propertyId }) {
  const queryClient = useQueryClient();
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [data, setData] = useState(null);

  const handleFileUpload = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    setFile(f);
    setLoading(true);

    try {
      const text = await f.text();
      const parser = PARSER_MAP[moduleType];
      if (!parser) throw new Error(`No parser found for ${moduleType}`);

      const result = parser(text);
      setData(result.rows);
      toast.success(`${result.rows.length} rows extracted successfully.`);
    } catch (err) {
      console.error(`[BulkImportModal] ${moduleType} parse error:`, err);
      toast.error(`Failed to parse file: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const executeImport = async () => {
    if (!data || data.length === 0) return;
    setImporting(true);
    const service = SERVICE_MAP[moduleType];

    try {
      let count = 0;
      for (const row of data) {
        // Clean row data (remove metadata fields like _row)
        const { _row, ...cleanData } = row;
        
        // Inject propertyId if provided and not in row
        if (propertyId && !cleanData.property_id) {
          cleanData.property_id = propertyId;
        }

        await service.create(cleanData);
        count++;
      }

      toast.success(`Successfully imported ${count} ${moduleType} records.`);
      queryClient.invalidateQueries(); // Refresh all data
      onClose();
      setData(null);
      setFile(null);
    } catch (err) {
      console.error(`[BulkImportModal] ${moduleType} import error:`, err);
      toast.error(`Import partially failed: ${err.message}`);
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(v) => { if(!v) onClose(); }}>
      <DialogContent className="max-w-4xl max-h-[85vh] overflow-hidden flex flex-col p-0">
        <DialogHeader className="p-6 pb-2">
          <DialogTitle className="capitalize">Bulk {moduleType} Import</DialogTitle>
          <DialogDescription>
            Upload a CSV file to import multiple {moduleType} records at once.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-2">
          {!data ? (
            <div className="border-2 border-dashed border-slate-200 rounded-xl p-12 text-center bg-slate-50/50">
              <Upload className="w-12 h-12 text-slate-300 mx-auto mb-4" />
              <h3 className="text-lg font-bold text-slate-900 mb-1">Select File</h3>
              <p className="text-sm text-slate-500 mb-6">Drag and drop your CSV file here, or click to browse.</p>
              
              {loading ? (
                <div className="flex items-center justify-center gap-2">
                  <Loader2 className="w-5 h-5 animate-spin text-blue-600" />
                  <span className="text-sm text-slate-500">Processing file...</span>
                </div>
              ) : (
                <label className="inline-block">
                  <input type="file" accept=".csv" className="hidden" onChange={handleFileUpload} />
                  <Button asChild className="bg-blue-600 hover:bg-blue-700 cursor-pointer">
                    <span>Browse CSV Files</span>
                  </Button>
                </label>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between bg-blue-50 border border-blue-100 rounded-lg p-3">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-5 h-5 text-blue-600" />
                  <span className="text-sm font-medium text-blue-900">{data.length} records ready to import</span>
                </div>
                <Button variant="ghost" size="sm" onClick={() => { setData(null); setFile(null); }} className="text-blue-700 hover:text-blue-900 text-xs">
                  Change File
                </Button>
              </div>

              <div className="border rounded-lg overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-slate-50">
                      {data.length > 0 && Object.keys(data[0]).filter(k => k !== '_row').map(key => (
                        <TableHead key={key} className="text-[10px] font-bold uppercase truncate max-w-[120px]">{key.replace(/_/g, ' ')}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.slice(0, 10).map((row, i) => (
                      <TableRow key={i}>
                        {Object.entries(row).filter(([k]) => k !== '_row').map(([key, val], j) => (
                          <TableCell key={j} className="text-xs truncate max-w-[120px]">{val?.toString() || '—'}</TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {data.length > 10 && (
                  <div className="p-3 text-center border-t bg-slate-50 text-[10px] text-slate-400">
                    Showing first 10 of {data.length} rows
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="p-6 pt-2 border-t bg-slate-50/50">
          <Button variant="outline" onClick={onClose} disabled={importing}>Cancel</Button>
          {data && (
            <Button onClick={executeImport} disabled={importing} className="bg-emerald-600 hover:bg-emerald-700 min-w-[140px]">
              {importing ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Download className="w-4 h-4 mr-2" />}
              Import {data.length} Records
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

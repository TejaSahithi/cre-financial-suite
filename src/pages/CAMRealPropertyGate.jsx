/**
 * CAMRealPropertyGate — Phase 4B acceptance gate page.
 *
 * Status: BLOCKED — DATA REQUIRED
 *
 * This page tracks the real-property validation gate that must pass before
 * FEATURE_CAM_POSTING_ENABLED can be set to true in production.
 *
 * Gate requirements (all must be checked before VERIFIED):
 *   1. A real anonymized property with actual leases and amendments is selected
 *   2. V1/legacy CAM review and manual reconciliation are completed
 *   3. V2 backfill dry-run passes
 *   4. CAM Setup is complete (pools, participants, policies, expenses)
 *   5. Readiness check passes
 *   6. CAM run is calculated and approved
 *   7. Variance report is submitted with all rows classified
 *   8. All variance rows have a non-POSSIBLE_ENGINE_DEFECT classification
 *   9. A human reviewer marks the gate VERIFIED
 *
 * No synthetic property can satisfy this gate. The gate remains BLOCKED
 * until a real property is supplied and fully reviewed.
 */
import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Lock, AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { supabase } from "@/services/supabaseClient";
import { toast } from "sonner";
import { invokeEdgeFunction } from "@/services/edgeFunctions";
import PageHeader from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

const GATE_ITEMS = [
  { id: 1, label: "Real anonymized property with actual leases, amendments, expenses, and manual CAM reconciliation selected" },
  { id: 2, label: "V1/legacy CAM review and manually prepared CAM reconciliation completed and attached" },
  { id: 3, label: "V2 backfill dry-run run and report reviewed; all backfill-confidence issues resolved" },
  { id: 4, label: "CAM Setup complete (calendar, pools, categories, participants, policies, expenses, estimates)" },
  { id: 5, label: "Readiness check passes with no blocking items" },
  { id: 6, label: "CAM V2 run calculated and approved (posting_eligible mode)" },
  { id: 7, label: "Variance report submitted via submit_real_property_variance_report RPC" },
  { id: 8, label: "All variance rows classified — zero rows with POSSIBLE_ENGINE_DEFECT" },
  { id: 9, label: "Human reviewer has set gate status to VERIFIED (requires service-role UPDATE)" },
];

const VARIANCE_CLASSIFICATIONS = [
  "SOURCE_DATA_MAPPING_DIFFERENCE",
  "CONTRACT_INTERPRETATION_DIFFERENCE",
  "CONFIGURATION_DIFFERENCE",
  "ROUNDING_POLICY_DIFFERENCE",
  "EXPECTED_V2_CORRECTION",
  "POSSIBLE_ENGINE_DEFECT",
];

const CLASSIFICATION_TONE = {
  SOURCE_DATA_MAPPING_DIFFERENCE:    "bg-blue-100 text-blue-700",
  CONTRACT_INTERPRETATION_DIFFERENCE: "bg-indigo-100 text-indigo-700",
  CONFIGURATION_DIFFERENCE:          "bg-amber-100 text-amber-800",
  ROUNDING_POLICY_DIFFERENCE:        "bg-slate-100 text-slate-600",
  EXPECTED_V2_CORRECTION:            "bg-emerald-100 text-emerald-700",
  POSSIBLE_ENGINE_DEFECT:            "bg-red-100 text-red-700",
};

export default function CAMRealPropertyGate() {
  const [selectedGate, setSelectedGate] = useState(null);
  const [verifyDialog, setVerifyDialog] = useState(false);
  const [verifyNotes, setVerifyNotes] = useState("");

  const { data: gateRows = [], refetch: refetchGate } = useQuery({
    queryKey: ["cam_real_property_validations"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("cam_real_property_validations")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const latestGate = gateRows[0];
  const gateStatus = latestGate?.status ?? "BLOCKED";
  const isVerified = gateStatus === "VERIFIED";
  const varianceRows = latestGate?.variance_report?.rows ?? [];

  const defectRows = varianceRows.filter((r) => r.classification === "POSSIBLE_ENGINE_DEFECT");
  const unclassifiedRows = varianceRows.filter((r) => !r.classification);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Real Property Validation Gate"
        subtitle="Acceptance Gate — internal validation prior to production posting enablement"
      />

      {/* Gate status banner */}
      <Alert className={`border-2 ${isVerified ? "border-emerald-300 bg-emerald-50" : "border-red-300 bg-red-50"}`}>
        <div className="flex items-center gap-2">
          {isVerified
            ? <CheckCircle2 className="h-5 w-5 text-emerald-600" />
            : <Lock className="h-5 w-5 text-red-600" />}
          <AlertDescription className={`text-base font-semibold ${isVerified ? "text-emerald-800" : "text-red-800"}`}>
            Gate Status: <strong>{gateStatus}</strong>
            {gateStatus === "BLOCKED" && " — DATA REQUIRED"}
          </AlertDescription>
        </div>
        {latestGate?.block_reason && !isVerified && (
          <p className="text-sm text-red-700 mt-2 ml-7">{latestGate.block_reason}</p>
        )}
      </Alert>

      {/* FEATURE_CAM_POSTING_ENABLED enablement requirement */}
      {!isVerified && (
        <Alert className="border-amber-200 bg-amber-50">
          <AlertTriangle className="h-4 w-4 text-amber-600" />
          <AlertDescription className="text-amber-800 text-sm">
            <strong>Do not set FEATURE_CAM_POSTING_ENABLED=true</strong> until this gate is VERIFIED.
            Synthetic fixtures (test data) do not satisfy this gate — a real anonymized property is required.
          </AlertDescription>
        </Alert>
      )}

      {/* Checklist */}
      <Card>
        <CardHeader><CardTitle className="text-base">Gate Checklist</CardTitle></CardHeader>
        <CardContent>
          <div className="space-y-2">
            {GATE_ITEMS.map((item) => {
              // Only item 7+ can be checked when gate is IN_PROGRESS or further
              const autoChecked =
                item.id <= 6 && gateStatus === "VERIFIED" ? true
                : item.id <= 6 && (gateStatus === "IN_PROGRESS" || gateStatus === "VERIFIED") ? true
                : item.id === 7 && gateStatus !== "BLOCKED" ? true
                : item.id === 8 && defectRows.length === 0 && varianceRows.length > 0 ? true
                : item.id === 9 && gateStatus === "VERIFIED" ? true
                : false;

              return (
                <div key={item.id} className={`flex items-start gap-3 p-3 rounded-lg ${autoChecked ? "bg-emerald-50" : "bg-slate-50"}`}>
                  {autoChecked
                    ? <CheckCircle2 className="w-4 h-4 text-emerald-600 mt-0.5 flex-shrink-0" />
                    : <XCircle className="w-4 h-4 text-red-400 mt-0.5 flex-shrink-0" />}
                  <p className="text-sm">{item.label}</p>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Variance report (shown when submitted) */}
      {varianceRows.length > 0 && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">Variance Report</CardTitle>
            <div className="flex items-center gap-2">
              <Badge className={`text-[10px] ${defectRows.length > 0 ? "bg-red-100 text-red-700" : "bg-emerald-100 text-emerald-700"}`}>
                {defectRows.length} POSSIBLE_ENGINE_DEFECT row(s)
              </Badge>
              <Badge className="text-[10px] bg-slate-100 text-slate-600">
                {varianceRows.length} total rows
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            {defectRows.length > 0 && (
              <Alert className="border-red-200 bg-red-50 mb-4">
                <AlertTriangle className="h-4 w-4 text-red-500" />
                <AlertDescription className="text-red-700 text-sm">
                  <strong>{defectRows.length} row(s) are classified POSSIBLE_ENGINE_DEFECT.</strong> These must be investigated
                  and reclassified (or the engine defect must be fixed) before the gate can be VERIFIED.
                </AlertDescription>
              </Alert>
            )}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Lease</TableHead>
                  <TableHead>Metric</TableHead>
                  <TableHead className="text-right">V1 Value</TableHead>
                  <TableHead className="text-right">V2 Value</TableHead>
                  <TableHead className="text-right">Delta</TableHead>
                  <TableHead>Classification</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {varianceRows.map((row, idx) => (
                  <TableRow key={idx} className={row.classification === "POSSIBLE_ENGINE_DEFECT" ? "bg-red-50" : ""}>
                    <TableCell className="font-mono text-xs">{row.lease_id?.slice(0, 8)}…</TableCell>
                    <TableCell className="text-xs">{row.metric}</TableCell>
                    <TableCell className="text-right text-xs">{Number(row.v1_value).toLocaleString("en-US", { minimumFractionDigits: 2 })}</TableCell>
                    <TableCell className="text-right text-xs">{Number(row.v2_value).toLocaleString("en-US", { minimumFractionDigits: 2 })}</TableCell>
                    <TableCell className={`text-right text-xs font-semibold ${Math.abs(row.v2_value - row.v1_value) > 0.01 ? "text-red-600" : "text-slate-600"}`}>
                      {(row.v2_value - row.v1_value).toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 })}
                    </TableCell>
                    <TableCell>
                      {row.classification
                        ? <Badge className={`text-[9px] ${CLASSIFICATION_TONE[row.classification] ?? "bg-slate-100 text-slate-600"}`}>{row.classification}</Badge>
                        : <Badge className="text-[9px] bg-amber-100 text-amber-700">UNCLASSIFIED</Badge>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* How to proceed / Controlled verify command */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Controlled Verification Command</CardTitle>
          {latestGate && !isVerified && (
            <Button
              id="btn-verify-gate-command"
              variant="outline"
              disabled={defectRows.length > 0 || varianceRows.length === 0}
              onClick={() => setVerifyDialog(true)}
            >
              Verify Gate (RPC)
            </Button>
          )}
        </CardHeader>
        <CardContent className="text-sm text-slate-600 space-y-3">
          <p>This gate remains <strong>BLOCKED</strong> until a real anonymized property is available and verified through the controlled command:</p>
          <ol className="list-decimal list-inside space-y-1.5 ml-2">
            <li>Complete steps 1–6 of the gate checklist (Setup → Calculate → Approve in posting_eligible mode).</li>
            <li>Prepare a manual CAM reconciliation for the property (the "ground truth").</li>
            <li>Compute per-lease variance between V1/manual and V2 results.</li>
            <li>Call <code className="bg-slate-100 px-1 rounded">submit_real_property_variance_report</code> RPC with the variance rows.</li>
            <li>Classify each variance row; resolve any POSSIBLE_ENGINE_DEFECT rows.</li>
            <li>Execute controlled <code className="bg-slate-100 px-1 rounded">verify_cam_real_property_validation</code> command with audit notes.</li>
            <li>Only then set <code className="bg-slate-100 px-1 rounded">FEATURE_CAM_POSTING_ENABLED=true</code>.</li>
          </ol>
        </CardContent>
      </Card>

      {/* Controlled Verification Dialog */}
      <Dialog open={verifyDialog} onOpenChange={setVerifyDialog}>
        <DialogContent>
          <DialogHeader><DialogTitle>Verify Real Property Validation Gate</DialogTitle></DialogHeader>
          <p className="text-sm text-slate-600">
            This will execute the controlled <code className="text-xs">verify_cam_real_property_validation</code> RPC to mark this gate <strong>VERIFIED</strong>.
          </p>
          <div className="space-y-3 mt-2">
            <div>
              <Label>Audit / Review Notes (required)</Label>
              <Textarea
                id="verify-notes"
                rows={3}
                placeholder="Enter audit evidence and tie-out review findings..."
                value={verifyNotes}
                onChange={(e) => setVerifyNotes(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setVerifyDialog(false)}>Cancel</Button>
            <Button
              id="btn-confirm-verify-gate"
              disabled={!verifyNotes.trim()}
              onClick={async () => {
                try {
                  const { data, error } = await invokeEdgeFunction("cam-run-workflow-v2", {
                    action: "verify_gate",
                    cam_run_id: latestGate.cam_run_id,
                    property_id: latestGate.property_id,
                    review_notes: verifyNotes,
                  });
                  if (error) throw new Error(error.message ?? JSON.stringify(error));
                  toast.success("Gate status set to VERIFIED");
                  setVerifyDialog(false);
                  refetchGate();
                } catch (err) {
                  toast.error(err.message);
                }
              }}
            >
              Confirm Verification
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

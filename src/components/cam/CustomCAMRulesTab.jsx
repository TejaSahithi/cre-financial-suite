import React, { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Save, AlertTriangle, ChevronDown, ChevronUp, Sliders, Calculator, CheckCircle2 } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { createPageUrl } from "@/utils";

import { toast } from "sonner";

import { fetchLeaseConfig, saveLeaseConfig, DEFAULT_LEASE_CAM_CONFIG } from "@/services/camConfig";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// sentinel value for "no selection" in dropdowns — React Select forbids empty string values
const NONE = "__none__";

const CAP_TYPES = [
  { value: "none", label: "No Cap" },
  { value: "cumulative", label: "Cumulative (year-over-year)" },
  { value: "non_cumulative", label: "Non-Cumulative (fixed base)" },
  { value: "absolute", label: "Absolute Dollar Cap" },
];

const ALLOCATION_METHODS = [
  { value: NONE, label: "— Use Property Default —" },
  { value: "pro_rata_total_sqft", label: "Pro-Rata by Total SqFt" },
  { value: "pro_rata_occupied_sqft", label: "Pro-Rata by Occupied SqFt" },
  { value: "equal_split", label: "Equal Split" },
  { value: "weighted_allocation", label: "Weighted Allocation" },
];

const COMMON_EXCLUSIONS = [
  "management", "insurance", "landscaping", "janitorial", "utilities",
  "security", "parking", "capital_improvements", "tenant_improvements",
];

function yearOptions(currentYear) {
  return [currentYear - 4, currentYear - 3, currentYear - 2, currentYear - 1, currentYear];
}

function LeaseRuleCard({ lease, currentYear, onSaved }) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState({ ...DEFAULT_LEASE_CAM_CONFIG });
  const [exclusionInput, setExclusionInput] = useState("");
  const [saved, setSaved] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["lease-config", lease.id],
    queryFn: () => fetchLeaseConfig(lease.id),
    enabled: expanded,
  });

  useEffect(() => {
    if (data?.values) setDraft({ ...DEFAULT_LEASE_CAM_CONFIG, ...data.values });
  }, [data]);

  const saveMut = useMutation({
    mutationFn: () => saveLeaseConfig(lease.id, draft),
    onSuccess: () => {
      toast.success(`CAM rules saved for ${lease.tenant_name}`);
      setSaved(true);
      queryClient.invalidateQueries({ queryKey: ["lease-config", lease.id] });
      onSaved?.();
    },
    onError: (err) => toast.error(`Failed to save: ${err?.message}`),
  });

  const toggleExclusion = (cat) => {
    setSaved(false);
    setDraft((prev) => ({
      ...prev,
      excluded_expenses: prev.excluded_expenses?.includes(cat)
        ? prev.excluded_expenses.filter((x) => x !== cat)
        : [...(prev.excluded_expenses ?? []), cat],
    }));
  };

  const addCustomExclusion = () => {
    const cat = exclusionInput.trim().toLowerCase().replace(/\s+/g, "_");
    if (!cat) return;
    if (!draft.excluded_expenses?.includes(cat)) {
      setDraft((prev) => ({ ...prev, excluded_expenses: [...(prev.excluded_expenses ?? []), cat] }));
      setSaved(false);
    }
    setExclusionInput("");
  };

  const set = (key, val) => { setDraft((p) => ({ ...p, [key]: val })); setSaved(false); };

  const hasSavedConfig = !!data?.row;
  const hasCustomRules = (
    draft.cam_cap_type !== "none" ||
    draft.base_year != null ||
    (draft.excluded_expenses?.length > 0) ||
    draft.gross_up_clause ||
    (draft.allocation_method && draft.allocation_method !== NONE) ||
    draft.cam_applicable === false
  );

  return (
    <div className="border rounded-xl overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-4 py-3 bg-white hover:bg-slate-50 transition-colors"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-teal-100 flex items-center justify-center text-teal-700 font-bold text-xs">
            {lease.tenant_name?.charAt(0) || "T"}
          </div>
          <div className="text-left">
            <p className="text-sm font-semibold text-slate-900">{lease.tenant_name}</p>
            <p className="text-xs text-slate-400">
              {lease.square_footage?.toLocaleString() || "—"} SF
              {lease.unit_id ? ` · Unit ${lease.unit_id.slice(0, 8)}` : ""}
            </p>
          </div>
          {hasCustomRules && (
            <Badge className="bg-amber-100 text-amber-700 border-amber-200 text-[9px] ml-1">CUSTOM RULES ACTIVE</Badge>
          )}
          {saved && (
            <span className="flex items-center gap-1 text-[10px] text-teal-600 ml-1">
              <CheckCircle2 className="w-3 h-3" /> Saved
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400">
            {draft.cam_applicable === false
              ? "❌ Excluded from CAM"
              : draft.cam_cap_type !== "none"
              ? `Cap: ${draft.cam_cap_rate ? `${draft.cam_cap_rate}%` : draft.cam_cap_type}`
              : "No cap"}
          </span>
          {expanded ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
        </div>
      </button>

      {expanded && (
        <div className="border-t bg-slate-50 p-4 space-y-5">
          {/* Info banner */}
          <div className="flex items-center justify-between bg-teal-50 border border-teal-200 rounded-lg px-3 py-2">
            <div className="flex items-start gap-2 text-xs text-teal-800">
              <Calculator className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>These rules are automatically applied when CAM is calculated for this property. Save rules, then run Calculate CAM.</span>
            </div>
            <Link to={createPageUrl("CAMCalculation")}>
              <Button variant="link" size="sm" className="h-auto p-0 text-[10px] text-teal-700 font-bold uppercase hover:text-teal-900">
                Run Calculation →
              </Button>
            </Link>
          </div>

          {/* CAM Applicability */}
          <div className="flex items-center justify-between border rounded-xl bg-white px-4 py-3">
            <div>
              <p className="text-sm font-medium text-slate-900">Include in CAM Pool</p>
              <p className="text-xs text-slate-500">Turn off to exclude this tenant from all CAM allocation</p>
            </div>
            <Switch
              checked={draft.cam_applicable !== false}
              onCheckedChange={(v) => set("cam_applicable", v)}
            />
          </div>

          {draft.cam_applicable !== false && (
            <>
              {/* Allocation + Weight */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Allocation Method Override</Label>
                  <Select
                    value={draft.allocation_method || NONE}
                    onValueChange={(v) => set("allocation_method", v === NONE ? "" : v)}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {ALLOCATION_METHODS.map((m) => (
                        <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Weight Factor (for weighted allocation)</Label>
                  <Input
                    type="number"
                    min={0}
                    placeholder={`Default: ${lease.square_footage || "lease sqft"}`}
                    value={draft.weight_factor ?? ""}
                    onChange={(e) => set("weight_factor", e.target.value !== "" ? Number(e.target.value) : null)}
                  />
                </div>
              </div>

              {/* Base Year */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Base Year <span className="text-slate-400">(tenant pays increase above base)</span></Label>
                  <Select
                    value={draft.base_year != null ? String(draft.base_year) : NONE}
                    onValueChange={(v) => set("base_year", v !== NONE ? Number(v) : null)}
                  >
                    <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>None</SelectItem>
                      {yearOptions(currentYear).map((y) => (
                        <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Base Year Amount Override $</Label>
                  <Input
                    type="number"
                    min={0}
                    placeholder="Auto-pull from prior snapshot"
                    value={draft.base_year_amount ?? ""}
                    onChange={(e) => set("base_year_amount", e.target.value !== "" ? Number(e.target.value) : null)}
                  />
                </div>
              </div>

              {/* Expense Stop & Mgmt Fee */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Expense Stop Amount $</Label>
                  <Input
                    type="number"
                    min={0}
                    placeholder="Gross lease stop threshold"
                    value={draft.expense_stop_amount ?? ""}
                    onChange={(e) => set("expense_stop_amount", e.target.value !== "" ? Number(e.target.value) : null)}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Management Fee % Override</Label>
                  <Input
                    type="number"
                    min={0}
                    placeholder="Use property default"
                    value={draft.management_fee_pct ?? ""}
                    onChange={(e) => set("management_fee_pct", e.target.value !== "" ? Number(e.target.value) : null)}
                  />
                </div>
              </div>

              {/* CAM Cap */}
              <div className="space-y-2">
                <Label className="text-xs font-semibold">CAM Cap Rules</Label>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Cap Type</Label>
                    <Select
                      value={draft.cam_cap_type || "none"}
                      onValueChange={(v) => set("cam_cap_type", v)}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {CAP_TYPES.map((t) => (
                          <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {(draft.cam_cap_type === "cumulative" || draft.cam_cap_type === "non_cumulative") && (
                    <div className="space-y-1">
                      <Label className="text-xs">Year-over-Year Cap Rate %</Label>
                      <Input
                        type="number"
                        min={0}
                        placeholder="e.g. 5 for 5%"
                        value={draft.cam_cap_rate ?? ""}
                        onChange={(e) => set("cam_cap_rate", e.target.value !== "" ? Number(e.target.value) : null)}
                      />
                    </div>
                  )}

                  {draft.cam_cap_type === "non_cumulative" && (
                    <div className="space-y-1">
                      <Label className="text-xs">Non-Cumulative Base Year</Label>
                      <Select
                        value={draft.non_cumulative_cap_base_year != null ? String(draft.non_cumulative_cap_base_year) : NONE}
                        onValueChange={(v) => set("non_cumulative_cap_base_year", v !== NONE ? Number(v) : null)}
                      >
                        <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE}>None</SelectItem>
                          {yearOptions(currentYear).map((y) => (
                            <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  {draft.cam_cap_type === "absolute" && (
                    <div className="space-y-1">
                      <Label className="text-xs">Absolute CAM Cap $</Label>
                      <Input
                        type="number"
                        min={0}
                        placeholder="Maximum annual CAM"
                        value={draft.cam_cap ?? ""}
                        onChange={(e) => set("cam_cap", e.target.value !== "" ? Number(e.target.value) : null)}
                      />
                    </div>
                  )}

                  {(draft.cam_cap_type === "cumulative" || draft.cam_cap_type === "non_cumulative") && (
                    <div className="space-y-1">
                      <Label className="text-xs">Controllable-Only Cap Rate %</Label>
                      <Input
                        type="number"
                        min={0}
                        placeholder="HVAC, janitorial, etc."
                        value={draft.controllable_cap_rate ?? ""}
                        onChange={(e) => set("controllable_cap_rate", e.target.value !== "" ? Number(e.target.value) : null)}
                      />
                    </div>
                  )}
                </div>
              </div>

              {/* Gross-Up */}
              <div className="flex items-center justify-between border rounded-xl bg-white px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-slate-900">Gross-Up Clause</p>
                  <p className="text-xs text-slate-500">Override property-level gross-up for this lease</p>
                </div>
                <Switch
                  checked={Boolean(draft.gross_up_clause)}
                  onCheckedChange={(v) => set("gross_up_clause", v)}
                />
              </div>

              {/* Excluded Expense Categories */}
              <div className="space-y-2">
                <Label className="text-xs font-semibold">Excluded Expense Categories</Label>
                <p className="text-[10px] text-slate-400">Click to exclude. The compute-cam engine will skip these categories for this tenant.</p>
                <div className="flex flex-wrap gap-2">
                  {COMMON_EXCLUSIONS.map((cat) => {
                    const active = draft.excluded_expenses?.includes(cat);
                    return (
                      <button
                        key={cat}
                        type="button"
                        onClick={() => toggleExclusion(cat)}
                        className={`text-[10px] px-2 py-1 rounded-full border transition-colors ${
                          active
                            ? "bg-red-100 text-red-700 border-red-300"
                            : "bg-white text-slate-600 border-slate-200 hover:border-slate-400"
                        }`}
                      >
                        {active ? "✕ " : "+ "}{cat.replace(/_/g, " ")}
                      </button>
                    );
                  })}
                </div>
                <div className="flex gap-2">
                  <Input
                    className="h-7 text-xs"
                    placeholder="Add custom category (e.g. hvac)..."
                    value={exclusionInput}
                    onChange={(e) => setExclusionInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && addCustomExclusion()}
                  />
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={addCustomExclusion}>Add</Button>
                </div>
                {draft.excluded_expenses?.filter((e) => !COMMON_EXCLUSIONS.includes(e)).map((cat) => (
                  <Badge key={cat} className="bg-red-50 text-red-600 border-red-200 text-[10px] mr-1">
                    {cat}{" "}
                    <button type="button" className="ml-1 hover:text-red-800" onClick={() => toggleExclusion(cat)}>✕</button>
                  </Badge>
                ))}
              </div>
            </>
          )}

          <div className="flex justify-end pt-2">
            <Button
              size="sm"
              className="bg-teal-600 hover:bg-teal-700"
              onClick={() => saveMut.mutate()}
              disabled={saveMut.isPending}
            >
              <Save className="w-3 h-3 mr-1" />
              {saveMut.isPending ? "Saving..." : "Save Rules"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function CustomCAMRulesTab({ leases = [], currentYear, onTriggerCalculation, propertyId }) {
  const navigate = useNavigate();
  const [savedCount, setSavedCount] = useState(0);

  const activeLeases = leases.filter((l) => {
    const status = String(l.status || "active").toLowerCase();
    return status !== "expired" && status !== "terminated";
  });

  if (!activeLeases.length) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <AlertTriangle className="w-8 h-8 text-amber-400 mx-auto mb-2" />
          <p className="text-sm text-slate-600">No active leases in the selected property.</p>
          <p className="text-xs text-slate-400 mt-1">Select a property with active leases to configure per-tenant CAM rules.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sliders className="w-4 h-4 text-teal-600" />
            <CardTitle className="text-base">Custom CAM Rules per Tenant</CardTitle>
          </div>
          <Button
            size="sm"
            className="bg-teal-600 hover:bg-teal-700 gap-1"
            onClick={onTriggerCalculation}
          >
            <Calculator className="w-3.5 h-3.5" />
            Run CAM Calculation
          </Button>
        </div>
        <div className="text-xs text-teal-700 bg-teal-50 border border-teal-200 rounded-lg px-3 py-2 mt-2 flex items-start gap-2">
          <Calculator className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>
            Rules saved here are <strong>automatically loaded by the compute-cam engine</strong> on every calculation.
            Configure per-tenant overrides below, save them, then click <strong>Run CAM Calculation</strong>.
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {activeLeases.map((lease) => (
          <LeaseRuleCard
            key={lease.id}
            lease={lease}
            currentYear={currentYear}
            onSaved={() => setSavedCount((n) => n + 1)}
          />
        ))}
        {savedCount > 0 && (
          <div className="flex items-center justify-between border border-teal-200 bg-teal-50 rounded-xl px-4 py-3">
            <div className="flex items-center gap-2 text-sm text-teal-800">
              <CheckCircle2 className="w-4 h-4" />
              {savedCount} rule{savedCount > 1 ? "s" : ""} saved — ready for recalculation
            </div>
            <Button size="sm" className="bg-teal-600 hover:bg-teal-700" onClick={onTriggerCalculation}>
              <Calculator className="w-3.5 h-3.5 mr-1" />
              Calculate CAM Now
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

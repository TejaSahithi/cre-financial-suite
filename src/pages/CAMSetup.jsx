/**
 * CAMSetup — per-lease CAM profile management. Sits between the Lease
 * Expense Rules page (which captures recovery responsibility per category)
 * and CAM Calculation (which produces tenant recoveries). The page is
 * backed by the existing `cam_profiles` table (1:1 with leases, populated
 * at lease-review time) plus the Phase 8 approval columns.
 *
 * Validation rule: if building_rsf is missing, the row is forced into
 * Manual Required regardless of stored status, because pro-rata recovery
 * cannot be calculated without it.
 */
import React, { useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  Calculator,
  CheckCircle2,
  Loader2,
  Pencil,
  Settings,
} from "lucide-react";
import PageHeader from "@/components/PageHeader";
import ScopeSelector from "@/components/ScopeSelector";
import useOrgQuery from "@/hooks/useOrgQuery";
import {
  buildHierarchyScope,
  getScopeSubtitle,
  matchesHierarchyScope,
} from "@/lib/hierarchyScope";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { supabase } from "@/services/supabaseClient";
import { createPageUrl } from "@/utils";

const STATUS_STYLE = {
  approved: "bg-emerald-100 text-emerald-700",
  draft: "bg-slate-100 text-slate-700",
  pending_review: "bg-blue-100 text-blue-700",
  manual_required: "bg-amber-100 text-amber-800",
  rejected: "bg-red-100 text-red-700",
};

function computeEffectiveStatus(profile) {
  if (!profile?.building_rsf || Number(profile.building_rsf) === 0) {
    return { status: "manual_required", reason: "Missing building RSF" };
  }
  if (!profile?.tenant_pro_rata_share && (!profile?.tenant_rsf || !profile?.building_rsf)) {
    return { status: "manual_required", reason: "Missing tenant share / RSF" };
  }
  return { status: profile.status || "draft", reason: null };
}

export default function CAMSetup() {
  const location = useLocation();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState("all");
  const [editing, setEditing] = useState(null);

  const { data: leases = [] } = useOrgQuery("Lease");
  const { data: portfolios = [] } = useOrgQuery("Portfolio");
  const { data: properties = [] } = useOrgQuery("Property");
  const { data: buildings = [] } = useOrgQuery("Building");
  const { data: units = [] } = useOrgQuery("Unit");

  const scope = useMemo(
    () =>
      buildHierarchyScope({
        search: location.search,
        portfolios,
        properties,
        buildings,
        units,
      }),
    [location.search, portfolios, properties, buildings, units]
  );

  const [scopeProperty, setScopeProperty] = useState(scope.propertyId || "all");
  const [scopeBuilding, setScopeBuilding] = useState(scope.buildingId || "all");
  const [scopeUnit, setScopeUnit] = useState(scope.unitId || "all");

  const { data: profiles = [], isLoading } = useQuery({
    queryKey: ["cam-profiles"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("cam_profiles")
        .select(
          "id, org_id, lease_id, property_id, cam_structure, recovery_status, " +
          "cam_start_date, cam_end_date, estimate_frequency, reconciliation_frequency, " +
          "tenant_rsf, building_rsf, tenant_pro_rata_share, cam_cap_type, cam_cap_percent, " +
          "admin_fee_percent, gross_up_percent, included_expenses, excluded_expenses, " +
          "status, approved_at, approved_by, validation_warnings, notes, created_at, updated_at",
        )
        .order("updated_at", { ascending: false });
      if (error) {
        console.warn("[CAMSetup] profiles query failed:", error.message);
        return [];
      }
      return data || [];
    },
  });

  const leaseById = useMemo(() => {
    const m = new Map();
    for (const l of leases) m.set(l.id, l);
    return m;
  }, [leases]);

  // Scope filter on the underlying lease.
  const scopedProfiles = profiles.filter((p) => {
    const lease = leaseById.get(p.lease_id);
    if (!lease) return false;
    if (!matchesHierarchyScope(lease, scope, { propertyKey: "property_id", unitKey: "unit_id" })) return false;
    if (scopeProperty !== "all" && p.property_id !== scopeProperty) return false;
    if (scopeBuilding !== "all") {
      const unit = lease.unit_id ? scope.unitById.get(lease.unit_id) : null;
      if (unit?.building_id !== scopeBuilding) return false;
    }
    if (scopeUnit !== "all" && lease.unit_id !== scopeUnit) return false;
    return true;
  });

  // Compute effective status per profile (forces manual_required when
  // critical fields are missing) and surface validation warnings.
  const decoratedProfiles = scopedProfiles.map((p) => {
    const effective = computeEffectiveStatus(p);
    return { ...p, effectiveStatus: effective.status, effectiveReason: effective.reason };
  });

  const filteredProfiles = decoratedProfiles.filter((p) => {
    if (filter === "all") return true;
    return p.effectiveStatus === filter;
  });

  const counts = useMemo(() => {
    const c = { all: decoratedProfiles.length, draft: 0, pending_review: 0, manual_required: 0, approved: 0 };
    for (const p of decoratedProfiles) {
      if (c[p.effectiveStatus] !== undefined) c[p.effectiveStatus] += 1;
    }
    return c;
  }, [decoratedProfiles]);

  // Mutation: save edits.
  const saveMutation = useMutation({
    mutationFn: async ({ id, patch }) => {
      const { data, error } = await supabase
        .from("cam_profiles")
        .update(patch)
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cam-profiles"] });
      toast.success("CAM profile updated");
      setEditing(null);
    },
    onError: (err) => toast.error(err?.message || "Could not save CAM profile"),
  });

  const approveMutation = useMutation({
    mutationFn: async (profile) => {
      const effective = computeEffectiveStatus(profile);
      if (effective.status === "manual_required") {
        throw new Error(`Cannot approve: ${effective.reason}`);
      }
      const { data, error } = await supabase
        .from("cam_profiles")
        .update({
          status: "approved",
          approved_at: new Date().toISOString(),
          approved_by: null, // populated via DB trigger or auth context in real deployment
        })
        .eq("id", profile.id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cam-profiles"] });
      toast.success("CAM Setup approved");
    },
    onError: (err) => toast.error(err?.message || "Could not approve CAM Setup"),
  });

  const subtitle = getScopeSubtitle(scope, {
    default: `${filteredProfiles.length} CAM profile${filteredProfiles.length === 1 ? "" : "s"}`,
  });

  // Find leases with no CAM profile so reviewers can create one from this view.
  const leasesWithoutProfile = leases.filter((l) => {
    if (String(l.abstract_status || l.status || "").toLowerCase() !== "approved") return false;
    return !profiles.some((p) => p.lease_id === l.id);
  });

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        icon={Settings}
        title="CAM Setup"
        subtitle={subtitle}
        iconColor="from-teal-500 to-cyan-600"
      />

      <Card className="border-blue-200 bg-blue-50">
        <CardContent className="flex items-start gap-2 p-4 text-sm text-blue-800">
          <AlertTriangle className="mt-0.5 h-4 w-4" />
          <div>
            <p className="font-medium">CAM Setup precedes CAM Calculation</p>
            <p className="text-xs">
              Each approved lease gets one CAM profile here. Once the profile is approved (RSF,
              pro-rata share, recoverable categories, caps), CAM Calculation can produce tenant
              recoveries. Approved lease expense rules from{" "}
              <Link to={createPageUrl("LeaseExpenseRules")} className="underline">Lease Expense Rules</Link>{" "}
              drive the recoverable category list.
            </p>
          </div>
        </CardContent>
      </Card>

      <ScopeSelector
        properties={scope.scopedProperties}
        buildings={scope.scopedBuildings}
        units={scope.scopedUnits}
        selectedProperty={scopeProperty}
        selectedBuilding={scopeBuilding}
        selectedUnit={scopeUnit}
        onPropertyChange={setScopeProperty}
        onBuildingChange={setScopeBuilding}
        onUnitChange={setScopeUnit}
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatCard label="All Profiles" value={counts.all} />
        <StatCard label="Draft" value={counts.draft} accent="border-l-slate-400 bg-slate-50" />
        <StatCard label="Pending Review" value={counts.pending_review} accent="border-l-blue-500 bg-blue-50" />
        <StatCard label="Manual Required" value={counts.manual_required} accent="border-l-amber-500 bg-amber-50" />
        <StatCard label="Approved" value={counts.approved} accent="border-l-emerald-500 bg-emerald-50" />
      </div>

      <Tabs value={filter} onValueChange={setFilter}>
        <TabsList className="bg-white border">
          <TabsTrigger value="all" className="text-xs">All ({counts.all})</TabsTrigger>
          <TabsTrigger value="manual_required" className="text-xs">Manual Required ({counts.manual_required})</TabsTrigger>
          <TabsTrigger value="draft" className="text-xs">Draft ({counts.draft})</TabsTrigger>
          <TabsTrigger value="pending_review" className="text-xs">Pending ({counts.pending_review})</TabsTrigger>
          <TabsTrigger value="approved" className="text-xs">Approved ({counts.approved})</TabsTrigger>
        </TabsList>
      </Tabs>

      <Card>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-slate-50">
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Lease</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">CAM Structure</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Tenant RSF</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Building RSF</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Pro-Rata</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Admin Fee</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Gross-Up</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Cap</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Estimate / Recon</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Status</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={11} className="py-12 text-center">
                    <Loader2 className="mx-auto h-5 w-5 animate-spin text-slate-400" />
                  </TableCell>
                </TableRow>
              ) : filteredProfiles.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={11} className="py-12 text-center text-sm text-slate-400">
                    No CAM profiles in this view. Approve a lease abstract to create one.
                  </TableCell>
                </TableRow>
              ) : (
                filteredProfiles.map((profile) => {
                  const lease = leaseById.get(profile.lease_id);
                  const property = lease?.property_id ? scope.propertyById.get(lease.property_id) : null;
                  const proRata = profile.tenant_pro_rata_share
                    ? `${Number(profile.tenant_pro_rata_share).toFixed(2)}%`
                    : "—";
                  return (
                    <TableRow key={profile.id} className="align-top hover:bg-slate-50">
                      <TableCell className="text-sm">
                        <p className="font-medium text-slate-900">{lease?.tenant_name || lease?.id?.slice(0, 8) || "—"}</p>
                        <p className="text-[10px] text-slate-500">{property?.name || "—"}</p>
                      </TableCell>
                      <TableCell className="text-sm text-slate-700">
                        {profile.cam_structure || profile.recovery_status || "—"}
                      </TableCell>
                      <TableCell className="text-sm">{profile.tenant_rsf ? Number(profile.tenant_rsf).toLocaleString() : "—"}</TableCell>
                      <TableCell className="text-sm">
                        {profile.building_rsf ? (
                          Number(profile.building_rsf).toLocaleString()
                        ) : (
                          <span className="text-red-600">missing</span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm">{proRata}</TableCell>
                      <TableCell className="text-sm">{profile.admin_fee_percent ? `${profile.admin_fee_percent}%` : "—"}</TableCell>
                      <TableCell className="text-sm">{profile.gross_up_percent ? `${profile.gross_up_percent}%` : "—"}</TableCell>
                      <TableCell className="text-sm">
                        {profile.cam_cap_type && profile.cam_cap_type !== "none"
                          ? `${profile.cam_cap_type} ${profile.cam_cap_percent ? `${profile.cam_cap_percent}%` : ""}`
                          : "—"}
                      </TableCell>
                      <TableCell className="text-sm">
                        {profile.estimate_frequency || "—"} / {profile.reconciliation_frequency || "—"}
                      </TableCell>
                      <TableCell>
                        <Badge className={`text-[10px] ${STATUS_STYLE[profile.effectiveStatus] || "bg-slate-100"}`}>
                          {profile.effectiveStatus.replace("_", " ")}
                        </Badge>
                        {profile.effectiveReason && (
                          <p className="mt-1 text-[10px] text-amber-700">{profile.effectiveReason}</p>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs"
                            onClick={() => setEditing(profile)}
                          >
                            <Pencil className="mr-1 h-3.5 w-3.5" />
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs text-emerald-700 hover:text-emerald-800"
                            disabled={profile.effectiveStatus === "manual_required" || approveMutation.isPending}
                            onClick={() => approveMutation.mutate(profile)}
                          >
                            <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                            Approve
                          </Button>
                          {lease?.property_id && (
                            <Link
                              to={
                                createPageUrl("CAMCalculation") +
                                `?property_id=${lease.property_id}&year=${new Date().getFullYear()}`
                              }
                            >
                              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-blue-700 hover:text-blue-800">
                                <Calculator className="mr-1 h-3.5 w-3.5" />
                                Generate Estimate
                              </Button>
                            </Link>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </Card>

      {leasesWithoutProfile.length > 0 && (
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="p-4 text-sm text-amber-800">
            <p className="font-medium">{leasesWithoutProfile.length} approved lease(s) without a CAM profile</p>
            <p className="text-xs">
              These leases need a CAM profile before recoveries can be calculated. Open the lease in
              Lease Review or Lease Detail to populate CAM terms; the profile will be created on save.
            </p>
            <ul className="mt-2 space-y-1 text-xs">
              {leasesWithoutProfile.slice(0, 10).map((l) => (
                <li key={l.id} className="flex items-center justify-between">
                  <span>{l.tenant_name || l.id.slice(0, 8)}</span>
                  <Link
                    to={createPageUrl("LeaseReview") + `?id=${l.id}`}
                    className="text-blue-600 hover:text-blue-700"
                  >
                    Open Lease Review →
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Edit dialog */}
      <Dialog open={!!editing} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              Edit CAM Setup — {leaseById.get(editing?.lease_id)?.tenant_name || ""}
            </DialogTitle>
          </DialogHeader>
          {editing && <EditForm profile={editing} onSave={(patch) => saveMutation.mutate({ id: editing.id, patch })} saving={saveMutation.isPending} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EditForm({ profile, onSave, saving }) {
  const [form, setForm] = useState({
    cam_structure: profile.cam_structure || "",
    tenant_rsf: profile.tenant_rsf || "",
    building_rsf: profile.building_rsf || "",
    tenant_pro_rata_share: profile.tenant_pro_rata_share || "",
    admin_fee_percent: profile.admin_fee_percent || "",
    gross_up_percent: profile.gross_up_percent || "",
    cam_cap_type: profile.cam_cap_type || "none",
    cam_cap_percent: profile.cam_cap_percent || "",
    estimate_frequency: profile.estimate_frequency || "annual",
    reconciliation_frequency: profile.reconciliation_frequency || "annual",
    status: profile.status || "draft",
    notes: profile.notes || "",
  });

  const set = (key) => (e) => setForm((prev) => ({ ...prev, [key]: e.target?.value ?? e }));

  const handleSubmit = () => {
    const patch = {
      ...form,
      tenant_rsf: form.tenant_rsf ? Number(form.tenant_rsf) : null,
      building_rsf: form.building_rsf ? Number(form.building_rsf) : null,
      tenant_pro_rata_share: form.tenant_pro_rata_share ? Number(form.tenant_pro_rata_share) : null,
      admin_fee_percent: form.admin_fee_percent ? Number(form.admin_fee_percent) : null,
      gross_up_percent: form.gross_up_percent ? Number(form.gross_up_percent) : null,
      cam_cap_percent: form.cam_cap_percent ? Number(form.cam_cap_percent) : null,
    };
    onSave(patch);
  };

  return (
    <div className="space-y-3 py-2">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="CAM Structure">
          <Input value={form.cam_structure} onChange={set("cam_structure")} placeholder="NNN, base year, FSG..." />
        </Field>
        <Field label="Tenant RSF">
          <Input type="number" value={form.tenant_rsf} onChange={set("tenant_rsf")} />
        </Field>
        <Field label="Building RSF *">
          <Input type="number" value={form.building_rsf} onChange={set("building_rsf")} />
        </Field>
        <Field label="Pro-Rata Share %">
          <Input type="number" step="0.01" value={form.tenant_pro_rata_share} onChange={set("tenant_pro_rata_share")} />
        </Field>
        <Field label="Admin Fee %">
          <Input type="number" step="0.01" value={form.admin_fee_percent} onChange={set("admin_fee_percent")} />
        </Field>
        <Field label="Gross-Up %">
          <Input type="number" step="0.01" value={form.gross_up_percent} onChange={set("gross_up_percent")} />
        </Field>
        <Field label="Cap Type">
          <Select value={form.cam_cap_type} onValueChange={(v) => setForm((prev) => ({ ...prev, cam_cap_type: v }))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None</SelectItem>
              <SelectItem value="cumulative">Cumulative</SelectItem>
              <SelectItem value="non_cumulative">Non-Cumulative</SelectItem>
              <SelectItem value="compounding">Compounding</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Cap %">
          <Input type="number" step="0.01" value={form.cam_cap_percent} onChange={set("cam_cap_percent")} />
        </Field>
        <Field label="Estimate Frequency">
          <Select value={form.estimate_frequency} onValueChange={(v) => setForm((prev) => ({ ...prev, estimate_frequency: v }))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="monthly">Monthly</SelectItem>
              <SelectItem value="quarterly">Quarterly</SelectItem>
              <SelectItem value="annual">Annual</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Reconciliation Frequency">
          <Select value={form.reconciliation_frequency} onValueChange={(v) => setForm((prev) => ({ ...prev, reconciliation_frequency: v }))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="annual">Annual</SelectItem>
              <SelectItem value="semi_annual">Semi-Annual</SelectItem>
              <SelectItem value="never">Never</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Status">
          <Select value={form.status} onValueChange={(v) => setForm((prev) => ({ ...prev, status: v }))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="pending_review">Pending Review</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>
      <Field label="Notes">
        <Input value={form.notes} onChange={set("notes")} placeholder="Any setup caveats or assumptions..." />
      </Field>
      <DialogFooter>
        <Button onClick={handleSubmit} disabled={saving} className="bg-blue-600 hover:bg-blue-700">
          {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
          Save
        </Button>
      </DialogFooter>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <Label className="text-xs">{label}</Label>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function StatCard({ label, value, accent }) {
  return (
    <Card className={accent ? `border-l-4 ${accent}` : ""}>
      <CardContent className="p-4">
        <p className="text-2xl font-bold text-slate-900">{value}</p>
        <p className="text-xs font-medium text-slate-500">{label}</p>
      </CardContent>
    </Card>
  );
}

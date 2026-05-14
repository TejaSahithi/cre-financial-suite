/**
 * ChargeScheduleAndPreview — read-only Charge Schedule and Invoice Preview
 * surfaces inside the Billing page. Both views derive from approved data:
 *   - approved lease abstracts (base rent, lease term)
 *   - approved CAM profiles (pro-rata share)
 *   - actual recoverable expenses (baseline for CAM allocation)
 *
 * Generating actual invoices is still handled by the existing "Generate
 * Invoices" button on Billing.jsx — this component is the planning surface
 * that lets users see WHAT will be billed before they hit generate.
 */
import React, { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  CheckCircle2,
  Edit,
  PauseCircle,
  Receipt,
  Send,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import useOrgQuery from "@/hooks/useOrgQuery";
import { supabase } from "@/services/supabaseClient";

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function fmtCurrency(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return "—";
  return `$${Math.round(n).toLocaleString()}`;
}

function isApprovedLease(lease) {
  const abstract = String(lease?.abstract_status || "").toLowerCase();
  if (abstract === "approved") return true;
  return String(lease?.status || "").toLowerCase() === "approved";
}

export function ChargeScheduleTab({ propertyId }) {
  const [scopeProperty, setScopeProperty] = useState(propertyId || "all");
  const [monthIndex, setMonthIndex] = useState(new Date().getMonth());
  const year = new Date().getFullYear();

  const { data: leases = [] } = useOrgQuery("Lease");
  const { data: properties = [] } = useOrgQuery("Property");

  const approvedLeases = useMemo(() => {
    return (leases || []).filter((lease) => {
      if (!isApprovedLease(lease)) return false;
      if (scopeProperty !== "all" && lease.property_id !== scopeProperty) return false;
      return true;
    });
  }, [leases, scopeProperty]);

  const leaseIds = approvedLeases.map((l) => l.id);

  const { data: camProfiles = [] } = useQuery({
    queryKey: ["charge-schedule-cam", leaseIds.join(",")],
    queryFn: async () => {
      if (leaseIds.length === 0) return [];
      const { data, error } = await supabase
        .from("cam_profiles")
        .select("id, lease_id, tenant_pro_rata_share, status, admin_fee_percent")
        .in("lease_id", leaseIds);
      if (error) return [];
      return data || [];
    },
    enabled: leaseIds.length > 0,
  });

  // Pull the recoverable expense baseline for each property in scope so we
  // can allocate CAM/Tax/Insurance/Utilities pro-rata.
  const propertyIds = [...new Set(approvedLeases.map((l) => l.property_id).filter(Boolean))];
  const { data: expenseTotals = {} } = useQuery({
    queryKey: ["charge-schedule-expense-totals", propertyIds.join(","), year],
    queryFn: async () => {
      if (propertyIds.length === 0) return {};
      const { data, error } = await supabase
        .from("expenses")
        .select("property_id, category, amount, recoverable, classification, fiscal_year")
        .in("property_id", propertyIds)
        .eq("fiscal_year", year);
      if (error) return {};
      const totals = {};
      for (const e of data || []) {
        const pid = e.property_id;
        if (!totals[pid]) totals[pid] = { cam: 0, tax: 0, insurance: 0, utilities: 0, other: 0, all: 0 };
        const amount = Number(e.amount || 0);
        const recoverable =
          e.recoverable === true || String(e.classification || "").toLowerCase() === "recoverable";
        const category = String(e.category || "").toLowerCase();
        totals[pid].all += amount;
        if (recoverable) {
          if (category.includes("tax")) totals[pid].tax += amount;
          else if (category.includes("insur")) totals[pid].insurance += amount;
          else if (category.includes("utilit") || category.includes("water") || category.includes("electric") || category.includes("gas"))
            totals[pid].utilities += amount;
          else if (category.includes("cam") || category.includes("common")) totals[pid].cam += amount;
          else totals[pid].other += amount;
        }
      }
      return totals;
    },
    enabled: propertyIds.length > 0,
  });

  const profileByLease = useMemo(() => {
    const m = new Map();
    for (const p of camProfiles) m.set(p.lease_id, p);
    return m;
  }, [camProfiles]);

  const rows = useMemo(() => {
    return approvedLeases.map((lease) => {
      const baseRent = Number(lease.monthly_rent || (lease.annual_rent ? lease.annual_rent / 12 : 0)) || 0;
      const profile = profileByLease.get(lease.id);
      const proRata = profile?.tenant_pro_rata_share != null ? Number(profile.tenant_pro_rata_share) / 100 : 0;
      const totals = expenseTotals[lease.property_id] || { cam: 0, tax: 0, insurance: 0, utilities: 0, other: 0 };
      const cam = (totals.cam / 12) * proRata;
      const tax = (totals.tax / 12) * proRata;
      const insurance = (totals.insurance / 12) * proRata;
      const utilities = (totals.utilities / 12) * proRata;
      const other = (totals.other / 12) * proRata;
      const total = baseRent + cam + tax + insurance + utilities + other;
      return {
        lease,
        baseRent,
        cam,
        tax,
        insurance,
        utilities,
        other,
        total,
        profileReady: profile?.status === "approved",
      };
    });
  }, [approvedLeases, profileByLease, expenseTotals]);

  const totals = rows.reduce(
    (acc, r) => ({
      baseRent: acc.baseRent + r.baseRent,
      cam: acc.cam + r.cam,
      tax: acc.tax + r.tax,
      insurance: acc.insurance + r.insurance,
      utilities: acc.utilities + r.utilities,
      other: acc.other + r.other,
      total: acc.total + r.total,
    }),
    { baseRent: 0, cam: 0, tax: 0, insurance: 0, utilities: 0, other: 0, total: 0 },
  );

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="text-base">Charge Schedule — {MONTHS[monthIndex]} {year}</CardTitle>
            <p className="text-xs text-slate-500">
              Per-tenant monthly charges derived from approved abstracts + approved CAM Setup +
              actual recoverable expenses for the property. Read-only.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Select value={String(monthIndex)} onValueChange={(v) => setMonthIndex(Number(v))}>
              <SelectTrigger className="h-8 w-32 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {MONTHS.map((m, idx) => (
                  <SelectItem key={m} value={String(idx)}>{m} {year}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={scopeProperty} onValueChange={setScopeProperty}>
              <SelectTrigger className="h-8 w-44 text-xs"><SelectValue placeholder="All properties" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All properties</SelectItem>
                {properties.map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-slate-50">
                <TableHead className="text-[10px] uppercase">Tenant</TableHead>
                <TableHead className="text-[10px] uppercase">Lease</TableHead>
                <TableHead className="text-right text-[10px] uppercase">Base Rent</TableHead>
                <TableHead className="text-right text-[10px] uppercase">CAM</TableHead>
                <TableHead className="text-right text-[10px] uppercase">Tax</TableHead>
                <TableHead className="text-right text-[10px] uppercase">Insurance</TableHead>
                <TableHead className="text-right text-[10px] uppercase">Utilities</TableHead>
                <TableHead className="text-right text-[10px] uppercase">Other</TableHead>
                <TableHead className="text-right text-[10px] uppercase">Total Charge</TableHead>
                <TableHead className="text-[10px] uppercase">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={10} className="py-8 text-center text-sm text-slate-400">
                    No approved leases in scope.
                  </TableCell>
                </TableRow>
              ) : (
                <>
                  {rows.map((r) => (
                    <TableRow key={r.lease.id}>
                      <TableCell className="text-sm font-medium">{r.lease.tenant_name || "—"}</TableCell>
                      <TableCell className="text-sm text-slate-600">{r.lease.lease_type || "—"}</TableCell>
                      <TableCell className="text-right text-sm font-mono">{fmtCurrency(r.baseRent)}</TableCell>
                      <TableCell className="text-right text-sm font-mono">{fmtCurrency(r.cam)}</TableCell>
                      <TableCell className="text-right text-sm font-mono">{fmtCurrency(r.tax)}</TableCell>
                      <TableCell className="text-right text-sm font-mono">{fmtCurrency(r.insurance)}</TableCell>
                      <TableCell className="text-right text-sm font-mono">{fmtCurrency(r.utilities)}</TableCell>
                      <TableCell className="text-right text-sm font-mono">{fmtCurrency(r.other)}</TableCell>
                      <TableCell className="text-right text-sm font-mono font-semibold text-slate-900">{fmtCurrency(r.total)}</TableCell>
                      <TableCell>
                        <Badge className={`text-[10px] ${r.profileReady ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-800"}`}>
                          {r.profileReady ? "Ready" : "CAM Setup pending"}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="bg-slate-50 font-semibold">
                    <TableCell colSpan={2} className="text-sm">Totals</TableCell>
                    <TableCell className="text-right font-mono">{fmtCurrency(totals.baseRent)}</TableCell>
                    <TableCell className="text-right font-mono">{fmtCurrency(totals.cam)}</TableCell>
                    <TableCell className="text-right font-mono">{fmtCurrency(totals.tax)}</TableCell>
                    <TableCell className="text-right font-mono">{fmtCurrency(totals.insurance)}</TableCell>
                    <TableCell className="text-right font-mono">{fmtCurrency(totals.utilities)}</TableCell>
                    <TableCell className="text-right font-mono">{fmtCurrency(totals.other)}</TableCell>
                    <TableCell className="text-right font-mono">{fmtCurrency(totals.total)}</TableCell>
                    <TableCell />
                  </TableRow>
                </>
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

export function InvoicePreviewTab({ propertyId, onGenerate }) {
  const [holdState, setHoldState] = useState({});
  const [approvedState, setApprovedState] = useState({});

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Invoice Preview</CardTitle>
        <p className="text-xs text-slate-500">
          Charges ready to become invoices. Approve, edit, or hold each line. Hit Generate to
          create invoices from the approved rows.
        </p>
      </CardHeader>
      <CardContent>
        <ChargePreviewInner
          propertyId={propertyId}
          holdState={holdState}
          setHoldState={setHoldState}
          approvedState={approvedState}
          setApprovedState={setApprovedState}
          onGenerate={onGenerate}
        />
      </CardContent>
    </Card>
  );
}

function ChargePreviewInner({ propertyId, holdState, setHoldState, approvedState, setApprovedState, onGenerate }) {
  const { data: leases = [] } = useOrgQuery("Lease");
  const approvedLeases = useMemo(() => {
    return (leases || []).filter((lease) => {
      if (!isApprovedLease(lease)) return false;
      if (propertyId && lease.property_id !== propertyId) return false;
      return true;
    });
  }, [leases, propertyId]);

  const leaseIds = approvedLeases.map((l) => l.id);
  const { data: camProfiles = [] } = useQuery({
    queryKey: ["invoice-preview-cam", leaseIds.join(",")],
    queryFn: async () => {
      if (leaseIds.length === 0) return [];
      const { data, error } = await supabase
        .from("cam_profiles")
        .select("id, lease_id, tenant_pro_rata_share, status")
        .in("lease_id", leaseIds);
      if (error) return [];
      return data || [];
    },
    enabled: leaseIds.length > 0,
  });

  const profileByLease = useMemo(() => {
    const m = new Map();
    for (const p of camProfiles) m.set(p.lease_id, p);
    return m;
  }, [camProfiles]);

  const rows = approvedLeases.map((lease) => {
    const baseRent = Number(lease.monthly_rent || (lease.annual_rent ? lease.annual_rent / 12 : 0)) || 0;
    const profile = profileByLease.get(lease.id);
    return {
      id: lease.id,
      tenant: lease.tenant_name || "—",
      monthly: baseRent,
      profileReady: profile?.status === "approved",
    };
  });

  const approveAll = () => {
    const next = {};
    for (const r of rows) next[r.id] = true;
    setApprovedState(next);
    toast.success("All rows marked approved (preview only)");
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={approveAll}>
          <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
          Approve All
        </Button>
        <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700" onClick={() => onGenerate?.(approvedState, holdState)}>
          <Send className="mr-1 h-3.5 w-3.5" />
          Generate Invoices
        </Button>
      </div>
      <Table>
        <TableHeader>
          <TableRow className="bg-slate-50">
            <TableHead className="text-[10px] uppercase">Tenant</TableHead>
            <TableHead className="text-right text-[10px] uppercase">Monthly Base Rent</TableHead>
            <TableHead className="text-[10px] uppercase">Status</TableHead>
            <TableHead className="text-[10px] uppercase">Decision</TableHead>
            <TableHead className="text-[10px] uppercase">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="py-8 text-center text-sm text-slate-400">
                No approved leases in scope.
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => {
              const approved = approvedState[row.id];
              const held = holdState[row.id];
              return (
                <TableRow key={row.id}>
                  <TableCell className="text-sm font-medium">{row.tenant}</TableCell>
                  <TableCell className="text-right text-sm font-mono">{fmtCurrency(row.monthly)}</TableCell>
                  <TableCell>
                    <Badge className={`text-[10px] ${row.profileReady ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-800"}`}>
                      {row.profileReady ? "CAM Ready" : "CAM Pending"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge className={`text-[10px] ${
                      held ? "bg-amber-100 text-amber-800" :
                      approved ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-700"
                    }`}>
                      {held ? "Held" : approved ? "Approved" : "Pending"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-xs text-emerald-700"
                        onClick={() => setApprovedState((s) => ({ ...s, [row.id]: !s[row.id] }))}
                      >
                        <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-xs"
                        onClick={() => toast.info("Edit charge — open the lease's rent schedule to adjust line items.")}
                      >
                        <Edit className="mr-1 h-3.5 w-3.5" />
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-xs text-amber-700"
                        onClick={() => setHoldState((s) => ({ ...s, [row.id]: !s[row.id] }))}
                      >
                        <PauseCircle className="mr-1 h-3.5 w-3.5" />
                        {held ? "Resume" : "Hold"}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}


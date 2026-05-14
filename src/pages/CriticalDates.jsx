/**
 * CriticalDates — portfolio-wide tracker for lease milestones (renewal
 * notice, option exercise, expiration, insurance certificates, etc.).
 *
 * Backed by `lease_critical_dates` (migration 20260514130000). Derived rows
 * are seeded from approved-lease columns; user-added reminders are full
 * citizens with owners and completion status.
 */
import React, { useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  Calendar,
  CheckCircle2,
  Clock,
  Loader2,
  Plus,
  Trash2,
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
import { Textarea } from "@/components/ui/textarea";
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { supabase } from "@/services/supabaseClient";
import {
  createCriticalDate,
  daysUntil,
  DATE_TYPES,
  DATE_TYPE_LABELS,
  deleteCriticalDate,
  markCriticalDateComplete,
  updateCriticalDate,
  urgencyOf,
} from "@/services/criticalDateService";
import { createPageUrl } from "@/utils";

const URGENCY_BADGE = {
  overdue: "bg-red-100 text-red-700",
  due_soon: "bg-amber-100 text-amber-800",
  upcoming: "bg-blue-100 text-blue-700",
  future: "bg-slate-100 text-slate-700",
  completed: "bg-emerald-100 text-emerald-700",
  dismissed: "bg-slate-100 text-slate-500",
  unknown: "bg-slate-100 text-slate-700",
};

const URGENCY_LABEL = {
  overdue: "Overdue",
  due_soon: "Due Soon",
  upcoming: "Upcoming",
  future: "Future",
  completed: "Completed",
  dismissed: "Dismissed",
  unknown: "—",
};

export default function CriticalDates() {
  const location = useLocation();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState("active"); // active | overdue | due_soon | completed | all
  const [showAdd, setShowAdd] = useState(false);
  const [showAssign, setShowAssign] = useState(false);
  const [assignTarget, setAssignTarget] = useState(null);

  // Add reminder form state.
  const [newLeaseId, setNewLeaseId] = useState("");
  const [newDateType, setNewDateType] = useState("custom");
  const [newDueDate, setNewDueDate] = useState("");
  const [newOwnerEmail, setNewOwnerEmail] = useState("");
  const [newOwnerName, setNewOwnerName] = useState("");
  const [newReminderDays, setNewReminderDays] = useState("");
  const [newNote, setNewNote] = useState("");

  // Assign owner form state.
  const [assignEmail, setAssignEmail] = useState("");
  const [assignName, setAssignName] = useState("");

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

  const { data: criticalDates = [], isLoading } = useQuery({
    queryKey: ["lease-critical-dates"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("lease_critical_dates")
        .select(
          "id, org_id, lease_id, property_id, date_type, due_date, owner_email, owner_name, status, completed_at, completed_by, reminder_days_before, note, source, created_at, updated_at",
        )
        .order("due_date", { ascending: true });
      if (error) {
        console.warn("[CriticalDates] query failed:", error.message);
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

  const scopedDates = criticalDates.filter((row) => {
    const lease = leaseById.get(row.lease_id);
    if (!lease) return true; // keep orphans visible
    return matchesHierarchyScope(lease, scope, { propertyKey: "property_id", unitKey: "unit_id" });
  });

  const propertyScopedDates = scopedDates.filter((row) => {
    if (scopeProperty !== "all" && row.property_id !== scopeProperty) return false;
    if (scopeBuilding !== "all") {
      const lease = leaseById.get(row.lease_id);
      const unit = lease?.unit_id ? scope.unitById.get(lease.unit_id) : null;
      if (unit?.building_id !== scopeBuilding) return false;
    }
    if (scopeUnit !== "all") {
      const lease = leaseById.get(row.lease_id);
      if (lease?.unit_id !== scopeUnit) return false;
    }
    return true;
  });

  const filteredDates = propertyScopedDates.filter((row) => {
    const urgency = urgencyOf(row);
    if (filter === "all") return true;
    if (filter === "active") return urgency !== "completed" && urgency !== "dismissed";
    if (filter === "overdue") return urgency === "overdue";
    if (filter === "due_soon") return urgency === "due_soon";
    if (filter === "completed") return urgency === "completed";
    return true;
  });

  const counts = useMemo(() => {
    const c = { overdue: 0, due_soon: 0, upcoming: 0, completed: 0, active: 0, all: propertyScopedDates.length };
    for (const row of propertyScopedDates) {
      const u = urgencyOf(row);
      if (u === "overdue") c.overdue += 1;
      if (u === "due_soon") c.due_soon += 1;
      if (u === "upcoming") c.upcoming += 1;
      if (u === "completed") c.completed += 1;
      if (u !== "completed" && u !== "dismissed") c.active += 1;
    }
    return c;
  }, [propertyScopedDates]);

  const subtitle = getScopeSubtitle(scope, {
    default: `${filteredDates.length} critical date${filteredDates.length === 1 ? "" : "s"} tracked`,
    property: (property) => `${filteredDates.length} dates for ${property.name}`,
  });

  // Mutations -----------------------------------------------------------

  const createMutation = useMutation({
    mutationFn: async (row) => createCriticalDate(row),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["lease-critical-dates"] });
      toast.success("Reminder added");
      resetAddForm();
      setShowAdd(false);
    },
    onError: (err) => toast.error(err?.message || "Could not add reminder"),
  });

  const assignMutation = useMutation({
    mutationFn: async ({ id, owner_email, owner_name }) => {
      return updateCriticalDate(id, { owner_email, owner_name });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["lease-critical-dates"] });
      toast.success("Owner assigned");
      setShowAssign(false);
      setAssignTarget(null);
    },
    onError: (err) => toast.error(err?.message || "Could not assign owner"),
  });

  const completeMutation = useMutation({
    mutationFn: async ({ id, by }) => markCriticalDateComplete(id, by),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["lease-critical-dates"] });
      toast.success("Marked completed");
    },
    onError: (err) => toast.error(err?.message || "Could not mark completed"),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id) => deleteCriticalDate(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["lease-critical-dates"] });
      toast.success("Reminder deleted");
    },
    onError: (err) => toast.error(err?.message || "Could not delete reminder"),
  });

  function resetAddForm() {
    setNewLeaseId("");
    setNewDateType("custom");
    setNewDueDate("");
    setNewOwnerEmail("");
    setNewOwnerName("");
    setNewReminderDays("");
    setNewNote("");
  }

  function handleAdd() {
    if (!newLeaseId) {
      toast.error("Select a lease.");
      return;
    }
    if (!newDueDate) {
      toast.error("Set a due date.");
      return;
    }
    const lease = leaseById.get(newLeaseId);
    if (!lease?.org_id) {
      toast.error("Lease is missing org context.");
      return;
    }
    createMutation.mutate({
      org_id: lease.org_id,
      lease_id: lease.id,
      property_id: lease.property_id || null,
      date_type: newDateType,
      due_date: newDueDate,
      owner_email: newOwnerEmail || null,
      owner_name: newOwnerName || null,
      reminder_days_before: newReminderDays ? Number(newReminderDays) : null,
      note: newNote || null,
      source: "manual",
    });
  }

  function openAssign(row) {
    setAssignTarget(row);
    setAssignEmail(row.owner_email || "");
    setAssignName(row.owner_name || "");
    setShowAssign(true);
  }

  function handleAssign() {
    if (!assignTarget) return;
    assignMutation.mutate({
      id: assignTarget.id,
      owner_email: assignEmail || null,
      owner_name: assignName || null,
    });
  }

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        icon={Calendar}
        title="Critical Dates"
        subtitle={subtitle}
        iconColor="from-purple-600 to-indigo-700"
      >
        <Button size="sm" onClick={() => setShowAdd(true)} className="bg-[#1a2744] hover:bg-[#243b67]">
          <Plus className="mr-1 h-4 w-4" />
          Add Reminder
        </Button>
      </PageHeader>

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

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Overdue" value={counts.overdue} accent="border-l-red-500 bg-red-50" icon={AlertTriangle} />
        <StatCard label="Due in 30 days" value={counts.due_soon} accent="border-l-amber-500 bg-amber-50" icon={Clock} />
        <StatCard label="Upcoming (30-90)" value={counts.upcoming} accent="border-l-blue-500 bg-blue-50" icon={Calendar} />
        <StatCard label="Completed" value={counts.completed} accent="border-l-emerald-500 bg-emerald-50" icon={CheckCircle2} />
      </div>

      {/* Filter tabs */}
      <Tabs value={filter} onValueChange={setFilter}>
        <TabsList className="bg-white border">
          <TabsTrigger value="active" className="text-xs">Active ({counts.active})</TabsTrigger>
          <TabsTrigger value="overdue" className="text-xs">Overdue ({counts.overdue})</TabsTrigger>
          <TabsTrigger value="due_soon" className="text-xs">Due Soon ({counts.due_soon})</TabsTrigger>
          <TabsTrigger value="completed" className="text-xs">Completed ({counts.completed})</TabsTrigger>
          <TabsTrigger value="all" className="text-xs">All ({counts.all})</TabsTrigger>
        </TabsList>
      </Tabs>

      <Card>
        <Table>
          <TableHeader>
            <TableRow className="bg-slate-50">
              <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Date Type</TableHead>
              <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Due Date</TableHead>
              <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Urgency</TableHead>
              <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Lease</TableHead>
              <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Owner</TableHead>
              <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Status</TableHead>
              <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Note</TableHead>
              <TableHead className="text-[11px] font-semibold uppercase text-slate-500">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={8} className="py-12 text-center">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin text-slate-400" />
                </TableCell>
              </TableRow>
            ) : filteredDates.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="py-12 text-center text-sm text-slate-400">
                  No critical dates in this view.
                </TableCell>
              </TableRow>
            ) : (
              filteredDates.map((row) => {
                const lease = leaseById.get(row.lease_id);
                const urgency = urgencyOf(row);
                const days = daysUntil(row.due_date);
                return (
                  <TableRow key={row.id} className="hover:bg-slate-50">
                    <TableCell className="text-sm font-medium text-slate-900">
                      {DATE_TYPE_LABELS[row.date_type] || row.date_type}
                      {row.source === "derived" && (
                        <span className="ml-1 text-[10px] text-slate-400">(derived)</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">
                      {row.due_date}
                      {days !== null && row.status !== "completed" && (
                        <span className="ml-2 text-xs text-slate-500">
                          {days < 0 ? `${Math.abs(days)}d overdue` : days === 0 ? "today" : `${days}d`}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge className={`text-[10px] ${URGENCY_BADGE[urgency]}`}>{URGENCY_LABEL[urgency]}</Badge>
                    </TableCell>
                    <TableCell className="text-sm">
                      {lease ? (
                        <Link
                          to={
                            createPageUrl(
                              String(lease.abstract_status || "").toLowerCase() === "approved"
                                ? "LeaseDetail"
                                : "LeaseReview",
                            ) + `?id=${lease.id}`
                          }
                          className="text-blue-600 hover:text-blue-700"
                        >
                          {lease.tenant_name || lease.id.slice(0, 8)}
                        </Link>
                      ) : (
                        <span className="text-slate-400">— deleted —</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">
                      {row.owner_email ? (
                        <>
                          <div className="font-medium text-slate-700">{row.owner_name || "—"}</div>
                          <div className="text-xs text-slate-500">{row.owner_email}</div>
                        </>
                      ) : (
                        <span className="text-slate-400">Unassigned</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge className={`text-[10px] ${row.status === "completed" ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-700"}`}>
                        {row.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-[200px] truncate text-sm text-slate-600">{row.note || "—"}</TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-xs"
                          onClick={() => openAssign(row)}
                        >
                          Assign
                        </Button>
                        {row.status !== "completed" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs text-emerald-700 hover:text-emerald-800"
                            onClick={() => completeMutation.mutate({ id: row.id, by: row.owner_name || row.owner_email })}
                            disabled={completeMutation.isPending}
                          >
                            <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                            Mark Complete
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-xs text-red-600 hover:text-red-700"
                          onClick={() => deleteMutation.mutate(row.id)}
                          disabled={deleteMutation.isPending}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </Card>

      {/* Add Reminder Dialog */}
      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Critical Date</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <Label>Lease</Label>
              <Select value={newLeaseId} onValueChange={setNewLeaseId}>
                <SelectTrigger><SelectValue placeholder="Select lease" /></SelectTrigger>
                <SelectContent>
                  {leases.map((l) => (
                    <SelectItem key={l.id} value={l.id}>
                      {l.tenant_name || l.id.slice(0, 8)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Date Type</Label>
              <Select value={newDateType} onValueChange={setNewDateType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {DATE_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Due Date</Label>
              <Input type="date" value={newDueDate} onChange={(e) => setNewDueDate(e.target.value)} />
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <Label>Owner Name (optional)</Label>
                <Input value={newOwnerName} onChange={(e) => setNewOwnerName(e.target.value)} placeholder="Jane Doe" />
              </div>
              <div>
                <Label>Owner Email (optional)</Label>
                <Input type="email" value={newOwnerEmail} onChange={(e) => setNewOwnerEmail(e.target.value)} placeholder="jane@example.com" />
              </div>
            </div>
            <div>
              <Label>Remind Days Before (optional)</Label>
              <Input type="number" value={newReminderDays} onChange={(e) => setNewReminderDays(e.target.value)} placeholder="30" />
            </div>
            <div>
              <Label>Note (optional)</Label>
              <Textarea rows={2} value={newNote} onChange={(e) => setNewNote(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAdd(false)}>Cancel</Button>
            <Button onClick={handleAdd} disabled={createMutation.isPending} className="bg-blue-600 hover:bg-blue-700">
              {createMutation.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              Add Reminder
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Assign Owner Dialog */}
      <Dialog open={showAssign} onOpenChange={setShowAssign}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Assign Owner</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-slate-500">
            {assignTarget ? `${DATE_TYPE_LABELS[assignTarget.date_type] || assignTarget.date_type} · ${assignTarget.due_date}` : ""}
          </p>
          <div className="space-y-3 py-2">
            <div>
              <Label>Owner Name</Label>
              <Input value={assignName} onChange={(e) => setAssignName(e.target.value)} placeholder="Jane Doe" />
            </div>
            <div>
              <Label>Owner Email</Label>
              <Input type="email" value={assignEmail} onChange={(e) => setAssignEmail(e.target.value)} placeholder="jane@example.com" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAssign(false)}>Cancel</Button>
            <Button onClick={handleAssign} disabled={assignMutation.isPending} className="bg-blue-600 hover:bg-blue-700">
              {assignMutation.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatCard({ label, value, accent, icon: Icon }) {
  return (
    <Card className={`border-l-4 ${accent}`}>
      <CardContent className="flex items-center justify-between p-4">
        <div>
          <p className="text-xs font-medium text-slate-500">{label}</p>
          <p className="text-2xl font-bold text-slate-900">{value}</p>
        </div>
        {Icon && <Icon className="h-6 w-6 text-slate-400" />}
      </CardContent>
    </Card>
  );
}

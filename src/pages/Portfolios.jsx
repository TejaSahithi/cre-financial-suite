import React, { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  Plus,
  Search,
  Briefcase,
  Loader2,
  Home,
  Building2,
  Users,
  MapPin,
  ChevronRight,
  Download,
  Trash2,
  Info,
} from "lucide-react";
import { PortfolioService } from "@/services/api";
import { createNotificationsForEvent, dispatchPortfolioCreatedNotification } from "@/services/notificationService";
import { supabase } from "@/services/supabaseClient";
import useOrgQuery from "@/hooks/useOrgQuery";
import { useAuth } from "@/lib/AuthContext";
import { clearCache } from "@/services/api";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { createPageUrl, downloadCSV } from "@/utils";
import PageHeader from "@/components/PageHeader";
import MetricCard from "@/components/MetricCard";
import ViewModeToggle from "@/components/ViewModeToggle";
import DeleteConfirmDialog from "@/components/DeleteConfirmDialog";
import ManagerAssignmentBadges from "@/components/ManagerAssignmentBadges";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useModuleAccess } from "@/lib/ModuleAccessContext";
import { getStoredActingOrgId, setStoredActingOrgId } from "@/lib/actingOrg";
import { resolveWritableOrgId } from "@/lib/orgUtils";
import { assertCanWritePage, describePermissionError } from "@/lib/userPermissions";
import useManagerAssignments from "@/hooks/useManagerAssignments";

async function ensureCreatorPortfolioAccess({ portfolioId, orgId, user }) {
  if (!portfolioId || !orgId || !user || ["super_admin", "org_admin"].includes(user._raw_role)) return;

  const { data: existingGrant, error: existingGrantError } = await supabase
    .from("user_access")
    .select("id")
    .eq("user_id", user.id)
    .eq("org_id", orgId)
    .eq("scope", "portfolio")
    .eq("scope_id", portfolioId)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  if (existingGrantError) throw existingGrantError;
  if (existingGrant?.id) return;

  const { error: grantError } = await supabase
    .from("user_access")
    .insert({
      user_id: user.id,
      org_id: orgId,
      scope: "portfolio",
      scope_id: portfolioId,
      role: "manager",
      is_active: true,
    });

  if (grantError) throw grantError;
}

async function assignPortfolioManager({ portfolioId, orgId, managerUserId }) {
  if (!portfolioId || !orgId || !managerUserId) return null;

  const { data: membership, error: membershipError } = await supabase
    .from("memberships")
    .select("user_id, assigned_portfolios")
    .eq("user_id", managerUserId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (membershipError) throw membershipError;

  const assignedPortfolios = Array.isArray(membership?.assigned_portfolios)
    ? membership.assigned_portfolios
    : [];

  if (membership?.user_id && !assignedPortfolios.includes(portfolioId)) {
    const { error: updateError } = await supabase
      .from("memberships")
      .update({ assigned_portfolios: [...assignedPortfolios, portfolioId] })
      .eq("user_id", managerUserId)
      .eq("org_id", orgId);

    if (updateError) throw updateError;
  }

  const { error: accessError } = await supabase
    .from("user_access")
    .upsert({
      user_id: managerUserId,
      org_id: orgId,
      scope: "portfolio",
      scope_id: portfolioId,
      role: "manager",
      is_active: true,
    }, { onConflict: "user_id,scope,scope_id" });

  if (accessError) throw accessError;

  return managerUserId;
}

export default function Portfolios() {
  const [showCreate, setShowCreate] = useState(false);
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState("grid");
  const [selectedOrgId, setSelectedOrgId] = useState(() => getStoredActingOrgId() || "all");
  const [selectedCreateOrgId, setSelectedCreateOrgId] = useState("");
  const [selectedPortfolioIds, setSelectedPortfolioIds] = useState([]);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [showBulkDelete, setShowBulkDelete] = useState(false);
  const defaultForm = {
    name: "",
    description: "",
    owner_entity: "",
    type: "commercial",
    geography: "",
    fiscal_year: "jan_dec",
    intents: [],
    notes: "",
    property_manager_user_id: "",
  };
  const [form, setForm] = useState(defaultForm);
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { canWritePage } = useModuleAccess();
  const canEditPortfolios = canWritePage("Portfolios");

  const { data: portfolios = [], isLoading, orgId, isAdmin } = useOrgQuery("Portfolio");
  const { data: properties = [] } = useOrgQuery("Property");
  const { data: buildings = [] } = useOrgQuery("Building");
  const { data: units = [] } = useOrgQuery("Unit");
  const { data: leases = [] } = useOrgQuery("Lease");
  const rawRole = user?._raw_role || user?.role || "";
  const canAssignPortfolioManager = isAdmin || ["admin", "super_admin", "org_admin", "owner", "org_owner"].includes(rawRole);

  const { data: organizations = [] } = useQuery({
    queryKey: ["portfolio-organizations"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("organizations")
        .select("id, name, status")
        .order("name");
      if (error) throw error;
      return data || [];
    },
    enabled: isAdmin,
    initialData: [],
  });

  const orgNameById = useMemo(
    () => Object.fromEntries(organizations.map((org) => [org.id, org.name])),
    [organizations]
  );

  const createOrgId = isAdmin
    ? selectedCreateOrgId
    : (orgId && orgId !== "__none__" ? orgId : "");

  const { data: assignableManagers = [], isFetching: isLoadingManagers } = useQuery({
    queryKey: ["portfolio-assignable-managers", createOrgId],
    queryFn: async () => {
      if (!createOrgId) return [];

      const { data: memberships, error: membershipError } = await supabase
        .from("memberships")
        .select("user_id, role, status, custom_role, capabilities, assigned_portfolios")
        .eq("org_id", createOrgId);

      if (membershipError) throw membershipError;

      const managerMemberships = (memberships || []).filter((membership) => {
        const roles = new Set([
          membership.role,
          membership.custom_role,
          ...(Array.isArray(membership.capabilities?.roles) ? membership.capabilities.roles : []),
        ].filter(Boolean));
        const status = membership.status || "active";
        return ["active", "approved"].includes(status) && (
          roles.has("property_manager") ||
          roles.has("manager") ||
          roles.has("portfolio_manager") ||
          roles.has("asset_manager")
        );
      });

      if (managerMemberships.length === 0) return [];

      const userIds = [...new Set(managerMemberships.map((membership) => membership.user_id).filter(Boolean))];
      const { data: profiles, error: profileError } = await supabase
        .from("profiles")
        .select("id, full_name, email")
        .in("id", userIds);

      if (profileError) throw profileError;

      const profilesById = Object.fromEntries((profiles || []).map((profile) => [profile.id, profile]));

      return managerMemberships
        .map((membership) => ({
          ...membership,
          profile: profilesById[membership.user_id] || {},
        }))
        .sort((a, b) => {
          const left = a.profile.full_name || a.profile.email || a.user_id;
          const right = b.profile.full_name || b.profile.email || b.user_id;
          return String(left).localeCompare(String(right));
        });
    },
    enabled: showCreate && canAssignPortfolioManager && !!createOrgId,
    initialData: [],
  });

  const handleSelectedOrgChange = (value) => {
    setSelectedOrgId(value);
    setStoredActingOrgId(value === "all" ? null : value);
  };

  const openCreateModal = () => {
    if (!canEditPortfolios) {
      toast.error("You have read-only access to Portfolios.");
      return;
    }

    if (isAdmin) {
      setSelectedCreateOrgId(
        selectedOrgId !== "all" ? selectedOrgId : (organizations[0]?.id || "")
      );
    } else {
      setSelectedCreateOrgId(orgId && orgId !== "__none__" ? orgId : "");
    }
    setShowCreate(true);
  };

  const createMutation = useMutation({
    mutationFn: async (data) => {
      assertCanWritePage(user, "Portfolios", "create portfolios");
      const writableOrgId = data.org_id || await resolveWritableOrgId(orgId);
      const { property_manager_user_id, ...portfolioData } = data;
      // TEMP DIAGNOSTIC (remove once the RLS 42501 on portfolio create is
      // root-caused): the client-side permission gate above passed, but the
      // database's WITH CHECK (can_write_page(org_id, 'Portfolios')) has
      // been rejecting the insert anyway. This dumps exactly what org_id is
      // being sent and what the client believes the user's org memberships
      // are, so a failing attempt tells us whether org_id is missing/wrong
      // or whether the membership itself lacks org_admin/write access.
      console.info("[Portfolio.create diagnostic]", {
        formOrgId: data.org_id || null,
        hookOrgId: orgId || null,
        resolvedWritableOrgId: writableOrgId || null,
        userId: user?.id || null,
        rawRole: user?._raw_role || user?.role || null,
        memberships: (user?.memberships || []).map((m) => ({
          org_id: m?.org_id,
          role: m?.role,
          status: m?.status,
        })),
      });
      const created = await PortfolioService.create({
        ...portfolioData,
        ...(writableOrgId ? { org_id: writableOrgId } : {}),
      });

      await ensureCreatorPortfolioAccess({
        portfolioId: created?.id,
        orgId: created?.org_id || writableOrgId,
        user,
      });

      if (property_manager_user_id) {
        await assignPortfolioManager({
          portfolioId: created?.id,
          orgId: created?.org_id || writableOrgId,
          managerUserId: property_manager_user_id,
        });

        createNotificationsForEvent({
          event_type: "portfolio.manager_assigned",
          org_id: created?.org_id || writableOrgId,
          portfolio_id: created?.id,
          entity_type: "portfolio",
          entity_id: created?.id,
          entity_label: created?.name || data.name,
          action_url: createPageUrl("Portfolios"),
          metadata: {
            portfolio_name: created?.name || data.name,
            assigned_manager_user_id: property_manager_user_id,
            assignment_source: "portfolio_create_modal",
          },
        }).catch((error) => {
          console.warn("[Portfolios] manager assignment notification failed:", error?.message || error);
        });
      }

      dispatchPortfolioCreatedNotification({
        org_id: created?.org_id || writableOrgId,
        portfolio_id: created?.id,
        portfolio_name: created?.name || data.name,
        action_url: createPageUrl("Portfolios"),
      }).catch((error) => {
        console.warn("[Portfolios] notification event failed:", error?.message || error);
      });

      return created;
    },
    onSuccess: (data) => {
      clearCache();
      queryClient.invalidateQueries({ queryKey: ["Portfolio"] });
      queryClient.invalidateQueries({ queryKey: ["Property"] });
      queryClient.invalidateQueries({ queryKey: ["Building"] });
      queryClient.invalidateQueries({ queryKey: ["Unit"] });
      queryClient.invalidateQueries({ queryKey: ["Lease"] });
      setShowCreate(false);
      setForm(defaultForm);
      if (data?.org_id) {
        handleSelectedOrgChange(data.org_id);
      }
      toast.success("Portfolio created successfully");
      // Stay on the Portfolios page so the user can see the newly created portfolio in the list
    },
    onError: (err) => {
      const permissionMessage = describePermissionError(err, "Portfolios");
      toast.error(permissionMessage || `Failed to create portfolio: ${err?.message || "Unknown error"}`);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id) => {
      assertCanWritePage(user, "Portfolios", "delete portfolios");
      const ok = await PortfolioService.delete(id);
      if (!ok) throw new Error("Delete failed");
      return id;
    },
    onSuccess: (id) => {
      queryClient.invalidateQueries();
      toast.success("Portfolio deleted");
      setDeleteTarget(null);
      setSelectedPortfolioIds((prev) => prev.filter((selectedId) => selectedId !== id));
    },
    onError: (err) => {
      const permissionMessage = describePermissionError(err, "Portfolios");
      toast.error(permissionMessage || `Failed to delete portfolio: ${err?.message || "Unknown error"}`);
    },
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: async (ids) => {
      assertCanWritePage(user, "Portfolios", "delete portfolios");
      await Promise.all(
        ids.map(async (id) => {
          const ok = await PortfolioService.delete(id);
          if (!ok) throw new Error("Delete failed");
        })
      );
      return ids.length;
    },
    onSuccess: (count) => {
      queryClient.invalidateQueries();
      setSelectedPortfolioIds([]);
      setShowBulkDelete(false);
      toast.success(`${count} portfolio${count === 1 ? "" : "s"} deleted`);
    },
    onError: (err) => {
      const permissionMessage = describePermissionError(err, "Portfolios");
      toast.error(permissionMessage || `Failed to delete selected portfolios: ${err?.message || "Unknown error"}`);
    },
  });

  const userOrgId = orgId && orgId !== "__none__" ? orgId : null;

  const visiblePortfolios = selectedOrgId === "all"
    ? (isAdmin ? portfolios : portfolios.filter((portfolio) => portfolio.org_id === userOrgId))
    : portfolios.filter((portfolio) => portfolio.org_id === selectedOrgId);

  const orgProperties = selectedOrgId === "all"
    ? (isAdmin ? properties : properties.filter((property) => property.org_id === userOrgId))
    : properties.filter((property) => property.org_id === selectedOrgId);

  const orgBuildings = selectedOrgId === "all"
    ? (isAdmin ? buildings : buildings.filter((building) => building.org_id === userOrgId))
    : buildings.filter((building) => building.org_id === selectedOrgId);

  const orgUnits = selectedOrgId === "all"
    ? (isAdmin ? units : units.filter((unit) => unit.org_id === userOrgId))
    : units.filter((unit) => unit.org_id === selectedOrgId);

  const orgLeases = selectedOrgId === "all"
    ? (isAdmin ? leases : leases.filter((lease) => lease.org_id === userOrgId))
    : leases.filter((lease) => lease.org_id === selectedOrgId);

  const visiblePortfolioIds = new Set(visiblePortfolios.map((portfolio) => portfolio.id));
  const visiblePortfolioIdList = visiblePortfolios.map((portfolio) => portfolio.id).filter(Boolean);
  const visiblePortfolioOrgIds = visiblePortfolios.map((portfolio) => portfolio.org_id).filter(Boolean);
  const { data: portfolioManagersById = {} } = useManagerAssignments({
    scope: "portfolio",
    scopeIds: visiblePortfolioIdList,
    orgIds: visiblePortfolioOrgIds,
  });
  const visibleProperties = orgProperties.filter(
    (property) => property.portfolio_id && visiblePortfolioIds.has(property.portfolio_id)
  );
  const visiblePropertyIds = new Set(visibleProperties.map((property) => property.id));
  const visibleBuildings = orgBuildings.filter((building) => visiblePropertyIds.has(building.property_id));
  const visibleUnits = orgUnits.filter((unit) => visiblePropertyIds.has(unit.property_id));
  const visibleLeases = orgLeases.filter((lease) => visiblePropertyIds.has(lease.property_id));

  const enriched = visiblePortfolios.map((portfolio) => {
    const portProperties = visibleProperties.filter((property) => property.portfolio_id === portfolio.id);
    const propertyIds = portProperties.map((property) => property.id);
    const portBuildings = visibleBuildings.filter((building) => propertyIds.includes(building.property_id));
    const portUnits = visibleUnits.filter((unit) => propertyIds.includes(unit.property_id));
    const portLeases = visibleLeases.filter((lease) => propertyIds.includes(lease.property_id));
    const totalSF = portProperties.reduce((sum, property) => sum + (property.total_sqft || 0), 0);
    const leasedUnits = portUnits.filter((unit) => unit.status === "leased");
    const leasedSF = leasedUnits.reduce((sum, unit) => sum + (unit.square_footage || 0), 0);
    const occupancy = totalSF > 0 ? (leasedSF / totalSF) * 100 : 0;
    const annualRent = portLeases
      .filter((lease) => lease.status !== "expired")
      .reduce((sum, lease) => sum + ((lease.monthly_rent || 0) * 12), 0);

    return {
      ...portfolio,
      _orgName: orgNameById[portfolio.org_id] || portfolio.org_id || "Unassigned",
      _propCount: portProperties.length,
      _buildingCount: portBuildings.length,
      _unitCount: portUnits.length,
      _leaseCount: portLeases.length,
      _totalSF: totalSF,
      _occupancy: occupancy,
      _annualRent: annualRent,
      _verifiedCount: 0,
      _properties: portProperties,
    };
  });

  const filtered = enriched.filter((portfolio) =>
    portfolio.name?.toLowerCase().includes(search.toLowerCase())
  );

  const exportRows = enriched.map((portfolio) => ({
    ...portfolio,
    managers: (portfolioManagersById[portfolio.id] || []).map((manager) => manager.label).join("; "),
  }));

  const allFilteredSelected = filtered.length > 0 && filtered.every((portfolio) => selectedPortfolioIds.includes(portfolio.id));

  const togglePortfolioSelection = (portfolioId) => {
    if (!canEditPortfolios) return;
    setSelectedPortfolioIds((prev) =>
      prev.includes(portfolioId)
        ? prev.filter((id) => id !== portfolioId)
        : [...prev, portfolioId]
    );
  };

  const toggleSelectAllFiltered = (checked) => {
    if (!canEditPortfolios) return;
    if (checked) {
      setSelectedPortfolioIds((prev) => [...new Set([...prev, ...filtered.map((portfolio) => portfolio.id)])]);
      return;
    }
    const filteredIds = new Set(filtered.map((portfolio) => portfolio.id));
    setSelectedPortfolioIds((prev) => prev.filter((id) => !filteredIds.has(id)));
  };

  const totals = {
    properties: visibleProperties.length,
    buildings: visibleBuildings.length,
    units: visibleUnits.length,
    totalSF: visibleProperties.reduce((sum, property) => sum + (property.total_sqft || 0), 0),
  };

  const createDisabled = !form.name || createMutation.isPending || (isAdmin && !selectedCreateOrgId);

  return (
    <div className="p-4 lg:p-6 space-y-5">
      <PageHeader
        icon={Briefcase}
        title="Portfolio Overview"
        subtitle={`${visiblePortfolios.length} portfolios · ${totals.properties} properties in view`}
        iconColor="from-blue-700 to-blue-600"
      >
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => downloadCSV(exportRows, "portfolios.csv")}
            className="border-slate-200 hover:bg-slate-50 shadow-sm"
          >
            <Download className="w-4 h-4 mr-2 text-slate-500" />
            Export
          </Button>
          <Button
            onClick={openCreateModal}
            disabled={!canEditPortfolios}
            className="bg-gradient-to-r from-blue-700 to-blue-600 hover:from-blue-700 hover:to-blue-800 shadow-sm"
          >
            <Plus className="w-4 h-4 mr-2" />
            Create Portfolio
          </Button>
        </div>
      </PageHeader>

      {!canEditPortfolios && (
        <Card className="border-blue-200 bg-blue-50">
          <CardContent className="p-4 text-sm text-blue-800">
            You have read-only access on this page. Viewing portfolios is allowed, but creating, selecting, and deleting portfolios is disabled.
          </CardContent>
        </Card>
      )}

      {isAdmin && organizations.length > 0 && (
        <Card className="border-blue-200 bg-blue-50/40">
          <CardContent className="p-4">
            <div className="flex items-center gap-4 flex-wrap">
              <div className="text-sm font-bold text-blue-700">SuperAdmin Org Context</div>
              <Select value={selectedOrgId} onValueChange={handleSelectedOrgChange}>
                <SelectTrigger className="w-72 bg-white border-blue-200">
                  <SelectValue placeholder="All organizations" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Organizations</SelectItem>
                  {organizations.map((org) => (
                    <SelectItem key={org.id} value={org.id}>
                      {org.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-xs bg-blue-100 text-blue-700 px-3 py-1.5 rounded-lg font-medium">
                Viewing:{" "}
                <strong>{selectedOrgId === "all" ? "All Organizations" : (orgNameById[selectedOrgId] || "Unknown")}</strong>
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <MetricCard label="Portfolios" value={visiblePortfolios.length} icon={Briefcase} color="bg-blue-50 text-blue-600" />
        <MetricCard label="Properties" value={totals.properties} icon={Home} color="bg-emerald-50 text-emerald-600" />
        <MetricCard label="Buildings" value={totals.buildings} icon={Building2} color="bg-blue-50 text-blue-600" />
        <MetricCard label="Total Units" value={totals.units} icon={Users} color="bg-amber-50 text-amber-600" />
        <MetricCard label="Total SF" value={`${(totals.totalSF / 1000000).toFixed(1)}M`} icon={MapPin} color="bg-slate-100 text-slate-600" />
      </div>

      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input
            placeholder="Search portfolios..."
            className="pl-9 h-9 bg-white"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {selectedPortfolioIds.length > 0 && (
            <>
              <span className="text-xs font-medium text-slate-500">
                {selectedPortfolioIds.length} selected
              </span>
              <Button variant="outline" size="sm" onClick={() => setSelectedPortfolioIds([])}>
                Clear
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="border-red-200 text-red-600 hover:bg-red-50"
                disabled={!canEditPortfolios}
                onClick={() => setShowBulkDelete(true)}
              >
                <Trash2 className="w-4 h-4 mr-1" />
                Delete Selected
              </Button>
            </>
          )}
          <ViewModeToggle viewMode={viewMode} onViewModeChange={setViewMode} />
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
        </div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="p-16 text-center">
            <p className="text-slate-400 text-sm mb-3">No portfolios found</p>
            <Button onClick={openCreateModal} disabled={!canEditPortfolios}>Create Your First Portfolio</Button>
          </CardContent>
        </Card>
      ) : viewMode === "grid" ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map((portfolio) => (
            <Card key={portfolio.id} className="overflow-hidden hover:shadow-lg transition-all border-slate-200/80 group">
              <CardContent className="p-5">
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <Checkbox
                      checked={selectedPortfolioIds.includes(portfolio.id)}
                      disabled={!canEditPortfolios}
                      onCheckedChange={() => togglePortfolioSelection(portfolio.id)}
                      className="mt-1"
                    />
                    <div className="w-12 h-12 bg-gradient-to-br from-blue-700 to-blue-600 rounded-xl flex items-center justify-center shadow-sm">
                      <Briefcase className="w-6 h-6 text-white" />
                    </div>
                    <div>
                      <h3 className="text-base font-bold text-slate-900">{portfolio.name}</h3>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        <Badge className="text-[10px] bg-emerald-100 text-emerald-700">Active</Badge>
                        {isAdmin && <Badge variant="outline" className="text-[10px]">{portfolio._orgName}</Badge>}
                      </div>
                      <div className="mt-2">
                        <ManagerAssignmentBadges managers={portfolioManagersById[portfolio.id] || []} emptyLabel="No portfolio manager" />
                      </div>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-slate-400 hover:text-red-600 hover:bg-red-50"
                    disabled={!canEditPortfolios}
                    onClick={() => setDeleteTarget(portfolio)}
                    title="Delete portfolio"
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
                {portfolio.description && (
                  <p className="text-xs text-slate-400 mb-3 line-clamp-2">{portfolio.description}</p>
                )}
                <div className="grid grid-cols-3 gap-2 mb-3">
                  {[
                    { label: "Properties", value: portfolio._propCount },
                    { label: "Total SF", value: `${(portfolio._totalSF / 1000).toFixed(0)}K` },
                    { label: "Occupancy", value: `${portfolio._occupancy.toFixed(0)}%` },
                  ].map((metric, index) => (
                    <div key={index} className="bg-slate-50 rounded-lg px-2 py-1.5 text-center">
                      <p className="text-[9px] font-bold text-slate-400 uppercase">{metric.label}</p>
                      <p className="text-sm font-bold text-slate-900">{metric.value}</p>
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-2 mb-3">
                  <div className="h-1.5 flex-1 bg-slate-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-emerald-500 rounded-full transition-all"
                      style={{ width: `${portfolio._propCount > 0 ? (portfolio._verifiedCount / portfolio._propCount) * 100 : 0}%` }}
                    />
                  </div>
                  <span className="text-[10px] text-slate-400 font-medium">
                    {portfolio._verifiedCount}/{portfolio._propCount} verified
                  </span>
                </div>
                <div className="space-y-1 max-h-24 overflow-y-auto">
                  {portfolio._properties.slice(0, 3).map((property) => (
                    <Link
                      key={property.id}
                      to={createPageUrl("PropertyDetail") + `?id=${property.id}`}
                      className="flex items-center justify-between bg-slate-50 rounded-md px-2 py-1 hover:bg-blue-50 transition-colors"
                    >
                      <div className="flex items-center gap-1.5">
                        {property.structure_type === "multi" ? (
                          <Building2 className="w-3 h-3 text-blue-500" />
                        ) : (
                          <Home className="w-3 h-3 text-blue-500" />
                        )}
                        <span className="text-xs font-medium text-slate-700 truncate">{property.name}</span>
                      </div>
                      <ChevronRight className="w-3 h-3 text-slate-300" />
                    </Link>
                  ))}
                </div>
                <Link to={createPageUrl("Properties") + `?portfolio=${portfolio.id}`}>
                  <Button variant="outline" size="sm" className="w-full mt-3 text-xs h-7">
                    View All Properties
                  </Button>
                </Link>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : viewMode === "list" ? (
        <div className="space-y-2">
          {filtered.map((portfolio) => (
            <Card key={portfolio.id} className="hover:shadow-md transition-all border-slate-200/80">
              <CardContent className="p-4 flex items-center gap-4">
                <Checkbox
                  checked={selectedPortfolioIds.includes(portfolio.id)}
                  disabled={!canEditPortfolios}
                  onCheckedChange={() => togglePortfolioSelection(portfolio.id)}
                />
                <div className="w-10 h-10 bg-gradient-to-br from-blue-700 to-blue-600 rounded-lg flex items-center justify-center flex-shrink-0">
                  <Briefcase className="w-5 h-5 text-white" />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-bold text-slate-900 truncate">{portfolio.name}</h3>
                  <div className="flex items-center gap-2 flex-wrap">
                    {portfolio.description && <p className="text-xs text-slate-400 truncate">{portfolio.description}</p>}
                    {isAdmin && <Badge variant="outline" className="text-[10px]">{portfolio._orgName}</Badge>}
                  </div>
                  <div className="mt-1">
                    <ManagerAssignmentBadges managers={portfolioManagersById[portfolio.id] || []} emptyLabel="No portfolio manager" />
                  </div>
                </div>
                <div className="hidden md:flex items-center gap-6 text-xs text-slate-600">
                  <div className="text-center"><p className="font-bold text-sm">{portfolio._propCount}</p><p className="text-slate-400">Properties</p></div>
                  <div className="text-center"><p className="font-bold text-sm">{`${(portfolio._totalSF / 1000).toFixed(0)}K`}</p><p className="text-slate-400">SF</p></div>
                  <div className="text-center"><p className="font-bold text-sm">{portfolio._occupancy.toFixed(0)}%</p><p className="text-slate-400">Occ.</p></div>
                  <div className="text-center"><p className="font-bold text-sm">${(portfolio._annualRent / 1000).toFixed(0)}K</p><p className="text-slate-400">Rent/yr</p></div>
                </div>
                <Badge className="flex-shrink-0 bg-emerald-100 text-emerald-700">Active</Badge>
                <Link to={createPageUrl("Properties") + `?portfolio=${portfolio.id}`}>
                  <Button variant="outline" size="sm" className="text-xs flex-shrink-0">
                    View
                    <ChevronRight className="w-3 h-3 ml-1" />
                  </Button>
                </Link>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-slate-400 hover:text-red-600 hover:bg-red-50 flex-shrink-0"
                  disabled={!canEditPortfolios}
                  onClick={() => setDeleteTarget(portfolio)}
                  title="Delete portfolio"
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Card className="overflow-hidden border-slate-200/80">
          <Table>
            <TableHeader>
              <TableRow className="bg-gradient-to-r from-slate-50 to-slate-100/50">
                <TableHead className="w-10">
                  <Checkbox
                    checked={allFilteredSelected}
                    disabled={!canEditPortfolios}
                    onCheckedChange={toggleSelectAllFiltered}
                    aria-label="Select all filtered portfolios"
                  />
                </TableHead>
                <TableHead className="text-xs font-bold tracking-wider">PORTFOLIO</TableHead>
                {isAdmin && <TableHead className="text-xs font-bold tracking-wider">ORG</TableHead>}
                <TableHead className="text-xs font-bold tracking-wider">MANAGER</TableHead>
                <TableHead className="text-xs font-bold tracking-wider">STATUS</TableHead>
                <TableHead className="text-xs font-bold tracking-wider">PROPERTIES</TableHead>
                <TableHead className="text-xs font-bold tracking-wider">BUILDINGS</TableHead>
                <TableHead className="text-xs font-bold tracking-wider">UNITS</TableHead>
                <TableHead className="text-xs font-bold tracking-wider">TOTAL SF</TableHead>
                <TableHead className="text-xs font-bold tracking-wider">OCCUPANCY</TableHead>
                <TableHead className="text-xs font-bold tracking-wider">ANNUAL RENT</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((portfolio) => (
                <TableRow key={portfolio.id} className="hover:bg-slate-50">
                  <TableCell>
                    <Checkbox
                      checked={selectedPortfolioIds.includes(portfolio.id)}
                      disabled={!canEditPortfolios}
                      onCheckedChange={() => togglePortfolioSelection(portfolio.id)}
                      aria-label={`Select ${portfolio.name}`}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 bg-gradient-to-br from-blue-700 to-blue-600 rounded-lg flex items-center justify-center">
                        <Briefcase className="w-4 h-4 text-white" />
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-slate-900">{portfolio.name}</p>
                        {portfolio.description && <p className="text-xs text-slate-400 truncate max-w-[200px]">{portfolio.description}</p>}
                      </div>
                    </div>
                  </TableCell>
                  {isAdmin && <TableCell className="text-sm">{portfolio._orgName}</TableCell>}
                  <TableCell>
                    <ManagerAssignmentBadges managers={portfolioManagersById[portfolio.id] || []} emptyLabel="No portfolio manager" />
                  </TableCell>
                  <TableCell><Badge className="bg-emerald-100 text-emerald-700">Active</Badge></TableCell>
                  <TableCell className="text-sm font-medium">{portfolio._propCount}</TableCell>
                  <TableCell className="text-sm">{portfolio._buildingCount}</TableCell>
                  <TableCell className="text-sm">{portfolio._unitCount}</TableCell>
                  <TableCell className="text-sm font-mono">{portfolio._totalSF.toLocaleString()}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{portfolio._occupancy.toFixed(0)}%</span>
                      <div className="w-14 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                        <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${portfolio._occupancy}%` }} />
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-sm font-medium">${(portfolio._annualRent / 1000).toFixed(0)}K</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Link to={createPageUrl("Properties") + `?portfolio=${portfolio.id}`}>
                        <Button variant="outline" size="sm">View</Button>
                      </Link>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-slate-400 hover:text-red-600 hover:bg-red-50"
                        disabled={!canEditPortfolios}
                        onClick={() => setDeleteTarget(portfolio)}
                        title="Delete portfolio"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <Dialog open={showCreate && canEditPortfolios} onOpenChange={(open) => setShowCreate(open && canEditPortfolios)}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Create Portfolio</DialogTitle>
            <DialogDescription>
              Group properties into a portfolio for unified management.
              <span className="block mt-1 text-blue-600 font-medium">
                Metrics like SF, Occupancy, and Rent are calculated automatically as you add properties.
              </span>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2">
                <Label>Portfolio Name *</Label>
                <Input
                  value={form.name}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                  placeholder="e.g. Southwest Commercial Portfolio"
                />
              </div>
              <div className="col-span-2">
                <Label>Description</Label>
                <Input
                  value={form.description}
                  onChange={(event) => setForm({ ...form, description: event.target.value })}
                  placeholder="e.g. Mixed-use assets across the Southwest"
                />
              </div>
              <div className="col-span-2">
                <Label>Owner / Legal Entity</Label>
                <Input
                  value={form.owner_entity}
                  onChange={(event) => setForm({ ...form, owner_entity: event.target.value })}
                  placeholder="e.g. MCG Capital Holdings LLC"
                />
              </div>

              {isAdmin && (
                <div className="col-span-2">
                  <Label>Organization *</Label>
                  <Select value={selectedCreateOrgId} onValueChange={setSelectedCreateOrgId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Assign this portfolio to an organization" />
                    </SelectTrigger>
                    <SelectContent>
                      {organizations.map((org) => (
                        <SelectItem key={org.id} value={org.id}>
                          {org.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {canAssignPortfolioManager && (
                <div className="col-span-2 rounded-xl border border-slate-200 bg-slate-50/70 p-3">
                  <Label>Property Manager Assignment</Label>
                  <Select
                    value={form.property_manager_user_id || "none"}
                    onValueChange={(value) => setForm({ ...form, property_manager_user_id: value === "none" ? "" : value })}
                    disabled={!createOrgId || isLoadingManagers || assignableManagers.length === 0}
                  >
                    <SelectTrigger className="mt-1 bg-white">
                      <SelectValue
                        placeholder={
                          isLoadingManagers
                            ? "Loading property managers..."
                            : "Assign a property manager to this portfolio"
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Do not assign now</SelectItem>
                      {assignableManagers.map((manager) => {
                        const displayName = manager.profile.full_name || manager.profile.email || manager.user_id;
                        const roleLabel = (manager.custom_role || manager.role || "manager").replaceAll("_", " ");
                        return (
                          <SelectItem key={manager.user_id} value={manager.user_id}>
                            {displayName} · {roleLabel}
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                  <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
                    Assigned managers receive portfolio-scope access and the portfolio assignment notification after creation.
                  </p>
                  {createOrgId && !isLoadingManagers && assignableManagers.length === 0 && (
                    <p className="mt-2 text-[11px] text-amber-700">
                      No active property manager users are available in this organization.
                    </p>
                  )}
                </div>
              )}

              <div>
                <Label>Portfolio Type</Label>
                <Select value={form.type} onValueChange={(value) => setForm({ ...form, type: value })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="commercial">Commercial / Office</SelectItem>
                    <SelectItem value="retail">Retail Center</SelectItem>
                    <SelectItem value="industrial">Industrial / Warehouse</SelectItem>
                    <SelectItem value="mixed_use">Mixed Use</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label>Primary Intent <span className="text-slate-400 font-normal">(select all that apply)</span></Label>
                <div className="mt-1.5 grid grid-cols-2 gap-2">
                  {[
                    { value: "asset_management", label: "Asset Management" },
                    { value: "budgeting_cam", label: "Budgeting & CAM Recovery" },
                    { value: "leasing", label: "Leasing & Rent Roll" },
                    { value: "acquisition", label: "Acquisition Modeling" },
                    { value: "disposition", label: "Disposition / Sale" },
                    { value: "development", label: "Development / Construction" },
                    { value: "value_add", label: "Value-Add Strategy" },
                    { value: "core_hold", label: "Core Hold / Stabilized" },
                    { value: "debt_financing", label: "Debt / Financing" },
                    { value: "investor_reporting", label: "Investor Reporting" },
                  ].map(({ value, label }) => (
                    <label key={value} className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-colors text-xs font-medium ${(form.intents || []).includes(value) ? "border-blue-500 bg-blue-50 text-blue-700" : "border-slate-200 hover:border-slate-300 text-slate-600"}`}>
                      <input
                        type="checkbox"
                        className="hidden"
                        checked={(form.intents || []).includes(value)}
                        onChange={() => {
                          const current = form.intents || [];
                          setForm({ ...form, intents: current.includes(value) ? current.filter(v => v !== value) : [...current, value] });
                        }}
                      />
                      <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 ${(form.intents || []).includes(value) ? "bg-blue-500 border-blue-500" : "border-slate-300"}`}>
                        {(form.intents || []).includes(value) && <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
                      </span>
                      {label}
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <Label>Geography / Region</Label>
                <Select value={form.geography} onValueChange={(value) => setForm({ ...form, geography: value })}>
                  <SelectTrigger><SelectValue placeholder="Select region..." /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="northeast_us">Northeast US</SelectItem>
                    <SelectItem value="southeast_us">Southeast US</SelectItem>
                    <SelectItem value="midwest_us">Midwest US</SelectItem>
                    <SelectItem value="southwest_us">Southwest US</SelectItem>
                    <SelectItem value="west_coast_us">West Coast US</SelectItem>
                    <SelectItem value="mountain_west">Mountain West</SelectItem>
                    <SelectItem value="texas">Texas</SelectItem>
                    <SelectItem value="florida">Florida</SelectItem>
                    <SelectItem value="new_york">New York Metro</SelectItem>
                    <SelectItem value="california">California</SelectItem>
                    <SelectItem value="chicago_metro">Chicago Metro</SelectItem>
                    <SelectItem value="national">National (Multi-Region)</SelectItem>
                    <SelectItem value="canada">Canada</SelectItem>
                    <SelectItem value="europe">Europe</SelectItem>
                    <SelectItem value="asia_pacific">Asia Pacific</SelectItem>
                    <SelectItem value="other">Other / International</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label>Fiscal Year</Label>
                <Select value={form.fiscal_year} onValueChange={(value) => setForm({ ...form, fiscal_year: value })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="jan_dec">Jan 1 - Dec 31</SelectItem>
                    <SelectItem value="jul_jun">Jul 1 - Jun 30</SelectItem>
                    <SelectItem value="oct_sep">Oct 1 - Sep 30</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="mt-6 p-4 bg-blue-50/50 border border-blue-100 rounded-xl flex items-start gap-3">
              <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center flex-shrink-0">
                <Info className="w-4 h-4 text-blue-600" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-bold text-blue-900">Automated KPI Tracking</p>
                <p className="text-xs text-blue-700 leading-relaxed">
                  After creating this portfolio, you will be redirected to link properties.
                  The dashboard will then automatically compute:
                </p>
                <div className="flex gap-3 pt-1">
                  {['Total Square Footage', 'Occupancy %', 'Annual Rent'].map((item) => (
                    <span key={item} className="text-[10px] bg-white/80 border border-blue-200 text-blue-600 px-2 py-0.5 rounded-full font-medium">
                      {item}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button
              onClick={() => {
                const extras = [
                  form.owner_entity && `Entity: ${form.owner_entity}`,
                  form.type && `Type: ${form.type}`,
                  form.geography && `Region: ${form.geography}`,
                  form.fiscal_year && `FY: ${form.fiscal_year}`,
                  form.intents?.length > 0 && `Intent: ${form.intents.join(", ")}`,
                ].filter(Boolean).join(" | ");
                const description = [form.description, extras].filter(Boolean).join(" — ") || undefined;

                createMutation.mutate({
                  name: form.name,
                  ...(description ? { description } : {}),
                  ...(form.property_manager_user_id ? { property_manager_user_id: form.property_manager_user_id } : {}),
                  ...(isAdmin && selectedCreateOrgId ? { org_id: selectedCreateOrgId } : {}),
                });
              }}
              disabled={!canEditPortfolios || createDisabled}
              className="bg-gradient-to-r from-blue-700 to-blue-600"
            >
              {createMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DeleteConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={`Delete portfolio "${deleteTarget?.name || ""}"?`}
        description="This will permanently remove the portfolio. Properties inside it will not be deleted but will become unassigned."
        loading={deleteMutation.isPending}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
      />

      <DeleteConfirmDialog
        open={showBulkDelete}
        onOpenChange={setShowBulkDelete}
        title={`Delete ${selectedPortfolioIds.length} selected portfolio${selectedPortfolioIds.length === 1 ? "" : "s"}?`}
        description="This will permanently remove all selected portfolios. Properties inside them will not be deleted but will become unassigned."
        confirmLabel="Delete Selected"
        loading={bulkDeleteMutation.isPending}
        onConfirm={() => bulkDeleteMutation.mutate(selectedPortfolioIds)}
      />
    </div>
  );
}

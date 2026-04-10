import React, { useEffect, useState, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/services/supabaseClient";
import { useAuth } from "@/lib/AuthContext";
import { logAudit } from "@/services/audit";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Card, CardContent } from "@/components/ui/card";
import {
  Plus, Upload, Search, Trash2, Mail, CheckCircle2,
  X, Loader2, Users, UserX, Building2, Download,
  Eye, Globe, AlertTriangle, UserCheck, PenLine, ChevronDown,
  ChevronRight, FileText, DollarSign, BarChart2, Settings,
} from "lucide-react";

// ─── CRE Industry Roles ───────────────────────────────────────────────────────
const CRE_ROLES = {
  // Management
  asset_manager:       { label: "Asset Manager",       category: "Management",   color: "violet",  description: "Oversees asset performance and value-add strategy" },
  portfolio_manager:   { label: "Portfolio Manager",   category: "Management",   color: "violet",  description: "Manages entire property portfolio" },
  operations_director: { label: "Operations Director", category: "Management",   color: "violet",  description: "Overall operations and team management" },
  // Property Operations
  property_manager:    { label: "Property Manager",    category: "Operations",   color: "blue",    description: "Day-to-day property operations and tenant relations" },
  facility_manager:    { label: "Facility Manager",    category: "Operations",   color: "blue",    description: "Building systems, maintenance, and repairs" },
  construction_manager:{ label: "Construction Mgr.",   category: "Operations",   color: "blue",    description: "Capital improvements and construction oversight" },
  // Finance
  cfo_controller:      { label: "CFO / Controller",    category: "Finance",      color: "emerald", description: "Financial controls, accounting, and reporting" },
  financial_analyst:   { label: "Financial Analyst",   category: "Finance",      color: "emerald", description: "Financial modeling, analysis, and projections" },
  accounts_manager:    { label: "Accounts Manager",    category: "Finance",      color: "emerald", description: "AR/AP management and reconciliations" },
  investor_relations:  { label: "Investor Relations",  category: "Finance",      color: "emerald", description: "Investor communication and capital reporting" },
  // Leasing
  leasing_director:    { label: "Leasing Director",    category: "Leasing",      color: "amber",   description: "Leasing strategy and broker relationships" },
  leasing_agent:       { label: "Leasing Agent",       category: "Leasing",      color: "amber",   description: "Tenant prospecting, tours, and lease execution" },
  lease_admin:         { label: "Lease Administrator", category: "Leasing",      color: "amber",   description: "Lease abstracts, CAM, and compliance" },
  // Acquisitions
  acquisitions_mgr:    { label: "Acquisitions Mgr.",   category: "Acquisitions", color: "rose",    description: "Deal sourcing, underwriting, and due diligence" },
  // Compliance
  compliance_officer:  { label: "Compliance Officer",  category: "Compliance",   color: "slate",   description: "Regulatory compliance and risk management" },
  internal_auditor:    { label: "Internal Auditor",    category: "Compliance",   color: "slate",   description: "Audit trail review and financial controls" },
};

const ROLE_CATEGORY_ORDER = ["Management", "Operations", "Finance", "Leasing", "Acquisitions", "Compliance"];

const ROLE_COLOR_CLASSES = {
  violet:  { badge: "bg-violet-100 text-violet-700 border-violet-200",  dot: "bg-violet-500" },
  blue:    { badge: "bg-blue-100 text-blue-700 border-blue-200",        dot: "bg-blue-500" },
  emerald: { badge: "bg-emerald-100 text-emerald-700 border-emerald-200", dot: "bg-emerald-500" },
  amber:   { badge: "bg-amber-100 text-amber-700 border-amber-200",     dot: "bg-amber-500" },
  rose:    { badge: "bg-rose-100 text-rose-700 border-rose-200",        dot: "bg-rose-500" },
  slate:   { badge: "bg-slate-100 text-slate-600 border-slate-200",     dot: "bg-slate-400" },
};

async function invokeInviteUser(body) {
  const attemptInvoke = async (session) => {
    if (!session?.access_token) {
      throw new Error("Not authenticated");
    }

    return supabase.functions.invoke("invite-user", {
      body,
      headers: {
        Authorization: `Bearer ${session.access_token}`,
      },
    });
  };

  let { data: sessionData } = await supabase.auth.getSession();
  let session = sessionData?.session;

  if (!session?.access_token) {
    const { data: refreshData, error: refreshError } = await supabase.auth.refreshSession();
    if (refreshError || !refreshData?.session?.access_token) {
      throw refreshError || new Error("Not authenticated");
    }
    session = refreshData.session;
  }

  let result = await attemptInvoke(session);

  if (result.error) {
    const { data: refreshData, error: refreshError } = await supabase.auth.refreshSession();
    if (!refreshError && refreshData?.session?.access_token) {
      result = await attemptInvoke(refreshData.session);
    }
  }

  if (result.error) {
    // FunctionsHttpError only exposes a generic message; the real reason is in
    // the response body. Read it so the toast shows the actual server error.
    let detail = result.error.message;
    try {
      const ctx = result.error.context;
      if (ctx && typeof ctx.json === "function") {
        const body = await ctx.json();
        if (body?.error) detail = body.error;
      }
    } catch {
      /* ignore body-parse failures */
    }
    throw new Error(detail);
  }

  return result.data;
}

// ─── Page-Level Permission Groups ─────────────────────────────────────────────
const PAGE_PERMISSION_GROUPS = [
  {
    key: "core", label: "Dashboard & Portfolio", icon: "📊",
    pages: [
      { key: "Dashboard",         label: "Dashboard" },
      { key: "Portfolios",        label: "Portfolio Overview" },
      { key: "PortfolioInsights", label: "Portfolio Insights" },
    ],
  },
  {
    key: "properties", label: "Properties", icon: "🏢",
    pages: [
      { key: "Properties",     label: "Properties List" },
      { key: "BuildingsUnits", label: "Buildings & Units" },
      { key: "PropertyDetail", label: "Property Detail" },
    ],
  },
  {
    key: "leases", label: "Leasing", icon: "📋",
    pages: [
      { key: "Leases",          label: "Leases" },
      { key: "LeaseUpload",     label: "Lease Upload" },
      { key: "LeaseReview",     label: "Lease Review" },
      { key: "RentProjection",  label: "Rent Projection" },
    ],
  },
  {
    key: "tenants", label: "Tenants & Vendors", icon: "🤝",
    pages: [
      { key: "Tenants",      label: "Tenants" },
      { key: "TenantDetail", label: "Tenant Detail" },
      { key: "Vendors",      label: "Vendors" },
      { key: "Billing",      label: "Billing" },
    ],
  },
  {
    key: "expenses", label: "Expenses", icon: "💰",
    pages: [
      { key: "Expenses",    label: "Expenses" },
      { key: "AddExpense",  label: "Add Expense" },
      { key: "BulkImport",  label: "Bulk Import" },
    ],
  },
  {
    key: "cam", label: "CAM Engine", icon: "🔧",
    pages: [
      { key: "CAMDashboard",    label: "CAM Dashboard" },
      { key: "CAMCalculation",  label: "CAM Calculation" },
      { key: "Reconciliation",  label: "Reconciliation" },
    ],
  },
  {
    key: "budget", label: "Budget & Financials", icon: "📈",
    pages: [
      { key: "BudgetDashboard",  label: "Budget Dashboard" },
      { key: "CreateBudget",     label: "Create Budget" },
      { key: "BudgetReview",     label: "Budget Review" },
      { key: "Revenue",          label: "Revenue" },
      { key: "ActualsVariance",  label: "Actuals & Variance" },
      { key: "Comparison",       label: "YoY Comparison" },
    ],
  },
  {
    key: "reports", label: "Analytics & Reports", icon: "📑",
    pages: [
      { key: "AnalyticsReports", label: "Analytics Reports" },
      { key: "Analytics",        label: "Analytics" },
    ],
  },
  {
    key: "admin", label: "Administration", icon: "⚙️",
    pages: [
      { key: "UserManagement", label: "User Management" },
      { key: "OrgSettings",    label: "Org Settings" },
      { key: "AuditLog",       label: "Audit Log" },
      { key: "Documents",      label: "Documents" },
      { key: "Workflows",      label: "Workflows" },
    ],
  },
];

// ─── Access Levels ─────────────────────────────────────────────────────────────
const ACCESS_LEVELS = {
  full: { label: "Full",  chipClass: "bg-emerald-100 text-emerald-700 border-emerald-200", btnActive: "bg-emerald-600 text-white border-transparent" },
  read: { label: "Read",  chipClass: "bg-blue-100 text-blue-700 border-blue-200",         btnActive: "bg-blue-600 text-white border-transparent" },
  none: { label: "None",  chipClass: "bg-slate-100 text-slate-400 border-slate-200",      btnActive: "bg-slate-200 text-slate-600 border-transparent" },
};

// ─── Signing Privilege Levels ──────────────────────────────────────────────────
const SIGNING_LEVELS = [
  { level: 0, label: "No Authority",     short: "—",  color: "slate",   description: "Cannot initiate or approve",             badgeClass: "bg-slate-100 text-slate-400" },
  { level: 1, label: "L1 · Initiator",   short: "L1", color: "sky",     description: "Can prepare and submit for review",       badgeClass: "bg-sky-100 text-sky-700" },
  { level: 2, label: "L2 · Reviewer",    short: "L2", color: "blue",    description: "Can review and recommend approval",       badgeClass: "bg-blue-100 text-blue-700" },
  { level: 3, label: "L3 · Approver",    short: "L3", color: "emerald", description: "Can approve and sign documents",          badgeClass: "bg-emerald-100 text-emerald-700" },
  { level: 4, label: "L4 · Final Auth.", short: "L4", color: "violet",  description: "Final signatory, can override all levels", badgeClass: "bg-violet-100 text-violet-700" },
];

const DOCUMENT_TYPES = [
  { key: "leases",           label: "Leases & Amendments",  Icon: FileText },
  { key: "budgets",          label: "Budgets & Forecasts",  Icon: BarChart2 },
  { key: "cam_reconciliation",label: "CAM Reconciliation",  Icon: Settings },
  { key: "vendor_contracts", label: "Vendor Contracts",     Icon: PenLine },
  { key: "acquisitions",     label: "Acquisition Docs",     Icon: Building2 },
  { key: "capex",            label: "Capital Expenditure",  Icon: DollarSign },
  { key: "financial_reports",label: "Financial Reports",    Icon: BarChart2 },
];

const DEFAULT_PAGE_PERMS = Object.fromEntries(
  PAGE_PERMISSION_GROUPS.flatMap(g => g.pages.map(p => [p.key, "none"]))
);
const DEFAULT_SIGNING = Object.fromEntries(DOCUMENT_TYPES.map(d => [d.key, 0]));
const DEFAULT_ROLES = [];
const DEFAULT_DATA_SCOPE = { portfolios: [], properties: [] };

const STATUS_CONFIG = {
  active:    { label: "Active",    badgeClass: "bg-emerald-100 text-emerald-700", Icon: CheckCircle2 },
  invited:   { label: "Invited",   badgeClass: "bg-amber-100 text-amber-700",    Icon: Mail },
  no_access: { label: "No Access", badgeClass: "bg-red-100 text-red-600",         Icon: UserX },
};

// ─── Utilities ────────────────────────────────────────────────────────────────
function avatarColor(email = "") {
  const colors = ["#6366f1","#8b5cf6","#ec4899","#f59e0b","#10b981","#3b82f6","#ef4444","#14b8a6"];
  let h = 0;
  for (const c of email) h = (h * 31 + c.charCodeAt(0)) % colors.length;
  return colors[h];
}

function formatLastActive(ts) {
  if (!ts) return "Never";
  const diff = Date.now() - new Date(ts).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "Just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function deriveStatus(member) {
  if (member.status === "invited") return "invited";
  const roles = member.capabilities?.roles || [];
  if (roles.length === 0 && !member.role) return "no_access";
  return "active";
}

function getMemberRoles(member) {
  return member.capabilities?.roles || (member.role ? [member.role] : []);
}

function getMemberSigningPrivileges(member) {
  return { ...DEFAULT_SIGNING, ...(member.capabilities?.signing_privileges || {}) };
}

function getMemberPagePerms(member) {
  return { ...DEFAULT_PAGE_PERMS, ...(member.page_permissions || {}) };
}

function getHighestSigningLevel(signingPrivs) {
  return Math.max(0, ...Object.values(signingPrivs));
}

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  // Normalize headers
  const rawHeaders = lines[0].split(",").map(h => h.trim().replace(/^["']|["']$/g, "").toLowerCase());
  const headerMap = {};
  rawHeaders.forEach((h, i) => {
    const clean = h.replace(/[\s_-]+/g, "_");
    if (/^(full_?name|name|first_?name|contact_?name)$/.test(clean)) headerMap.full_name = i;
    else if (/^(email|email_?address)$/.test(clean)) headerMap.email = i;
    else if (/^(phone|phone_?number|mobile|cell|telephone)$/.test(clean)) headerMap.phone = i;
  });

  return lines.slice(1).map(line => {
    // Handle quoted CSV values
    const vals = [];
    let cur = "", inQ = false;
    for (const ch of line + ",") {
      if (ch === '"') { inQ = !inQ; }
      else if (ch === "," && !inQ) { vals.push(cur.trim()); cur = ""; }
      else cur += ch;
    }
    return {
      full_name: headerMap.full_name !== undefined ? vals[headerMap.full_name] || "" : "",
      email:     headerMap.email     !== undefined ? vals[headerMap.email]     || "" : "",
      phone:     headerMap.phone     !== undefined ? vals[headerMap.phone]     || "" : "",
    };
  }).filter(r => r.email && r.email.includes("@"));
}

function getMemberDataScope(member) {
  const grants = member?.access_grants || [];
  return {
    portfolios: grants.filter((grant) => grant.scope === "portfolio").map((grant) => grant.scope_id),
    properties: grants.filter((grant) => grant.scope === "property").map((grant) => grant.scope_id),
  };
}

function deriveAccessGrantRole(selectedRoles, pagePerms) {
  const selected = new Set(selectedRoles || []);
  const hasFullPageAccess = Object.values(pagePerms || {}).some((value) => value === "full");

  if (
    hasFullPageAccess ||
    selected.has("asset_manager") ||
    selected.has("portfolio_manager") ||
    selected.has("property_manager") ||
    selected.has("operations_director")
  ) {
    return "manager";
  }

  if (
    selected.has("financial_analyst") ||
    selected.has("accounts_manager") ||
    selected.has("leasing_agent") ||
    selected.has("lease_admin")
  ) {
    return "editor";
  }

  return "viewer";
}

async function syncUserAccessGrants({ userId, orgId, dataScope, role }) {
  const normalized = {
    portfolios: [...new Set((dataScope?.portfolios || []).filter(Boolean))],
    properties: [...new Set((dataScope?.properties || []).filter(Boolean))],
  };

  const { error: deleteError } = await supabase
    .from("user_access")
    .delete()
    .eq("user_id", userId)
    .eq("org_id", orgId);

  if (deleteError) throw deleteError;

  const rows = [
    ...normalized.portfolios.map((scopeId) => ({
      user_id: userId,
      org_id: orgId,
      scope: "portfolio",
      scope_id: scopeId,
      role,
      is_active: true,
    })),
    ...normalized.properties.map((scopeId) => ({
      user_id: userId,
      org_id: orgId,
      scope: "property",
      scope_id: scopeId,
      role,
      is_active: true,
    })),
  ];

  if (rows.length === 0) return;

  const { error: insertError } = await supabase
    .from("user_access")
    .insert(rows);

  if (insertError) throw insertError;
}

function DataScopeEditor({ orgId, value, onChange }) {
  const { data: portfolios = [] } = useQuery({
    queryKey: ["member-scope-portfolios", orgId],
    queryFn: async () => {
      if (!orgId) return [];
      const { data, error } = await supabase
        .from("portfolios")
        .select("id, name")
        .eq("org_id", orgId)
        .order("name");
      if (error) throw error;
      return data || [];
    },
    enabled: !!orgId,
    initialData: [],
  });

  const { data: properties = [] } = useQuery({
    queryKey: ["member-scope-properties", orgId],
    queryFn: async () => {
      if (!orgId) return [];
      const { data, error } = await supabase
        .from("properties")
        .select("id, name, portfolio_id")
        .eq("org_id", orgId)
        .order("name");
      if (error) throw error;
      return data || [];
    },
    enabled: !!orgId,
    initialData: [],
  });

  const selectedPortfolios = new Set(value?.portfolios || []);
  const selectedProperties = new Set(value?.properties || []);
  const portfolioNameById = Object.fromEntries(portfolios.map((portfolio) => [portfolio.id, portfolio.name]));

  const toggle = (key, scopeId) => {
    const current = new Set(value?.[key] || []);
    if (current.has(scopeId)) current.delete(scopeId);
    else current.add(scopeId);
    onChange({ ...(value || DEFAULT_DATA_SCOPE), [key]: [...current] });
  };

  return (
    <div className="space-y-4">
      <div className="p-3 rounded-xl border border-blue-100 bg-blue-50 text-xs text-blue-700">
        Assign the exact portfolios or properties this user can work on. For non-admin org users, leaving both lists empty means they will not see portfolio or property data.
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 overflow-hidden">
          <div className="px-4 py-3 bg-slate-50 border-b border-slate-100">
            <p className="text-sm font-semibold text-slate-800">Portfolio Access</p>
            <p className="text-[11px] text-slate-500">{selectedPortfolios.size} selected</p>
          </div>
          <div className="max-h-56 overflow-y-auto divide-y divide-slate-100">
            {portfolios.length === 0 ? (
              <div className="px-4 py-4 text-xs text-slate-400">No portfolios in this organization</div>
            ) : (
              portfolios.map((portfolio) => (
                <label key={portfolio.id} className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50 cursor-pointer">
                  <Checkbox
                    checked={selectedPortfolios.has(portfolio.id)}
                    onCheckedChange={() => toggle("portfolios", portfolio.id)}
                  />
                  <span className="text-sm text-slate-700">{portfolio.name}</span>
                </label>
              ))
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 overflow-hidden">
          <div className="px-4 py-3 bg-slate-50 border-b border-slate-100">
            <p className="text-sm font-semibold text-slate-800">Property Access</p>
            <p className="text-[11px] text-slate-500">{selectedProperties.size} selected</p>
          </div>
          <div className="max-h-56 overflow-y-auto divide-y divide-slate-100">
            {properties.length === 0 ? (
              <div className="px-4 py-4 text-xs text-slate-400">No properties in this organization</div>
            ) : (
              properties.map((property) => (
                <label key={property.id} className="flex items-start gap-3 px-4 py-3 hover:bg-slate-50 cursor-pointer">
                  <Checkbox
                    checked={selectedProperties.has(property.id)}
                    onCheckedChange={() => toggle("properties", property.id)}
                  />
                  <div className="min-w-0">
                    <p className="text-sm text-slate-700">{property.name}</p>
                    <p className="text-[11px] text-slate-400">
                      {portfolioNameById[property.portfolio_id] || "No portfolio"}
                    </p>
                  </div>
                </label>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── RoleSelector Component ───────────────────────────────────────────────────
function RoleSelector({ selectedRoles, onChange, customRoleName, onCustomNameChange }) {
  const [open, setOpen] = useState(false);
  const grouped = ROLE_CATEGORY_ORDER.map(cat => ({
    category: cat,
    roles: Object.entries(CRE_ROLES).filter(([, r]) => r.category === cat),
  }));

  const toggle = (key) => {
    if (selectedRoles.includes(key)) {
      onChange(selectedRoles.filter(r => r !== key));
    } else {
      onChange([...selectedRoles, key]);
    }
  };

  const hasCustom = selectedRoles.includes("custom");

  return (
    <div className="space-y-2">
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          className="w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl border border-slate-200 bg-white text-sm text-left hover:border-slate-300 transition-colors"
        >
          <div className="flex flex-wrap gap-1 flex-1 min-w-0">
            {selectedRoles.length === 0 ? (
              <span className="text-slate-400">Select roles…</span>
            ) : (
              selectedRoles.slice(0, 3).map(r => {
                const def = r === "custom" ? null : CRE_ROLES[r];
                const color = def ? ROLE_COLOR_CLASSES[def.color] : ROLE_COLOR_CLASSES.violet;
                return (
                  <span key={r} className={`text-[10px] px-2 py-0.5 rounded-full border font-semibold ${color.badge}`}>
                    {r === "custom" ? (customRoleName || "Custom") : def?.label}
                  </span>
                );
              })
            )}
            {selectedRoles.length > 3 && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 border border-slate-200">
                +{selectedRoles.length - 3}
              </span>
            )}
          </div>
          <ChevronDown className={`w-4 h-4 text-slate-400 flex-shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>

        {open && (
          <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-slate-200 rounded-2xl shadow-xl z-50 max-h-80 overflow-y-auto">
            <div className="p-2 space-y-1">
              {grouped.map(({ category, roles: catRoles }) => (
                <div key={category}>
                  <div className="px-2 py-1.5 text-[10px] font-bold text-slate-400 uppercase tracking-wider">{category}</div>
                  {catRoles.map(([key, def]) => {
                    const isSelected = selectedRoles.includes(key);
                    const colorCls = ROLE_COLOR_CLASSES[def.color];
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => toggle(key)}
                        className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl text-left transition-colors ${isSelected ? "bg-slate-50" : "hover:bg-slate-50"}`}
                      >
                        <div className={`w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center ${isSelected ? "bg-[#1a2744] border-[#1a2744]" : "border-slate-300"}`}>
                          {isSelected && <CheckCircle2 className="w-3 h-3 text-white" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-slate-800">{def.label}</span>
                            <span className={`text-[9px] px-1.5 py-0.5 rounded-full border font-semibold ${colorCls.badge}`}>{category}</span>
                          </div>
                          <p className="text-[10px] text-slate-400 truncate">{def.description}</p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              ))}
              {/* Custom Role Option */}
              <div>
                <div className="px-2 py-1.5 text-[10px] font-bold text-slate-400 uppercase tracking-wider">Custom</div>
                <button
                  type="button"
                  onClick={() => toggle("custom")}
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl text-left transition-colors ${hasCustom ? "bg-slate-50" : "hover:bg-slate-50"}`}
                >
                  <div className={`w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center ${hasCustom ? "bg-[#1a2744] border-[#1a2744]" : "border-slate-300"}`}>
                    {hasCustom && <CheckCircle2 className="w-3 h-3 text-white" />}
                  </div>
                  <span className="text-sm font-medium text-slate-800">Custom Role…</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Custom role name input */}
      {hasCustom && (
        <Input
          placeholder="Enter custom role title (e.g. Senior Deal Analyst)"
          value={customRoleName}
          onChange={e => onCustomNameChange(e.target.value)}
          className="text-sm"
        />
      )}
    </div>
  );
}

// ─── PagePermissionMatrix Component ───────────────────────────────────────────
function PagePermissionMatrix({ permissions, onChange, readonly = false }) {
  const [expanded, setExpanded] = useState({ core: true, properties: true, leases: true });

  const toggleGroup = (key) => setExpanded(e => ({ ...e, [key]: !e[key] }));

  const groupAccess = (group) => {
    const levels = group.pages.map(p => permissions[p.key] || "none");
    if (levels.every(l => l === "full")) return "full";
    if (levels.every(l => l === "none")) return "none";
    return "mixed";
  };

  const setGroupAccess = (group, level) => {
    const update = {};
    group.pages.forEach(p => { update[p.key] = level; });
    Object.entries(update).forEach(([k, v]) => onChange(k, v));
  };

  return (
    <div className="space-y-1">
      {PAGE_PERMISSION_GROUPS.map(group => {
        const isOpen = expanded[group.key] !== false;
        const groupLevel = groupAccess(group);
        return (
          <div key={group.key} className="border border-slate-200 rounded-xl overflow-hidden">
            {/* Group header */}
            <div
              className="flex items-center justify-between px-3 py-2.5 bg-slate-50 cursor-pointer hover:bg-slate-100 transition-colors"
              onClick={() => toggleGroup(group.key)}
            >
              <div className="flex items-center gap-2">
                {isOpen ? <ChevronDown className="w-3.5 h-3.5 text-slate-400" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-400" />}
                <span className="text-xs font-semibold text-slate-700">{group.icon} {group.label}</span>
                {groupLevel === "mixed" && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-600 font-semibold">Mixed</span>}
                {groupLevel === "full" && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-600 font-semibold">Full</span>}
              </div>
              {!readonly && (
                <div className="flex gap-1" onClick={e => e.stopPropagation()}>
                  {Object.entries(ACCESS_LEVELS).map(([l, cfg]) => (
                    <button
                      key={l}
                      onClick={() => setGroupAccess(group, l)}
                      className={`text-[9px] px-2 py-0.5 rounded-lg font-semibold border transition-all ${
                        groupLevel === l ? cfg.btnActive : "bg-white border-slate-200 text-slate-500 hover:border-slate-300"
                      }`}
                    >
                      All {cfg.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Page rows */}
            {isOpen && (
              <div className="divide-y divide-slate-100">
                {group.pages.map(page => {
                  const current = permissions[page.key] || "none";
                  return (
                    <div key={page.key} className="flex items-center justify-between px-4 py-2">
                      <span className="text-xs text-slate-600">{page.label}</span>
                      {readonly ? (
                        <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${ACCESS_LEVELS[current]?.chipClass}`}>
                          {ACCESS_LEVELS[current]?.label}
                        </span>
                      ) : (
                        <div className="flex gap-1">
                          {Object.entries(ACCESS_LEVELS).map(([l, cfg]) => (
                            <button
                              key={l}
                              onClick={() => onChange(page.key, l)}
                              className={`text-[9px] px-2 py-1 rounded-lg font-semibold border transition-all ${
                                current === l ? cfg.btnActive : "bg-white border-slate-200 text-slate-500 hover:border-slate-300"
                              }`}
                            >
                              {cfg.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── SigningPrivilegesMatrix Component ────────────────────────────────────────
function SigningPrivilegesMatrix({ privileges, onChange, readonly = false }) {
  return (
    <div className="space-y-1.5">
      {DOCUMENT_TYPES.map(({ key, label, Icon }) => {
        const current = privileges[key] ?? 0;
        const lvl = SIGNING_LEVELS[current];
        return (
          <div key={key} className="flex items-center gap-3 py-1.5">
            <div className="flex items-center gap-2 w-44 flex-shrink-0">
              <Icon className="w-3.5 h-3.5 text-slate-400" />
              <span className="text-xs text-slate-700 font-medium">{label}</span>
            </div>
            {readonly ? (
              <span className={`text-[10px] px-2.5 py-1 rounded-full font-semibold ${lvl.badgeClass}`}>
                {lvl.short === "—" ? lvl.label : lvl.label}
              </span>
            ) : (
              <div className="flex gap-1 flex-wrap">
                {SIGNING_LEVELS.map(sl => (
                  <button
                    key={sl.level}
                    onClick={() => onChange(key, sl.level)}
                    title={sl.description}
                    className={`text-[10px] px-2.5 py-1 rounded-lg font-semibold border transition-all ${
                      current === sl.level
                        ? sl.badgeClass + " border-transparent shadow-sm"
                        : "bg-white border-slate-200 text-slate-500 hover:border-slate-300"
                    }`}
                  >
                    {sl.short}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {/* Legend */}
      <div className="mt-3 pt-3 border-t border-slate-100 flex flex-wrap gap-3">
        {SIGNING_LEVELS.slice(1).map(sl => (
          <div key={sl.level} className="flex items-center gap-1.5 text-[10px] text-slate-500">
            <span className={`px-2 py-0.5 rounded-full font-semibold ${sl.badgeClass}`}>{sl.short}</span>
            {sl.description}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── PageAccessChips Component ────────────────────────────────────────────────
function PageAccessChips({ pagePerms, maxVisible = 4 }) {
  const active = Object.entries(pagePerms)
    .filter(([, v]) => v !== "none")
    .map(([k, v]) => {
      const page = PAGE_PERMISSION_GROUPS.flatMap(g => g.pages).find(p => p.key === k);
      return { key: k, label: page?.label || k, level: v };
    });
  if (active.length === 0) return <span className="text-xs text-slate-400 italic">No access</span>;
  const visible = active.slice(0, maxVisible);
  const rest = active.length - maxVisible;
  return (
    <div className="flex flex-wrap gap-1">
      {visible.map(p => (
        <span key={p.key} className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${ACCESS_LEVELS[p.level]?.chipClass}`}>
          {p.label.split(" ")[0]}
        </span>
      ))}
      {rest > 0 && (
        <span className="text-[10px] px-1.5 py-0.5 rounded border bg-slate-100 text-slate-500 border-slate-200">
          +{rest}
        </span>
      )}
    </div>
  );
}

// ─── RoleBadges Component ──────────────────────────────────────────────────────
function RoleBadges({ member, maxVisible = 2 }) {
  const roles = getMemberRoles(member);
  const customName = member.capabilities?.custom_role;
  if (roles.length === 0) return <span className="text-xs text-slate-400 italic">No role</span>;
  const visible = roles.slice(0, maxVisible);
  const rest = roles.length - maxVisible;
  return (
    <div className="flex flex-wrap gap-1">
      {visible.map(r => {
        if (r === "custom") {
          return (
            <span key="custom" className="text-[10px] px-2 py-0.5 rounded-full border font-semibold bg-purple-100 text-purple-700 border-purple-200">
              {customName || "Custom"}
            </span>
          );
        }
        const def = CRE_ROLES[r];
        if (!def) return null;
        const color = ROLE_COLOR_CLASSES[def.color];
        return (
          <span key={r} className={`text-[10px] px-2 py-0.5 rounded-full border font-semibold ${color.badge}`}>
            {def.label}
          </span>
        );
      })}
      {rest > 0 && (
        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500 border border-slate-200">
          +{rest}
        </span>
      )}
    </div>
  );
}

// ─── UserDetailDrawer Component ───────────────────────────────────────────────
function UserDetailDrawer({ member, orgId, onClose, isSuperAdmin }) {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState("roles");
  const [selectedRoles, setSelectedRoles] = useState(getMemberRoles(member));
  const [customRoleName, setCustomRoleName] = useState(member.capabilities?.custom_role || "");
  const [pagePerms, setPagePerms] = useState(getMemberPagePerms(member));
  const [signingPrivs, setSigningPrivs] = useState(getMemberSigningPrivileges(member));
  const [dataScope, setDataScope] = useState(DEFAULT_DATA_SCOPE);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const status = deriveStatus(member);
  const StatusIcon = STATUS_CONFIG[status]?.Icon || CheckCircle2;
  const initials = (member.profiles?.full_name || member.profiles?.email || "?")
    .split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2);

  const TABS = [
    { key: "roles",    label: "Roles" },
    { key: "access",   label: "Page Access" },
    { key: "data",     label: "Data Scope" },
    { key: "signing",  label: "Signing" },
  ];

  const { data: accessGrants = [] } = useQuery({
    queryKey: ["member-access-grants", member.user_id, orgId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("user_access")
        .select("scope, scope_id, role, is_active, expires_at")
        .eq("user_id", member.user_id)
        .eq("org_id", orgId)
        .eq("is_active", true);
      if (error) throw error;
      return data || [];
    },
    enabled: !!member?.user_id && !!orgId,
    initialData: [],
  });

  useEffect(() => {
    setSelectedRoles(getMemberRoles(member));
    setCustomRoleName(member.capabilities?.custom_role || "");
    setPagePerms(getMemberPagePerms(member));
    setSigningPrivs(getMemberSigningPrivileges(member));
  }, [member]);

  useEffect(() => {
    setDataScope(getMemberDataScope({ access_grants: accessGrants }));
  }, [accessGrants]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const primaryRole = selectedRoles.find(r => r !== "custom") || selectedRoles[0] || null;
      const accessRole = deriveAccessGrantRole(selectedRoles, pagePerms);
      const { error } = await supabase.from("memberships").update({
        role: primaryRole,
        page_permissions: pagePerms,
        status: selectedRoles.length > 0 ? "active" : member.status,
        capabilities: {
          ...(member.capabilities || {}),
          roles: selectedRoles,
          custom_role: customRoleName || null,
          signing_privileges: signingPrivs,
        },
      }).eq("user_id", member.user_id).eq("org_id", orgId);
      if (error) throw error;
      await syncUserAccessGrants({ userId: member.user_id, orgId, dataScope, role: accessRole });
      await logAudit({ action: "update_user_permissions", target_user_id: member.user_id, details: { roles: selectedRoles, signing: signingPrivs } });
      toast.success("Permissions saved");
      queryClient.invalidateQueries({ queryKey: ["org-members"] });
      queryClient.invalidateQueries({ queryKey: ["member-access-grants", member.user_id, orgId] });
      onClose();
    } catch (e) {
      toast.error(e.message || "Failed to save");
    }
    setSaving(false);
  };

  const handleRemove = async () => {
    if (!confirm(`Remove ${member.profiles?.full_name || member.profiles?.email} from this organization?`)) return;
    setRemoving(true);
    try {
      await supabase.from("user_access").delete().eq("user_id", member.user_id).eq("org_id", orgId);
      const { error } = await supabase.from("memberships").delete().eq("user_id", member.user_id).eq("org_id", orgId);
      if (error) throw error;
      await logAudit({ action: "remove_member", target_user_id: member.user_id });
      toast.success("Member removed");
      queryClient.invalidateQueries({ queryKey: ["org-members"] });
      onClose();
    } catch (e) {
      toast.error(e.message || "Failed to remove member");
    }
    setRemoving(false);
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />
      <div className="fixed right-0 top-0 h-full w-[520px] bg-white shadow-2xl z-50 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-50 flex-shrink-0">
          <h2 className="text-base font-bold text-slate-800">User Details</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-200 text-slate-500">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Profile */}
        <div className="px-6 py-4 border-b border-slate-100 flex-shrink-0">
          <div className="flex items-start gap-4">
            <div className="w-14 h-14 rounded-2xl flex items-center justify-center text-white font-bold text-lg flex-shrink-0"
              style={{ backgroundColor: avatarColor(member.profiles?.email) }}>
              {initials}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-0.5">
                <h3 className="font-bold text-slate-900 truncate">{member.profiles?.full_name || "—"}</h3>
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${STATUS_CONFIG[status]?.badgeClass}`}>
                  <StatusIcon className="w-2.5 h-2.5 inline mr-0.5" />{STATUS_CONFIG[status]?.label}
                </span>
              </div>
              <p className="text-sm text-slate-500 truncate">{member.profiles?.email}</p>
              {member.profiles?.phone && <p className="text-xs text-slate-400">{member.profiles.phone}</p>}
            </div>
          </div>
          {isSuperAdmin && (
            <div className="mt-3 flex items-center gap-2 text-xs text-violet-700 bg-violet-50 rounded-lg px-3 py-1.5">
              <Globe className="w-3 h-3" /> SuperAdmin — cross-org view enabled
            </div>
          )}
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-100 px-6 flex-shrink-0">
          {TABS.map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-4 py-3 text-sm font-semibold border-b-2 transition-colors ${
                activeTab === tab.key
                  ? "border-[#1a2744] text-[#1a2744]"
                  : "border-transparent text-slate-500 hover:text-slate-700"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {activeTab === "roles" && (
            <div className="space-y-4">
              <div>
                <Label className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2 block">CRE Roles (Multi-select)</Label>
                <RoleSelector
                  selectedRoles={selectedRoles}
                  onChange={setSelectedRoles}
                  customRoleName={customRoleName}
                  onCustomNameChange={setCustomRoleName}
                />
              </div>
              {selectedRoles.length > 0 && (
                <div>
                  <Label className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2 block">Selected Roles</Label>
                  <div className="space-y-2">
                    {selectedRoles.map(r => {
                      if (r === "custom") return (
                        <div key="custom" className="flex items-start gap-2 p-2.5 rounded-xl bg-purple-50 border border-purple-200">
                          <div className="w-2 h-2 rounded-full bg-purple-500 mt-1.5 flex-shrink-0" />
                          <div>
                            <p className="text-xs font-semibold text-purple-800">{customRoleName || "Custom Role"}</p>
                            <p className="text-[10px] text-purple-600">Custom title</p>
                          </div>
                        </div>
                      );
                      const def = CRE_ROLES[r];
                      if (!def) return null;
                      const color = ROLE_COLOR_CLASSES[def.color];
                      return (
                        <div key={r} className={`flex items-start gap-2 p-2.5 rounded-xl border ${color.badge}`}>
                          <div className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${color.dot}`} />
                          <div>
                            <p className="text-xs font-semibold">{def.label}</p>
                            <p className="text-[10px] opacity-70">{def.description}</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === "access" && (
            <div>
              <p className="text-xs text-slate-500 mb-3">Set page-level access permissions. Changes apply immediately on save.</p>
              <PagePermissionMatrix
                permissions={pagePerms}
                onChange={(k, v) => setPagePerms(p => ({ ...p, [k]: v }))}
              />
            </div>
          )}

          {activeTab === "data" && (
            <DataScopeEditor orgId={orgId} value={dataScope} onChange={setDataScope} />
          )}

          {activeTab === "signing" && (
            <div>
              <div className="mb-4 p-3 bg-blue-50 border border-blue-100 rounded-xl text-xs text-blue-700">
                <strong>Signing authority levels</strong> control who can initiate, review, approve, and finally sign each document type.
              </div>
              <SigningPrivilegesMatrix
                privileges={signingPrivs}
                onChange={(k, v) => setSigningPrivs(p => ({ ...p, [k]: v }))}
              />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-100 bg-slate-50 flex-shrink-0">
          <div className="flex gap-2 mb-3">
            {status === "invited" && (
              <Button variant="outline" size="sm" className="flex-1 gap-2 text-xs"
                onClick={async () => {
                  try {
                    await invokeInviteUser({
                      email: member.profiles?.email,
                      full_name: member.profiles?.full_name,
                      org_id: orgId,
                      role: getMemberRoles(member)[0] || null,
                    });
                    toast.success("Invite resent");
                  } catch (error) {
                    toast.error(error?.message || "Failed");
                  }
                }}>
                <Mail className="w-3.5 h-3.5" /> Resend Invite
              </Button>
            )}
            <Button variant="outline" size="sm" className="flex-1 gap-2 text-xs border-red-200 text-red-600 hover:bg-red-50"
              onClick={handleRemove} disabled={removing}>
              {removing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
              Remove
            </Button>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={onClose}>Cancel</Button>
            <Button className="flex-1 bg-[#1a2744] hover:bg-[#1a2744]/90 text-white" onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="w-4 h-4 animate-spin mr-2" />} Save
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}

// ─── InviteDialog Component ───────────────────────────────────────────────────
function InviteDialog({ open, onClose, orgId }) {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState("info");
  const [form, setForm] = useState({ full_name: "", email: "", phone: "" });
  const [selectedRoles, setSelectedRoles] = useState([]);
  const [customRoleName, setCustomRoleName] = useState("");
  const [pagePerms, setPagePerms] = useState({ ...DEFAULT_PAGE_PERMS });
  const [signingPrivs, setSigningPrivs] = useState({ ...DEFAULT_SIGNING });
  const [dataScope, setDataScope] = useState({ ...DEFAULT_DATA_SCOPE });
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState({});

  const TABS = [
    { key: "info",    label: "1. Contact" },
    { key: "roles",   label: "2. Roles" },
    { key: "access",  label: "3. Page Access" },
    { key: "data",    label: "4. Data Scope" },
    { key: "signing", label: "5. Signing" },
  ];

  const validate = () => {
    const e = {};
    if (!form.full_name.trim()) e.full_name = "Required";
    if (!form.email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) e.email = "Valid email required";
    if (!form.phone.trim()) e.phone = "Required";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) { setActiveTab("info"); return; }
    setSubmitting(true);
    try {
      const primaryRole = selectedRoles.find(r => r !== "custom") || null;
      const accessRole = deriveAccessGrantRole(selectedRoles, pagePerms);
      await invokeInviteUser({
        email: form.email.trim(),
        full_name: form.full_name.trim(),
        phone: form.phone.trim(),
        role: primaryRole,
        org_id: orgId,
        page_permissions: pagePerms,
        access_scopes: dataScope,
        capabilities: {
          roles: selectedRoles,
          custom_role: customRoleName || null,
          signing_privileges: signingPrivs,
        },
        access_role: accessRole,
      });
      toast.success(`Invite sent to ${form.email}`);
      queryClient.invalidateQueries({ queryKey: ["org-members"] });
      // Reset
      setForm({ full_name: "", email: "", phone: "" });
      setSelectedRoles([]);
      setCustomRoleName("");
      setPagePerms({ ...DEFAULT_PAGE_PERMS });
      setDataScope({ ...DEFAULT_DATA_SCOPE });
      setSigningPrivs({ ...DEFAULT_SIGNING });
      setActiveTab("info");
      onClose();
    } catch (e) {
      toast.error(e.message || "Failed to send invite");
    }
    setSubmitting(false);
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader className="flex-shrink-0">
          <DialogTitle className="text-lg font-bold">Invite Team Member</DialogTitle>
        </DialogHeader>

        {/* Step tabs */}
        <div className="flex border-b border-slate-100 flex-shrink-0 -mx-6 px-6">
          {TABS.map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-4 py-2.5 text-xs font-semibold border-b-2 transition-colors whitespace-nowrap ${
                activeTab === tab.key
                  ? "border-[#1a2744] text-[#1a2744]"
                  : "border-transparent text-slate-400 hover:text-slate-600"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto py-4 space-y-4">
          {activeTab === "info" && (
            <div className="space-y-4">
              <div>
                <Label className="text-sm font-medium mb-1.5 block">Full Name <span className="text-red-500">*</span></Label>
                <Input placeholder="Jane Smith" value={form.full_name}
                  onChange={e => setForm(f => ({ ...f, full_name: e.target.value }))}
                  className={errors.full_name ? "border-red-400" : ""} />
                {errors.full_name && <p className="text-xs text-red-500 mt-1">{errors.full_name}</p>}
              </div>
              <div>
                <Label className="text-sm font-medium mb-1.5 block">Email Address <span className="text-red-500">*</span></Label>
                <Input type="email" placeholder="jane@company.com" value={form.email}
                  onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                  className={errors.email ? "border-red-400" : ""} />
                {errors.email && <p className="text-xs text-red-500 mt-1">{errors.email}</p>}
              </div>
              <div>
                <Label className="text-sm font-medium mb-1.5 block">Phone Number <span className="text-red-500">*</span></Label>
                <Input type="tel" placeholder="+1 (555) 000-0000" value={form.phone}
                  onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                  className={errors.phone ? "border-red-400" : ""} />
                {errors.phone && <p className="text-xs text-red-500 mt-1">{errors.phone}</p>}
              </div>
              <Button className="w-full bg-[#1a2744]/10 text-[#1a2744] hover:bg-[#1a2744]/20 font-semibold"
                onClick={() => setActiveTab("roles")}>
                Next: Assign Roles →
              </Button>
            </div>
          )}

          {activeTab === "roles" && (
            <div className="space-y-4">
              <div>
                <Label className="text-sm font-medium mb-2 block">CRE Roles (select one or more)</Label>
                <RoleSelector
                  selectedRoles={selectedRoles} onChange={setSelectedRoles}
                  customRoleName={customRoleName} onCustomNameChange={setCustomRoleName}
                />
              </div>
              {selectedRoles.length === 0 && (
                <p className="text-xs text-amber-600 flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  No roles selected — user will be created with No Access status.
                </p>
              )}
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={() => setActiveTab("info")}>← Back</Button>
                <Button className="flex-1 bg-[#1a2744]/10 text-[#1a2744] hover:bg-[#1a2744]/20 font-semibold" onClick={() => setActiveTab("access")}>
                  Next: Page Access →
                </Button>
              </div>
            </div>
          )}

          {activeTab === "access" && (
            <div className="space-y-3">
              <p className="text-xs text-slate-500">Configure which pages this user can access and at what level.</p>
              <PagePermissionMatrix
                permissions={pagePerms}
                onChange={(k, v) => setPagePerms(p => ({ ...p, [k]: v }))}
              />
              <div className="flex gap-2 pt-2">
                <Button variant="outline" className="flex-1" onClick={() => setActiveTab("roles")}>← Back</Button>
                <Button className="flex-1 bg-[#1a2744]/10 text-[#1a2744] hover:bg-[#1a2744]/20 font-semibold" onClick={() => setActiveTab("data")}>
                  Next: Data Scope →
                </Button>
              </div>
            </div>
          )}

          {activeTab === "data" && (
            <div className="space-y-4">
              <DataScopeEditor orgId={orgId} value={dataScope} onChange={setDataScope} />
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={() => setActiveTab("access")}>← Back</Button>
                <Button className="flex-1 bg-[#1a2744]/10 text-[#1a2744] hover:bg-[#1a2744]/20 font-semibold" onClick={() => setActiveTab("signing")}>
                  Next: Signing →
                </Button>
              </div>
            </div>
          )}

          {activeTab === "signing" && (
            <div className="space-y-4">
              <p className="text-xs text-slate-500">Set signing authority levels for each document type. L4 = Final Authority.</p>
              <SigningPrivilegesMatrix
                privileges={signingPrivs}
                onChange={(k, v) => setSigningPrivs(p => ({ ...p, [k]: v }))}
              />
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 flex-shrink-0 pt-2 border-t border-slate-100">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button className="bg-[#1a2744] hover:bg-[#1a2744]/90 text-white gap-2" onClick={handleSubmit} disabled={submitting}>
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
            Send Invite
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── CSVUploadDialog Component ────────────────────────────────────────────────
function CSVUploadDialog({ open, onClose, orgId }) {
  const queryClient = useQueryClient();
  const fileInputRef = useRef(null);
  const [rows, setRows] = useState([]);
  const [parseError, setParseError] = useState("");
  const [progress, setProgress] = useState(null);
  const [dragging, setDragging] = useState(false);

  const processFile = (file) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".csv")) {
      setParseError("Please upload a .csv file");
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      setParseError("");
      const parsed = parseCSV(e.target.result);
      if (parsed.length === 0) {
        setParseError("No valid rows found. Check that your CSV has email, name, and phone columns.");
        return;
      }
      setRows(parsed);
    };
    reader.onerror = () => setParseError("Failed to read file");
    reader.readAsText(file);
  };

  const downloadTemplate = () => {
    const csv = [
      "full_name,email,phone",
      "Jane Smith,jane@company.com,+1-555-0100",
      "John Doe,john@company.com,+1-555-0101",
      "Sarah Lee,sarah@company.com,+1-555-0102",
    ].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "user_import_template.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const handleImport = async () => {
    if (!orgId) { toast.error("Select an organization first"); return; }
    setProgress({ done: 0, total: rows.length, errors: [], success: 0 });
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        await invokeInviteUser({
          email: row.email,
          full_name: row.full_name,
          phone: row.phone,
          org_id: orgId,
          role: null,
        });
        setProgress(p => ({ ...p, done: p.done + 1, success: p.success + 1 }));
      } catch (e) {
        setProgress(p => ({ ...p, done: p.done + 1, errors: [...p.errors, { email: row.email, msg: e.message }] }));
      }
    }
    queryClient.invalidateQueries({ queryKey: ["org-members"] });
  };

  const isDone = progress && progress.done === progress.total;

  const reset = () => { setRows([]); setProgress(null); setParseError(""); };

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) { reset(); onClose(); } }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader className="flex-shrink-0">
          <DialogTitle className="text-lg font-bold">Import Users from CSV</DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-4 py-2">
          {/* Info */}
          <div className="flex items-start gap-3 p-3 bg-blue-50 border border-blue-100 rounded-xl text-xs text-blue-700">
            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0 text-blue-500" />
            <span>
              <strong>CSV must contain: full_name, email, phone columns.</strong>{" "}
              No roles are assigned during import. Users are created with <strong>No Access</strong> status — assign roles individually after import.
            </span>
          </div>

          {/* Drop Zone */}
          {rows.length === 0 && !progress && (
            <div>
              <div
                onDragOver={e => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={e => { e.preventDefault(); setDragging(false); processFile(e.dataTransfer.files[0]); }}
                className={`border-2 border-dashed rounded-2xl p-10 text-center transition-colors ${
                  dragging ? "border-blue-400 bg-blue-50" : "border-slate-200 hover:border-slate-300 cursor-pointer"
                }`}
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className="w-10 h-10 text-slate-300 mx-auto mb-3" />
                <p className="text-sm font-semibold text-slate-600 mb-1">Drop your CSV file here</p>
                <p className="text-xs text-slate-400">or click to browse — accepts .csv only</p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv"
                  className="hidden"
                  onChange={e => processFile(e.target.files[0])}
                />
              </div>
              {parseError && (
                <p className="mt-2 text-xs text-red-600 flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5" /> {parseError}
                </p>
              )}
            </div>
          )}

          {/* Preview Table */}
          {rows.length > 0 && !progress && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm font-semibold text-slate-700">{rows.length} users ready to import</p>
                <button className="text-xs text-slate-400 hover:text-slate-600 underline" onClick={reset}>
                  Clear & re-upload
                </button>
              </div>
              <div className="border border-slate-200 rounded-xl overflow-hidden max-h-60 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 sticky top-0">
                    <tr className="border-b border-slate-200">
                      <th className="px-3 py-2.5 text-left text-slate-500 font-semibold">#</th>
                      <th className="px-3 py-2.5 text-left text-slate-500 font-semibold">Full Name</th>
                      <th className="px-3 py-2.5 text-left text-slate-500 font-semibold">Email</th>
                      <th className="px-3 py-2.5 text-left text-slate-500 font-semibold">Phone</th>
                      <th className="px-3 py-2.5 text-left text-slate-500 font-semibold">Status After Import</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {rows.map((r, i) => (
                      <tr key={i} className="hover:bg-slate-50">
                        <td className="px-3 py-2 text-slate-400">{i + 1}</td>
                        <td className="px-3 py-2 text-slate-700 font-medium">{r.full_name || <span className="text-slate-400 italic">—</span>}</td>
                        <td className="px-3 py-2 text-slate-600">{r.email}</td>
                        <td className="px-3 py-2 text-slate-500">{r.phone || <span className="text-slate-400 italic">—</span>}</td>
                        <td className="px-3 py-2">
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-100 text-red-600 font-semibold">No Access</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[10px] text-amber-700 mt-2 flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" />
                Roles must be assigned manually after import from the Users table.
              </p>
            </div>
          )}

          {/* Progress */}
          {progress && (
            <div className="space-y-4">
              <div className="flex items-center justify-between text-sm">
                <span className="font-semibold text-slate-700">
                  {isDone ? "Import complete!" : "Importing…"}
                </span>
                <span className="text-slate-500">{progress.done} / {progress.total}</span>
              </div>
              <div className="w-full bg-slate-100 rounded-full h-2.5">
                <div
                  className="h-2.5 rounded-full transition-all bg-[#1a2744]"
                  style={{ width: `${(progress.done / progress.total) * 100}%` }}
                />
              </div>
              {isDone && (
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-100 text-emerald-700 font-semibold">
                    ✓ {progress.success} imported
                  </div>
                  <div className={`p-3 rounded-xl border font-semibold ${progress.errors.length > 0 ? "bg-red-50 border-red-100 text-red-700" : "bg-slate-50 border-slate-100 text-slate-500"}`}>
                    {progress.errors.length > 0 ? `✗ ${progress.errors.length} failed` : "0 errors"}
                  </div>
                </div>
              )}
              {progress.errors.length > 0 && (
                <div className="text-xs text-red-600 space-y-1 max-h-32 overflow-y-auto bg-red-50 rounded-xl p-3">
                  {progress.errors.map((e, i) => (
                    <div key={i}><strong>{e.email}:</strong> {e.msg}</div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 flex-shrink-0 pt-2 border-t border-slate-100">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={downloadTemplate}>
            <Download className="w-3.5 h-3.5" /> Download Template
          </Button>
          <Button variant="outline" onClick={() => { reset(); onClose(); }}>
            {isDone ? "Close" : "Cancel"}
          </Button>
          {rows.length > 0 && !progress && (
            <Button className="bg-[#1a2744] hover:bg-[#1a2744]/90 text-white gap-2" onClick={handleImport}>
              <Upload className="w-4 h-4" /> Import {rows.length} Users
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── BulkUpdateDialog Component ───────────────────────────────────────────────
function BulkUpdateDialog({ open, onClose, selectedMembers, orgId }) {
  const queryClient = useQueryClient();
  const [selectedRoles, setSelectedRoles] = useState([]);
  const [customRoleName, setCustomRoleName] = useState("");
  const [pagePerms, setPagePerms] = useState({ ...DEFAULT_PAGE_PERMS });
  const [signingPrivs, setSigningPrivs] = useState({ ...DEFAULT_SIGNING });
  const [dataScope, setDataScope] = useState({ ...DEFAULT_DATA_SCOPE });
  const [activeTab, setActiveTab] = useState("roles");
  const [saving, setSaving] = useState(false);

  const TABS = [
    { key: "roles", label: "Roles" },
    { key: "access", label: "Page Access" },
    { key: "data", label: "Data Scope" },
    { key: "signing", label: "Signing" },
  ];

  const handleSave = async () => {
    setSaving(true);
    try {
      const primaryRole = selectedRoles.find(r => r !== "custom") || null;
      const accessRole = deriveAccessGrantRole(selectedRoles, pagePerms);
      for (const m of selectedMembers) {
        await supabase.from("memberships").update({
          role: primaryRole,
          page_permissions: pagePerms,
          status: selectedRoles.length > 0 ? "active" : m.status,
          capabilities: {
            ...(m.capabilities || {}),
            roles: selectedRoles,
            custom_role: customRoleName || null,
            signing_privileges: signingPrivs,
          },
        }).eq("user_id", m.user_id).eq("org_id", orgId);
        await syncUserAccessGrants({ userId: m.user_id, orgId, dataScope, role: accessRole });
      }
      await logAudit({ action: "bulk_update_permissions", details: { count: selectedMembers.length, roles: selectedRoles } });
      toast.success(`Updated ${selectedMembers.length} users`);
      queryClient.invalidateQueries({ queryKey: ["org-members"] });
      onClose();
    } catch (e) {
      toast.error(e.message || "Bulk update failed");
    }
    setSaving(false);
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader className="flex-shrink-0">
          <DialogTitle className="text-lg font-bold">Update {selectedMembers.length} Users</DialogTitle>
        </DialogHeader>
        <div className="p-3 bg-amber-50 border border-amber-100 rounded-xl text-xs text-amber-700 flex-shrink-0">
          This will overwrite roles, page access, and signing privileges for all selected users.
        </div>

        <div className="flex border-b border-slate-100 flex-shrink-0">
          {TABS.map(tab => (
            <button key={tab.key} onClick={() => setActiveTab(tab.key)}
              className={`px-4 py-2.5 text-xs font-semibold border-b-2 transition-colors ${activeTab === tab.key ? "border-[#1a2744] text-[#1a2744]" : "border-transparent text-slate-400 hover:text-slate-600"}`}>
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto py-4">
          {activeTab === "roles" && (
            <RoleSelector selectedRoles={selectedRoles} onChange={setSelectedRoles}
              customRoleName={customRoleName} onCustomNameChange={setCustomRoleName} />
          )}
          {activeTab === "access" && (
            <PagePermissionMatrix permissions={pagePerms} onChange={(k, v) => setPagePerms(p => ({ ...p, [k]: v }))} />
          )}
          {activeTab === "data" && (
            <DataScopeEditor orgId={orgId} value={dataScope} onChange={setDataScope} />
          )}
          {activeTab === "signing" && (
            <SigningPrivilegesMatrix privileges={signingPrivs} onChange={(k, v) => setSigningPrivs(p => ({ ...p, [k]: v }))} />
          )}
        </div>

        <DialogFooter className="gap-2 flex-shrink-0 pt-2 border-t border-slate-100">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button className="bg-[#1a2744] hover:bg-[#1a2744]/90 text-white gap-2" onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            Apply to {selectedMembers.length} Users
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main UserManagement ──────────────────────────────────────────────────────
export default function UserManagement() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const isSuperAdmin = user?.memberships?.some(m => m.role === "super_admin");
  const defaultOrgId = user?.activeOrg?.id || user?.org_id;

  const [selectedOrgId, setSelectedOrgId] = useState(defaultOrgId);
  const [selectedOrgName, setSelectedOrgName] = useState(user?.activeOrg?.name || "My Organization");
  const [searchQuery, setSearchQuery] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterCategory, setFilterCategory] = useState("all");
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [drawerMember, setDrawerMember] = useState(null);
  const [showInvite, setShowInvite] = useState(false);
  const [showCSV, setShowCSV] = useState(false);
  const [showBulkUpdate, setShowBulkUpdate] = useState(false);

  const activeOrgId = selectedOrgId || defaultOrgId;

  // Fetch all orgs for SuperAdmin
  const { data: allOrgs = [] } = useQuery({
    queryKey: ["all-orgs-sa"],
    queryFn: async () => {
      const { data, error } = await supabase.from("organizations").select("id, name, status").order("name");
      if (error) throw error;
      return data || [];
    },
    enabled: isSuperAdmin,
  });

  // Fetch members
  const { data: members = [], isLoading } = useQuery({
    queryKey: ["org-members", activeOrgId],
    queryFn: async () => {
      if (!activeOrgId) return [];

      const { data: membershipRows, error: membershipError } = await supabase
        .from("memberships")
        .select("*")
        .eq("org_id", activeOrgId)
        .neq("role", "super_admin");
      if (membershipError) throw membershipError;

      const baseMembers = membershipRows || [];
      const userIds = [...new Set(baseMembers.map(member => member.user_id).filter(Boolean))];

      const [profilesResult, invitationsResult] = await Promise.all([
        userIds.length > 0
          ? supabase
              .from("profiles")
              .select("*")
              .in("id", userIds)
          : Promise.resolve({ data: [], error: null }),
        supabase
          .from("invitations")
          .select("*")
          .eq("org_id", activeOrgId)
          .in("status", ["pending", "pending_approval"]),
      ]);

      if (profilesResult.error) {
        console.warn("[UserManagement] profile enrichment failed:", profilesResult.error.message);
      }
      if (invitationsResult.error) {
        console.warn("[UserManagement] invitation enrichment failed:", invitationsResult.error.message);
      }

      const profilesById = new Map((profilesResult.data || []).map(profile => [profile.id, profile]));

      const enrichedMembers = baseMembers.map(member => {
        const profile = profilesById.get(member.user_id);
        const invitedEmail = member.capabilities?.invited_email || null;
        const invitedFullName = member.capabilities?.invited_full_name || null;

        return {
          ...member,
          profiles: {
            id: profile?.id || member.user_id || null,
            full_name: profile?.full_name || invitedFullName || null,
            email: profile?.email || invitedEmail || null,
            phone: profile?.phone || member.phone || null,
            status: profile?.status || null,
            last_sign_in_at: profile?.last_sign_in_at || null,
            avatar_url: profile?.avatar_url || null,
          },
        };
      });

      const knownEmails = new Set(
        enrichedMembers
          .map(member => member.profiles?.email?.toLowerCase())
          .filter(Boolean),
      );

      const invitationOnlyMembers = (invitationsResult.data || [])
        .filter(invitation => invitation.email && !knownEmails.has(invitation.email.toLowerCase()))
        .map(invitation => ({
          id: `invitation:${invitation.id}`,
          user_id: `invitation:${invitation.id}`,
          role: invitation.role || null,
          status: "invited",
          phone: null,
          custom_role: null,
          module_permissions: {},
          page_permissions: {},
          capabilities: {
            roles: invitation.role ? [invitation.role] : [],
            invited_email: invitation.email,
            invited_full_name: null,
          },
          created_at: invitation.created_at,
          updated_at: invitation.updated_at || invitation.created_at,
          invitation,
          isInvitationOnly: true,
          profiles: {
            id: null,
            full_name: null,
            email: invitation.email,
            phone: null,
            status: "invited",
            last_sign_in_at: null,
            avatar_url: null,
          },
        }));

      return [...enrichedMembers, ...invitationOnlyMembers].sort(
        (a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime(),
      );
    },
    enabled: !!activeOrgId,
  });

  // Stats
  const stats = useMemo(() => ({
    total: members.length,
    active: members.filter(m => deriveStatus(m) === "active").length,
    invited: members.filter(m => deriveStatus(m) === "invited").length,
    noAccess: members.filter(m => deriveStatus(m) === "no_access").length,
  }), [members]);

  // Filtered
  const filtered = useMemo(() => {
    return members.filter(m => {
      const name = (m.profiles?.full_name || "").toLowerCase();
      const email = (m.profiles?.email || "").toLowerCase();
      const q = searchQuery.toLowerCase();
      if (q && !name.includes(q) && !email.includes(q)) return false;
      if (filterStatus !== "all" && deriveStatus(m) !== filterStatus) return false;
      if (filterCategory !== "all") {
        const roles = getMemberRoles(m);
        const hasCategory = roles.some(r => r !== "custom" && CRE_ROLES[r]?.category === filterCategory);
        if (!hasCategory) return false;
      }
      return true;
    });
  }, [members, searchQuery, filterStatus, filterCategory]);

  const selectableMembers = filtered.filter(m => !m.isInvitationOnly);
  const selectedMembers = members.filter(m => !m.isInvitationOnly && selectedIds.has(m.user_id));
  const allSelected = selectableMembers.length > 0 && selectableMembers.every(m => selectedIds.has(m.user_id));
  const hasFilters = searchQuery || filterStatus !== "all" || filterCategory !== "all";

  const toggleSelect = (id) => setSelectedIds(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const toggleAll = () => {
    if (allSelected) setSelectedIds(new Set());
    else setSelectedIds(new Set(selectableMembers.map(m => m.user_id)));
  };

  const handleBulkRemove = async () => {
    if (!confirm(`Remove ${selectedMembers.length} members?`)) return;
    for (const m of selectedMembers) {
      await supabase.from("memberships").delete().eq("user_id", m.user_id).eq("org_id", activeOrgId);
    }
    await logAudit({ action: "bulk_remove_members", details: { count: selectedMembers.length } });
    toast.success(`Removed ${selectedMembers.length} members`);
    setSelectedIds(new Set());
    queryClient.invalidateQueries({ queryKey: ["org-members"] });
  };

  const handleBulkResend = async () => {
    const targets = selectedMembers.filter(m => deriveStatus(m) === "invited");
    if (!targets.length) { toast.info("No invited users selected"); return; }
    for (const m of targets) {
      await invokeInviteUser({
        email: m.profiles?.email,
        full_name: m.profiles?.full_name,
        org_id: activeOrgId,
        role: getMemberRoles(m)[0] || null,
      });
    }
    toast.success(`Resent ${targets.length} invites`);
  };

  return (
    <div className="p-6 space-y-6 max-w-[1600px] mx-auto">

      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-black text-slate-900">User Management</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {isSuperAdmin ? "Manage users across all organizations" : "Manage your team's roles, access, and signing authority"}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="gap-2 h-9" onClick={() => setShowCSV(true)}>
            <Upload className="w-4 h-4" /> Import CSV
          </Button>
          <Button size="sm" className="gap-2 h-9 bg-[#1a2744] hover:bg-[#1a2744]/90 text-white" onClick={() => setShowInvite(true)}>
            <Plus className="w-4 h-4" /> Invite Member
          </Button>
        </div>
      </div>

      {/* SuperAdmin Org Switcher */}
      {isSuperAdmin && allOrgs.length > 0 && (
        <Card className="border-violet-200 bg-violet-50/40">
          <CardContent className="p-4">
            <div className="flex items-center gap-4 flex-wrap">
              <div className="flex items-center gap-2 text-sm font-bold text-violet-700">
                <Globe className="w-4 h-4" /> SuperAdmin View
              </div>
              <Select
                value={selectedOrgId || ""}
                onValueChange={val => {
                  setSelectedOrgId(val);
                  const org = allOrgs.find(o => o.id === val);
                  setSelectedOrgName(org?.name || "Unknown");
                  setSelectedIds(new Set());
                }}
              >
                <SelectTrigger className="h-9 w-72 bg-white border-violet-200">
                  <SelectValue placeholder="Select organization to manage" />
                </SelectTrigger>
                <SelectContent>
                  {allOrgs.map(org => (
                    <SelectItem key={org.id} value={org.id}>
                      <div className="flex items-center gap-2">
                        <Building2 className="w-3 h-3 text-slate-400" />
                        {org.name}
                        <span className={`text-[10px] px-1.5 rounded-full font-semibold ${org.status === "active" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
                          {org.status}
                        </span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-xs bg-violet-100 text-violet-700 px-3 py-1.5 rounded-lg font-medium">
                Viewing: <strong>{selectedOrgName}</strong>
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          { label: "Total Members", value: stats.total,    Icon: Users,      bg: "bg-slate-50",   iconColor: "text-slate-500" },
          { label: "Active",        value: stats.active,   Icon: UserCheck,  bg: "bg-emerald-50", iconColor: "text-emerald-500" },
          { label: "Invited",       value: stats.invited,  Icon: Mail,       bg: "bg-amber-50",   iconColor: "text-amber-500" },
          { label: "No Access",     value: stats.noAccess, Icon: UserX,      bg: "bg-red-50",     iconColor: "text-red-500" },
        ].map(s => (
          <Card key={s.label} className={`border-0 shadow-sm ${s.bg}`}>
            <CardContent className="p-4 flex items-center gap-3">
              <s.Icon className={`w-7 h-7 ${s.iconColor}`} />
              <div>
                <div className="text-2xl font-black text-slate-900">{s.value}</div>
                <div className="text-xs text-slate-500 font-medium">{s.label}</div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* No Access Warning */}
      {stats.noAccess > 0 && (
        <div className="flex items-center gap-3 p-3 bg-amber-50 border border-amber-200 rounded-xl text-sm">
          <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0" />
          <span className="text-amber-800">
            <strong>{stats.noAccess} user{stats.noAccess > 1 ? "s" : ""}</strong> have no roles assigned and cannot access the platform. Click their row to assign roles.
          </span>
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input placeholder="Search name or email…" value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)} className="pl-9 h-9 text-sm" />
        </div>
        <Select value={filterStatus} onValueChange={setFilterStatus}>
          <SelectTrigger className="h-9 w-36 text-sm"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="invited">Invited</SelectItem>
            <SelectItem value="no_access">No Access</SelectItem>
          </SelectContent>
        </Select>
        <Select value={filterCategory} onValueChange={setFilterCategory}>
          <SelectTrigger className="h-9 w-44 text-sm"><SelectValue placeholder="Role Category" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Categories</SelectItem>
            {ROLE_CATEGORY_ORDER.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
          </SelectContent>
        </Select>
        {hasFilters && (
          <Button variant="ghost" size="sm" className="h-9 text-xs text-slate-500 gap-1"
            onClick={() => { setSearchQuery(""); setFilterStatus("all"); setFilterCategory("all"); }}>
            <X className="w-3.5 h-3.5" /> Clear
          </Button>
        )}
        <div className="ml-auto text-xs text-slate-400">{filtered.length} of {members.length} members</div>
      </div>

      {/* Bulk Action Bar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 px-5 py-3 bg-[#1a2744] rounded-xl shadow-lg flex-wrap">
          <span className="text-sm text-white font-bold">{selectedIds.size} selected</span>
          <Button size="sm" variant="ghost" className="h-8 text-xs text-white hover:bg-white/10 gap-1.5"
            onClick={() => setShowBulkUpdate(true)}>
            <Settings className="w-3.5 h-3.5" /> Assign Roles & Access
          </Button>
          <Button size="sm" variant="ghost" className="h-8 text-xs text-white hover:bg-white/10 gap-1.5"
            onClick={handleBulkResend}>
            <Mail className="w-3.5 h-3.5" /> Resend Invites
          </Button>
          <Button size="sm" variant="ghost"
            className="h-8 text-xs text-red-300 hover:bg-white/10 gap-1.5 ml-auto"
            onClick={handleBulkRemove}>
            <Trash2 className="w-3.5 h-3.5" /> Remove ({selectedIds.size})
          </Button>
          <button className="text-white/50 hover:text-white" onClick={() => setSelectedIds(new Set())}>
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Table */}
      <div className="rounded-2xl border border-slate-200 shadow-sm overflow-hidden bg-white">
        <Table>
          <TableHeader>
            <TableRow className="bg-slate-50 hover:bg-slate-50">
              <TableHead className="w-10 px-4">
                <Checkbox checked={allSelected} onCheckedChange={toggleAll} aria-label="Select all" />
              </TableHead>
              <TableHead className="text-xs font-bold text-slate-500 uppercase tracking-wide">Member</TableHead>
              <TableHead className="text-xs font-bold text-slate-500 uppercase tracking-wide">CRE Roles</TableHead>
              <TableHead className="text-xs font-bold text-slate-500 uppercase tracking-wide">Page Access</TableHead>
              <TableHead className="text-xs font-bold text-slate-500 uppercase tracking-wide">Signing Authority</TableHead>
              <TableHead className="text-xs font-bold text-slate-500 uppercase tracking-wide">Status</TableHead>
              <TableHead className="text-xs font-bold text-slate-500 uppercase tracking-wide">Last Active</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={8} className="py-16 text-center">
                  <Loader2 className="w-6 h-6 animate-spin mx-auto text-slate-300" />
                </TableCell>
              </TableRow>
            ) : filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="py-16 text-center">
                  <Users className="w-8 h-8 text-slate-200 mx-auto mb-2" />
                  <p className="text-sm text-slate-400 font-medium">
                    {hasFilters ? "No members match your filters" : "No members yet — invite your first team member"}
                  </p>
                  {!hasFilters && (
                    <Button size="sm" className="mt-3 gap-1.5 bg-[#1a2744] text-white" onClick={() => setShowInvite(true)}>
                      <Plus className="w-3.5 h-3.5" /> Invite Member
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ) : (
              filtered.map(member => {
                const status = deriveStatus(member);
                const statusCfg = STATUS_CONFIG[status];
                const StatusIcon = statusCfg?.Icon || CheckCircle2;
                const pagePerms = getMemberPagePerms(member);
                const signingPrivs = getMemberSigningPrivileges(member);
                const highestSigning = getHighestSigningLevel(signingPrivs);
                const highestSlvl = SIGNING_LEVELS[highestSigning];
                const isSelected = selectedIds.has(member.user_id);
                const canOpenDetails = !member.isInvitationOnly;
                const initials = (member.profiles?.full_name || member.profiles?.email || "?")
                  .split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2);

                return (
                  <TableRow
                    key={member.user_id}
                    className={`${canOpenDetails ? "cursor-pointer" : "cursor-default"} transition-colors ${isSelected ? "bg-[#1a2744]/5" : "hover:bg-slate-50/80"}`}
                    onClick={() => {
                      if (canOpenDetails) setDrawerMember(member);
                    }}
                  >
                    <TableCell className="px-4" onClick={e => e.stopPropagation()}>
                      <Checkbox
                        checked={isSelected}
                        disabled={member.isInvitationOnly}
                        onCheckedChange={() => toggleSelect(member.user_id)}
                      />
                    </TableCell>

                    {/* Member */}
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
                          style={{ backgroundColor: avatarColor(member.profiles?.email) }}>
                          {initials}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-sm font-semibold text-slate-800 truncate">
                              {member.profiles?.full_name || <span className="italic text-slate-400">Unnamed</span>}
                            </span>
                            {status === "no_access" && (
                              <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-red-100 text-red-600 font-bold uppercase tracking-wide flex-shrink-0">
                                Needs Role
                              </span>
                            )}
                            {member.isInvitationOnly && (
                              <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 font-bold uppercase tracking-wide flex-shrink-0">
                                Pending Invite
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] text-slate-400 truncate">{member.profiles?.email}</p>
                          {member.profiles?.phone && <p className="text-[10px] text-slate-300">{member.profiles.phone}</p>}
                        </div>
                      </div>
                    </TableCell>

                    {/* Roles */}
                    <TableCell><RoleBadges member={member} maxVisible={2} /></TableCell>

                    {/* Page Access */}
                    <TableCell><PageAccessChips pagePerms={pagePerms} maxVisible={3} /></TableCell>

                    {/* Signing Authority */}
                    <TableCell>
                      {highestSigning === 0 ? (
                        <span className="text-xs text-slate-400 italic">None</span>
                      ) : (
                        <div className="space-y-1">
                          <span className={`text-[10px] px-2.5 py-1 rounded-full font-semibold ${highestSlvl.badgeClass}`}>
                            {highestSlvl.label}
                          </span>
                          <div className="flex gap-0.5">
                            {DOCUMENT_TYPES.filter(d => (signingPrivs[d.key] || 0) > 0).slice(0, 3).map(d => (
                              <span key={d.key} className="text-[9px] text-slate-400">{d.label.split(" ")[0]}</span>
                            )).reduce((acc, el, i, arr) => [...acc, el, i < arr.length - 1 ? <span key={`sep-${i}`} className="text-slate-200"> · </span> : null], [])}
                          </div>
                        </div>
                      )}
                    </TableCell>

                    {/* Status */}
                    <TableCell>
                      <span className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full font-semibold ${statusCfg?.badgeClass}`}>
                        <StatusIcon className="w-3 h-3" />{statusCfg?.label}
                      </span>
                    </TableCell>

                    {/* Last Active */}
                    <TableCell>
                      <span className="text-xs text-slate-400">{formatLastActive(member.profiles?.last_sign_in_at)}</span>
                    </TableCell>

                    {/* Actions */}
                    <TableCell onClick={e => e.stopPropagation()}>
                      {canOpenDetails ? (
                        <button className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors"
                          onClick={() => setDrawerMember(member)}>
                          <Eye className="w-4 h-4" />
                        </button>
                      ) : (
                        <span className="text-xs text-slate-300">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* Drawer & Dialogs */}
      {drawerMember && (
        <UserDetailDrawer
          member={drawerMember}
          orgId={activeOrgId}
          isSuperAdmin={isSuperAdmin}
          onClose={() => setDrawerMember(null)}
        />
      )}
      <InviteDialog open={showInvite} onClose={() => setShowInvite(false)} orgId={activeOrgId} />
      <CSVUploadDialog open={showCSV} onClose={() => setShowCSV(false)} orgId={activeOrgId} />
      {showBulkUpdate && (
        <BulkUpdateDialog
          open={showBulkUpdate}
          onClose={() => { setShowBulkUpdate(false); setSelectedIds(new Set()); }}
          selectedMembers={selectedMembers}
          orgId={activeOrgId}
        />
      )}
    </div>
  );
}

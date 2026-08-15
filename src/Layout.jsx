import React, { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { redirectToLogin } from "@/services/auth";
import { useAuth } from "@/lib/AuthContext";
import { filterNavForAllowedPages, filterNavForRole, LAYOUT_EXEMPT_PAGES, isSuperAdmin } from "@/lib/rbac";
import { useModuleAccess } from "@/lib/ModuleAccessContext";
import { filterNavForModules } from "@/lib/moduleConfig";
import {
  LayoutDashboard, Briefcase, Home, FileText,
  DollarSign, Calculator, TrendingUp, ClipboardCheck, BarChart3,
  Bell, Shield, ChevronRight, LogOut, Menu, X,
  Users, Receipt, GitBranch, FolderOpen, Plug,
  Search, User, Layers, ArrowLeftRight, Sun, Moon
} from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import AssistantPanel from "@/assistant/AssistantPanel";
import ProFormaBrand from "@/components/ProFormaBrand";
import { useAssistantContext } from "@/assistant/useAssistantContext";

const navSections = [
  { label: "Dashboard", icon: LayoutDashboard, page: "Dashboard" },
  { label: "Portfolio", icon: Briefcase, page: "Portfolios" },
  {
    label: "Properties", icon: Home, children: [
      { label: "All Properties", page: "Properties" },
      { label: "Buildings", page: "Buildings" },
      { label: "Units", page: "Units" },
    ]
  },
  {
    label: "Tenants", icon: Users, children: [
      { label: "All Tenants", page: "Tenants" },
      { label: "Billing", page: "Billing" },
    ]
  },
  {
    label: "Leases", icon: FileText, children: [
      { label: "Upload Lease", page: "LeaseUpload" },
      { label: "Lease List", page: "Leases" },
      { label: "File Pipeline", page: "FileHistoryPage" },
      { label: "Rent Projection", page: "RentProjection" },
      { label: "Critical Dates", page: "CriticalDates" },
    ]
  },
  {
    label: "Expenses", icon: Receipt, children: [
      { label: "Expense Dashboard", page: "ExpenseDashboard" },
      { label: "Lease Expense Rules", page: "LeaseExpenseRules" },
      { label: "Actual Expenses", page: "Expenses" },
      { label: "Expense Classification (per-lease)", page: "LeaseExpenseClassification" },
      { label: "Expense Review", page: "ExpenseReview" },
      { label: "Expense Projection", page: "ExpenseProjection" },
      { label: "Vendors", page: "Vendors" },
    ]
  },
  {
    label: "CAM Engine", icon: Calculator, children: [
      { label: "Overview", page: "CAMDashboard" },
      { label: "Setup", page: "CAMSetup" },
      { label: "Runs", page: "CAMRun" },
      { label: "Budget Readiness", page: "BudgetReadiness" },
    ]
  },
  { label: "Revenue", icon: TrendingUp, page: "Revenue" },
  {
    label: "Budget Studio", icon: ClipboardCheck, children: [
      { label: "Budget Dashboard", page: "BudgetDashboard" },
      { label: "Create Budget", page: "CreateBudget" },
      { label: "Budget Review", page: "BudgetReview" },
    ]
  },
  {
    label: "Actuals & Variance", icon: Layers, children: [
      { label: "Overview", page: "ActualsVariance" },
      { label: "Actuals", page: "Actuals" },
      { label: "Variance", page: "Variance" },
    ]
  },
  { label: "YoY Comparison", icon: ArrowLeftRight, page: "Comparison" },
  { label: "Reconciliation", icon: DollarSign, page: "Reconciliation" },
  {
    label: "Analytics & Reports", icon: BarChart3, children: [
      { label: "Analytics Hub", page: "AnalyticsReports" },
      { label: "Portfolio Insights", page: "PortfolioInsights" },
      { label: "Analytics", page: "Analytics" },
      { label: "Reports & KPIs", page: "Reports" },
    ]
  },
  {
    label: "Workflows", icon: GitBranch, children: [
      { label: "Workflow Overview", page: "Workflows" },
      { label: "Automation & Exceptions", page: "AutomationReadiness" },
      { label: "Approval Inbox", page: "Approvals" },
    ]
  },
  { label: "Notifications", icon: Bell, page: "Notifications" },
  { label: "Documents", icon: FolderOpen, page: "Documents" },
  { label: "Integrations", icon: Plug, page: "Integrations" },
  {
    label: "Settings", icon: Shield, children: [
      { label: "Team Management", page: "UserManagement" },
      { label: "Org Settings", page: "OrgSettings" },
      { label: "Chart of Accounts", page: "ChartOfAccounts" },
      { label: "Field Mapping Rules", page: "FieldMappingRules" },
      { label: "Approval Workflows", page: "ApprovalWorkflows" },
      { label: "Approval Policies", page: "ApprovalPolicies" },
      { label: "Approval Inbox", page: "Approvals" },
      { label: "Audit Log", page: "AuditLog" },
    ]
  },
  {
    label: "Platform", icon: Layers, children: [
      { label: "Organizations", page: "SuperAdmin" },
      { label: "Stakeholders", page: "Stakeholders" },
    ]
  },
];

function buildPageLabelMap(items, map = {}) {
  items.forEach((item) => {
    if (item.page) {
      map[item.page] = item.label;
    }
    if (item.children) {
      buildPageLabelMap(item.children, map);
    }
  });
  return map;
}

const PAGE_LABELS = buildPageLabelMap(navSections);
const SIDEBAR_MIN_WIDTH = 236;
const SIDEBAR_MAX_WIDTH = 360;
const SIDEBAR_COLLAPSED_WIDTH = 78;

function formatUserLabel(value, fallback = "User") {
  const raw = String(value || fallback).replace(/_/g, " ").trim();
  return raw.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function NavItem({ item, currentPageName, collapsed, onNavigate }) {
  const [open, setOpen] = useState(false);
  const isActive = item.page === currentPageName || item.children?.some(c => c.page === currentPageName);

  useEffect(() => {
    if (isActive && item.children) setOpen(true);
  }, [isActive]);

  if (item.children) {
    return (
      <div>
        <button
          onClick={() => setOpen(!open)}
          className={`cre-nav-item cre-nav-trigger text-sm font-medium ${isActive ? 'cre-nav-item-active' : ''}`}
          aria-expanded={open}
        >
          <item.icon className="w-5 h-5 flex-shrink-0" />
          {!collapsed && (
            <>
              <span className="cre-nav-label flex-1 text-left">{item.label}</span>
              <ChevronRight className={`cre-nav-chevron w-3.5 h-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
            </>
          )}
        </button>
        {open && !collapsed && (
          <div className="cre-nav-children ml-8 mt-1 space-y-0.5">
            {item.children.map(child => (
              <Link
                key={child.page}
                to={createPageUrl(child.page)}
                onClick={onNavigate}
                className={`block rounded-md px-3 py-1.5 text-[13px] transition-colors ${child.page === currentPageName ? 'bg-white/10 text-white' : 'text-white/55 hover:bg-white/5 hover:text-white'}`}
              >
                {child.label}
              </Link>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <Link
      to={createPageUrl(item.page)}
      onClick={onNavigate}
      className={`cre-nav-item cre-nav-trigger text-sm font-medium ${isActive ? 'cre-nav-item-active' : ''}`}
    >
      <item.icon className="w-5 h-5 flex-shrink-0" />
      {!collapsed && <span className="cre-nav-label">{item.label}</span>}
    </Link>
  );
}

export default function Layout({ children, currentPageName }) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(263);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [theme, setTheme] = useState(() => {
    if (typeof window === "undefined") return "light";
    return window.localStorage.getItem("cre-theme") || "light";
  });
  const { user, logout: authContextLogout } = useAuth();
  const { enabledModules, pageAccess } = useModuleAccess();
  const { isOpen: assistantOpen } = useAssistantContext();
  const allowedPageNames = Object.keys(pageAccess || {}).filter(Boolean);
  const baseNav = allowedPageNames.length > 0
    ? filterNavForAllowedPages(navSections, allowedPageNames, user)
    : filterNavForRole(navSections, user?.role, user);
  const visibleNav = filterNavForModules(baseNav, enabledModules, user);
  const currentPageLabel = PAGE_LABELS[currentPageName] || currentPageName;
  const profileName = user?.full_name || user?.profile?.full_name || user?.email?.split("@")[0] || "User";
  const profileEmail = user?.email || "No email available";
  const profileRole = isSuperAdmin(user) ? "SuperAdmin" : formatUserLabel(user?.role || user?._raw_role);
  const profileOrg = user?.activeOrg?.name || user?.activeOrg?.company_name || user?.profile?.company_name || "No active organization";
  const profileStatus = formatUserLabel(user?.profile?.status || (user ? "active" : "signed_out"), "Active");

  // Handle unauthenticated state if on a protected page
  useEffect(() => {
    if (!user) {
      if (!LAYOUT_EXEMPT_PAGES.includes(currentPageName)) {
        redirectToLogin(window.location.href);
      }
    }
  }, [user, currentPageName]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.body.dataset.theme = theme;
    document.documentElement.classList.toggle("dark", theme === "dark");
    try {
      window.localStorage.setItem("cre-theme", theme);
    } catch {
      /* Preference persistence is best-effort only. */
    }
  }, [theme]);

  const handleSidebarResizeStart = (event) => {
    if (!sidebarOpen || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.preventDefault();

    const handlePointerMove = (moveEvent) => {
      const nextWidth = Math.min(
        SIDEBAR_MAX_WIDTH,
        Math.max(SIDEBAR_MIN_WIDTH, Math.round(moveEvent.clientX))
      );
      setSidebarWidth(nextWidth);
    };

    const handlePointerUp = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      document.body.classList.remove("cre-sidebar-resizing");
    };

    document.body.classList.add("cre-sidebar-resizing");
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
  };

  const shellStyle = {
    "--sidebar-width": `${sidebarOpen ? sidebarWidth : SIDEBAR_COLLAPSED_WIDTH}px`,
  };
  if (LAYOUT_EXEMPT_PAGES.includes(currentPageName)) {
    return <>{children}</>;
  }

  return (
    <div
      className={`cre-shell ${sidebarOpen ? '' : 'cre-shell-collapsed'} ${assistantOpen ? 'cre-shell-assistant-open' : ''}`}
      style={shellStyle}
    >
      {/* Sidebar */}
      <aside className="cre-sidebar hidden lg:flex">
        <div className="cre-brand">
          <ProFormaBrand className="cre-brand-lockup" compact={!sidebarOpen} />
          {sidebarOpen && (
            <span className="sr-only">ProForma OS. Budget. Forecast. Plan. Decide.</span>
          )}
        </div>

        <div className="cre-sidebar-scroll">
          <nav className="cre-nav space-y-0.5">
          {visibleNav.length > 0 ? (
            visibleNav.map((item, i) => (
              <NavItem key={i} item={item} currentPageName={currentPageName} collapsed={!sidebarOpen} />
            ))
          ) : (
            sidebarOpen && (
              <div className="rounded-xl border border-white/10 bg-white/5 p-3 text-xs text-white/60">
                No modules are enabled for this view yet. Ask an org admin to grant access or enable a module.
              </div>
            )
          )}
          </nav>
        </div>

        <div className="cre-sidebar-footer">
          <button
            type="button"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="cre-collapse-button mb-3"
            aria-label={sidebarOpen ? "Collapse navigation" : "Expand navigation"}
          >
            {sidebarOpen ? <><span aria-hidden="true">&lsaquo;</span> Collapse</> : <Menu className="mx-auto h-4 w-4" />}
          </button>
          <div className={`flex items-center gap-3 px-2 ${sidebarOpen ? '' : 'justify-center px-0'}`}>
            <div className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-full bg-[var(--accent)] text-xs font-bold text-white">
              <User className="h-4 w-4" />
            </div>
            {sidebarOpen && (
              <>
                <div className="cre-user-copy min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-white">{user?.full_name || "User"}</p>
                  <p className="truncate text-xs capitalize text-white/45">{isSuperAdmin(user) ? "SuperAdmin" : (user?.role || "User").replace("_", " ")}</p>
                </div>
                <button onClick={() => authContextLogout(true)} className="text-white/40 hover:text-white" title="Logout" aria-label="Logout">
                  <LogOut className="h-4 w-4" />
                </button>
              </>
            )}
          </div>
        </div>
        {sidebarOpen && (
          <button
            type="button"
            className="cre-sidebar-resizer"
            onPointerDown={handleSidebarResizeStart}
            aria-label="Resize sidebar"
            title="Drag to resize navigation"
          />
        )}
      </aside>

      {/* Mobile sidebar */}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/50" onClick={() => setMobileOpen(false)} />
          <aside className="cre-sidebar relative flex translate-x-0">
            <div className="cre-brand">
              <ProFormaBrand className="cre-brand-lockup" />
              <button onClick={() => setMobileOpen(false)} className="ml-auto text-white/60 hover:text-white" aria-label="Close navigation"><X className="w-5 h-5" /></button>
            </div>
            <div className="cre-sidebar-scroll">
              <nav className="cre-nav space-y-0.5">
              {visibleNav.map((item, i) => (
                <NavItem key={i} item={item} currentPageName={currentPageName} collapsed={false} onNavigate={() => setMobileOpen(false)} />
              ))}
              </nav>
            </div>
          </aside>
        </div>
      )}

      {/* Main content */}
      <div className="cre-content flex flex-col">
        <header className="cre-topbar flex-shrink-0">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <button onClick={() => setMobileOpen(true)} className="cre-top-action grid h-[38px] w-[38px] place-items-center lg:hidden" aria-label="Open navigation"><Menu className="w-5 h-5" /></button>
            <label className="cre-search-wrap hidden sm:block">
              <Search className="cre-search-icon" />
              <Input placeholder="Search..." className="cre-search-input shadow-none" />
              <span className="cre-search-shortcut">&#8984; K</span>
            </label>
            <div className="text-sm text-[var(--muted)] sm:hidden">
              <span className="font-semibold text-[var(--ink)]">{currentPageLabel}</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Link to={createPageUrl("Notifications")} className="cre-top-action relative grid h-[38px] w-[38px] place-items-center" aria-label="Notifications">
              <Bell className="w-5 h-5" />
              <span className="absolute right-1 top-1 h-2.5 w-2.5 rounded-full border-2 border-[var(--surface)] bg-[var(--danger)]" />
            </Link>
            <button
              type="button"
              className="cre-top-action cre-theme-toggle hidden md:inline-flex"
              onClick={() => setTheme((value) => value === "dark" ? "light" : "dark")}
              aria-label="Toggle theme"
              aria-pressed={theme === "dark"}
            >
              <Sun className="h-3.5 w-3.5" />
              <span className="cre-theme-track"><span className="cre-theme-thumb" /></span>
              <Moon className="h-3.5 w-3.5" />
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className="cre-top-action flex items-center gap-2 px-2 text-left" aria-label="Open user profile details">
                  <div className="grid h-8 w-8 place-items-center rounded-full bg-[var(--sidebar)] text-xs font-bold text-white">
                    <User className="w-4 h-4" />
                  </div>
                  <div className="hidden min-w-0 lg:block">
                    <p className="max-w-[150px] truncate text-xs font-semibold text-[var(--ink)]">{profileName}</p>
                    <p className="max-w-[150px] truncate text-[10px] text-[var(--muted)]">{profileRole}</p>
                  </div>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-80 p-0">
                <div className="border-b border-slate-200 px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div className="grid h-11 w-11 place-items-center rounded-full bg-[var(--sidebar)] text-white">
                      <User className="h-5 w-5" />
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-slate-950">{profileName}</p>
                      <p className="truncate text-xs text-slate-500">{profileEmail}</p>
                    </div>
                  </div>
                </div>
                <div className="space-y-2 px-4 py-3 text-xs">
                  <div className="flex items-start justify-between gap-4">
                    <span className="text-slate-500">Role</span>
                    <span className="text-right font-semibold text-slate-900">{profileRole}</span>
                  </div>
                  <div className="flex items-start justify-between gap-4">
                    <span className="text-slate-500">Organization</span>
                    <span className="max-w-[180px] text-right font-semibold text-slate-900">{profileOrg}</span>
                  </div>
                  <div className="flex items-start justify-between gap-4">
                    <span className="text-slate-500">Status</span>
                    <span className="font-semibold text-emerald-700">{profileStatus}</span>
                  </div>
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild className="cursor-pointer">
                  <Link to={createPageUrl("OrgSettings")}>Organization settings</Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild className="cursor-pointer">
                  <Link to={createPageUrl("UserManagement")}>Team management</Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="cursor-pointer text-red-600 focus:text-red-700" onSelect={() => authContextLogout(true)}>
                  <LogOut className="h-4 w-4" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        <main className="cre-main flex-1">{children}</main>
      </div>
      <AssistantPanel />
    </div>
  );
}

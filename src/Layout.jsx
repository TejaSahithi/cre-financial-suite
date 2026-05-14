import React, { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { redirectToLogin } from "@/services/auth";
import { useAuth } from "@/lib/AuthContext";
import { filterNavForAllowedPages, filterNavForRole, PUBLIC_PAGES } from "@/lib/rbac";
import { useModuleAccess } from "@/lib/ModuleAccessContext";
import { filterNavForModules } from "@/lib/moduleConfig";
import {
  Building2, LayoutDashboard, Briefcase, Home, FileText,
  DollarSign, Calculator, TrendingUp, ClipboardCheck, BarChart3,
  Bell, Shield, ChevronRight, LogOut, Menu, X,
  Users, Receipt, GitBranch, FolderOpen, Plug,
  Search, User, Layers, ArrowLeftRight
} from "lucide-react";
import { Input } from "@/components/ui/input";

const publicPages = PUBLIC_PAGES;

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
      { label: "Lease Review", page: "LeaseReview" },
      { label: "Rent Projection", page: "RentProjection" },
      { label: "Critical Dates", page: "CriticalDates" },
      { label: "Lease List", page: "Leases" },
    ]
  },
  {
    label: "Expenses", icon: Receipt, children: [
      { label: "Expense Dashboard", page: "Expenses" },
      { label: "Lease Expense Rules", page: "LeaseExpenseRules" },
      { label: "Actual Expenses", page: "Expenses" },
      { label: "Add Expense", page: "AddExpense" },
      { label: "Bulk Import", page: "BulkImport" },
      { label: "Expense Classification (per-lease)", page: "LeaseExpenseClassification" },
      { label: "Expense Review", page: "ExpenseReview" },
      { label: "Expense Projection", page: "ExpenseProjection" },
      { label: "Vendors", page: "Vendors" },
    ]
  },
  {
    label: "CAM Engine", icon: Calculator, children: [
      { label: "CAM Dashboard", page: "CAMDashboard" },
      { label: "CAM Setup", page: "CAMSetup" },
      { label: "CAM Calculation", page: "CAMCalculation" },
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
  { label: "Workflows", icon: GitBranch, page: "Workflows" },
  { label: "Notifications", icon: Bell, page: "Notifications" },
  { label: "Documents", icon: FolderOpen, page: "Documents" },
  { label: "Integrations", icon: Plug, page: "Integrations" },
  {
    label: "Settings", icon: Shield, children: [
      { label: "User Management", page: "UserManagement" },
      { label: "Org Settings", page: "OrgSettings" },
      { label: "Chart of Accounts", page: "ChartOfAccounts" },
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
          className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${isActive ? 'text-white bg-white/10' : 'text-white/60 hover:text-white hover:bg-white/5'}`}
        >
          <item.icon className="w-[18px] h-[18px] flex-shrink-0" />
          {!collapsed && (
            <>
              <span className="flex-1 text-left">{item.label}</span>
              <ChevronRight className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
            </>
          )}
        </button>
        {open && !collapsed && (
          <div className="ml-8 mt-1 space-y-0.5">
            {item.children.map(child => (
              <Link
                key={child.page}
                to={createPageUrl(child.page)}
                onClick={onNavigate}
                className={`block px-3 py-1.5 rounded-md text-[13px] transition-colors ${child.page === currentPageName ? 'text-white bg-white/10' : 'text-white/50 hover:text-white hover:bg-white/5'}`}
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
      className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${isActive ? 'text-white bg-white/10' : 'text-white/60 hover:text-white hover:bg-white/5'}`}
    >
      <item.icon className="w-[18px] h-[18px] flex-shrink-0" />
      {!collapsed && <span>{item.label}</span>}
    </Link>
  );
}

export default function Layout({ children, currentPageName }) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);
  const { user, logout: authContextLogout } = useAuth();
  const { enabledModules, pageAccess } = useModuleAccess();
  const allowedPageNames = Object.keys(pageAccess || {}).filter(Boolean);
  const baseNav = allowedPageNames.length > 0
    ? filterNavForAllowedPages(navSections, allowedPageNames)
    : filterNavForRole(navSections, user?.role);
  const visibleNav = filterNavForModules(baseNav, enabledModules);
  const currentPageLabel = PAGE_LABELS[currentPageName] || currentPageName;

  // Handle unauthenticated state if on a protected page
  useEffect(() => {
    if (!user) {
      if (!publicPages.includes(currentPageName)) {
        redirectToLogin(window.location.href);
      }
    }
  }, [user, currentPageName]);

  if (publicPages.includes(currentPageName) || currentPageName === "Onboarding" || currentPageName === "Landing") {
    return <>{children}</>;
  }

  return (
    <div className="flex h-screen bg-slate-50 overflow-hidden">
      {/* Sidebar */}
      <aside className={`hidden lg:flex flex-col bg-[#1a2744] transition-all duration-300 ${sidebarOpen ? 'w-[250px]' : 'w-[68px]'} flex-shrink-0`}>
        <div className="h-14 flex items-center gap-2.5 px-4 border-b border-white/10">
          <div className="w-8 h-8 bg-gradient-to-br from-blue-400 to-blue-600 rounded-lg flex items-center justify-center flex-shrink-0 shadow-md">
            <Building2 className="w-4.5 h-4.5 text-white" />
          </div>
          {sidebarOpen && (
            <div className="min-w-0">
              <div className="text-white font-bold text-sm leading-tight truncate">CRE PLATFORM</div>
              <div className="text-blue-300/50 text-[9px] font-semibold tracking-[0.1em]">BUDGETING & CAM</div>
            </div>
          )}
          <button onClick={() => setSidebarOpen(!sidebarOpen)} className="ml-auto text-white/40 hover:text-white transition-colors">
            {sidebarOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-3 space-y-0.5">
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

        {sidebarOpen && (
          <div className="p-3 border-t border-white/10">
            <div className="flex items-center gap-3 px-2">
              <div className="w-8 h-8 bg-blue-600 rounded-full flex items-center justify-center text-white text-xs font-bold">
                <User className="w-4 h-4" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-white text-sm font-medium truncate">{user?.full_name || "User"}</p>
                <p className="text-white/40 text-xs truncate capitalize">{user?.role === "admin" ? "SuperAdmin" : (user?.role || "User").replace("_", " ")}</p>
              </div>
              <button onClick={() => authContextLogout(true)} className="text-white/30 hover:text-white" title="Logout">
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </aside>

      {/* Mobile sidebar */}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/50" onClick={() => setMobileOpen(false)} />
          <aside className="relative w-[250px] h-full bg-[#1a2744] flex flex-col">
            <div className="h-14 flex items-center gap-2.5 px-4 border-b border-white/10">
              <Building2 className="w-5 h-5 text-white" />
              <span className="text-white font-bold text-sm">CRE PLATFORM</span>
              <button onClick={() => setMobileOpen(false)} className="ml-auto text-white/40"><X className="w-5 h-5" /></button>
            </div>
            <nav className="flex-1 overflow-y-auto px-3 py-3 space-y-0.5">
              {visibleNav.map((item, i) => (
                <NavItem key={i} item={item} currentPageName={currentPageName} collapsed={false} onNavigate={() => setMobileOpen(false)} />
              ))}
            </nav>
          </aside>
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="h-14 bg-white border-b border-slate-200 flex items-center justify-between px-6 flex-shrink-0">
          <div className="flex items-center gap-4">
            <button onClick={() => setMobileOpen(true)} className="lg:hidden text-slate-600"><Menu className="w-5 h-5" /></button>
            <div className="text-sm text-slate-500">
              <span className="font-semibold text-slate-700">{currentPageLabel}</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="relative hidden md:block">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <Input placeholder="Search..." className="pl-9 w-56 h-9 bg-slate-50 border-slate-200 text-sm" />
            </div>
            <Link to={createPageUrl("Notifications")} className="relative p-2 hover:bg-slate-100 rounded-lg">
              <Bell className="w-5 h-5 text-slate-500" />
              <span className="absolute top-1 right-1 w-2.5 h-2.5 bg-red-500 rounded-full border-2 border-white" />
            </Link>
            <div className="w-8 h-8 bg-blue-600 rounded-full flex items-center justify-center text-white text-xs font-bold">
              <User className="w-4 h-4" />
            </div>
          </div>
        </header>
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}

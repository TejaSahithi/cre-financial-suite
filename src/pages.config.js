/**
 * pages.config.js - Page routing configuration
 * 
 * This file is AUTO-GENERATED. Do not add imports or modify PAGES manually.
 * Pages are auto-registered when you create files in the ./pages/ folder.
 * 
 * THE ONLY EDITABLE VALUE: mainPage
 * This controls which page is the landing page (shown when users visit the app).
 * 
 * Example file structure:
 * 
 *   import HomePage from './pages/HomePage';
 *   import Dashboard from './pages/Dashboard';
 *   import Settings from './pages/Settings';
 *   
 *   export const PAGES = {
 *       "HomePage": HomePage,
 *       "Dashboard": Dashboard,
 *       "Settings": Settings,
 *   }
 *   
 *   export const pagesConfig = {
 *       mainPage: "HomePage",
 *       Pages: PAGES,
 *   };
 * 
 * Example with Layout (wraps all pages):
 *
 *   import Home from './pages/Home';
 *   import Settings from './pages/Settings';
 *   import __Layout from './Layout.jsx';
 *
 *   export const PAGES = {
 *       "Home": Home,
 *       "Settings": Settings,
 *   }
 *
 *   export const pagesConfig = {
 *       mainPage: "Home",
 *       Pages: PAGES,
 *       Layout: __Layout,
 *   };
 *
 * To change the main page from HomePage to Dashboard, use find_replace:
 *   Old: mainPage: "HomePage",
 *   New: mainPage: "Dashboard",
 *
 * The mainPage value must match a key in the PAGES object exactly.
 */
import AcceptInvite from './pages/AcceptInvite';
import AwaitingRole from './pages/AwaitingRole';
import AddExpense from './pages/AddExpense';
import AuditLog from './pages/AuditLog';
import ApprovalWorkflows from './pages/ApprovalWorkflows';
import FieldMappingRules from './pages/FieldMappingRules';
import BudgetDashboard from './pages/BudgetDashboard';
import BudgetReview from './pages/BudgetReview';
import Buildings from './pages/Buildings';
import BuildingsUnits from './pages/BuildingsUnits';
import BulkImport from './pages/BulkImport';
import CAMCalculation from './pages/CAMCalculation';
import CAMDashboard from './pages/CAMDashboard';
import CAMSetup from './pages/CAMSetup';
import ContactUs from './pages/ContactUs';
import CreateBudget from './pages/CreateBudget';
import Dashboard from './pages/Dashboard';
import Expenses from './pages/Expenses';
import ExpenseReview from './pages/ExpenseReview';
import Landing from './pages/Landing';
import LeaseReview from './pages/LeaseReview';
import LeaseUpload from './pages/LeaseUpload';
import Leases from './pages/Leases';
import LeaseDetail from './pages/LeaseDetail';
import CriticalDates from './pages/CriticalDates';
import Notifications from './pages/Notifications';
import Onboarding from './pages/Onboarding';
import OrgSettings from './pages/OrgSettings';
import PendingApproval from './pages/PendingApproval';
import Portfolios from './pages/Portfolios';
import Properties from './pages/Properties';
import PropertyDetail from './pages/PropertyDetail';
import Reconciliation from './pages/Reconciliation';
import RentProjection from './pages/RentProjection';
import Reports from './pages/Reports';
import AnalyticsReports from './pages/AnalyticsReports';
import ActualsVariance from './pages/ActualsVariance';
import Stakeholders from './pages/Stakeholders';
import SuperAdmin from './pages/SuperAdmin';
import ExpenseProjection from './pages/ExpenseProjection';
import Tenants from './pages/Tenants';
import TenantDetail from './pages/TenantDetail';
import Units from './pages/Units';
import Revenue from './pages/Revenue';
import Actuals from './pages/Actuals';
import Variance from './pages/Variance';
import Analytics from './pages/Analytics';
import Workflows from './pages/Workflows';
import Documents from './pages/Documents';
import Integrations from './pages/Integrations';
import Pricing from './pages/Pricing';
import Comparison from './pages/Comparison';
import ChartOfAccounts from './pages/ChartOfAccounts';
import Billing from './pages/Billing';
import Vendors from './pages/Vendors';
import VendorProfile from './pages/VendorProfile';
import PortfolioInsights from './pages/PortfolioInsights';
import RequestAccess from './pages/RequestAccess';
import Login from './pages/Login';
import Welcome from './pages/Welcome';
import WelcomeAboard from './pages/WelcomeAboard';
import UserManagement from './pages/UserManagement';
import DemoExperience from './pages/DemoExperience';
import RequestDemo from './pages/RequestDemo';
import PaymentSuccess from './pages/PaymentSuccess';
import FileHistoryPage from './pages/FileHistoryPage';
import PipelineUpload from './pages/PipelineUpload';
import LeaseExpenseClassification from './pages/LeaseExpenseClassification';
import LeaseExpenseRules from './pages/LeaseExpenseRules';

import __Layout from './Layout.jsx';


export const PAGES = {
    "AcceptInvite": AcceptInvite,
    "AwaitingRole": AwaitingRole,
    "AddExpense": AddExpense,
    "AuditLog": AuditLog,
    "ApprovalWorkflows": ApprovalWorkflows,
    "FieldMappingRules": FieldMappingRules,
    "BudgetDashboard": BudgetDashboard,
    "BudgetReview": BudgetReview,
    "Buildings": Buildings,
    "BuildingsUnits": BuildingsUnits,
    "BulkImport": BulkImport,
    "CAMCalculation": CAMCalculation,
    "CAMDashboard": CAMDashboard,
    "CAMSetup": CAMSetup,
    "ContactUs": ContactUs,
    "CreateBudget": CreateBudget,
    "Dashboard": Dashboard,
    "Expenses": Expenses,
    "ExpenseReview": ExpenseReview,
    "Landing": Landing,
    "LeaseReview": LeaseReview,
    "LeaseUpload": LeaseUpload,
    "Leases": Leases,
    "LeaseDetail": LeaseDetail,
    "CriticalDates": CriticalDates,
    "Notifications": Notifications,
    "Onboarding": Onboarding,
    "OrgSettings": OrgSettings,
    "PendingApproval": PendingApproval,
    "Portfolios": Portfolios,
    "Properties": Properties,
    "PropertyDetail": PropertyDetail,
    "Reconciliation": Reconciliation,
    "RentProjection": RentProjection,
    "Reports": Reports,
    "Stakeholders": Stakeholders,
    "SuperAdmin": SuperAdmin,
    "ExpenseProjection": ExpenseProjection,
    "Tenants": Tenants,
    "TenantDetail": TenantDetail,
    "Units": Units,
    "Revenue": Revenue,
    "Actuals": Actuals,
    "Variance": Variance,
    "Analytics": Analytics,
    "Workflows": Workflows,
    "Documents": Documents,
    "Integrations": Integrations,
    "Pricing": Pricing,
    "Comparison": Comparison,
    "ChartOfAccounts": ChartOfAccounts,
    "Billing": Billing,
    "Vendors": Vendors,
    "VendorProfile": VendorProfile,
    "PortfolioInsights": PortfolioInsights,
    "AnalyticsReports": AnalyticsReports,
    "ActualsVariance": ActualsVariance,
    "RequestAccess": RequestAccess,
    "Login": Login,
    "Welcome": Welcome,
    "WelcomeAboard": WelcomeAboard,
    "UserManagement": UserManagement,
    "DemoExperience": DemoExperience,
    "RequestDemo": RequestDemo,
    "PaymentSuccess": PaymentSuccess,
    "FileHistoryPage": FileHistoryPage,
    "PipelineUpload": PipelineUpload,
    "LeaseExpenseClassification": LeaseExpenseClassification,
    "LeaseExpenseRules": LeaseExpenseRules,
}

export const pagesConfig = {
    mainPage: "Landing",
    Pages: PAGES,
    Layout: __Layout,
};

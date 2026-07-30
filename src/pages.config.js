/**
 * pages.config.js - Page routing configuration
 * 
 * This file is AUTO-GENERATED. Do not modify PAGES manually.
 * Pages are auto-registered when you create files in the ./pages/ folder.
 * 
 * THE ONLY EDITABLE VALUE: mainPage
 * This controls which page is the landing page (shown when users visit the app).
 * 
 * Example file structure:
 * 
 *   const HomePage = lazy(() => import('./pages/HomePage'));
 *   const Dashboard = lazy(() => import('./pages/Dashboard'));
 *   const Settings = lazy(() => import('./pages/Settings'));
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
import { lazy } from 'react';

import __Layout from './Layout.jsx';

const AcceptInvite = lazy(() => import('./pages/AcceptInvite'));
const AddExpense = lazy(() => import('./pages/AddExpense'));
const AuditLog = lazy(() => import('./pages/AuditLog'));
const ApprovalWorkflows = lazy(() => import('./pages/ApprovalWorkflows'));
const FieldMappingRules = lazy(() => import('./pages/FieldMappingRules'));
const BudgetDashboard = lazy(() => import('./pages/BudgetDashboard'));
const BudgetReview = lazy(() => import('./pages/BudgetReview'));
const Buildings = lazy(() => import('./pages/Buildings'));
const BuildingsUnits = lazy(() => import('./pages/BuildingsUnits'));
const BulkImport = lazy(() => import('./pages/BulkImport'));
const CAMCalculation = lazy(() => import('./pages/CAMCalculation'));
const CAMDashboard = lazy(() => import('./pages/CAMDashboard'));
const CAMSetup = lazy(() => import('./pages/CAMSetup'));
const ContactUs = lazy(() => import('./pages/ContactUs'));
const CreateBudget = lazy(() => import('./pages/CreateBudget'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const ExpenseDashboard = lazy(() => import('./pages/ExpenseDashboard'));
const Expenses = lazy(() => import('./pages/Expenses'));
const ExpenseReview = lazy(() => import('./pages/ExpenseReview'));
const Landing = lazy(() => import('./pages/Landing'));
const LeaseReview = lazy(() => import('./pages/LeaseReview'));
const LeaseUpload = lazy(() => import('./pages/LeaseUpload'));
const Leases = lazy(() => import('./pages/Leases'));
const LeaseDetail = lazy(() => import('./pages/LeaseDetail'));
const LeaseRentSchedule = lazy(() => import('./pages/LeaseRentSchedule'));
const CriticalDates = lazy(() => import('./pages/CriticalDates'));
const Notifications = lazy(() => import('./pages/Notifications'));
const Onboarding = lazy(() => import('./pages/Onboarding'));
const OrgSettings = lazy(() => import('./pages/OrgSettings'));
const PendingApproval = lazy(() => import('./pages/PendingApproval'));
const Portfolios = lazy(() => import('./pages/Portfolios'));
const Properties = lazy(() => import('./pages/Properties'));
const PropertyDetail = lazy(() => import('./pages/PropertyDetail'));
const Reconciliation = lazy(() => import('./pages/Reconciliation'));
const RentProjection = lazy(() => import('./pages/RentProjection'));
const Reports = lazy(() => import('./pages/Reports'));
const AnalyticsReports = lazy(() => import('./pages/AnalyticsReports'));
const ActualsVariance = lazy(() => import('./pages/ActualsVariance'));
const Stakeholders = lazy(() => import('./pages/Stakeholders'));
const SuperAdmin = lazy(() => import('./pages/SuperAdmin'));
const ExpenseProjection = lazy(() => import('./pages/ExpenseProjection'));
const Tenants = lazy(() => import('./pages/Tenants'));
const TenantDetail = lazy(() => import('./pages/TenantDetail'));
const Units = lazy(() => import('./pages/Units'));
const Revenue = lazy(() => import('./pages/Revenue'));
const Actuals = lazy(() => import('./pages/Actuals'));
const Variance = lazy(() => import('./pages/Variance'));
const Analytics = lazy(() => import('./pages/Analytics'));
const Workflows = lazy(() => import('./pages/Workflows'));
const Documents = lazy(() => import('./pages/Documents'));
const Integrations = lazy(() => import('./pages/Integrations'));
const Pricing = lazy(() => import('./pages/Pricing'));
const Comparison = lazy(() => import('./pages/Comparison'));
const ChartOfAccounts = lazy(() => import('./pages/ChartOfAccounts'));
const Billing = lazy(() => import('./pages/Billing'));
const Vendors = lazy(() => import('./pages/Vendors'));
const VendorProfile = lazy(() => import('./pages/VendorProfile'));
const PortfolioInsights = lazy(() => import('./pages/PortfolioInsights'));
const RequestAccess = lazy(() => import('./pages/RequestAccess'));
const Login = lazy(() => import('./pages/Login'));
const Welcome = lazy(() => import('./pages/Welcome'));
const WelcomeAboard = lazy(() => import('./pages/WelcomeAboard'));
const UserManagement = lazy(() => import('./pages/UserManagement'));
const DemoExperience = lazy(() => import('./pages/DemoExperience'));
const RequestDemo = lazy(() => import('./pages/RequestDemo'));
const PaymentSuccess = lazy(() => import('./pages/PaymentSuccess'));
const FileHistoryPage = lazy(() => import('./pages/FileHistoryPage'));
const PipelineUpload = lazy(() => import('./pages/PipelineUpload'));
const LeaseExpenseClassification = lazy(() => import('./pages/LeaseExpenseClassification'));
const LeaseExpenseRules = lazy(() => import('./pages/LeaseExpenseRules'));
const ResetPassword = lazy(() => import('./pages/ResetPassword'));
const SecurityQuestionsSetup = lazy(() => import('./pages/SecurityQuestionsSetup'));


export const PAGES = {
    "AcceptInvite": AcceptInvite,
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
    "ExpenseDashboard": ExpenseDashboard,
    "Expenses": Expenses,
    "ExpenseReview": ExpenseReview,
    "Landing": Landing,
    "LeaseReview": LeaseReview,
    "LeaseUpload": LeaseUpload,
    "Leases": Leases,
    "LeaseDetail": LeaseDetail,
    "LeaseRentSchedule": LeaseRentSchedule,
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
    "ResetPassword": ResetPassword,
    "SecurityQuestionsSetup": SecurityQuestionsSetup,
}

export const pagesConfig = {
    mainPage: "Landing",
    Pages: PAGES,
    Layout: __Layout,
};

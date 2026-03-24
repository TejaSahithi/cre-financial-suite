/**
 * Seed Data — Realistic CRE demo data for DEV_MODE
 *
 * Auto-loaded into the in-memory store when Supabase isn't configured,
 * so every page has content to display.
 *
 * All records share org_id: "demo-org" to match the DEV_MODE user.
 */

const ORG = "demo-org";
let _id = 100;
const id = () => `demo-${++_id}`;

// ─── Properties ────────────────────────────────────────
const p1 = id(), p2 = id(), p3 = id(), p4 = id(), p5 = id();

export const SEED_PROPERTIES = [
  { id: p1, org_id: ORG, name: "Camelback Commerce Center", address: "2801 E Camelback Rd", city: "Phoenix", state: "AZ", zip: "85016", property_type: "office", structure_type: "multi", total_sf: 285000, leased_sf: 256500, total_buildings: 3, total_units: 24, occupancy_pct: 90, status: "active", property_id_code: "MCG-AZ-001", address_verified: true },
  { id: p2, org_id: ORG, name: "Scottsdale Retail Plaza", address: "7014 E Camelback Rd", city: "Scottsdale", state: "AZ", zip: "85251", property_type: "retail", structure_type: "multi", total_sf: 142000, leased_sf: 127800, total_buildings: 2, total_units: 16, occupancy_pct: 90, status: "active", property_id_code: "MCG-AZ-002", address_verified: true },
  { id: p3, org_id: ORG, name: "Tempe Industrial Park", address: "1850 W University Dr", city: "Tempe", state: "AZ", zip: "85281", property_type: "industrial", structure_type: "single", total_sf: 175000, leased_sf: 175000, total_buildings: 1, total_units: 4, occupancy_pct: 100, status: "active", property_id_code: "MCG-AZ-003", address_verified: true },
  { id: p4, org_id: ORG, name: "Chandler Business Tower", address: "3100 W Ray Rd", city: "Chandler", state: "AZ", zip: "85226", property_type: "office", structure_type: "single", total_sf: 95000, leased_sf: 76000, total_buildings: 1, total_units: 12, occupancy_pct: 80, status: "active", property_id_code: "MCG-AZ-004", address_verified: false },
  { id: p5, org_id: ORG, name: "Mesa Mixed-Use Center", address: "456 W Main St", city: "Mesa", state: "AZ", zip: "85201", property_type: "mixed_use", structure_type: "multi", total_sf: 210000, leased_sf: 168000, total_buildings: 2, total_units: 20, occupancy_pct: 80, status: "active", property_id_code: "MCG-AZ-005", address_verified: true },
];

// ─── Tenants ───────────────────────────────────────────
const t1 = id(), t2 = id(), t3 = id(), t4 = id(), t5 = id();

export const SEED_TENANTS = [
  { id: t1, org_id: ORG, name: "TechVista Solutions", contact_email: "leasing@techvista.com", contact_phone: "480-555-0101", industry: "Technology", status: "active", credit_score: 780 },
  { id: t2, org_id: ORG, name: "Summit Legal Group", contact_email: "admin@summitlegal.com", contact_phone: "480-555-0202", industry: "Legal", status: "active", credit_score: 720 },
  { id: t3, org_id: ORG, name: "CoreFit Athletics", contact_email: "ops@corefit.com", contact_phone: "602-555-0303", industry: "Retail / Fitness", status: "active", credit_score: 690 },
  { id: t4, org_id: ORG, name: "Pacific Freight Logistics", contact_email: "accounts@pacificfreight.com", contact_phone: "480-555-0404", industry: "Logistics", status: "active", credit_score: 740 },
  { id: t5, org_id: ORG, name: "Meridian Café & Bakery", contact_email: "hello@meridiancafe.com", contact_phone: "602-555-0505", industry: "Food & Beverage", status: "active", credit_score: 650 },
];

// ─── Leases ────────────────────────────────────────────
export const SEED_LEASES = [
  { id: id(), org_id: ORG, property_id: p1, tenant_id: t1, tenant_name: "TechVista Solutions", unit: "Suite 200", lease_type: "NNN", status: "active", start_date: "2024-01-01", end_date: "2028-12-31", base_rent: 18500, annual_rent: 222000, rent_per_sf: 28, leased_sf: 7900, escalation_rate: 3, security_deposit: 37000 },
  { id: id(), org_id: ORG, property_id: p1, tenant_id: t2, tenant_name: "Summit Legal Group", unit: "Suite 400", lease_type: "Full Service", status: "active", start_date: "2023-06-01", end_date: "2028-05-31", base_rent: 22000, annual_rent: 264000, rent_per_sf: 32, leased_sf: 8250, escalation_rate: 2.5, security_deposit: 44000 },
  { id: id(), org_id: ORG, property_id: p2, tenant_id: t3, tenant_name: "CoreFit Athletics", unit: "Unit A", lease_type: "NNN", status: "active", start_date: "2024-03-01", end_date: "2029-02-28", base_rent: 12000, annual_rent: 144000, rent_per_sf: 22, leased_sf: 6500, escalation_rate: 3, security_deposit: 24000 },
  { id: id(), org_id: ORG, property_id: p2, tenant_id: t5, tenant_name: "Meridian Café & Bakery", unit: "Unit C", lease_type: "Modified Gross", status: "active", start_date: "2024-06-01", end_date: "2027-05-31", base_rent: 8500, annual_rent: 102000, rent_per_sf: 34, leased_sf: 3000, escalation_rate: 2, security_deposit: 17000 },
  { id: id(), org_id: ORG, property_id: p3, tenant_id: t4, tenant_name: "Pacific Freight Logistics", unit: "Warehouse A", lease_type: "NNN", status: "active", start_date: "2023-01-01", end_date: "2032-12-31", base_rent: 35000, annual_rent: 420000, rent_per_sf: 12, leased_sf: 35000, escalation_rate: 2.5, security_deposit: 70000 },
  { id: id(), org_id: ORG, property_id: p4, tenant_id: t1, tenant_name: "TechVista Solutions", unit: "Floor 3", lease_type: "NNN", status: "active", start_date: "2025-01-01", end_date: "2029-12-31", base_rent: 14000, annual_rent: 168000, rent_per_sf: 26, leased_sf: 6500, escalation_rate: 3, security_deposit: 28000 },
  { id: id(), org_id: ORG, property_id: p5, tenant_id: t2, tenant_name: "Summit Legal Group", unit: "Suite 100", lease_type: "Full Service", status: "active", start_date: "2024-09-01", end_date: "2029-08-31", base_rent: 16500, annual_rent: 198000, rent_per_sf: 30, leased_sf: 6600, escalation_rate: 2.5, security_deposit: 33000 },
  { id: id(), org_id: ORG, property_id: p1, tenant_id: t3, tenant_name: "CoreFit Athletics", unit: "Suite 105", lease_type: "Modified Gross", status: "expired", start_date: "2021-01-01", end_date: "2024-12-31", base_rent: 9000, annual_rent: 108000, rent_per_sf: 24, leased_sf: 4500, escalation_rate: 2, security_deposit: 18000 },
];

// ─── Expenses ──────────────────────────────────────────
export const SEED_EXPENSES = [
  { id: id(), org_id: ORG, property_id: p1, category: "utilities", description: "Electric — Q1 2025", amount: 42000, date: "2025-01-15", month: 1, classification: "recoverable", vendor: "APS Electric", status: "approved" },
  { id: id(), org_id: ORG, property_id: p1, category: "maintenance", description: "HVAC Preventive Maintenance", amount: 18500, date: "2025-02-01", month: 2, classification: "recoverable", vendor: "CoolAir Mechanical", status: "approved" },
  { id: id(), org_id: ORG, property_id: p1, category: "insurance", description: "Property Insurance Annual Premium", amount: 67000, date: "2025-01-01", month: 1, classification: "non_recoverable", vendor: "National Property Insurance", status: "approved" },
  { id: id(), org_id: ORG, property_id: p2, category: "property_tax", description: "2025 Property Tax — H1", amount: 89000, date: "2025-01-10", month: 1, classification: "recoverable", vendor: "Maricopa County", status: "approved" },
  { id: id(), org_id: ORG, property_id: p2, category: "utilities", description: "Water & Sewer — Q1", amount: 12500, date: "2025-01-20", month: 1, classification: "recoverable", vendor: "City of Scottsdale", status: "approved" },
  { id: id(), org_id: ORG, property_id: p2, category: "janitorial", description: "Common Area Cleaning", amount: 8400, date: "2025-02-01", month: 2, classification: "recoverable", vendor: "CleanPro Services", status: "approved" },
  { id: id(), org_id: ORG, property_id: p3, category: "maintenance", description: "Loading Dock Repair", amount: 14200, date: "2025-01-25", month: 1, classification: "non_recoverable", vendor: "Industrial Repairs Inc", status: "approved" },
  { id: id(), org_id: ORG, property_id: p3, category: "utilities", description: "Electric — Q1 2025", amount: 28000, date: "2025-02-15", month: 2, classification: "recoverable", vendor: "SRP Energy", status: "pending" },
  { id: id(), org_id: ORG, property_id: p4, category: "security", description: "Security System Upgrade", amount: 22000, date: "2025-03-01", month: 3, classification: "non_recoverable", vendor: "SecureTech AZ", status: "approved" },
  { id: id(), org_id: ORG, property_id: p4, category: "landscaping", description: "Grounds Maintenance — Q1", amount: 6800, date: "2025-01-05", month: 1, classification: "recoverable", vendor: "Desert Green Landscaping", status: "approved" },
  { id: id(), org_id: ORG, property_id: p5, category: "utilities", description: "Electric — Jan 2025", amount: 19500, date: "2025-01-31", month: 1, classification: "recoverable", vendor: "SRP Energy", status: "approved" },
  { id: id(), org_id: ORG, property_id: p5, category: "property_tax", description: "2025 Property Tax — H1", amount: 52000, date: "2025-01-10", month: 1, classification: "recoverable", vendor: "Maricopa County", status: "approved" },
  { id: id(), org_id: ORG, property_id: p1, category: "management_fee", description: "Property Management Fee — Jan", amount: 15000, date: "2025-01-31", month: 1, classification: "non_recoverable", vendor: "Meridian Capital Group", status: "approved" },
  { id: id(), org_id: ORG, property_id: p5, category: "maintenance", description: "Elevator Service Contract", amount: 11000, date: "2025-02-01", month: 2, classification: "recoverable", vendor: "Otis Elevator", status: "pending" },
  { id: id(), org_id: ORG, property_id: p1, category: "legal", description: "Lease Review — Legal Counsel", amount: 7500, date: "2025-03-10", month: 3, classification: "non_recoverable", vendor: "Baker & Associates", status: "approved" },
];

// ─── Vendors ───────────────────────────────────────────
export const SEED_VENDORS = [
  { id: id(), org_id: ORG, name: "CoolAir Mechanical", contact_name: "Mike Reynolds", email: "mike@coolair.com", phone: "480-555-1001", category: "HVAC & Mechanical", status: "active", rating: 4.5 },
  { id: id(), org_id: ORG, name: "CleanPro Services", contact_name: "Sarah Chen", email: "sarah@cleanpro.com", phone: "602-555-1002", category: "Janitorial", status: "active", rating: 4.2 },
  { id: id(), org_id: ORG, name: "Desert Green Landscaping", contact_name: "Carlos Mendez", email: "carlos@desertgreen.com", phone: "480-555-1003", category: "Landscaping", status: "active", rating: 4.0 },
  { id: id(), org_id: ORG, name: "SecureTech AZ", contact_name: "David Park", email: "david@securetech.com", phone: "602-555-1004", category: "Security", status: "active", rating: 4.7 },
];

// ─── Budgets ───────────────────────────────────────────
export const SEED_BUDGETS = [
  { id: id(), org_id: ORG, property_id: p1, name: "Camelback 2025 OpEx Budget", fiscal_year: 2025, total_expenses: 520000, status: "approved", created_at: "2024-11-01" },
  { id: id(), org_id: ORG, property_id: p2, name: "Scottsdale Plaza 2025 Budget", fiscal_year: 2025, total_expenses: 310000, status: "approved", created_at: "2024-11-15" },
  { id: id(), org_id: ORG, property_id: p3, name: "Tempe Industrial 2025 Budget", fiscal_year: 2025, total_expenses: 180000, status: "draft", created_at: "2025-01-10" },
];

// ─── CAM Calculations ──────────────────────────────────
export const SEED_CAM_CALCULATIONS = [
  { id: id(), org_id: ORG, property_id: p1, year: 2025, annual_cam: 185000, cam_per_sf: 6.49, method: "pro_rata", status: "active" },
  { id: id(), org_id: ORG, property_id: p2, year: 2025, annual_cam: 98000, cam_per_sf: 6.90, method: "pro_rata", status: "active" },
  { id: id(), org_id: ORG, property_id: p5, year: 2025, annual_cam: 72000, cam_per_sf: 4.29, method: "fixed", status: "draft" },
];

// ─── Portfolios ────────────────────────────────────────
export const SEED_PORTFOLIOS = [
  { id: id(), org_id: ORG, name: "Arizona Core Portfolio", description: "Primary AZ metro properties", property_ids: [p1, p2, p4] },
  { id: id(), org_id: ORG, name: "Industrial Holdings", description: "Industrial and logistics assets", property_ids: [p3] },
];

// ─── Buildings ─────────────────────────────────────────
export const SEED_BUILDINGS = [
  { id: id(), org_id: ORG, property_id: p1, name: "Building A", total_sf: 100000, floors: 4 },
  { id: id(), org_id: ORG, property_id: p1, name: "Building B", total_sf: 95000, floors: 3 },
  { id: id(), org_id: ORG, property_id: p1, name: "Building C", total_sf: 90000, floors: 3 },
  { id: id(), org_id: ORG, property_id: p2, name: "North Wing", total_sf: 82000, floors: 2 },
  { id: id(), org_id: ORG, property_id: p2, name: "South Wing", total_sf: 60000, floors: 1 },
];

// ─── Units ─────────────────────────────────────────────
export const SEED_UNITS = [
  { id: id(), org_id: ORG, property_id: p1, building_id: null, unit_number: "Suite 200", floor: 2, square_footage: 7900, status: "occupied", tenant_id: t1 },
  { id: id(), org_id: ORG, property_id: p1, building_id: null, unit_number: "Suite 400", floor: 4, square_footage: 8250, status: "occupied", tenant_id: t2 },
  { id: id(), org_id: ORG, property_id: p1, building_id: null, unit_number: "Suite 105", floor: 1, square_footage: 4500, status: "vacant", tenant_id: null },
  { id: id(), org_id: ORG, property_id: p2, building_id: null, unit_number: "Unit A", floor: 1, square_footage: 6500, status: "occupied", tenant_id: t3 },
  { id: id(), org_id: ORG, property_id: p2, building_id: null, unit_number: "Unit C", floor: 1, square_footage: 3000, status: "occupied", tenant_id: t5 },
  { id: id(), org_id: ORG, property_id: p3, building_id: null, unit_number: "Warehouse A", floor: 1, square_footage: 35000, status: "occupied", tenant_id: t4 },
];

// ─── Notifications ─────────────────────────────────────
export const SEED_NOTIFICATIONS = [
  { id: id(), org_id: ORG, title: "Lease Expiring Soon", message: "CoreFit Athletics lease expires in 60 days", type: "warning", read: false, created_at: new Date().toISOString() },
  { id: id(), org_id: ORG, title: "Budget Approved", message: "Camelback 2025 OpEx budget has been approved", type: "success", read: true, created_at: new Date(Date.now() - 86400000).toISOString() },
  { id: id(), org_id: ORG, title: "Expense Pending Review", message: "2 expenses await your approval", type: "info", read: false, created_at: new Date(Date.now() - 172800000).toISOString() },
];

/**
 * Master map of entity name → seed records.
 * Keys must match the entity names used in createEntityService().
 */
export const ALL_SEED_DATA = {
  Property: SEED_PROPERTIES,
  Lease: SEED_LEASES,
  Expense: SEED_EXPENSES,
  Tenant: SEED_TENANTS,
  Vendor: SEED_VENDORS,
  Budget: SEED_BUDGETS,
  CAMCalculation: SEED_CAM_CALCULATIONS,
  Portfolio: SEED_PORTFOLIOS,
  Building: SEED_BUILDINGS,
  Unit: SEED_UNITS,
  Notification: SEED_NOTIFICATIONS,
  AuditLog: [
    { id: 'a1', org_id: ORG, entity_type: 'Property', entity_id: p1, action: 'create', user_name: 'Demo Admin', user_email: 'admin@demo.com', timestamp: new Date(Date.now() - 3600000).toISOString(), property_name: 'Camelback Commerce Center' },
    { id: 'a2', org_id: ORG, entity_type: 'Lease', entity_id: 'l1', action: 'upload', user_name: 'Tejas', user_email: 'tejas@demo.com', timestamp: new Date(Date.now() - 7200000).toISOString(), property_name: 'Scottsdale Retail Plaza', tenant_name: 'CoreFit Athletics' },
    { id: 'a3', org_id: ORG, entity_type: 'Expense', entity_id: 'e1', action: 'approve', user_name: 'System', user_email: 'system@demo.com', timestamp: new Date(Date.now() - 86400000).toISOString(), property_name: 'Tempe Industrial Park', field_changed: 'status', old_value: 'pending', new_value: 'approved' }
  ],
  Organization: [],
  AccessRequest: [
    { id: 'ar1', full_name: 'Sarah Johnson', email: 'sarah@westfield.com', company_name: 'Westfield Properties', role: 'asset_manager', property_count: '21-50', plan_interest: 'professional', status: 'pending', requested_at: new Date(Date.now() - 86400000).toISOString() },
    { id: 'ar2', full_name: 'Michael Chen', email: 'mchen@pacificcre.com', company_name: 'Pacific CRE Partners', role: 'finance_director', property_count: '6-20', plan_interest: 'starter', status: 'pending', requested_at: new Date(Date.now() - 172800000).toISOString() },
    { id: 'ar3', full_name: 'Emily Rodriguez', email: 'emily@summitcapital.com', company_name: 'Summit Capital Group', role: 'vp_operations', property_count: '100+', plan_interest: 'enterprise', status: 'approved', requested_at: new Date(Date.now() - 604800000).toISOString() },
  ],
  Document: [],
  Invoice: [],
  Reconciliation: [],
  Workflow: [],
  ChartOfAccount: [],
};

/**
 * CRE Financial Suite — Entity & Type Definitions
 *
 * Centralized entity-to-table mapping and JSDoc types.
 * All service calls should reference ENTITIES for consistent table naming.
 */

// ─── Entity → Supabase table name mapping ──────────────────────────────
// Keys are the logical names used throughout the app (e.g. "Property").
// Values are the Supabase table names (snake_case, plural).
export const ENTITIES = {
  Property:          'properties',
  Building:          'buildings',
  Unit:              'units',
  Lease:             'leases',
  Tenant:            'tenants',
  Expense:           'expenses',
  Budget:            'budgets',
  Vendor:            'vendors',
  Invoice:           'invoices',
  CAMCalculation:    'cam_calculations',
  GLAccount:         'gl_accounts',
  Document:          'documents',
  Organization:      'organizations',
  Notification:      'notifications',
  AuditLog:          'audit_logs',
  AccessRequest:     'access_requests',
  Portfolio:         'portfolios',
  Reconciliation:    'reconciliations',
  Revenue:           'revenues',
  Actual:            'actuals',
  Variance:          'variances',
  Workflow:          'workflows',
  Stakeholder:       'stakeholders',
  IntegrationConfig: 'integration_configs',
  Billing:           'billings',
  RentProjection:    'rent_projections',
  ExpenseProjection: 'expense_projections',
  User:              'users',
  DemoRequest:       'demo_requests',
  UploadedFile:      'uploaded_files',
  ComputationSnapshot: 'computation_snapshots',
};

/**
 * Resolve a logical entity name to its Supabase table name.
 * Falls back to snake_case + plural if not explicitly mapped.
 * @param {string} entityName - e.g. "Property", "AuditLog"
 * @returns {string} e.g. "properties", "audit_logs"
 */
export function resolveTableName(entityName) {
  if (ENTITIES[entityName]) return ENTITIES[entityName];
  // Fallback: PascalCase → snake_case, then pluralise
  const snake = entityName
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '');
  return `${snake}s`;
}

// ─── Standard field sets (Supabase schema prep) ────────────────────────
export const BASE_FIELDS = {
  id:         'uuid primary key default gen_random_uuid()',
  org_id:     'uuid not null references organizations(id)',
  created_at: 'timestamptz not null default now()',
  updated_at: 'timestamptz not null default now()',
};

// Tables whose rows are NOT scoped by org_id (platform-level)
export const ORG_EXEMPT_TABLES = new Set([
  'organizations',
  'access_requests',
  'audit_logs',
  'users',
  'demo_requests',
]);

// ─── Standardised service response shape ───────────────────────────────
/**
 * @template T
 * @typedef {Object} ServiceResponse
 * @property {T}      data    - Payload (array or single object)
 * @property {boolean} loading - Whether the request is in-flight
 * @property {Error|null} error - Error object or null
 */

/**
 * Helper to build a successful response.
 * @template T
 * @param {T} data
 * @returns {ServiceResponse<T>}
 */
export function successResponse(data) {
  return { data, loading: false, error: null };
}

/**
 * Helper to build an error response.
 * @param {Error|string} error
 * @param {*} [fallback=[]]
 * @returns {ServiceResponse<*>}
 */
export function errorResponse(error, fallback = []) {
  return {
    data: fallback,
    loading: false,
    error: typeof error === 'string' ? new Error(error) : error,
  };
}

// ─── JSDoc type definitions ────────────────────────────────────────────

/**
 * @typedef {Object} Property
 * @property {string} id
 * @property {string} org_id
 * @property {string} name
 * @property {string} [address]
 * @property {string} [city]
 * @property {string} [state]
 * @property {string} [zip]
 * @property {string} [property_type]
 * @property {number} [total_sqft]
 * @property {number} [year_built]
 * @property {string} [portfolio_id]
 * @property {string} [status]
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * @typedef {Object} Building
 * @property {string} id
 * @property {string} org_id
 * @property {string} property_id
 * @property {string} [name]
 * @property {number} [total_sqft]
 * @property {number} [floors]
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * @typedef {Object} Unit
 * @property {string} id
 * @property {string} org_id
 * @property {string} property_id
 * @property {string} building_id
 * @property {string} [unit_number]
 * @property {number} [square_footage]
 * @property {string} [status]
 * @property {string} [tenant_id]
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * @typedef {Object} Lease
 * @property {string} id
 * @property {string} org_id
 * @property {string} [property_id]
 * @property {string} [building_id]
 * @property {string} [unit_id]
 * @property {string} [tenant_name]
 * @property {string} [start_date]
 * @property {string} [end_date]
 * @property {number} [monthly_rent]
 * @property {number} [annual_rent]
 * @property {number} [rent_per_sf]
 * @property {number} [square_footage]
 * @property {string} [status]
 * @property {string} [lease_type]
 * @property {boolean} [cam_applicable]
 * @property {number} [cam_cap]
 * @property {string} [cam_cap_type]
 * @property {number} [cam_cap_rate]
 * @property {number} [admin_fee_pct]
 * @property {number} [management_fee_pct]
 * @property {string} [management_fee_basis]
 * @property {boolean} [gross_up_clause]
 * @property {string} [allocation_method]
 * @property {number} [weight_factor]
 * @property {number} [base_year_amount]
 * @property {number} [expense_stop_amount]
 * @property {string} [created_by]
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * @typedef {Object} Expense
 * @property {string} id
 * @property {string} org_id
 * @property {string} [property_id]
 * @property {string} [building_id]
 * @property {string} [unit_id]
 * @property {string} [lease_id]
 * @property {string} [category]
 * @property {number} [amount]
 * @property {string} [classification] - 'recoverable' | 'non_recoverable' | 'conditional'
 * @property {string} [vendor]
 * @property {string} [vendor_id]
 * @property {string} [gl_code]
 * @property {number} [fiscal_year]
 * @property {number} [month]
 * @property {string} [date]
 * @property {string} [source]
 * @property {boolean} [is_controllable]
 * @property {string} [allocation_type]
 * @property {Object} [allocation_meta]
 * @property {string[]} [direct_tenant_ids]
 * @property {string} [created_by]
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * @typedef {Object} Tenant
 * @property {string} id
 * @property {string} org_id
 * @property {string} name
 * @property {string} [email]
 * @property {string} [phone]
 * @property {string} [company]
 * @property {string} [status]
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * @typedef {Object} Vendor
 * @property {string} id
 * @property {string} org_id
 * @property {string} name
 * @property {string} [email]
 * @property {string} [phone]
 * @property {string} [category]
 * @property {string} [status]
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * @typedef {Object} Invoice
 * @property {string} id
 * @property {string} org_id
 * @property {string} [tenant_id]
 * @property {string} [property_id]
 * @property {number} [amount]
 * @property {string} [status]
 * @property {string} [due_date]
 * @property {string} [issued_date]
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * @typedef {Object} AuditLogEntry
 * @property {string} id
 * @property {string} [org_id]
 * @property {string} entity_type
 * @property {string} [entity_id]
 * @property {string} action - 'create' | 'update' | 'delete' | 'upload' | 'approve' | 'lock'
 * @property {string} [field_changed]
 * @property {string} [old_value]
 * @property {string} [new_value]
 * @property {string} [user_email]
 * @property {string} [user_name]
 * @property {string} [property_name]
 * @property {string} [building_name]
 * @property {string} [unit_number]
 * @property {string} [ip_address]
 * @property {string} timestamp
 * @property {string} created_at
 */

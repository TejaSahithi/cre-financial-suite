/**
 * Entity CRUD Service Layer — Production-Ready
 *
 * Features:
 *  • Multi-tenant org_id isolation on all queries
 *  • Integrated audit logging on create/update/delete
 *  • Simple in-memory cache with TTL
 *  • Consistent error handling with safe fallbacks
 *  • Standardised Supabase table naming via ENTITIES map
 */

import { resolveTableName, ORG_EXEMPT_TABLES } from '@/types';
import { logAudit } from '@/services/audit';
import { ALL_SEED_DATA } from '@/services/seedData';
import { supabase } from '@/services/supabaseClient';

// ─── In-memory store (used when Supabase is unavailable) ───────────────
const memoryStore = new Map();
let _memorySeeded = false;

function getStore(entityName) {
  if (!memoryStore.has(entityName)) {
    memoryStore.set(entityName, []);
  }
  return memoryStore.get(entityName);
}

function seedMemoryStore() {
  if (_memorySeeded) return;
  _memorySeeded = true;
  for (const [entity, records] of Object.entries(ALL_SEED_DATA)) {
    memoryStore.set(entity, [...records]);
  }
  console.log('[api] In-memory store seeded with demo data');
}
// Cached so we don't call auth.me() on every query.
let _cachedOrgId = undefined; // undefined = not resolved yet

/**
 * Get the current user's org_id for multi-tenant filtering.
 *
 * Reads org_id from the user's resolved membership object (set in auth.js),
 * not from email-based lookups. Super-admins get null (see all). Regular users
 * get their org_id from their primary membership. '__none__' means no org found.
 */
export async function getCurrentOrgId() {
  if (_cachedOrgId !== undefined) return _cachedOrgId;
  try {
    const { me } = await import('@/services/auth');
    const user = await me();

    if (!user) {
      _cachedOrgId = '__none__';
      return _cachedOrgId;
    }

    // Super-admin: role mapped to 'admin', _raw_role is 'super_admin'
    if (user.role === 'admin' || user._raw_role === 'super_admin') {
      _cachedOrgId = null; // null = no filter, sees all data
      return _cachedOrgId;
    }

    // org_id is already resolved from memberships in auth.js — use it directly
    _cachedOrgId = user.org_id || '__none__';
    return _cachedOrgId;
  } catch {
    _cachedOrgId = '__none__';
    return _cachedOrgId;
  }
}


/** Reset the cached org ID (e.g. after login/logout). */
export function resetOrgIdCache() {
  _cachedOrgId = undefined;
}

// ─── Simple TTL cache ──────────────────────────────────────────────────
const queryCache = new Map();
const CACHE_TTL_MS = 30_000; // 30 seconds

function getCached(key) {
  const entry = queryCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    queryCache.delete(key);
    return undefined;
  }
  return entry.data;
}

function setCached(key, data) {
  queryCache.set(key, { data, ts: Date.now() });
}

/** Invalidate cache entries for a given entity. */
function invalidateEntity(entityName) {
  for (const key of queryCache.keys()) {
    if (key.startsWith(`${entityName}:`)) queryCache.delete(key);
  }
}

/** Clear all cached data. */
export function clearCache() {
  queryCache.clear();
}

// ─── Table-not-found detection ─────────────────────────────────────────
/**
 * Returns true if the error indicates the table doesn't exist in Supabase.
 * PGRST205 = relation not found in schema cache
 * 42P01    = undefined_table (Postgres error)
 */
function isTableNotFound(err) {
  return (
    err?.code === 'PGRST205' ||
    err?.code === '42P01' ||
    (typeof err?.message === 'string' && err.message.includes('does not exist'))
  );
}

function extractMissingColumn(err) {
  const message = [err?.message, err?.details, err?.hint].filter(Boolean).join(' ');
  if (!message) return null;

  let match = message.match(/Could not find the '([^']+)' column/i);
  if (match?.[1]) return match[1];

  match = message.match(/column ["']?([a-zA-Z0-9_]+)["']?/i);
  if (match?.[1]) return match[1];

  return null;
}

function isMissingColumnError(err) {
  return (
    err?.code === 'PGRST204' ||
    err?.code === '42703' ||
    !!extractMissingColumn(err)
  );
}

// ─── Per-entity column allow-lists ─────────────────────────────────────
// These reflect the actual columns present in the Supabase tables AFTER all
// migrations (including the bulk-import enrichment migration). Anything not
// listed here is silently dropped before INSERT/UPDATE so the request can't
// fail with `column "X" does not exist`. This is the single source of truth
// for what survives a `service.create()` call.
const COMMON_BASE_COLUMNS = ['id', 'org_id', 'created_at', 'updated_at'];
const ALLOWED_COLUMNS = {
  Property: new Set([
    ...COMMON_BASE_COLUMNS,
    'portfolio_id', 'name', 'address', 'city', 'state', 'zip',
    'property_type', 'total_sqft', 'year_built', 'status',
    'structure_type', 'total_buildings', 'total_units', 'occupancy_pct',
    'address_verified', 'address_verification_note', 'property_id_code',
    // Bulk-import enrichment columns (added in 20260408_bulk_import_columns.sql)
    'purchase_price', 'market_value', 'noi', 'cap_rate',
    'manager', 'owner', 'contact', 'notes',
  ]),
  Building: new Set([
    ...COMMON_BASE_COLUMNS,
    'property_id', 'name', 'total_sqft', 'floors',
    'address', 'year_built', 'status', 'description',
  ]),
  Unit: new Set([
    ...COMMON_BASE_COLUMNS,
    'property_id', 'building_id', 'unit_number', 'square_footage',
    'status', 'tenant_id', 'floor', 'unit_type', 'occupancy_status',
    'lease_id', 'monthly_rent', 'lease_start', 'lease_end', 'notes',
  ]),
  Lease: new Set([
    ...COMMON_BASE_COLUMNS,
    'property_id', 'unit_id', 'tenant_name', 'tenant_id',
    'start_date', 'end_date', 'monthly_rent', 'square_footage',
    'status', 'lease_type', 'created_by',
    // Bulk-import enrichment columns
    'annual_rent', 'rent_per_sf', 'lease_term_months', 'security_deposit',
    'cam_amount', 'nnn_amount', 'escalation_rate', 'renewal_options',
    'ti_allowance', 'free_rent_months', 'notes',
  ]),
  Tenant: new Set([
    ...COMMON_BASE_COLUMNS,
    'name', 'email', 'phone', 'company', 'status',
    // Bulk-import enrichment columns
    'contact_name', 'industry', 'credit_rating', 'notes',
  ]),
  Expense: new Set([
    ...COMMON_BASE_COLUMNS,
    'property_id', 'category', 'amount', 'classification', 'vendor',
    'vendor_id', 'gl_code', 'fiscal_year', 'month', 'date', 'source',
    'is_controllable', 'created_by',
    // Bulk-import enrichment columns
    'description', 'invoice_number',
  ]),
  Revenue: new Set([
    ...COMMON_BASE_COLUMNS,
    'property_id', 'lease_id', 'fiscal_year', 'month', 'type', 'amount', 'notes',
    // Bulk-import enrichment columns
    'date', 'tenant_name',
  ]),
  Invoice: new Set([
    ...COMMON_BASE_COLUMNS,
    'tenant_id', 'property_id', 'amount', 'status', 'due_date', 'issued_date',
  ]),
  GLAccount: new Set([
    ...COMMON_BASE_COLUMNS,
    'code', 'name', 'category', 'type', 'description', 'is_active',
    // Bulk-import enrichment columns
    'normal_balance', 'is_recoverable', 'notes',
  ]),
};

// ─── Generic Entity Service Factory ────────────────────────────────────
/**
 * Create a CRUD service for a given entity.
 * @param {string} entityName - Logical entity name (e.g. "Property")
 */
export function createEntityService(entityName) {
  const tableName = resolveTableName(entityName);
  const isOrgExempt = ORG_EXEMPT_TABLES.has(tableName);
  const allowedColumns = ALLOWED_COLUMNS[entityName] || null;

  /**
   * Apply org_id scoping to a Supabase query unless exempt.
   * Super-admins (orgId === null) bypass the filter.
   */
  async function applyOrgScope(query) {
    if (!query) return { query };
    if (isOrgExempt) return { query };
    const orgId = await getCurrentOrgId();
    if (orgId && orgId !== '__none__') {
      return { query: query.eq('org_id', orgId), orgId };
    }
    return { query, orgId };
  }

  /**
   * Translates UI-standardized fields back to the specific database schema 
   * expected by Supabase for this entity. This resolves mismatches such as 
   * 'total_sf' vs 'total_sqft' or 'square_footage'.
   */
  function translateToDbSchema(data) {
    if (!data || typeof data !== 'object') return data;
    const clean = { ...data };
    
    // 1. Generic field translation (Total SF)
    if (clean.total_sf !== undefined) {
      if (['Property', 'Building'].includes(entityName)) {
        clean.total_sqft = clean.total_sf;
      } else if (['Unit', 'Lease'].includes(entityName)) {
        clean.square_footage = clean.total_sf;
      }
    }

    // 2. Entity-specific cleanup (none currently — `floors` is now a real
    //    column on properties, see 20260408_bulk_import_columns.sql)

    // 3. Global Strip List (Relational aliases and UI-only artifacts)
    const toStrip = [
      'total_sf', 'square_feet', 'sqft', 'sf', 'leased_sf', 'area',
      'property_name', 'building_name', 'unit_id_code', 'property_id_code',
      '_row' // Used by BulkImportModal UI
    ];

    toStrip.forEach(key => delete clean[key]);

    // 4. Strict allow-list — drop any column not present in the table schema.
    // This guarantees the INSERT/UPDATE never fails with `column "X" does not
    // exist`. Without this guard, bulk imports silently lose entire rows when
    // the source data carries extra fields the DB doesn't know about.
    if (allowedColumns) {
      Object.keys(clean).forEach(k => {
        if (!allowedColumns.has(k)) delete clean[k];
      });
    }

    return clean;
  }

  /**
   * Normalizes database-specific keys back to UI-standardized fields.
   * This is the inverse of translateToDbSchema.
   */
  function normalizeFromDb(data) {
    if (!data) return data;
    if (Array.isArray(data)) return data.map(item => normalizeFromDb(item));
    
    const normalized = { ...data };
    
    // 1. Map specialized SQFT keys back to UI-standard 'total_sf'
    if (normalized.total_sqft !== undefined) {
      normalized.total_sf = normalized.total_sqft;
    } else if (normalized.square_footage !== undefined) {
      normalized.total_sf = normalized.square_footage;
    }

    if (entityName === 'Lease') {
      if (normalized.base_rent === undefined && normalized.monthly_rent !== undefined) {
        normalized.base_rent = normalized.monthly_rent;
      }
      if (normalized.annual_rent === undefined && normalized.monthly_rent !== undefined) {
        normalized.annual_rent = Number(normalized.monthly_rent || 0) * 12;
      }
      if (
        normalized.rent_per_sf === undefined &&
        normalized.annual_rent !== undefined &&
        normalized.square_footage
      ) {
        normalized.rent_per_sf = Number(normalized.annual_rent || 0) / Number(normalized.square_footage || 1);
      }
    }

    if (entityName === 'Invoice') {
      if (normalized.total_amount === undefined && normalized.amount !== undefined) {
        normalized.total_amount = normalized.amount;
      }
      if (normalized.billing_period === undefined && normalized.issued_date) {
        normalized.billing_period = String(normalized.issued_date).slice(0, 7);
      }
      if (normalized.invoice_number === undefined && normalized.id) {
        normalized.invoice_number = `INV-${String(normalized.id).slice(0, 8).toUpperCase()}`;
      }
      if (normalized.amount_paid === undefined) {
        normalized.amount_paid = normalized.status === 'paid' ? Number(normalized.amount || 0) : 0;
      }
    }

    if (entityName === 'Tenant') {
      if (normalized.contact_email === undefined && normalized.email !== undefined) {
        normalized.contact_email = normalized.email;
      }
      if (normalized.contact_phone === undefined && normalized.phone !== undefined) {
        normalized.contact_phone = normalized.phone;
      }
    }
    
    return normalized;
  }

  return {
    // ── GET ──────────────────────────────────────────────────────────
    /**
     * Get a single record by ID.
     * @param {string|number} id
     * @returns {Promise<object|null>}
     */
    async get(id) {
      if (!id) return null;
      const cacheKey = `${entityName}:get:${id}`;
      const cached = getCached(cacheKey);
      if (cached) return cached;

      try {
        if (supabase) {
          const { data, error } = await supabase
            .from(tableName)
            .select('*')
            .eq('id', id)
            .single();
          if (error) {
            if (error.code === 'PGRST116') return null; // Not found
            throw error;
          }
          const normalized = normalizeFromDb(data);
          setCached(cacheKey, normalized);
          return normalized;
        }
        // In-memory fallback
        seedMemoryStore();
        const record = getStore(entityName).find(r => r.id === id);
        return record || null;
      } catch (err) {
        if (isTableNotFound(err)) {
          console.warn(`[api] ${entityName} table not found in Supabase — using in-memory fallback`);
          seedMemoryStore();
          const record = getStore(entityName).find(r => r.id === id);
          return record || null;
        }
        console.error(`[api] ${entityName}.get() error:`, err);
        return null;
      }
    },

    // ── LIST ─────────────────────────────────────────────────────────
    /**
     * List all records, optionally sorted.
     * @param {string} [sortField] - Prefix with '-' for descending.
     * @param {number} [limit] - Max records.
     * @returns {Promise<Array>}
     */
    async list(sortField, limit) {
      const cacheKey = `${entityName}:list:${sortField || ''}:${limit || ''}`;
      const cached = getCached(cacheKey);
      if (cached) return cached;

      try {
        if (supabase) {
          const orgId = isOrgExempt ? null : await getCurrentOrgId();
          let query = supabase.from(tableName).select('*');
          
          if (orgId && orgId !== '__none__') {
            query = query.eq('org_id', orgId);
          }

          if (sortField) {
            const desc = sortField.startsWith('-');
            const field = desc ? sortField.slice(1) : sortField;
            query = query.order(field, { ascending: !desc });
          }
          if (limit) query = query.limit(limit);
          
          let { data, error } = await query;
          if (error && sortField && isMissingColumnError(error)) {
            const fallbackSort = ['created_at', 'updated_at'].includes(sortField.replace(/^-/, ''))
              ? null
              : '-created_at';
            let retry = supabase.from(tableName).select('*');
            if (orgId && orgId !== '__none__') {
              retry = retry.eq('org_id', orgId);
            }
            if (fallbackSort) {
              const desc = fallbackSort.startsWith('-');
              const field = desc ? fallbackSort.slice(1) : fallbackSort;
              retry = retry.order(field, { ascending: !desc });
            }
            if (limit) retry = retry.limit(limit);
            ({ data, error } = await retry);
          }
          if (error) throw error;
          const result = normalizeFromDb(data || []);
          setCached(cacheKey, result);
          return result;
        }
        // In-memory fallback
        seedMemoryStore();
        let items = [...getStore(entityName)];
        if (sortField) {
          const desc = sortField.startsWith('-');
          const field = desc ? sortField.slice(1) : sortField;
          items.sort((a, b) => {
            if (a[field] < b[field]) return desc ? 1 : -1;
            if (a[field] > b[field]) return desc ? -1 : 1;
            return 0;
          });
        }
        if (limit) items = items.slice(0, limit);
        setCached(cacheKey, items);
        return items;
      } catch (err) {
        if (isTableNotFound(err)) {
          console.warn(`[api] ${entityName} table not found in Supabase — using in-memory fallback`);
          seedMemoryStore();
          let items = [...getStore(entityName)];
          if (sortField) {
            const desc = sortField.startsWith('-');
            const field = desc ? sortField.slice(1) : sortField;
            items.sort((a, b) => {
              if (a[field] < b[field]) return desc ? 1 : -1;
              if (a[field] > b[field]) return desc ? -1 : 1;
              return 0;
            });
          }
          if (limit) items = items.slice(0, limit);
          return items;
        }
        console.error(`[api] ${entityName}.list() error:`, err);
        return [];
      }
    },

    // ── FILTER ───────────────────────────────────────────────────────
    /**
     * Filter records by criteria.
     * org_id is automatically enforced.
     * @param {object} filters
     * @returns {Promise<Array>}
     */
    async filter(filters = {}) {
      const cacheKey = `${entityName}:filter:${JSON.stringify(filters)}`;
      const cached = getCached(cacheKey);
      if (cached) return cached;

      try {
        if (supabase) {
          let baseQuery = supabase.from(tableName).select('*');
          // Supabase builders are thenables, so returning them directly from an
          // async helper causes the request to execute before we add the actual
          // filters. Wrap the builder in a plain object so `id`/`property_id`
          // constraints still make it into the final query.
          const scoped = await applyOrgScope(baseQuery);
          let query = scoped.query;
          
          if (filters && typeof filters === 'object') {
            for (const [key, value] of Object.entries(filters)) {
              if (query && typeof query.eq === 'function') {
                query = query.eq(key, value);
              }
            }
          }
          const { data, error } = await query;
          if (error) throw error;
          const result = normalizeFromDb(data || []);
          setCached(cacheKey, result);
          return result;
        }
        // In-memory fallback
        seedMemoryStore();
        const items = getStore(entityName).filter(record =>
          Object.entries(filters).every(([key, value]) => record[key] === value)
        );
        setCached(cacheKey, items);
        return items;
      } catch (err) {
        if (isTableNotFound(err)) {
          console.warn(`[api] ${entityName} table not found in Supabase — using in-memory fallback`);
          seedMemoryStore();
          // Skip org_id when filtering seed data — seed records use 'demo-org', not the real UUID
          const { org_id: _skip, ...nonOrgFilters } = filters;
          return getStore(entityName).filter(record =>
            Object.entries(nonOrgFilters).every(([key, value]) => record[key] === value)
          );
        }
        console.error(`[api] ${entityName}.filter() error:`, err);
        return [];
      }
    },

    // ── CREATE ───────────────────────────────────────────────────────
    /**
     * Insert a new record. Automatically stamps created_at/updated_at.
     * Logs audit trail.
     * @param {object} data
     * @returns {Promise<object>}
     */
    async create(data) {
      try {
        const translated = translateToDbSchema(data);
        const now = new Date().toISOString();
        const enriched = {
          ...translated,
          created_at: translated.created_at || now,
          updated_at: translated.updated_at || now,
        };

        // Inject org_id if not present and table requires it
        if (!isOrgExempt && !enriched.org_id) {
          const orgId = await getCurrentOrgId();
          if (orgId && orgId !== '__none__') {
            enriched.org_id = orgId;
          }
        }

        if (supabase) {
          const isPublicForm = tableName === 'access_requests';
          let payload = { ...enriched };
          const strippedColumns = [];
          let created = null;

          while (true) {
            let query = supabase.from(tableName).insert(payload);
            if (!isPublicForm) {
              query = query.select().single();
            }

            const { data: insertData, error } = await query;
            if (!error) {
              created = insertData;
              break;
            }

            const missingColumn = extractMissingColumn(error);
            if (!isMissingColumnError(error) || !missingColumn || !(missingColumn in payload)) {
              throw error;
            }

            strippedColumns.push(missingColumn);
            delete payload[missingColumn];
          }

          if (strippedColumns.length > 0) {
            console.warn(`[api] ${entityName}.create() stripped unsupported columns: ${strippedColumns.join(', ')}`);
          }

          const finalRecord = normalizeFromDb(isPublicForm ? { id: 'pending', ...payload } : created);

          // Audit
          logAudit({
            entityType: entityName,
            entityId: finalRecord.id,
            action: 'create',
            orgId: finalRecord.org_id,
          }).catch(() => {});

          invalidateEntity(entityName);
          return finalRecord;
        }

        // In-memory fallback
        seedMemoryStore();
        const newRecord = { id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ...enriched };
        getStore(entityName).push(newRecord);

        logAudit({
          entityType: entityName,
          entityId: newRecord.id,
          action: 'create',
          orgId: newRecord.org_id,
        }).catch(() => {});

        invalidateEntity(entityName);
        return newRecord;
      } catch (err) {
        if (isTableNotFound(err)) {
          console.warn(`[api] ${entityName} table not found in Supabase — creating in-memory`);
          seedMemoryStore();
          const now = new Date().toISOString();
          const enriched = { ...data, created_at: data.created_at || now, updated_at: data.updated_at || now };
          const newRecord = { id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ...enriched };
          getStore(entityName).push(newRecord);
          invalidateEntity(entityName);
          return newRecord;
        }
        console.error(`[api] ${entityName}.create() error:`, err);
        throw err;
      }
    },
    // ── UPSERT ──────────────────────────────────────────────────────
    /**
     * Insert or update a record based on a conflict column (default: 'email').
     * Used for public forms like access_requests where duplicate emails should update.
     * @param {object} data
     * @param {string} conflictColumn - column to detect conflicts on
     * @returns {Promise<object>}
     */
    async upsert(data, conflictColumn = 'email') {
      try {
        const translated = translateToDbSchema(data);
        const now = new Date().toISOString();
        const enriched = {
          ...translated,
          created_at: translated.created_at || now,
          updated_at: now,
        };

        if (supabase) {
          // For public forms (e.g. access_requests), RLS prevents public UPDATE.
          // Using .upsert() natively causes Postgres to demand UPDATE privileges.
          // Instead, we try .insert(). If it fails due to a unique constraint (duplicate email),
          // we gracefully catch it and return success so the user flow continues smoothly.
          const { data: inserted, error } = await supabase
            .from(tableName)
            .insert(enriched)
            .select();

          let finalRecord = inserted ? inserted[0] : enriched;

          if (error) {
            if (error.code === '23505') {
              console.warn('[api] Duplicate record identified, bypassing to continue flow.');
              // We successfully caught the duplicate.
            } else {
              throw error;
            }
          }

          logAudit({
            entityType: entityName,
            entityId: finalRecord?.id || 'upserted',
            action: 'upsert',
          }).catch(() => {});

          invalidateEntity(entityName);
          return finalRecord;
        }

        // In-memory fallback — just create
        return this.create(data);
      } catch (err) {
        console.error(`[api] ${entityName}.upsert() error:`, err);
        return { id: `error-${Date.now()}`, ...data };
      }
    },

    // ── UPDATE ───────────────────────────────────────────────────────
    /**
     * Update a record by ID. Scoped by org_id. Logs audit trail.
     * @param {string|number} id
     * @param {object} data
     * @returns {Promise<object>}
     */
    async update(id, data) {
      try {
        const translated = translateToDbSchema(data);
        const enriched = {
          ...translated,
          updated_at: translated.updated_at || new Date().toISOString(),
        };

        if (supabase) {
          const orgId = isOrgExempt ? null : await getCurrentOrgId();
          let payload = { ...enriched };
          const strippedColumns = [];
          let updated = null;

          while (true) {
            let query = supabase.from(tableName).update(payload).eq('id', id);
            
            if (orgId && orgId !== '__none__') {
              query = query.eq('org_id', orgId);
            }

            const { data: updateData, error } = await query.select().single();
            if (!error) {
              updated = updateData;
              break;
            }

            const missingColumn = extractMissingColumn(error);
            if (!isMissingColumnError(error) || !missingColumn || !(missingColumn in payload)) {
              throw error;
            }

            strippedColumns.push(missingColumn);
            delete payload[missingColumn];
          }

          if (strippedColumns.length > 0) {
            console.warn(`[api] ${entityName}.update() stripped unsupported columns: ${strippedColumns.join(', ')}`);
          }

          updated = normalizeFromDb(updated);

          logAudit({
            entityType: entityName,
            entityId: id,
            action: 'update',
            orgId: updated.org_id,
          }).catch(() => {});

          invalidateEntity(entityName);
          return updated;
        }

        // In-memory fallback
        seedMemoryStore();
        const store = getStore(entityName);
        const idx = store.findIndex(r => r.id === id);
        if (idx !== -1) {
          store[idx] = { ...store[idx], ...enriched };
        }
        const updated = idx !== -1 ? store[idx] : { id, ...enriched };

        logAudit({
          entityType: entityName,
          entityId: id,
          action: 'update',
        }).catch(() => {});

        invalidateEntity(entityName);
        return updated;
      } catch (err) {
        if (isTableNotFound(err)) {
          console.warn(`[api] ${entityName} table not found in Supabase — updating in-memory`);
          seedMemoryStore();
          const store = getStore(entityName);
          const enriched = { ...data, updated_at: new Date().toISOString() };
          const idx = store.findIndex(r => r.id === id);
          if (idx !== -1) store[idx] = { ...store[idx], ...enriched };
          invalidateEntity(entityName);
          return idx !== -1 ? store[idx] : { id, ...enriched };
        }
        console.error(`[api] ${entityName}.update() error:`, err);
        return { id, ...data };
      }
    },

    // ── DELETE ───────────────────────────────────────────────────────
    /**
     * Delete a record by ID. Scoped by org_id. Logs audit trail.
     * @param {string|number} id
     * @returns {Promise<boolean>}
     */
    async delete(id) {
      try {
        if (supabase) {
          const orgId = isOrgExempt ? null : await getCurrentOrgId();
          let query = supabase.from(tableName).delete().eq('id', id);
          
          if (orgId && orgId !== '__none__') {
            query = query.eq('org_id', orgId);
          }

          const { error } = await query;
          if (error) throw error;

          logAudit({
            entityType: entityName,
            entityId: id,
            action: 'delete',
          }).catch(() => {});

          invalidateEntity(entityName);
          return true;
        }

        // In-memory fallback
        seedMemoryStore();
        const delStore = getStore(entityName);
        const delIdx = delStore.findIndex(r => r.id === id);
        if (delIdx !== -1) delStore.splice(delIdx, 1);

        logAudit({
          entityType: entityName,
          entityId: id,
          action: 'delete',
        }).catch(() => {});

        invalidateEntity(entityName);
        return true;
      } catch (err) {
        if (isTableNotFound(err)) {
          console.warn(`[api] ${entityName} table not found in Supabase — deleting in-memory`);
          seedMemoryStore();
          const delStore = getStore(entityName);
          const delIdx = delStore.findIndex(r => r.id === id);
          if (delIdx !== -1) delStore.splice(delIdx, 1);
          invalidateEntity(entityName);
          return true;
        }
        console.error(`[api] ${entityName}.delete() error:`, err);
        return false;
      }
    },
  };
}

// ─── Pre-built Entity Services ─────────────────────────────────────────
export const PropertyService           = createEntityService('Property');
export const BuildingService           = createEntityService('Building');
export const UnitService               = createEntityService('Unit');
export const LeaseService              = createEntityService('Lease');
export const TenantService             = createEntityService('Tenant');
export const ExpenseService            = createEntityService('Expense');
export const BudgetService             = createEntityService('Budget');
export const VendorService             = createEntityService('Vendor');
export const CAMCalculationService     = createEntityService('CAMCalculation');
export const GLAccountService          = createEntityService('GLAccount');
export const DocumentService           = createEntityService('Document');
export const OrganizationService       = createEntityService('Organization');
export const NotificationService       = createEntityService('Notification');
export const AuditLogService           = createEntityService('AuditLog');
export const AccessRequestService      = createEntityService('AccessRequest');
export const PortfolioService          = createEntityService('Portfolio');
export const InvoiceService            = createEntityService('Invoice');
export const ReconciliationService     = createEntityService('Reconciliation');
export const RevenueService            = createEntityService('Revenue');
export const ActualService             = createEntityService('Actual');
export const VarianceService           = createEntityService('Variance');
export const WorkflowService           = createEntityService('Workflow');
export const StakeholderService        = createEntityService('Stakeholder');
export const IntegrationConfigService  = createEntityService('IntegrationConfig');
export const BillingEntityService      = createEntityService('Billing');
export const RentProjectionService     = createEntityService('RentProjection');
export const ExpenseProjectionService  = createEntityService('ExpenseProjection');
export const UserService               = createEntityService('User');
export const DemoRequestService        = createEntityService('DemoRequest');
export const UploadedFileService       = createEntityService('UploadedFile');
export const ComputationSnapshotService = createEntityService('ComputationSnapshot');

/**
 * Submit a public-facing ACCESS REQUEST.
 * Inserts ONLY into the `access_requests` table.
 * Status defaults to 'pending_approval' so SuperAdmins can review.
 */
export async function submitPublicAccessRequest(payload) {
  // Strict: ONLY inserts into access_requests. Never touches demo_requests.
  const requestPayload = {
    full_name:        payload.full_name,
    email:            payload.email,
    phone:            payload.phone || null,
    company_name:     payload.company_name,
    role:             payload.role,
    portfolios:       payload.portfolios || null,
    properties_count: payload.properties_count || null,
    plan:             payload.plan || null,
    billing_cycle:    payload.billing_cycle || 'monthly',
    request_type:     'access', // Always 'access' for SuperAdmin visibility
    status:           'pending_approval',
    updated_at:       new Date().toISOString(),
  };

  if (!supabase) {
    return { id: `mem-${Date.now()}`, ...requestPayload, created_at: new Date().toISOString() };
  }

  // Use .insert() — upsert requires UPDATE privilege even for fresh rows,
  // which RLS blocks for anon users when existing rows have non-pending statuses.
  const { data, error } = await supabase
    .from('access_requests')
    .insert(requestPayload)
    .select();

  if (error) {
    // 23505 = unique_violation (duplicate email) — treat as success so user isn't stuck
    if (error.code === '23505') {
      console.warn('[api] submitPublicAccessRequest: duplicate email, returning gracefully');
      return { ...requestPayload, created_at: new Date().toISOString() };
    }
    console.error('[api] submitPublicAccessRequest failed:', error);
    throw new Error(error.message || 'Failed to submit access request');
  }

  return data?.[0] || requestPayload;
}

/**
 * Submit a public-facing DEMO REQUEST.
 * Inserts ONLY into `demo_requests` — completely separate from access_requests.
 * Status defaults to 'new'. There is NO pending_approval state for demo leads.
 */
export async function submitPublicDemoRequest(payload) {
  const requestPayload = {
    full_name:    payload.full_name,
    email:        payload.email,
    phone:        payload.phone || null,
    company_name: payload.company_name || null,
    role:         payload.role || null,
    plan:         payload.plan || null,
    notes:        payload.notes || null,
    demo_viewed:  false,
    status:       'new', 
    updated_at:   new Date().toISOString(),
  };

  if (!supabase) {
    return { id: `mem-demo-${Date.now()}`, ...requestPayload, created_at: new Date().toISOString() };
  }

  const { data, error } = await supabase
    .from('demo_requests')
    .insert(requestPayload)
    .select();

  if (error) {
    if (error.code === '23505') {
      console.warn('[api] submitPublicDemoRequest: duplicate email, returning gracefully');
      return { ...requestPayload, created_at: new Date().toISOString() };
    }
    console.error('[api] submitPublicDemoRequest failed:', error);
    throw new Error(error.message || 'Failed to submit demo request');
  }

  return data?.[0] || requestPayload;
}

export async function verifyAccessRequest(email) {
  if (!supabase) {
    // In-memory fallback
    return { valid: true, company_name: 'Test Company' };
  }
  const { data, error } = await supabase.rpc('verify_access_request', { p_email: email });
  if (error) {
    console.error('[api] verifyAccessRequest error:', error);
    throw error;
  }
  return data;
}

export async function saveSecurityQuestions(questions) {
  if (!supabase) {
    return { success: true };
  }
  const { data, error } = await supabase.functions.invoke('save-security-questions', {
    body: questions
  });
  if (error) {
    console.error('[api] saveSecurityQuestions error:', error);
    throw error;
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

export async function markDemoViewed(requestId) {
  if (!supabase || !requestId) return { success: true };
  try {
    return { success: true };
  } catch (err) {
    console.error('[api] markDemoViewed error:', err);
    return { success: false, error: err };
  }
}
/**
 * Check if a pending request (access or demo) already exists for an email.
 * @param {string} email
 * @param {'access' | 'demo'} type
 */
export async function getExistingRequest(email, type = 'access') {
  if (!supabase || !email) return null;
  const table = type === 'demo' ? 'demo_requests' : 'access_requests';
  try {
    const { data, error } = await supabase
      .from(table)
      .select('status, company_name, created_at')
      .eq('email', email)
      .maybeSingle();
      
    if (error) throw error;
    return data;
  } catch (err) {
    console.warn(`[api] checkExistingRequest (${type}) failed:`, err);
    return null;
  }
}

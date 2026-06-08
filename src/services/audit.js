/**
 * Audit Logging Service
 *
 * Provides a centralised helper for recording audit trail entries
 * whenever entities are created, updated, or deleted.
 */

import { supabase } from '@/services/supabaseClient';
import { getStoredActingOrgId } from '@/lib/actingOrg';

/**
 * @typedef {Object} AuditEntry
 * @property {string}  [entityType]  - Logical entity name (e.g. "Property")
 * @property {string}  [entityId]    - ID of the affected record
 * @property {string}  action      - 'create' | 'update' | 'delete'
 * @property {string}  [orgId]     - Organisation that owns the record
 * @property {string}  [fieldChanged] - Name of the changed field (updates)
 * @property {*}       [oldValue]  - Previous value
 * @property {*}       [newValue]  - New value
 * @property {string}  [userId]    - ID of the acting user
 * @property {string}  [userEmail] - Email of the acting user
 * @property {string}  [target_user_id] - Fallback entity ID used by admin/member actions
 * @property {*}       [details] - Structured payload stored in `new_value` when no explicit newValue is provided
 */

function serializeAuditValue(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isUuidLike(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function cleanUuid(value) {
  return isUuidLike(value) ? value : null;
}

function inferEntityType(entry) {
  if (entry.entityType || entry.entity_type) {
    return entry.entityType || entry.entity_type;
  }

  const action = String(entry.action || '');
  if (entry.target_user_id || action.includes('member') || action.includes('permissions')) {
    return 'Membership';
  }

  return 'System';
}

function inferEntityId(entry) {
  return entry.entityId || entry.entity_id || entry.target_user_id || null;
}

async function resolveAuditContext(entry) {
  const resolved = {
    orgId: cleanUuid(entry.orgId || entry.org_id || getStoredActingOrgId()),
    userId: entry.userId || entry.user_id || null,
    userEmail: entry.userEmail || entry.user_email || null,
  };
  if (resolved.orgId === '__none__') resolved.orgId = null;

  if (!supabase || (resolved.orgId && resolved.userId && resolved.userEmail)) {
    return resolved;
  }

  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      resolved.userId ||= user.id;
      resolved.userEmail ||= user.email || null;
    }

    if (!resolved.orgId && user?.id) {
      const { data: memberships } = await supabase
        .from('memberships')
        .select('org_id, role, status')
        .eq('user_id', user.id)
        .not('org_id', 'is', null);

      const usableMemberships = (memberships || []).filter((membership) => {
        const status = membership?.status || 'active';
        return ['active', 'owner', 'invited'].includes(status);
      });

      const prioritizedMembership = usableMemberships.sort((a, b) => {
        const rank = { org_admin: 0, manager: 1, editor: 2, viewer: 3 };
        return (rank[a.role] ?? 99) - (rank[b.role] ?? 99);
      })[0];

      resolved.orgId = cleanUuid(prioritizedMembership?.org_id);
      resolved.role = prioritizedMembership?.role || null;
    }
  } catch (err) {
    console.warn('[audit] Unable to resolve audit context:', err?.message || err);
  }

  return resolved;
}

// Module-level cache: the current production schema has the enhanced audit
// columns. If an older environment is still missing them, the first schema
// error flips this to false and subsequent calls use the core row only.
let _enhancedSchemaAvailable = true;

/**
 * Record an audit log entry.
 * @param {AuditEntry} entry
 */
export async function logAudit(entry) {
  if (!entry?.action) {
    console.error('[audit] Missing action for audit log entry:', entry);
    return;
  }

  const context = await resolveAuditContext(entry);

  // Do NOT silently drop audit logs when orgId is null.
  // Super-admin actions (user approvals, org creation) have no acting org but must
  // still be recorded. We proceed with org_id = null and let the DB decide.
  // If the audit_logs table requires org_id to be non-null, run:
  //   ALTER TABLE audit_logs ALTER COLUMN org_id DROP NOT NULL;
  if (!context.orgId) {
    console.warn('[audit] Writing audit log with null org_id — super-admin or pre-org action:', {
      entity_type: inferEntityType(entry),
      action: entry.action,
    });
  }

  const optionalDetails = entry.metadata ?? entry.details ?? null;
  const optionalBefore = entry.before ?? entry.oldValue ?? entry.old_value ?? null;
  const optionalAfter = entry.after ?? entry.newValue ?? entry.new_value ?? null;

  const row = {
    entity_type:    inferEntityType(entry),
    entity_id:      cleanUuid(inferEntityId(entry)),
    action:         entry.action,
    org_id:         context.orgId,
    actor_user_id:  context.userId,
    target_user_id: cleanUuid(entry.target_user_id || entry.targetUserId || null),
    severity:       entry.severity || 'info',
    source:         'frontend',
    before:         optionalBefore,
    after:          optionalAfter,
    metadata:       optionalDetails,
  };

  const coreRow = {
    entity_type: row.entity_type,
    entity_id:   row.entity_id,
    action:      row.action,
    org_id:      row.org_id,
  };

  const isSchemaError = (error) =>
    error.code === 'PGRST204' ||
    error.code === 'PGRST200' ||
    error.code === '42703' ||
    error.code === '42P01' ||
    /column|schema cache|does not exist/i.test(error.message || '');

  try {
    if (supabase) {
      // Strategy: use the enhanced schema now that the audit hardening
      // migration is part of the live database. Older databases still fall back
      // to the core insert after one schema-cache/column error.
      if (_enhancedSchemaAvailable === true) {
        const { error } = await supabase.from('audit_logs').insert(row);
        if (!error) return;
        if (isSchemaError(error)) {
          _enhancedSchemaAvailable = false;
        } else {
          throw error;
        }
      }

      // Core schema — works on every deployment.
      const { error: coreErr } = await supabase.from('audit_logs').insert(coreRow);
      if (coreErr) {
        if (isSchemaError(coreErr)) {
          // Even core columns missing — table may not exist yet.
          console.debug('[audit] audit_logs table unavailable, skipping audit entry.');
          return;
        }
        throw coreErr;
      }
    } else {
      console.log('[audit]', row);
    }
  } catch (err) {
    console.error('[audit] Failed to write audit log:', {
      error: err?.message || err,
      row,
    });
    if (row.severity === 'critical' || row.severity === 'error') {
      throw err;
    }
  }
}

/**
 * Build audit entries by diffing old and new data objects.
 * Returns an array of entries (one per changed field).
 * @param {string} entityType
 * @param {string} entityId
 * @param {object} oldData
 * @param {object} newData
 * @param {object} [meta] - { orgId, userId, userEmail }
 * @returns {AuditEntry[]}
 */
export function diffForAudit(entityType, entityId, oldData, newData, meta = {}) {
  const entries = [];
  const allKeys = new Set([...Object.keys(oldData || {}), ...Object.keys(newData || {})]);

  for (const key of allKeys) {
    const oldVal = oldData?.[key];
    const newVal = newData?.[key];
    if (oldVal !== newVal) {
      entries.push({
        entityType,
        entityId,
        action: 'update',
        fieldChanged: key,
        oldValue: oldVal,
        newValue: newVal,
        ...meta,
      });
    }
  }
  return entries;
}

/**
 * Log multiple audit entries in parallel.
 * @param {AuditEntry[]} entries
 */
export async function logAuditBatch(entries) {
  await Promise.allSettled(entries.map(logAudit));
}

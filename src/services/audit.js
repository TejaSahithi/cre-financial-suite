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
    orgId: entry.orgId || entry.org_id || getStoredActingOrgId() || null,
    userId: entry.userId || entry.user_id || null,
    userEmail: entry.userEmail || entry.user_email || null,
  };

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

      resolved.orgId = prioritizedMembership?.org_id || null;
    }
  } catch (err) {
    console.warn('[audit] Unable to resolve audit context:', err?.message || err);
  }

  return resolved;
}

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
  const row = {
    entity_type:   inferEntityType(entry),
    entity_id:     inferEntityId(entry),
    action:        entry.action,
    org_id:        context.orgId,
    field_changed: entry.fieldChanged || entry.field_changed || null,
    old_value:     serializeAuditValue(entry.oldValue ?? entry.old_value),
    new_value:     serializeAuditValue(
      entry.newValue ?? entry.new_value ?? entry.details ?? null,
    ),
    user_email:    context.userEmail,
    user_name:     entry.userName || entry.user_name || null,
    property_id:   entry.propertyId || entry.property_id || null,
    timestamp:     new Date().toISOString(),
    created_at:    new Date().toISOString(),
  };

  try {
    if (supabase) {
      const { error } = await supabase.from('audit_logs').insert(row);

      if (error) throw error;
    } else {
      console.log('[audit]', row);
    }
  } catch (err) {
    // Audit logging should never crash the caller
    console.error('[audit] Failed to write audit log:', {
      error: err?.message || err,
      row,
    });
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

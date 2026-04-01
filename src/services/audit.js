/**
 * Audit Logging Service
 *
 * Provides a centralised helper for recording audit trail entries
 * whenever entities are created, updated, or deleted.
 */

import { resolveTableName } from '@/types';
import { supabase } from '@/services/supabaseClient';

/**
 * @typedef {Object} AuditEntry
 * @property {string}  entityType  - Logical entity name (e.g. "Property")
 * @property {string}  entityId    - ID of the affected record
 * @property {string}  action      - 'create' | 'update' | 'delete'
 * @property {string}  [orgId]     - Organisation that owns the record
 * @property {string}  [fieldChanged] - Name of the changed field (updates)
 * @property {*}       [oldValue]  - Previous value
 * @property {*}       [newValue]  - New value
 * @property {string}  [userId]    - ID of the acting user
 * @property {string}  [userEmail] - Email of the acting user
 */

/**
 * Record an audit log entry.
 * @param {AuditEntry} entry
 */
export async function logAudit(entry) {
  const row = {
    entity_type:   entry.entityType,
    entity_id:     entry.entityId,
    action:        entry.action,
    org_id:        entry.orgId || null,
    field_changed: entry.fieldChanged || null,
    old_value:     entry.oldValue != null ? String(entry.oldValue) : null,
    new_value:     entry.newValue != null ? String(entry.newValue) : null,
    user_email:    entry.userEmail || null,
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
    console.error('[audit] Failed to write audit log:', err);
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

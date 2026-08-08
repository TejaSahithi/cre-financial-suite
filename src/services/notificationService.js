import { createEntityService } from '@/services/api';
import { logAudit } from '@/services/audit';
import { supabase } from '@/services/supabaseClient';
import { dispatchNotificationChannel } from '@/services/notificationChannels';
import { NOTIFICATION_CHANNELS } from '@/lib/notifications/notificationConstants';
import { NOTIFICATION_EVENT_PERMISSIONS, NOTIFICATION_EVENT_POLICIES } from '@/lib/notifications/notificationPolicies';
import { canApproveWorkflow, resolveNotificationRecipients } from '@/lib/notifications/recipientResolver';

export const notificationService = createEntityService('Notification');

const notificationDeliveryService = createEntityService('NotificationDelivery');
const notificationPreferenceService = createEntityService('NotificationPreference');

function normalizeEvent(event) {
  return {
    ...event,
    event_type: event?.event_type || event?.type,
    org_id: event?.org_id || event?.organization_id,
    metadata: event?.metadata && typeof event.metadata === 'object' ? event.metadata : {},
  };
}

function logicalNotificationPayload(event, recipient) {
  return {
    org_id: event.org_id,
    organization_id: event.org_id,
    recipient_user_id: recipient.userId || null,
    event_type: recipient.eventType,
    module: recipient.module,
    entity_type: recipient.entityType,
    entity_id: recipient.entityId || null,
    portfolio_id: recipient.portfolioId || null,
    property_id: recipient.propertyId || null,
    tenant_id: recipient.tenantId || null,
    notification_type: recipient.notificationType,
    type: recipient.eventType,
    title: recipient.title,
    message: recipient.message,
    action_url: recipient.actionUrl,
    link: recipient.actionUrl || recipient.entityId || '',
    requires_action: recipient.requiresAction,
    priority: recipient.requiresAction ? 'high' : 'normal',
    metadata: {
      ...(event.metadata || {}),
      external_type: recipient.externalType || null,
      external_recipient_id: recipient.id || null,
      external_email: !recipient.userId ? recipient.email || null : null,
      matching_reasons: recipient.matchingReasons,
      channels: recipient.channels,
    },
  };
}

function deliveryPayload(notificationId, recipient, channel, statusResult = {}) {
  return {
    notification_id: notificationId,
    channel,
    destination: channel === NOTIFICATION_CHANNELS.SMS ? recipient.phone : recipient.email,
    status: statusResult.status || 'queued',
    provider_message_id: statusResult.provider_message_id || null,
    attempts: statusResult.status === 'queued' ? 0 : 1,
    sent_at: statusResult.sent_at || null,
    delivered_at: statusResult.delivered_at || null,
    failed_at: statusResult.failed_at || null,
    error_message: statusResult.error_message || null,
  };
}

async function safeCreateDelivery(payload) {
  try {
    return await notificationDeliveryService.create(payload);
  } catch (error) {
    console.warn('[notificationService] delivery record unavailable:', error?.message || error);
    return null;
  }
}

async function fetchNotificationContext(orgId) {
  if (!supabase || !orgId) {
    return {
      memberships: [],
      userAccess: [],
      stakeholders: [],
      notificationPreferences: [],
      profilesByUserId: {},
    };
  }

  const [
    membershipsResult,
    accessResult,
    stakeholdersResult,
    preferencesResult,
  ] = await Promise.all([
    supabase
      .from('memberships')
      .select('user_id, org_id, role, status, phone, custom_role, assigned_portfolios, capabilities, module_permissions, page_permissions, profiles:user_id(email, full_name, phone)')
      .eq('org_id', orgId),
    supabase
      .from('user_access')
      .select('user_id, org_id, scope, scope_id, role, is_active, expires_at')
      .eq('org_id', orgId)
      .eq('is_active', true),
    supabase
      .from('stakeholders')
      .select('id, org_id, property_id, portfolio_id, tenant_id, name, email, phone, role')
      .eq('org_id', orgId),
    supabase
      .from('notification_preferences')
      .select('user_id, email_enabled, sms_enabled')
      .eq('org_id', orgId),
  ]);

  const memberships = (membershipsResult.data || []).map((membership) => ({
    ...membership,
    email: membership.profiles?.email,
    full_name: membership.profiles?.full_name,
    phone: membership.phone || membership.profiles?.phone,
  }));

  return {
    memberships,
    userAccess: accessResult.data || [],
    stakeholders: stakeholdersResult.data || [],
    notificationPreferences: preferencesResult.data || [],
    profilesByUserId: Object.fromEntries(memberships.map((membership) => [membership.user_id, membership.profiles || {}])),
  };
}

export function resolveBusinessNotificationEvent(event, context = {}) {
  return resolveNotificationRecipients(normalizeEvent(event), context);
}

export async function createNotificationsForEvent(event, options = {}) {
  const normalizedEvent = normalizeEvent(event);
  const context = options.context || await fetchNotificationContext(normalizedEvent.org_id);
  const resolution = resolveNotificationRecipients(normalizedEvent, context);
  const created = [];
  const deliveries = [];

  await logAudit({
    action: 'notification_event_created',
    entityType: 'NotificationEvent',
    orgId: normalizedEvent.org_id,
    details: {
      event_type: normalizedEvent.event_type,
      entity_type: normalizedEvent.entity_type,
      entity_id: normalizedEvent.entity_id,
      portfolio_id: normalizedEvent.portfolio_id,
      property_id: normalizedEvent.property_id,
    },
  });

  for (const recipient of resolution.recipients) {
    const notificationPayload = logicalNotificationPayload(normalizedEvent, recipient);
    const notification = await notificationService.create(notificationPayload);
    created.push(notification || notificationPayload);

    await logAudit({
      action: 'notification_recipient_resolved',
      entityType: 'Notification',
      entityId: notification?.id,
      orgId: normalizedEvent.org_id,
      details: {
        recipient_user_id: recipient.userId || null,
        external_recipient_id: recipient.id || null,
        event_type: recipient.eventType,
        matching_reasons: recipient.matchingReasons,
      },
    });

    for (const channel of recipient.channels) {
      await safeCreateDelivery(deliveryPayload(notification?.id, recipient, channel));
      const dispatchResult = options.dispatch === false
        ? { status: 'queued' }
        : await dispatchNotificationChannel(notification || notificationPayload, recipient, channel);
      const delivery = await safeCreateDelivery(deliveryPayload(notification?.id, recipient, channel, dispatchResult));
      deliveries.push(delivery || { channel, ...dispatchResult });

      await logAudit({
        action: `notification_${channel}_${dispatchResult.status || 'queued'}`,
        entityType: 'Notification',
        entityId: notification?.id,
        orgId: normalizedEvent.org_id,
        details: {
          event_type: recipient.eventType,
          recipient_user_id: recipient.userId || null,
          status: dispatchResult.status,
          error_message: dispatchResult.error_message || null,
        },
        severity: dispatchResult.status === 'failed' ? 'warning' : 'info',
      });
    }
  }

  return {
    ...resolution,
    notifications: created,
    deliveries,
  };
}

export async function getNotificationPreferences(userId, orgId) {
  if (!userId || !orgId) return null;
  const rows = await notificationPreferenceService.filter({ user_id: userId, org_id: orgId });
  return rows?.[0] || null;
}

export async function upsertNotificationPreferences({ userId, orgId, emailEnabled = true, smsEnabled = true }) {
  if (!userId || !orgId) throw new Error('userId and orgId are required for notification preferences');

  if (supabase) {
    const { data, error } = await supabase
      .from('notification_preferences')
      .upsert({
        user_id: userId,
        org_id: orgId,
        email_enabled: emailEnabled,
        sms_enabled: smsEnabled,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,org_id' })
      .select()
      .single();
    if (error) throw error;
    await logAudit({
      action: 'notification_preferences_updated',
      entityType: 'NotificationPreference',
      orgId,
      details: { user_id: userId, email_enabled: emailEnabled, sms_enabled: smsEnabled },
    });
    return data;
  }

  return notificationPreferenceService.create({
    user_id: userId,
    org_id: orgId,
    email_enabled: emailEnabled,
    sms_enabled: smsEnabled,
  });
}

export async function markNotificationRead(id) {
  return notificationService.update(id, {
    is_read: true,
    read_at: new Date().toISOString(),
  });
}

export function assertWorkflowApprovalAuthority(params) {
  const result = canApproveWorkflow(params);
  if (!result.allowed) {
    const error = new Error(`Approval denied: ${result.reason}`);
    error.code = result.reason;
    error.permission = result.permission;
    throw error;
  }
  return result;
}

export {
  NOTIFICATION_EVENT_PERMISSIONS,
  NOTIFICATION_EVENT_POLICIES,
};

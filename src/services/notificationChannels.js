import { invokeEdgeFunction } from "@/services/edgeFunctions";
import { NOTIFICATION_CHANNELS } from "@/lib/notifications/notificationConstants";

function compactSms(message, actionUrl) {
  const suffix = actionUrl ? ` Review: ${actionUrl}` : "";
  const maxBodyLength = Math.max(40, 160 - suffix.length);
  const body = String(message || "").replace(/\s+/g, " ").trim();
  const trimmed = body.length > maxBodyLength ? `${body.slice(0, maxBodyLength - 1)}…` : body;
  return `${trimmed}${suffix}`;
}

export function buildEmailPayload(notification, recipient) {
  const actionUrl = notification.action_url || notification.link || "";
  const orgId = recipient.orgId || notification.org_id || notification.organization_id || "";
  return {
    to: recipient.email || undefined,
    recipientUserId: recipient.userId || null,
    orgId,
    templateId: "generic_internal_notification",
    variables: {
      subject: notification.title,
      message: [
        notification.message,
        actionUrl ? `Action: ${actionUrl}` : "",
      ].filter(Boolean).join("\n\n"),
      action_url: actionUrl,
      notification_type: notification.notification_type,
      module: notification.module,
      event_type: notification.event_type || notification.type,
      recipient_name: recipient.displayName || recipient.email,
      recipient_user_id: recipient.userId || null,
      org_id: orgId,
    },
  };
}

export function buildSmsPayload(notification, recipient) {
  const actionUrl = notification.action_url || notification.link || "";
  const orgId = recipient.orgId || notification.org_id || notification.organization_id || "";
  return {
    to: recipient.phone || undefined,
    recipientUserId: recipient.userId || null,
    orgId,
    message: compactSms(notification.message || notification.title, actionUrl),
    metadata: {
      notification_id: notification.id,
      event_type: notification.event_type || notification.type,
      module: notification.module,
      recipient_user_id: recipient.userId || null,
      org_id: orgId,
    },
  };
}

export async function dispatchEmailNotification(notification, recipient) {
  if (!recipient.email && !recipient.userId) {
    return { status: "skipped", error_message: "Recipient has no email address or user id" };
  }

  try {
    const result = await invokeEdgeFunction("send-email", buildEmailPayload(notification, recipient));
    return {
      status: "sent",
      provider_message_id: result?.id || result?.message_id || null,
      sent_at: new Date().toISOString(),
    };
  } catch (error) {
    return {
      status: "failed",
      failed_at: new Date().toISOString(),
      error_message: error?.message || String(error),
    };
  }
}

export async function dispatchSmsNotification(notification, recipient) {
  if (!recipient.phone && !recipient.userId) {
    return { status: "skipped", error_message: "Recipient has no phone number or user id" };
  }

  const smsFunctionName = import.meta.env?.VITE_SMS_EDGE_FUNCTION_NAME || "send-sms";

  try {
    const result = await invokeEdgeFunction(smsFunctionName, buildSmsPayload(notification, recipient));
    return {
      status: "sent",
      provider_message_id: result?.id || result?.message_id || null,
      sent_at: new Date().toISOString(),
    };
  } catch (error) {
    return {
      status: "failed",
      failed_at: new Date().toISOString(),
      error_message: error?.message || String(error),
    };
  }
}

export async function dispatchNotificationChannel(notification, recipient, channel) {
  if (channel === NOTIFICATION_CHANNELS.EMAIL) return dispatchEmailNotification(notification, recipient);
  if (channel === NOTIFICATION_CHANNELS.SMS) return dispatchSmsNotification(notification, recipient);
  return { status: "skipped", error_message: `Unsupported notification channel: ${channel}` };
}

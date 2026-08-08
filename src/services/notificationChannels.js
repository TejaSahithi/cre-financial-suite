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
  return {
    to: recipient.email,
    templateId: "generic_internal_notification",
    variables: {
      subject: notification.title,
      message: [
        notification.message,
        notification.action_url ? `Action: ${notification.action_url}` : "",
      ].filter(Boolean).join("\n\n"),
      action_url: notification.action_url || "",
      notification_type: notification.notification_type,
      module: notification.module,
    },
  };
}

export function buildSmsPayload(notification, recipient) {
  return {
    to: recipient.phone,
    message: compactSms(notification.message || notification.title, notification.action_url),
    metadata: {
      notification_id: notification.id,
      event_type: notification.event_type,
      module: notification.module,
    },
  };
}

export async function dispatchEmailNotification(notification, recipient) {
  if (!recipient.email) {
    return { status: "skipped", error_message: "Recipient has no email address" };
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
  if (!recipient.phone) {
    return { status: "skipped", error_message: "Recipient has no phone number" };
  }

  const smsFunctionName = import.meta.env?.VITE_SMS_EDGE_FUNCTION_NAME || "";
  if (!smsFunctionName) {
    return {
      status: "provider_unconfigured",
      error_message: "SMS provider is not configured. Set VITE_SMS_EDGE_FUNCTION_NAME to enable SMS delivery.",
    };
  }

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


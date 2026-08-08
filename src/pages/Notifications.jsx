import React, { useEffect, useMemo, useState } from "react";
import useOrgQuery from "@/hooks/useOrgQuery";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getNotificationPreferences,
  markNotificationRead,
  notificationService,
  upsertNotificationPreferences,
} from "@/services/notificationService";
import { useAuth } from "@/lib/AuthContext";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  Clock,
  DollarSign,
  Info,
  Mail,
  MessageSquare,
  ShieldCheck,
  X,
} from "lucide-react";

const typeIcons = {
  ACTION_REQUIRED: AlertTriangle,
  INFORMATIONAL: Info,
  WARNING: AlertTriangle,
  CRITICAL: AlertTriangle,
  APPROVAL_REQUIRED: Clock,
  APPROVED: CheckCircle2,
  REJECTED: X,
  CORRECTION_REQUIRED: AlertTriangle,
  SYSTEM_ERROR: AlertTriangle,
  lease_expiry: AlertTriangle,
  budget_approval: Clock,
  cam_variance: AlertTriangle,
  reconciliation_pending: Clock,
  expense_threshold: DollarSign,
  system: Info,
  info: Info,
  warning: AlertTriangle,
  success: CheckCircle2,
};

const typeStyles = {
  ACTION_REQUIRED: "border-l-[var(--warning)] bg-[var(--warning-soft)]",
  INFORMATIONAL: "border-l-[var(--info)] bg-[var(--surface)]",
  WARNING: "border-l-[var(--warning)] bg-[var(--warning-soft)]",
  CRITICAL: "border-l-[var(--danger)] bg-[var(--danger-soft)]",
  APPROVAL_REQUIRED: "border-l-[var(--accent)] bg-[var(--accent-soft)]",
  APPROVED: "border-l-[var(--success)] bg-[var(--success-soft)]",
  REJECTED: "border-l-[var(--danger)] bg-[var(--danger-soft)]",
  CORRECTION_REQUIRED: "border-l-[var(--warning)] bg-[var(--warning-soft)]",
  SYSTEM_ERROR: "border-l-[var(--danger)] bg-[var(--danger-soft)]",
};

function getClassification(notification) {
  return notification.notification_type || notification.type || "INFORMATIONAL";
}

function isRead(notification) {
  return Boolean(notification.read_at || notification.is_read);
}

export default function Notifications() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { data: notifications = [], orgId } = useOrgQuery("Notification");
  const [preferences, setPreferences] = useState({ email_enabled: true, sms_enabled: true });
  const [preferencesLoading, setPreferencesLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function loadPreferences() {
      if (!user?.id || !orgId || orgId === "__none__") return;
      setPreferencesLoading(true);
      try {
        const row = await getNotificationPreferences(user.id, orgId);
        if (!cancelled && row) {
          setPreferences({
            email_enabled: row.email_enabled !== false,
            sms_enabled: row.sms_enabled !== false,
          });
        }
      } catch (error) {
        console.warn("[Notifications] preferences unavailable:", error?.message || error);
      } finally {
        if (!cancelled) setPreferencesLoading(false);
      }
    }
    loadPreferences();
    return () => {
      cancelled = true;
    };
  }, [orgId, user?.id]);

  const stats = useMemo(() => {
    const unread = notifications.filter((notification) => !isRead(notification)).length;
    const actionRequired = notifications.filter((notification) =>
      ["ACTION_REQUIRED", "APPROVAL_REQUIRED", "CORRECTION_REQUIRED"].includes(getClassification(notification)) &&
      !isRead(notification)
    ).length;
    const critical = notifications.filter((notification) =>
      ["CRITICAL", "SYSTEM_ERROR"].includes(getClassification(notification))
    ).length;
    return { unread, actionRequired, critical };
  }, [notifications]);

  const markRead = useMutation({
    mutationFn: (id) => markNotificationRead(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["Notification", orgId] }),
  });

  const markAllRead = useMutation({
    mutationFn: async () => {
      const unreadItems = notifications.filter((notification) => !isRead(notification));
      for (const notification of unreadItems) {
        await markNotificationRead(notification.id);
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["Notification", orgId] }),
  });

  const deleteNotification = useMutation({
    mutationFn: (id) => notificationService.delete(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["Notification", orgId] }),
  });

  const savePreference = useMutation({
    mutationFn: (nextPreferences) => upsertNotificationPreferences({
      userId: user.id,
      orgId,
      emailEnabled: nextPreferences.email_enabled,
      smsEnabled: nextPreferences.sms_enabled,
    }),
    onSuccess: (row) => {
      setPreferences({
        email_enabled: row.email_enabled !== false,
        sms_enabled: row.sms_enabled !== false,
      });
    },
  });

  const updatePreference = (key, value) => {
    const nextPreferences = { ...preferences, [key]: value };
    setPreferences(nextPreferences);
    if (user?.id && orgId && orgId !== "__none__") {
      savePreference.mutate(nextPreferences);
    }
  };

  return (
    <div className="p-6 space-y-6 bg-[var(--bg)] min-h-screen">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-[28px] font-bold text-[var(--ink)] tracking-[-0.03em]">Notification Center</h1>
            {stats.unread > 0 && <Badge className="bg-[var(--danger-soft)] text-[var(--danger)] border border-[color-mix(in_srgb,var(--danger)_35%,var(--border-cre))]">{stats.unread} unread</Badge>}
          </div>
          <p className="text-sm text-[var(--muted)] mt-1">
            Role, permission, scope, and workflow-aware alerts for your organization.
          </p>
        </div>

        <Card className="border-[var(--border-cre)] bg-[var(--surface)] shadow-[var(--card-shadow)]">
          <CardContent className="p-4 flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="flex items-center gap-2 text-sm font-semibold text-[var(--ink)]">
              <ShieldCheck className="h-4 w-4 text-[var(--accent)]" />
              Delivery Preferences
            </div>
            <div className="flex items-center gap-5">
              <label className="flex items-center gap-2 text-xs font-semibold text-[var(--muted)]">
                <Mail className="h-4 w-4" />
                Email
                <Switch
                  checked={preferences.email_enabled}
                  disabled={preferencesLoading || savePreference.isPending}
                  onCheckedChange={(checked) => updatePreference("email_enabled", checked)}
                />
              </label>
              <label className="flex items-center gap-2 text-xs font-semibold text-[var(--muted)]">
                <MessageSquare className="h-4 w-4" />
                SMS
                <Switch
                  checked={preferences.sms_enabled}
                  disabled={preferencesLoading || savePreference.isPending}
                  onCheckedChange={(checked) => updatePreference("sms_enabled", checked)}
                />
              </label>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card className="border-[var(--border-cre)] bg-[var(--surface)] shadow-[var(--card-shadow)]">
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold text-[var(--muted)] uppercase tracking-[0.14em]">Total</p>
            <p className="text-2xl font-bold text-[var(--ink)] tabular-nums">{notifications.length}</p>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-[var(--danger)] bg-[var(--surface)] shadow-[var(--card-shadow)]">
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold text-[var(--danger)] uppercase tracking-[0.14em]">Unread</p>
            <p className="text-2xl font-bold text-[var(--danger)] tabular-nums">{stats.unread}</p>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-[var(--accent)] bg-[var(--surface)] shadow-[var(--card-shadow)]">
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold text-[var(--accent)] uppercase tracking-[0.14em]">Pending Action</p>
            <p className="text-2xl font-bold text-[var(--ink)] tabular-nums">{stats.actionRequired}</p>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-[var(--warning)] bg-[var(--surface)] shadow-[var(--card-shadow)]">
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold text-[var(--warning)] uppercase tracking-[0.14em]">Critical</p>
            <p className="text-2xl font-bold text-[var(--ink)] tabular-nums">{stats.critical}</p>
          </CardContent>
        </Card>
      </div>

      <div className="flex items-center justify-end">
        {stats.unread > 0 && (
          <Button variant="outline" size="sm" onClick={() => markAllRead.mutate()} disabled={markAllRead.isPending}>
            Mark All Read
          </Button>
        )}
      </div>

      {notifications.length === 0 ? (
        <Card className="border-[var(--border-cre)] bg-[var(--surface)] shadow-[var(--card-shadow)]">
          <CardContent className="py-16 text-center">
            <Bell className="w-12 h-12 text-[var(--border-strong)] mx-auto mb-4" />
            <p className="text-lg font-semibold text-[var(--muted)]">No notifications yet</p>
            <p className="text-sm text-[var(--muted)] mt-1">
              Notifications appear when scoped workflows require review, approval, action, or awareness.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {notifications.map((notification) => {
            const classification = getClassification(notification);
            const Icon = typeIcons[classification] || typeIcons[notification.type] || Info;
            const read = isRead(notification);
            const metadata = notification.metadata || {};
            return (
              <Card
                key={notification.id}
                className={`border-l-4 border-[var(--border-cre)] ${typeStyles[classification] || "border-l-[var(--border-strong)] bg-[var(--surface)]"} ${read ? "opacity-70" : ""}`}
              >
                <CardContent className="p-5 flex items-start justify-between gap-4">
                  <div className="flex items-start gap-4 min-w-0">
                    <Icon className="w-5 h-5 text-[var(--muted)] mt-0.5 flex-shrink-0" />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-bold text-[var(--ink)]">{notification.title}</p>
                        {!read && <div className="w-2 h-2 rounded-full bg-[var(--accent)]" />}
                        <Badge variant="outline" className="text-[9px] uppercase tracking-[0.12em] border-[var(--border-cre)] text-[var(--muted)]">
                          {classification.replace(/_/g, " ")}
                        </Badge>
                        {notification.requires_action && <Badge className="bg-[var(--accent)] text-white text-[9px]">ACTION</Badge>}
                      </div>
                      <p className="text-sm text-[var(--muted)] mt-1">{notification.message}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-[var(--muted)]">
                        {notification.module && <span className="font-semibold uppercase tracking-[0.12em]">{notification.module}</span>}
                        {metadata.matching_reasons?.length > 0 && <span>{metadata.matching_reasons.length} eligibility reason{metadata.matching_reasons.length === 1 ? "" : "s"}</span>}
                        <span>
                          {notification.created_at || notification.created_date
                            ? new Date(notification.created_at || notification.created_date).toLocaleString()
                            : ""}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {!read && (
                      <Button variant="ghost" size="sm" className="text-xs" onClick={() => markRead.mutate(notification.id)}>
                        Mark read
                      </Button>
                    )}
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => deleteNotification.mutate(notification.id)}>
                      <X className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}


import React, { useEffect, useMemo, useState } from "react";
import { Loader2, Send, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { createNotificationsForEvent } from "@/services/notificationService";
import { supabase } from "@/services/supabaseClient";
import { useAuth } from "@/lib/AuthContext";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const APPROVAL_ROLE_KEYS = new Set([
  "org_owner",
  "owner",
  "org_admin",
  "admin",
  "portfolio_manager",
  "property_manager",
  "finance",
  "custom",
  "custom_role",
]);

const ACTIVE_STATUSES = new Set(["active", "owner", "approved", "accepted"]);

function roleLabel(role) {
  return String(role || "member")
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeRole(role) {
  return String(role || "").trim().toLowerCase();
}

function normalizeObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function memberDisplayName(member) {
  return member.full_name || member.email || roleLabel(member.role);
}

export default function SendForApprovalButton({
  orgId,
  eventType,
  entityType,
  entityId,
  entityLabel,
  portfolioId = null,
  propertyId = null,
  actionUrl = "",
  metadata = {},
  onBeforeSend = null,
  onSent = null,
  disabled = false,
  className = "",
  variant = "outline",
  size,
  title,
}) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [sending, setSending] = useState(false);
  const [members, setMembers] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  const [note, setNote] = useState("");

  const canOpen = Boolean(orgId && eventType && entityType && entityId) && !disabled;

  useEffect(() => {
    if (!open || !orgId || !supabase) return;

    let cancelled = false;
    const loadMembers = async () => {
      setLoadingMembers(true);
      try {
        const { data: membershipRows, error: membershipError } = await supabase
          .from("memberships")
          .select("id,user_id,role,status,custom_role,capabilities")
          .eq("org_id", orgId);

        if (membershipError) throw membershipError;

        const activeMemberships = (membershipRows || [])
          .filter((membership) => ACTIVE_STATUSES.has(String(membership.status || "active").toLowerCase()))
          .filter((membership) => membership.user_id && membership.user_id !== user?.id)
          .filter((membership) => {
            const role = normalizeRole(membership.role);
            const capabilities = normalizeObject(membership.capabilities);
            const capabilityRoles = Array.isArray(capabilities.roles)
              ? capabilities.roles.map(normalizeRole)
              : [];
            return Boolean(membership.custom_role) ||
              APPROVAL_ROLE_KEYS.has(role) ||
              capabilityRoles.some((capabilityRole) => APPROVAL_ROLE_KEYS.has(capabilityRole));
          });

        const profileIds = [...new Set(activeMemberships.map((membership) => membership.user_id).filter(Boolean))];
        const { data: profileRows, error: profileError } = profileIds.length > 0
          ? await supabase
              .from("profiles")
              .select("id,email,full_name,phone")
              .in("id", profileIds)
          : { data: [], error: null };

        if (profileError) throw profileError;

        const profilesById = new Map((profileRows || []).map((profile) => [profile.id, profile]));
        const rows = activeMemberships
          .map((membership) => {
            const profile = profilesById.get(membership.user_id) || {};
            return {
              id: membership.id,
              user_id: membership.user_id,
              role: membership.custom_role || membership.role,
              full_name: profile.full_name,
              email: profile.email,
            };
          })
          .sort((a, b) => memberDisplayName(a).localeCompare(memberDisplayName(b)));

        if (!cancelled) {
          setMembers(rows);
          setSelectedIds((current) => current.filter((id) => rows.some((member) => member.user_id === id)));
        }
      } catch (error) {
        if (!cancelled) {
          console.warn("[SendForApprovalButton] could not load approval recipients:", error?.message || error);
          toast.error(error?.message || "Could not load approval recipients");
        }
      } finally {
        if (!cancelled) setLoadingMembers(false);
      }
    };

    loadMembers();
    return () => {
      cancelled = true;
    };
  }, [open, orgId, user?.id]);

  const selectedMembers = useMemo(
    () => members.filter((member) => selectedIds.includes(member.user_id)),
    [members, selectedIds]
  );

  const toggleMember = (userId) => {
    setSelectedIds((current) =>
      current.includes(userId)
        ? current.filter((id) => id !== userId)
        : [...current, userId]
    );
  };

  const handleSend = async () => {
    if (selectedIds.length === 0) {
      toast.error("Select at least one approver.");
      return;
    }

    setSending(true);
    try {
      const beforeSendResult = typeof onBeforeSend === "function"
        ? await onBeforeSend({
            selectedIds,
            selectedMembers,
            note: note.trim(),
          })
        : {};
      const updatedEntity = beforeSendResult?.entity || {};
      const updatedMetadata = beforeSendResult?.metadata || {};
      const emailAttachments = Array.isArray(beforeSendResult?.emailAttachments)
        ? beforeSendResult.emailAttachments
        : [];

      await createNotificationsForEvent({
        org_id: orgId,
        event_type: eventType,
        entity_type: entityType,
        entity_id: entityId,
        entity_label: updatedEntity.entityLabel || updatedEntity.name || entityLabel,
        portfolio_id: updatedEntity.portfolio_id || portfolioId,
        property_id: updatedEntity.property_id || propertyId,
        action_url: updatedEntity.actionUrl || actionUrl,
        assigned_user_ids: selectedIds,
        title: `${entityLabel || "This item"} needs approval`,
        message: note.trim()
          ? `${entityLabel || "This item"} was sent for approval. Note: ${note.trim()}`
          : `${entityLabel || "This item"} was sent for approval.`,
        email_attachments: emailAttachments,
        metadata: {
          ...metadata,
          ...updatedMetadata,
          source: metadata.source || "manual_send_for_approval",
          approval_note: note.trim() || null,
          approval_recipient_ids: selectedIds,
        },
      });

      toast.success(`Sent for approval to ${selectedIds.length} member${selectedIds.length === 1 ? "" : "s"}.`);
      if (typeof onSent === "function") {
        await onSent({
          selectedIds,
          selectedMembers,
          note: note.trim(),
          result: beforeSendResult,
        });
      }
      setOpen(false);
      setNote("");
      setSelectedIds([]);
    } catch (error) {
      console.error("[SendForApprovalButton] send failed:", error);
      toast.error(error?.message || "Could not send for approval");
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size}
        className={cn("border-amber-300 text-amber-800 hover:bg-amber-50", className)}
        disabled={!canOpen || sending}
        title={title}
        onClick={() => setOpen(true)}
      >
        <Send className="mr-2 h-4 w-4" />
        Send for Approval
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-amber-600" />
              Send for Approval
            </DialogTitle>
            <DialogDescription>
              Choose the team members who should review and approve this workflow item.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
              <div className="font-medium text-slate-900">{entityLabel || "Selected item"}</div>
              <div className="mt-0.5 text-xs text-slate-500">{eventType?.replace(/\./g, " ")}</div>
            </div>

            <div className="space-y-2">
              <Label className="text-xs font-semibold uppercase text-slate-500">Approvers</Label>
              <div className="max-h-72 overflow-y-auto rounded-md border border-slate-200">
                {loadingMembers ? (
                  <div className="flex items-center justify-center gap-2 py-8 text-sm text-slate-500">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading team members...
                  </div>
                ) : members.length === 0 ? (
                  <div className="px-4 py-6 text-center text-sm text-slate-500">
                    No active approvers found in this organization.
                  </div>
                ) : (
                  members.map((member) => (
                    <label
                      key={member.id || member.user_id}
                      className="flex cursor-pointer items-start gap-3 border-b border-slate-100 px-4 py-3 last:border-b-0 hover:bg-slate-50"
                    >
                      <Checkbox
                        checked={selectedIds.includes(member.user_id)}
                        onCheckedChange={() => toggleMember(member.user_id)}
                        className="mt-0.5"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-slate-900">{memberDisplayName(member)}</span>
                        <span className="block truncate text-xs text-slate-500">{member.email || "No email on profile"}</span>
                      </span>
                      <Badge variant="outline" className="shrink-0 text-[10px]">
                        {roleLabel(member.role)}
                      </Badge>
                    </label>
                  ))
                )}
              </div>
              {selectedMembers.length > 0 && (
                <div className="text-xs text-slate-500">
                  Selected: {selectedMembers.map(memberDisplayName).join(", ")}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="approval-note" className="text-xs font-semibold uppercase text-slate-500">Note</Label>
              <Textarea
                id="approval-note"
                rows={3}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Add context for the approver..."
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={sending}>
              Cancel
            </Button>
            <Button onClick={handleSend} disabled={sending || selectedIds.length === 0} className="bg-slate-900 hover:bg-slate-800">
              {sending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
              Send Request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

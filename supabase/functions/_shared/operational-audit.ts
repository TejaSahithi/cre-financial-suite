// @ts-nocheck

export function operationalStatus(status: unknown): string {
  const value = String(status || "").trim().toLowerCase();
  if (value === "needs_review" || value === "requires_review" || value === "submitted") return "pending_review";
  if (value === "compliant") return "approved";
  if (value === "eligible") return "approved";
  return value || "pending_review";
}

export async function writeOperationalAudit(supabaseAdmin: any, input: {
  orgId: string;
  entityType: string;
  entityId?: string | null;
  action: string;
  actorEmail?: string | null;
  actorUserId?: string | null;
  propertyId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  reason?: string | null;
  source?: string | null;
}) {
  try {
    await supabaseAdmin.from("audit_logs").insert({
      org_id: input.orgId,
      entity_type: input.entityType,
      entity_id: input.entityId || null,
      action: input.action,
      user_email: input.actorEmail || null,
      property_id: input.propertyId || null,
      old_value: input.oldValue == null ? null : JSON.stringify(input.oldValue),
      new_value: JSON.stringify({
        value: input.newValue ?? null,
        actor_user_id: input.actorUserId || null,
        reason: input.reason || null,
        source: input.source || null,
      }),
    });
  } catch (error) {
    console.warn(`[operational-audit] ${input.action} audit skipped:`, error?.message || error);
  }
}

export function financialSeverity(exception: Record<string, unknown>): "low" | "medium" | "high" | "critical" {
  const variancePercent = Number(exception?.variancePercent ?? 0);
  if (String(exception?.code) === "UNBUDGETED_EXPENSE") return "high";
  if (variancePercent >= 100) return "critical";
  if (variancePercent >= 50) return "high";
  if (variancePercent >= 25) return "medium";
  return "low";
}

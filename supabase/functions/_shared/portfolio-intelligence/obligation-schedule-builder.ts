// @ts-nocheck

export function buildObligationSchedule(obligation: any, anchors: Record<string, string | null> = {}) {
  const rule = obligation?.dueRule;
  if (!rule) return { ...obligation, status: obligation.status ?? "partially_resolved", nextDueDate: obligation.nextDueDate ?? null };
  if (rule.relation === "on" && obligation.nextDueDate) return { ...obligation, status: "resolved" };
  const anchorDate = anchors[rule.anchor] ?? null;
  if (!anchorDate) return { ...obligation, status: "missing_anchor", nextDueDate: null, reasonCodes: [...new Set([...(obligation.reasonCodes ?? []), "anchor_date_unresolved"])] };
  const date = new Date(`${anchorDate}T00:00:00Z`);
  const offset = Number(rule.offsetDays ?? 0) * (rule.relation === "before" ? -1 : 1);
  date.setUTCDate(date.getUTCDate() + offset);
  return { ...obligation, status: "resolved", nextDueDate: date.toISOString().slice(0, 10) };
}

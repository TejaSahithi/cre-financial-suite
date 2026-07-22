// @ts-nocheck

export function evaluateObligationStatus(obligation: any) {
  if (obligation.status === "not_applicable") return obligation;
  if (obligation.nextDueDate || obligation.dueRule?.relation === "on") return { ...obligation, status: "resolved" };
  if (obligation.dueRule?.anchor && !obligation.nextDueDate) return { ...obligation, status: "missing_anchor" };
  return { ...obligation, status: obligation.status ?? "partially_resolved" };
}

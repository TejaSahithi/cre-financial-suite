// @ts-nocheck
export function requestSupportAccess(args) {
  return { ...args, status: "requested", createdAt: args.now, reasonCodes: ["support_access_requested"] };
}
export function approveSupportAccess(request, approval) {
  if (!request.reason || !request.ticketReference) return { approved: false, reasonCodes: ["support_reason_and_ticket_required"] };
  if (!approval.approverId || approval.approverId === request.operatorId) return { approved: false, reasonCodes: ["independent_approval_required"] };
  return { ...request, status: "approved", approvedBy: approval.approverId, expiresAt: approval.expiresAt, allowedActions: approval.allowedActions, includeSensitiveEvidence: Boolean(approval.includeSensitiveEvidence), reasonCodes: ["support_access_approved"] };
}
export function isSupportAccessActive(access, now = new Date()) {
  return Boolean(access?.status === "approved" && Date.parse(access.expiresAt) > now.getTime());
}
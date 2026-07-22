// @ts-nocheck

export function createDeadLetter(args: { delivery: any; event: any; failedPayload: any; failureReason: string; attempts: any[]; lastError?: string | null; recoveryAction?: string | null }) {
  return {
    organizationId: args.event.organizationId ?? args.event.organization_id ?? args.delivery.organizationId,
    deliveryId: args.delivery.id ?? null,
    eventId: args.event.id ?? null,
    endpointId: args.delivery.endpointId ?? args.delivery.endpoint_id ?? null,
    failedPayload: args.failedPayload,
    failureReason: args.failureReason,
    retryHistory: args.attempts.map((attempt) => ({ attemptNumber: attempt.attemptNumber, status: attempt.status, errorCode: attempt.errorCode, retryable: attempt.retryable })),
    lastError: args.lastError ?? null,
    recoveryAction: args.recoveryAction ?? "replay_after_correction",
    replayStatus: "not_replayed",
  };
}

export function replayDeadLetter(deadLetter: any) {
  if (deadLetter.replayStatus === "replayed") return { replayQueued: false, reasonCode: "already_replayed" };
  return { replayQueued: true, reasonCode: "queued_for_replay", deliveryPayload: deadLetter.failedPayload };
}

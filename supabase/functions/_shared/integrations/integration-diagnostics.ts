// @ts-nocheck

export function summarizeIntegrationDiagnostics(args: { deliveries: any[]; deadLetters: any[]; replays?: any[]; endpoints?: any[] }) {
  const delivered = args.deliveries.filter((delivery) => delivery.deliveryStatus === "delivered" || delivery.delivery_status === "delivered").length;
  const failures = args.deliveries.filter((delivery) => ["failed", "dead_lettered"].includes(delivery.deliveryStatus ?? delivery.delivery_status)).length;
  const retries = args.deliveries.reduce((sum, delivery) => sum + Number(delivery.attemptCount ?? delivery.attempt_count ?? 0), 0);
  const latencies = args.deliveries.map((delivery) => Number(delivery.latencyMs ?? delivery.latency_ms)).filter(Number.isFinite);
  return {
    successfulDeliveries: delivered,
    retries,
    failures,
    averageLatencyMs: latencies.length ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : 0,
    deadLetters: args.deadLetters.length,
    replayCount: args.replays?.length ?? 0,
    connectorUptime: Object.fromEntries((args.endpoints ?? []).map((endpoint) => [endpoint.connectorKey ?? endpoint.connector_key, endpoint.status === "enabled" ? 1 : 0])),
  };
}

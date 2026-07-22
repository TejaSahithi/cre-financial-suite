// @ts-nocheck
export function backpressureState(thresholds, queue) {
  if (queue.depth >= thresholds.hardDepth) return { state: "hard_limit", acceptNewWork: false, reasonCodes: ["queue_hard_backpressure"] };
  if (queue.depth >= thresholds.warningDepth) return { state: "warning", acceptNewWork: true, reasonCodes: ["queue_backpressure_warning"] };
  return { state: "healthy", acceptNewWork: true, reasonCodes: ["queue_healthy"] };
}
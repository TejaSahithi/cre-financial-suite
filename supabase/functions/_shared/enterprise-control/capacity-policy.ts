// @ts-nocheck
export function capacityDecision(policy, observed) {
  const failures = [];
  if (observed.concurrentJobs > policy.maxConcurrentJobs) failures.push("organization_concurrency_exceeded");
  if (observed.queueDepth > policy.maxQueueDepth) failures.push("queue_depth_exceeded");
  if (observed.exportBytes > policy.maxExportBytes) failures.push("export_size_exceeded");
  return { allowed: failures.length === 0, reasonCodes: failures.length ? failures : ["capacity_available"] };
}
// @ts-nocheck
import { evaluateRetention } from "./retention-policy.ts";
export function planRetentionDeletion(policies, artifacts, now = new Date()) {
  return artifacts.map((artifact) => {
    const policy = policies.find((p) => p.artifactClass === artifact.artifactClass);
    const decision = evaluateRetention(policy, artifact, now);
    return { artifactId: artifact.id, artifactClass: artifact.artifactClass, ...decision };
  });
}
// @ts-nocheck
import { credentialPolicyState } from "./credential-policy.ts";
export function credentialHealthSummary(credentials, now = new Date()) {
  const states = credentials.map((credential) => credentialPolicyState(credential, now).state);
  return { healthy: states.every((state) => state === "healthy"), states, alertCount: states.filter((state) => state !== "healthy").length };
}
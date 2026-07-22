// @ts-nocheck
export function credentialPolicyState(credential, now = new Date()) {
  if (credential.revokedAt) return { state: "revoked", reasonCodes: ["credential_revoked"] };
  if (credential.expiresAt && Date.parse(credential.expiresAt) <= now.getTime()) return { state: "expired", reasonCodes: ["credential_expired"] };
  if (credential.expiresAt && Date.parse(credential.expiresAt) - now.getTime() <= 14 * 86400000) return { state: "expiring", reasonCodes: ["credential_nearing_expiry"] };
  if (credential.lastUsedAt && now.getTime() - Date.parse(credential.lastUsedAt) > 90 * 86400000) return { state: "stale", reasonCodes: ["credential_unused_beyond_policy"] };
  return { state: "healthy", reasonCodes: ["credential_healthy"] };
}
// @ts-nocheck
export function rotateCredential(current, next, now) {
  if (!next?.fingerprint || next.fingerprint === current?.fingerprint) return { rotated: false, reasonCodes: ["new_fingerprint_required"] };
  return { rotated: true, previousFingerprint: current?.fingerprint, activeFingerprint: next.fingerprint, rotatedAt: now, reasonCodes: ["credential_rotated"] };
}
export function revokeCredential(credential, now, reason = "emergency_revocation") { return { ...credential, status: "revoked", revokedAt: now, reasonCodes: [reason] }; }
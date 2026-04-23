const ACTING_ORG_STORAGE_KEY = "cre.acting_org_id";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeActingOrgId(orgId) {
  if (typeof orgId !== "string") return null;
  const trimmed = orgId.trim();
  return UUID_RE.test(trimmed) ? trimmed : null;
}

export function getStoredActingOrgId() {
  if (typeof window === "undefined") return null;

  try {
    const value = window.localStorage.getItem(ACTING_ORG_STORAGE_KEY);
    const normalized = normalizeActingOrgId(value);
    if (value && !normalized) {
      window.localStorage.removeItem(ACTING_ORG_STORAGE_KEY);
    }
    return normalized;
  } catch {
    return null;
  }
}

export function setStoredActingOrgId(orgId) {
  if (typeof window === "undefined") return;

  try {
    const normalized = normalizeActingOrgId(orgId);
    if (normalized) {
      window.localStorage.setItem(ACTING_ORG_STORAGE_KEY, normalized);
    } else {
      window.localStorage.removeItem(ACTING_ORG_STORAGE_KEY);
    }
  } catch {
    // Ignore storage failures and fall back to auth-scoped org resolution.
  }
}

export function clearStoredActingOrgId() {
  setStoredActingOrgId(null);
}

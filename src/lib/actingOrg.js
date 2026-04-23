const ACTING_ORG_STORAGE_KEY = "cre.acting_org_id";

export function getStoredActingOrgId() {
  if (typeof window === "undefined") return null;

  try {
    const value = window.localStorage.getItem(ACTING_ORG_STORAGE_KEY);
    return value || null;
  } catch {
    return null;
  }
}

export function setStoredActingOrgId(orgId) {
  if (typeof window === "undefined") return;

  try {
    if (orgId) {
      window.localStorage.setItem(ACTING_ORG_STORAGE_KEY, orgId);
    } else {
      window.localStorage.removeItem(ACTING_ORG_STORAGE_KEY);
    }
  } catch {
    // Ignore storage failures and fall back to auth-scoped org resolution.
  }
}

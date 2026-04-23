const ACTING_ORG_STORAGE_KEY = "cre.acting_org_id";
export const ACTING_ORG_CHANGED_EVENT = "cre:acting-org-changed";
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
    const previousValue = getStoredActingOrgId();
    const normalized = normalizeActingOrgId(orgId);
    if (normalized) {
      window.localStorage.setItem(ACTING_ORG_STORAGE_KEY, normalized);
    } else {
      window.localStorage.removeItem(ACTING_ORG_STORAGE_KEY);
    }

    const nextValue = normalized || null;
    if (previousValue !== nextValue) {
      window.dispatchEvent(
        new CustomEvent(ACTING_ORG_CHANGED_EVENT, {
          detail: {
            previousOrgId: previousValue,
            orgId: nextValue,
          },
        })
      );
    }
  } catch {
    // Ignore storage failures and fall back to auth-scoped org resolution.
  }
}

export function clearStoredActingOrgId() {
  setStoredActingOrgId(null);
}

export function subscribeToActingOrgChanges(listener) {
  if (typeof window === "undefined" || typeof listener !== "function") {
    return () => {};
  }

  const handleCustomEvent = (event) => {
    listener(event?.detail?.orgId || null);
  };

  const handleStorageEvent = (event) => {
    if (event.key !== ACTING_ORG_STORAGE_KEY) return;
    listener(normalizeActingOrgId(event.newValue));
  };

  window.addEventListener(ACTING_ORG_CHANGED_EVENT, handleCustomEvent);
  window.addEventListener("storage", handleStorageEvent);

  return () => {
    window.removeEventListener(ACTING_ORG_CHANGED_EVENT, handleCustomEvent);
    window.removeEventListener("storage", handleStorageEvent);
  };
}

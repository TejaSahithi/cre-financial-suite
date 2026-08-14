export interface VendorCredentialInput {
  vendor_id?: string | null;
  service_type?: string | null;
  jurisdiction?: string | null;
  status?: string | null;
  effective_date?: string | null;
  expiration_date?: string | null;
}

const REGULATED_SERVICE_PATTERNS = [
  /\bhvac\b/,
  /\bmechanical\b/,
  /\belectrical\b/,
  /\bplumbing\b/,
  /\bfire\b/,
  /\blife\s*safety\b/,
  /\belevator\b/,
  /\bsprinkler\b/,
  /\balarm\b/,
  /\broof(ing)?\b/,
  /\bstructural\b/,
  /\babatement\b/,
  /\bhazardous\b/,
];

function normalized(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function matchesText(actual: unknown, expected: unknown): boolean {
  const a = normalized(actual);
  const e = normalized(expected);
  return Boolean(a && e && a === e);
}

export function serviceRequiresCredential(serviceType: unknown): boolean {
  const value = normalized(serviceType).replace(/[_-]+/g, " ");
  return REGULATED_SERVICE_PATTERNS.some((pattern) => pattern.test(value));
}

export function canVendorPerformService(input: {
  vendorId: string;
  serviceType: string;
  jurisdiction?: string | null;
  asOfDate: string;
  credentials?: VendorCredentialInput[];
}) {
  if (!serviceRequiresCredential(input.serviceType)) {
    return { eligible: true, status: "not_required", reasonCodes: [], credential: null };
  }

  const matching = (input.credentials ?? []).filter((credential) => {
    if (credential.vendor_id && credential.vendor_id !== input.vendorId) return false;
    if (!matchesText(credential.service_type, input.serviceType)) return false;
    if (input.jurisdiction && credential.jurisdiction && !matchesText(credential.jurisdiction, input.jurisdiction)) return false;
    return true;
  });

  if (matching.length === 0) {
    return { eligible: false, status: "blocked", reasonCodes: ["VENDOR_CREDENTIAL_REQUIRED"], credential: null };
  }

  const verified = matching.find((credential) => {
    const status = normalized(credential.status);
    if (!["approved", "active", "verified"].includes(status)) return false;
    if (credential.effective_date && credential.effective_date > input.asOfDate) return false;
    if (credential.expiration_date && credential.expiration_date < input.asOfDate) return false;
    return true;
  });

  if (verified) return { eligible: true, status: "eligible", reasonCodes: [], credential: verified };

  const expired = matching.some((credential) => credential.expiration_date && credential.expiration_date < input.asOfDate);
  return {
    eligible: false,
    status: expired ? "expired" : "needs_review",
    reasonCodes: [expired ? "VENDOR_CREDENTIAL_EXPIRED" : "VENDOR_CREDENTIAL_NOT_VERIFIED"],
    credential: matching[0],
  };
}
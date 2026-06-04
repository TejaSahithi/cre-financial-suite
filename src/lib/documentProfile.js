/**
 * Document profile classification for Lease Review.
 *
 * Determines whether an uploaded document is a full lease or an
 * assignment / amendment / consent / estoppel so the UI can choose the
 * correct messaging and field coverage.
 *
 * Design principle: the AI extractor frequently mis-stamps full leases that
 * contain Article 14 "Transfers" sections as documentType = "assignment".
 * We counter this by checking for strong full-lease signals (commencement
 * date + expiration date OR rent being present in the extraction output).
 * When two or more of these signals are found we override the AI's label.
 *
 * Every function in this module must be a pure function with no React
 * dependencies so it can be tested in isolation.
 */

const ASSIGNMENT_TYPES = new Set(["assignment", "amendment", "estoppel", "consent"]);

/**
 * Probe whether a field key has a non-empty value in any of the supplied
 * data maps. Accepts both primitive values and `{ value: ... }` objects.
 *
 * @param {string[]} keys - Field keys (including aliases) to look for.
 * @param {...Object} maps - Data maps to search (null/undefined maps are skipped).
 * @returns {boolean}
 */
function hasValueInMaps(keys, ...maps) {
  for (const map of maps) {
    if (!map || typeof map !== "object") continue;
    for (const key of keys) {
      const raw = map[key];
      if (raw == null) continue;
      if (typeof raw === "object") {
        if (raw.value != null && raw.value !== "") return true;
        if (raw.normalized_value != null && raw.normalized_value !== "") return true;
      } else if (raw !== "") {
        return true;
      }
    }
  }
  return false;
}

/**
 * Classify a lease document based on its extraction output and top-level columns.
 *
 * Returns one of:
 *   "full_lease"  — standard lease document (all tabs applicable)
 *   "assignment"  — assignment of lease only
 *   "amendment"   — amendment / modification
 *   "estoppel"    — estoppel certificate
 *   "consent"     — landlord consent
 *   "unknown"     — could not determine (treat as full lease for safety)
 *
 * @param {Object|null} lease - Lease object, ideally leaseFull (with uploaded_files merged).
 * @returns {"full_lease"|"assignment"|"amendment"|"estoppel"|"consent"|"unknown"}
 */
export function detectDocumentProfile(lease) {
  if (!lease) return "unknown";

  // Manual reviewer override always wins.
  if (lease?.extraction_data?.document_type_override === "full_lease") return "full_lease";

  // Read explicit documentType from the AI extractor output.
  const wfOutput = lease?.extraction_data?.workflow_output || {};
  const rawDocumentType = (
    wfOutput?.document_profile?.documentType
    || wfOutput?.document_profile?.document_type
    || wfOutput?.records?.[0]?.document_profile?.documentType
    || lease?.extraction_data?.document_profile?.documentType
    || lease?.extraction_data?.document_profile?.document_type
    || ""
  );
  const documentType = String(rawDocumentType).toLowerCase();

  // Build the set of data maps we can probe for field presence.
  const wfLeaseFields = wfOutput?.lease_fields || wfOutput?.records?.[0]?.lease_fields || {};
  const edFields = lease?.extraction_data?.fields || {};
  const ufPayload = lease?.uploaded_files?.ui_review_payload || lease?.uploaded_file?.ui_review_payload;
  const ufRecord0 = ufPayload?.records?.[0] ?? null;
  const ufFields = ufRecord0?.fields || ufRecord0?.standard_fields || {};
  const ufWfFields = ufRecord0?.workflow_output?.lease_fields || {};

  // Full-lease signal detection. These three fields are only present in a
  // full lease — assignment documents don't have commencement dates or rent
  // of their own (they reference the original lease).
  const hasCommencement = Boolean(lease?.commencement_date || lease?.start_date)
    || hasValueInMaps(["commencement_date", "start_date", "lease_commencement_date"], wfLeaseFields, edFields, ufFields, ufWfFields);

  const hasExpiration = Boolean(lease?.expiration_date || lease?.end_date)
    || hasValueInMaps(["expiration_date", "end_date", "lease_expiration_date"], wfLeaseFields, edFields, ufFields, ufWfFields);

  const hasRent = Boolean(lease?.monthly_rent || lease?.annual_rent)
    || hasValueInMaps(["monthly_rent", "annual_rent", "base_rent_monthly", "base_rent", "base_rent_annual"], wfLeaseFields, edFields, ufFields, ufWfFields);

  const fullLeaseSignals = [hasCommencement, hasExpiration, hasRent].filter(Boolean).length;

  // Two or more full-lease signals → definitively a full lease regardless of
  // what the AI stamped as documentType. This prevents Article 14 "Transfers"
  // sections from causing the extractor to label a full lease as "assignment".
  if (fullLeaseSignals >= 2) return "full_lease";

  // No full-lease signals — trust the explicit documentType from the AI.
  if (ASSIGNMENT_TYPES.has(documentType)) return documentType;
  for (const type of ASSIGNMENT_TYPES) {
    if (documentType.includes(type)) return type;
  }

  // No signals either way — default to unknown (UI treats it as full lease).
  return "unknown";
}

/**
 * Returns true when the document is an assignment, amendment, estoppel, or
 * consent and should NOT show full-lease expense/CAM/insurance sections.
 *
 * @param {Object|null} lease
 * @returns {boolean}
 */
export function isAssignmentDocument(lease) {
  return ASSIGNMENT_TYPES.has(detectDocumentProfile(lease));
}

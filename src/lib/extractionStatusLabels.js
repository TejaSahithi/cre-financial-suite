/**
 * Friendly, non-technical progress copy for the extraction pipeline. Kept in
 * its own dependency-free module (no JSX/DOM imports) so it can be unit
 * tested without a browser environment, and reused by any page with its own
 * status polling (e.g. LeaseUpload) instead of maintaining a second,
 * potentially divergent copy of "what does this status mean to a user" (this
 * replaced a literal "Uploaded / OCR Processing / Text Extracted / AI
 * Extracting / AI Extracted / Needs Review" technical stepper).
 */
export function getFriendlyExtractionLabel(status) {
  switch (status) {
    case "uploaded":
    case "parsing":
      return "Preparing document";
    case "pdf_parsed":
      return "Reading document";
    case "validating":
      return "Extracting lease fields";
    case "validated":
    case "storing":
    case "stored":
    case "computing":
      return "Preparing review";
    case "review_required":
      return "Preparing review";
    case "completed":
      return "Complete";
    case "failed":
      return "Extraction failed";
    case "cancelled":
      return "Cancelled";
    default:
      return "Processing...";
  }
}

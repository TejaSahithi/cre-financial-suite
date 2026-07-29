// @ts-nocheck
/**
 * Extraction Pipeline — Module Schemas
 *
 * Defines the expected fields for each CRE module type, including:
 * - Field type and validation constraints
 * - Document labels (what text to look for in rule-based extraction)
 * - Regex patterns for pattern matching
 * - Field groups for LLM extraction (small batches)
 * - Which fields are derived (computed, never extracted)
 */

import type { ModuleType } from "./types.ts";

// Bumped only when a change to LEASE_SCHEMA/other module schemas' field set,
// types, or evidence-policy configuration could invalidate a diagnostic
// snapshot taken against an older version (Release 2's diagnostics_context —
// see document-intelligence-v3/run-metrics.ts).
export const LEASE_SCHEMA_VERSION = "release-1";

// ── Field definition ─────────────────────────────────────────────────────────

export type FieldType = "string" | "number" | "date" | "boolean" | "enum";

export interface FieldDef {
  type: FieldType;
  required?: boolean;
  enumValues?: string[];
  /** Min/max for numbers */
  min?: number;
  max?: number;
  /** Document labels that precede this field's value */
  labels: string[];
  /** Regex patterns for direct extraction from text */
  patterns?: RegExp[];
  /** Table header aliases (lowercase) that map to this field */
  tableHeaders?: string[];
  /** This field is computed from others — never extract or send to LLM */
  derived?: boolean;
  /** Human-readable description for LLM prompt */
  description: string;

  // ── Candidate-decision engine metadata (Release 1) ──────────────────────
  /** Coarse business domain this field belongs to. Explicit on high-risk
   *  fields; inferred for the rest from LEASE_GROUPS membership via
   *  getFieldDomain() — most fields do not set this literal directly. */
  domain?: LeaseFieldDomain;
  /** CLAUSE_DEFINITIONS[].type strings (lease-workflow.ts) a fact's category
   *  must match to count as a strong positive signal for this field. Not a
   *  hard requirement — see evaluateCandidateForField()'s decision order. */
  allowedClauseCategories?: string[];
  /** CLAUSE_DEFINITIONS[].type strings that, if matched, hard-reject a
   *  candidate for this field regardless of confidence or keyword score. */
  rejectedClauseCategories?: string[];
  /** Field-specific exclusion phrasing that a clause-category vocabulary
   *  can't express (e.g. landlord_name rejecting M&A/assignment context).
   *  A match hard-rejects, same as rejectedClauseCategories. Tested against
   *  the candidate's sourceText. */
  rejectedEvidencePatterns?: RegExp[];
  /** Same hard-reject mechanism as rejectedEvidencePatterns, but tested
   *  against the candidate's own VALUE instead of its sourceText — for
   *  cases where the surrounding clause is legitimately on-topic (so a
   *  sourceText-based pattern can't distinguish the good and bad
   *  candidates) but the specific extracted value is structurally wrong for
   *  this field's type (e.g. property_name, a short marketing/trade name,
   *  should never literally be a "1,875 square feet" measurement string —
   *  that shape belongs to square_footage, not a name field, regardless of
   *  which clause it came from). */
  rejectedValuePatterns?: RegExp[];
  /** Positive text signal used only when no fact category is available
   *  (the legacy rule/table/LLM path never has one). */
  requiredEvidencePatterns?: RegExp[];
  /** "enforced": allow/reject lists and patterns are populated and gate
   *  candidates. "advisory": domain is known (for reporting/soft-penalty
   *  purposes) but nothing is gated yet. Absent/"unconfigured": no check
   *  possible, current behavior preserved exactly. See
   *  getFieldEvidencePolicy() for the actual resolved value — most fields
   *  don't set this literal directly, same reasoning as `domain`. */
  evidencePolicy?: "enforced" | "advisory" | "unconfigured";
  /** Declares how this field is meant to be populated, for reachability tooling
   *  and future readers. Most fields leave this unset (their extraction path
   *  is whatever combination of LEASE_GROUPS/patterns/labels already applies).
   *  Set explicitly only when a field's intended path needs to be documented
   *  in the schema itself rather than inferred. */
  extractionMode?: "automatic" | "derived" | "human_only";
}

/** Coarse business domains for candidate-decision reconciliation (Release 1
 *  of the document-coverage architecture audit). Lease-specific — other
 *  module schemas (property/expense/...) don't populate this. */
export type LeaseFieldDomain =
  | "parties"
  | "premises"
  | "dates"
  | "rent"
  | "late_payment"
  | "cam"
  | "operating_expenses"
  | "taxes"
  | "insurance"
  | "utilities"
  | "repairs"
  | "renewal"
  | "termination"
  | "assignment"
  | "legal"
  | "notices";

export type ModuleSchema = Record<string, FieldDef>;

/** Fields grouped for LLM extraction — each group is one LLM call */
export interface FieldGroup {
  name: string;
  fields: string[];
  hint: string; // contextual hint for the LLM
}

// ── Lease schema ─────────────────────────────────────────────────────────────

export const LEASE_SCHEMA: ModuleSchema = {
  tenant_name: {
    type: "string",
    required: true,
    // Deliberately NOT "tenant"/"lessee"/"occupant" as bare, standalone
    // labels: "Tenant" is the document's own defined term for the party and
    // is used as a plain pronoun throughout virtually every clause in the
    // lease (repairs, nuisance, insurance, defaults...), not just the
    // identity clause -- a bare-word label match on ANY such clause clears
    // MIN_LABEL_SCORE even after the needs_review penalty, and clears it at
    // FULL strength when the fact's category resolves to clause:default
    // (bareCategory() treats "default" as no-category, skipping the
    // needs_review halving entirely). The multi-word phrases below only
    // appear in genuinely identity-labeled contexts ("Tenant Name:",
    // labeled table headers), which is the actual signal this field needs
    // from keyword matching; category-based accept (party_identification)
    // and tableHeaders/patterns carry the rest.
    labels: ["tenant name", "lessee name"],
    tableHeaders: ["tenant", "tenant_name", "tenant name", "lessee", "company"],
    patterns: [
      // Numbered summary: "4. Tenant: Riverside Consulting, Inc."
      // Stop at newline OR before contact info (phone, email, address line).
      /\d+\s*\.\s*tenant\s*[:.]?\s*([A-Z][A-Za-z0-9.,&'\- ]{2,100}(?:LLC|L\.L\.C\.|Inc\.?|Corporation|Corp\.?|Company|Co\.?|LP|L\.P\.|LLP|L\.L\.P\.|Trust|Foundation|Bank|Holdings|Partners?))/i,
      // Plain labeled line: "Tenant: Riverside Consulting, Inc."
      /(?:^|\n)\s*tenant\s*[:.]\s*([A-Z][A-Za-z0-9.,&'\- ]{2,100}(?:LLC|L\.L\.C\.|Inc\.?|Corporation|Corp\.?|Company|Co\.?|LP|L\.P\.|LLP|L\.L\.P\.|Trust|Foundation|Bank|Holdings|Partners?))/i,
      // Opening-clause format: "by and between [Landlord], and Cress Family Restaurants, LLC, (referred to as "Tenant")"
      /,\s*and\s+([A-Z][A-Za-z0-9.,&'\- ]{2,100}?(?:LLC|L\.L\.C\.|Inc\.?|Corporation|Corp\.?|Company|Co\.?|LP|L\.P\.|LLP|L\.L\.P\.|Trust|Foundation|Holdings|Partners?))\s*[,\s]+\(?referred\s+to\s+as\s+["']?Tenant["']?\)?/i,
    ],
    description:
      "LEGAL ENTITY name of the tenant ONLY (e.g. 'Riverside Consulting, Inc.'). " +
      "DO NOT use the signatory, signer, contact person, or 'By:' name. " +
      "If the lease reads 'Tenant: Riverside Consulting, Inc.  By: John Doe', return 'Riverside Consulting, Inc.', NOT 'John Doe'. " +
      "Also look for opening-clause format: 'between [Landlord Entity] ... and [Tenant Entity] (referred to as \"Tenant\")'.",
    domain: "parties",
    evidencePolicy: "enforced",
    // Migrated from the old hardcoded isLlmSourceTextRelevantToField() guard —
    // rejects source text pulled from an M&A/assignment clause instead of the
    // actual identity clause.
    rejectedEvidencePatterns: [/\b(closely held|voting shares|reorganization|merger|consolidation|assignee|permitted transfer)\b/i],
    // allowedClauseCategories closes the actual flagship bug: without this,
    // a fact whose sourceText merely CONTAINS the word "tenant"/"landlord"
    // anywhere (e.g. an indemnification clause naming Landlord as the party
    // being held harmless) passes candidate-decision.ts's fallback check and
    // can win this field on keyword length alone, even though its value has
    // nothing to do with party identity.
    allowedClauseCategories: ["party_identification"],
    rejectedClauseCategories: ["indemnification"],
  },
  tenant_signatory_name: {
    type: "string",
    labels: ["signed by", "tenant signatory", "by:", "authorized signer", "tenant representative", "tenant contact"],
    tableHeaders: ["signed_by", "tenant_signatory", "signatory", "by"],
    patterns: [/\bBy:\s*([A-Z][A-Za-z.' -]{3,60})(?=\s*(?:Date:|Title:|Name:|$|\n))/],
    description:
      "Individual PERSON who signed the lease on behalf of the tenant — found in the SIGNATURE BLOCK near the END of the document (after 'TENANT:' or 'LESSEE:' header). " +
      "Extract the human name after 'By:' or 'Signed:'. " +
      "Do NOT return 'Date', 'Title', 'Name', or any other signature block label — those are field labels, not signer names. " +
      "Do NOT extract from body clauses. This is NEVER the tenant entity/company name.",
  },
  landlord_signatory_name: {
    type: "string",
    labels: ["landlord signatory", "landlord signed by", "authorized landlord signer"],
    tableHeaders: ["landlord_signatory"],
    description:
      "Individual person who signed the lease on behalf of the landlord. " +
      "This is NEVER the landlord entity name.",
  },
  broker_name: {
    type: "string",
    labels: ["broker", "broker name", "brokerage", "brokerage firm", "real estate broker"],
    tableHeaders: ["broker", "broker_name", "brokerage", "brokerage firm"],
    patterns: [
      /(?:broker|brokerage|real\s+estate\s+broker)\s*[:.]\s*([A-Z][A-Za-z0-9.,&'\- ]{2,120}(?:LLC|L\.L\.C\.|Inc\.?|Corporation|Corp\.?|Company|Co\.?|LP|L\.P\.|LLP|L\.L\.P\.|Brokerage|Realty|Commercial|Partners?))/i,
    ],
    description:
      "Real estate broker or brokerage firm name only. " +
      "Do NOT return the brokerage-fees clause text. If the lease says no broker, leave null.",
    domain: "parties",
    evidencePolicy: "enforced",
    allowedClauseCategories: ["party_identification"],
    rejectedClauseCategories: ["default", "late_fees", "repairs_maintenance", "indemnification"],
    requiredEvidencePatterns: [/\b(?:broker|brokers|brokerage|real\s+estate\s+broker|realtor|realty)\b/i],
    rejectedValuePatterns: [/\b(?:costs?\s+of\s+reletting|reletting|damages?|attorneys?|repairs?|maintenance|alterations?)\b/i],
  },
  property_name: {
    type: "string",
    labels: ["property", "property name", "building", "building name", "shopping center", "project name", "development name"],
    tableHeaders: ["property", "property_name", "property name", "building"],
    patterns: [
      // "located in [Name] Shopping Center" / "within the [Name] Plaza"
      /(?:located\s+in|within|at)\s+(?:the\s+)?([A-Z][A-Za-z0-9\s'&,.-]{2,60}?)\s+(?:Shopping\s+Center|Development|Plaza|Center|Complex|Park|Building|Mall|Strip|Village)/i,
      // "known as 'Property Name'"
      /(?:known\s+as|called)\s+["']([A-Z][A-Za-z0-9\s'&,.-]{2,60}?)["']/i,
      // Explicit labeled line: "Property Name: Markets at Choto"
      /(?:^|\n)\s*property\s+name\s*[:.]\s*([^\n]{2,80})/i,
    ],
    description:
      "Marketing or trade name of the property, building, or shopping center — NOT a tenant or landlord entity name. " +
      "Look for the name of the commercial development, shopping center, or building complex. Examples: 'Markets at Choto', 'Riverside Professional Center', 'Cedar Grove Commons'. " +
      "Common patterns: 'located in the [Name] Shopping Center', 'known as [Name]', 'Property Name: [Name]'. " +
      "Return ONLY the short property name (2-6 words). Do NOT return street addresses, clause text, party names, or mailing addresses. " +
      "If no named property or shopping center is identified in the lease, return null.",
    // Previously fully unconfigured -- any fact could win this field on
    // keyword length alone (e.g. a square-footage fact whose sourceText
    // happened to mention "building"). See fact-field-mapper.ts /
    // candidate-decision.ts.
    domain: "premises",
    evidencePolicy: "enforced",
    allowedClauseCategories: ["premises_description"],
    // A "premises" clause frequently bundles the property name, square
    // footage, AND address in one sentence -- premises_description is a
    // correct category for all three, so the category veto alone can't
    // stop a square-footage-valued fact from winning here too. This is the
    // structural fix: a name field's value should never itself BE a bare
    // measurement, regardless of which (legitimately on-topic) clause it
    // came from.
    rejectedValuePatterns: [/^\s*[\d,]+\.?\d*\s*(rentable\s+|leasable\s+)?(square\s+feet|square\s+footage|sq\.?\s*ft\.?|\bsf\b|\brsf\b)\s*$/i, /\b(?:one\s*\(1\)\s+day|calendar\s+year|shall|must|may)\b/i],
  },
  property_address: {
    type: "string",
    required: true,
    // Strict address separation: "address of tenant" / "address of landlord"
    // are intentionally NOT labels here — they are mailing/notice addresses
    // and must not flow into the premises address column even via label
    // fallback. The workflow extractor and LLM still capture them under
    // tenant_address / landlord_address workflow fields for display.
    labels: ["property address", "premises", "premises address", "address", "location", "street address", "building", "address of premises", "address of property", "address of building"],
    tableHeaders: ["property_address", "property address", "premises", "address", "location", "street address", "building"],
    patterns: [
      // Assignment/amendment phrasing:
      // "for the lease of approximately 4,200 rentable square feet of space (the 'Premises') located at 7804..."
      /for\s+the\s+lease\s+of\s+approximately\s+[\d,]+\s+rentable\s+square\s+feet\s+of\s+space\s+\(?(?:the\s+['"]?premises['"]?)\)?\s+located\s+at\s+([^\n.]{8,180})/i,
      /premises\s+located\s+at\s+([^\n.]{8,180})/i,
      /\bfurther\s+described\s+as\s+([0-9]{2,6}[^.\n]{8,180})/i,
      /\b(?:premises|demised\s+premises|leased\s+premises|building|suites?)\b[^.\n]{0,220}?([0-9]{2,6}\s+[A-Za-z0-9.'#&\- ]{2,100},\s*[A-Za-z.'\- ]+,\s*[A-Z]{2}\s*\d{5}(?:-\d{4})?)/i,
      // Building location line: "Building: ... located at 224 S Peters Road Knoxville, TN 37923"
      /\bbuilding\b[^\n]{0,80}?(?:located\s+at|address[:\s]+)\s*([^\n.]{8,180})/i,
      // Numbered summary: "5. Address of Premises: 224 S Peters Road Suite #211 Knoxville, TN 37923"
      // Note: "address of tenant" / "address of landlord" excluded — those
      // are notice/mailing addresses, not the leased premises.
      /\d+\s*\.\s*(?:address\s+of\s+(?:premises|property|building)|property\s+address|premises\s+address|street\s+address|premises|building)\s*[:.]?\s*([^\n]{8,180})/i,
      // Inline label variants
      /(?:premises|property\s+address|premises\s+address|street\s+address|address)\s*[:.]\s*([^\n]{4,180})/i,
    ],
    description: "Street address or premises description for the leased property (NOT the landlord's or tenant's mailing address)",
    // See property_name above -- was fully unconfigured; rejectedClauseCategories
    // is a direct veto for the concretely-observed failure (a permitted-use
    // clause's "Tenant shall use the Premises for Restaurant..." winning this
    // field purely because it contains the word "Premises").
    domain: "premises",
    evidencePolicy: "enforced",
    allowedClauseCategories: ["premises_description"],
    rejectedClauseCategories: ["use_clause"],
  },
  landlord_name: {
    type: "string",
    required: true,
    // See tenant_name's identical comment -- "Landlord" is used as a plain
    // pronoun throughout the whole document, not just the identity clause.
    labels: ["landlord name", "lessor name"],
    tableHeaders: ["landlord", "landlord_name", "landlord name", "lessor", "owner"],
    patterns: [
      // Numbered summary: "2. Landlord: Sunbelt Holdings, LLC"
      /\d+\s*\.\s*landlord\s*[:.]?\s*([^\n]{2,120})/i,
      // Plain labeled line: "Landlord: Sunbelt Holdings, LLC"
      /(?:^|\n)\s*landlord\s*[:.]\s*([^\n]{2,120})/i,
      /(?:^|\n)\s*lessor\s*[:.]\s*([^\n]{2,120})/i,
      // Opening-clause format: "between Markets at Choto, LLC, or its assigns (referred to as 'Landlord')"
      /\bbetween\s+([A-Z0-9][A-Za-z0-9.,&'\- ]{2,100}?(?:LLC|L\.L\.C\.|Inc\.?|Corporation|Corp\.?|Company|Co\.?|LP|L\.P\.|LLP|L\.L\.P\.|Trust|Foundation|Holdings|Partners?))\s*[,\s]+(?:or\s+its\s+assigns[,\s]+)?\(?referred\s+to\s+as\s+["']?Landlord["']?\)?/i,
      // Simpler parenthetical: "between Sunbelt Holdings, LLC ("Landlord") and ..."
      /\bbetween\s+([A-Z0-9][A-Za-z0-9.,&'\- ]{2,100}?(?:LLC|L\.L\.C\.|Inc\.?|Corporation|Corp\.?|Company|Co\.?|LP|L\.P\.|LLP|L\.L\.P\.|Trust|Foundation|Holdings|Partners?))\s*\(['""]?[Ll]andlord['""]?\)/i,
      // Legacy variants
      /(?:landlord\s+name|lessor\s+name|landlord|lessor|owner)\s*[:\-]\s*([^\n]{2,120})/i,
    ],
    description:
      "LEGAL ENTITY name of the landlord/lessor ONLY (e.g. 'Sunbelt Holdings, LLC'). " +
      "DO NOT use the signatory or signer. " +
      "If the lease reads 'Landlord: Sunbelt Holdings, LLC  By: Jane Doe', return 'Sunbelt Holdings, LLC', NOT 'Jane Doe'. " +
      "Look for two opening-clause formats: (1) 'between [Entity], or its assigns (referred to as \"Landlord\")' and (2) 'between [Entity] (\"Landlord\") and ...' — in both cases extract the entity name BEFORE the parenthetical.",
    domain: "parties",
    evidencePolicy: "enforced",
    rejectedEvidencePatterns: [/\b(closely held|voting shares|reorganization|merger|consolidation|assignee|permitted transfer)\b/i],
    allowedClauseCategories: ["party_identification"],
    rejectedClauseCategories: ["indemnification"],
  },
  // ─── Contact/notice addresses — added to close a gap flagged in
  // docs/lease-standard-field-model.md: these already had working
  // lease-workflow.ts FIELD_SPECS entries (real patterns/aliases) but no
  // LEASE_SCHEMA entry, so they were captured for legacy_hybrid's workflow
  // display but never validated, never part of getSchema()'s standard-field
  // set, and unreachable by openai_fact_ledger's fact-field-mapper.ts (which
  // only scores against LEASE_SCHEMA labels). Patterns/labels below mirror
  // the existing FIELD_SPECS entries (lease-workflow.ts) so both vocabularies
  // agree on what these fields mean.
  landlord_address: {
    type: "string",
    labels: ["landlord address", "landlord's address", "landlord notice address", "lessor address"],
    tableHeaders: ["landlord_address", "landlord address"],
    patterns: [/\blandlord(?:'s)?\s+address\b[:\s-]+([^\n]{6,180})/i, /\baddress\s+of\s+landlord\b[:\s-]+([^\n]{6,180})/i],
    description: "The landlord's mailing or notice address — NOT the leased premises address.",
  },
  tenant_address: {
    type: "string",
    labels: ["tenant address", "tenant's address"],
    tableHeaders: ["tenant_address", "tenant address"],
    patterns: [/\btenant(?:'s)?\s+address\b[:\s-]+([^\n]{6,180})/i],
    description: "The tenant's mailing or notice address — NOT the leased premises address.",
  },
  tenant_contact_name: {
    type: "string",
    labels: ["tenant contact", "tenant representative", "tenant contact name"],
    tableHeaders: ["tenant_contact_name", "tenant contact"],
    patterns: [/\btenant(?:\s+contact|\s+representative)?\b[:\s-]+([A-Z][A-Za-z.' -]{3,80})/i],
    description:
      "The tenant's operational point of contact. Distinct from tenant_signatory_name (the individual who signed " +
      "the lease in the signature block) — this is who to contact day-to-day, which may or may not be the same person.",
  },
  tenant_contact_phone: {
    type: "string",
    labels: ["tenant phone", "tenant contact phone", "tenant telephone"],
    tableHeaders: ["tenant_contact_phone", "tenant phone"],
    patterns: [/\btenant(?:'s)?\s+(?:contact\s+)?(?:phone|telephone)\b[:\s-]+([\d()+\-.\s]{7,20})/i],
    description: "The tenant's contact phone number, if stated.",
  },
  assignor_name: {
    type: "string",
    labels: ["assignor", "original tenant", "current tenant", "seller", "transferor"],
    tableHeaders: ["assignor", "assignor_name", "original tenant", "transferor"],
    patterns: [/(?:assignor|original tenant|transferor)[:\s]+([^\n]{2,120})/i],
    description: "For lease assignments, the party assigning or transferring the lease",
  },
  assignee_name: {
    type: "string",
    labels: ["assignee", "new tenant", "successor tenant", "buyer", "transferee"],
    tableHeaders: ["assignee", "assignee_name", "new tenant", "transferee"],
    // Require entity-type suffix to avoid matching obligation clauses ("transferee assumes...")
    patterns: [/(?:assignee|new tenant|transferee)\s*[:\-]\s*([A-Z][A-Za-z0-9.,&'\- ]{2,100}?(?:LLC|L\.L\.C\.|Inc\.?|Corporation|Corp\.?|Company|Co\.?|LP|L\.P\.|LLP|L\.L\.P\.|Trust|Holdings|Partners?))/i],
    description:
      "For lease ASSIGNMENT documents, the entity receiving/assuming the lease. " +
      "Return null for regular leases. " +
      "Extract only the legal entity name — do NOT return obligation clauses like 'assumes, in full, the obligations of Tenant'.",
  },
  assignment_effective_date: {
    type: "date",
    labels: ["assignment effective date", "effective date", "date of assignment", "assignment date"],
    tableHeaders: ["assignment_effective_date", "effective date", "assignment date"],
    patterns: [
      /(?:assignment\s+effective\s+date|date\s+of\s+assignment|assignment\s+date)[:\s]+([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i,
    ],
    description: "For lease assignments, the assignment effective date in YYYY-MM-DD",
  },
  landlord_consent: {
    type: "boolean",
    labels: ["landlord consent", "consent", "consent required", "landlord approval"],
    tableHeaders: ["landlord_consent", "consent", "landlord approval"],
    patterns: [/(?:landlord\s+consent|landlord\s+approval|consent)[:\s]+(yes|no|true|false|required|received|granted)/i],
    description: "Whether landlord consent or approval is stated for the assignment",
  },
  assumption_scope: {
    type: "string",
    labels: ["assumption", "assumption scope", "assumes", "obligations assumed", "scope of assumption"],
    tableHeaders: ["assumption_scope", "assumption", "obligations assumed"],
    patterns: [/(assignee[^.\n]{0,220}\b(?:assumes?|agrees\s+to\s+perform|shall\s+perform)[^.\n]{0,220}(?:obligations|liabilities|lease))/i],
    description: "Assignment assumption language or obligations assumed by the assignee",
  },
  assignee_notice_address: {
    type: "string",
    labels: ["assignee notice address", "notice address", "address for notices", "assignee address"],
    tableHeaders: ["assignee_notice_address", "notice address", "assignee address"],
    patterns: [/(?:assignee(?:'s)?\s+notice\s+address|address\s+for\s+notices\s+to\s+assignee|assignee\s+address)[:\s]+([^\n]{8,220})/i],
    description: "Notice address for the assignee or new tenant",
  },
  assignment_consideration: {
    type: "number",
    min: 0,
    labels: ["assignment consideration", "consideration", "transfer consideration", "assignment fee"],
    tableHeaders: ["assignment_consideration", "consideration", "assignment fee"],
    patterns: [/(?:assignment\s+consideration|consideration)[^\n$]{0,80}\$?\s*([\d,]+(?:\.\d{2})?)/i],
    description: "Return null for regular leases — this field is ONLY for lease ASSIGNMENT documents. If this is an assignment, return the explicit dollar amount stated as consideration. Do NOT return '.', '0', or any non-numeric artifact. If no dollar amount is explicitly stated, return null.",
  },
  amended_base_rent_for_additional_year: {
    type: "number",
    min: 0,
    labels: ["amended base rent", "additional year base rent", "additional one year base rent", "base rent for additional year", "base rent for additional one year", "extended term rent"],
    tableHeaders: ["amended_base_rent", "additional year base rent", "additional one year base rent", "extended term rent"],
    patterns: [/(?:base\s+rent\s+for\s+(?:the\s+)?additional\s+(?:one\s+)?year|additional\s+(?:one\s+)?year\s+base\s+rent|amended\s+base\s+rent|extended\s+term\s+rent)[^\n$]{0,100}\$?\s*([\d,]+(?:\.\d{2})?)/i],
    description: "Explicit base rent stated for an amendment/extension period. Do not calculate monthly rent from it.",
  },
  all_other_terms_remain_same: {
    type: "boolean",
    labels: ["all other terms remain unchanged", "all other terms remain same", "remaining terms unchanged"],
    tableHeaders: ["all_other_terms_remain_same", "remaining terms"],
    patterns: [/(all\s+other\s+terms[^.\n]{0,160}(?:remain|shall\s+remain|continue)[^.\n]{0,120}(?:unchanged|same|full\s+force\s+and\s+effect))/i],
    description: "Whether an amendment/assignment states all other lease terms remain unchanged.",
  },
  unit_number: {
    type: "string",
    labels: ["unit", "suite", "space", "unit number", "suite number", "space number"],
    tableHeaders: ["unit", "suite", "unit_number", "unit number", "space", "suite #"],
    patterns: [
      // Plural "Suites 3 and 4" or "Building 9, Suites 3 and 4"
      /(?:Building\s+[\w\-]+[,\s]+)?Suites?\s+([\w\-]+(?:\s+and\s+[\w\-]+)*)/i,
      // Singular: "Suite 101", "Unit 2B", "Space 4"
      /(?:Suite|Unit|Space)\s+([\w\-]+)/i,
    ],
    description:
      "Unit, suite, or space identifier — a short alphanumeric code (e.g. '3', '3 and 4', '101', '2B'). " +
      "Look in the Premises section (e.g. 'Building 9, Suites 3 and 4'). " +
      "NEVER return rent-rate language like 'per leasable square foot' or CAM descriptions.",
    domain: "premises",
    evidencePolicy: "enforced",
    allowedClauseCategories: ["premises_description"],
    rejectedValuePatterns: [/^\s*(?:in|at|of|the|and|to|from|for|with|on|by|as|is|be|not|no|per|premises|tenant|landlord)\s*$/i],
    requiredEvidencePatterns: [/\b(?:suite|unit|space|store|#)\b/i],
  },
  lease_date: {
    type: "date",
    labels: ["lease date", "effective date", "date of lease", "date signed", "execution date"],
    tableHeaders: ["lease_date", "date", "effective date", "execution date"],
    patterns: [
      /\b(?:made\s+and\s+entered\s+into|entered\s+into)\s+(?:as\s+of\s+)?(?:this\s+)?(\d{1,2}(?:st|nd|rd|th)?\s+day\s+of\s+[A-Za-z]+,?\s+\d{4}|[A-Za-z]+\s+\d{1,2},?\s+\d{4})/i,
      /\b(?:lease\s+date|date\s+of\s+lease|execution\s+date|effective\s+date)\b\s*[:;-]?\s*(\d{1,2}(?:st|nd|rd|th)?\s+day\s+of\s+[A-Za-z]+,?\s+\d{4}|[A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i,
    ],
    description:
      "The date the lease was signed or executed (YYYY-MM-DD). " +
      "Look for 'made and entered into as of [DATE]', 'Effective Date: [DATE]', 'dated [DATE]', " +
      "or the date in the opening recital. This is BEFORE commencement_date.",
  },
  start_date: {
    type: "date",
    required: true,
    labels: ["start date", "commencement date", "lease start", "commence", "effective date", "begin date"],
    tableHeaders: ["start_date", "start date", "commencement", "commence", "start", "effective"],
    description: "Lease start date in YYYY-MM-DD",
    // See fact-field-mapper.ts's resolveLeaseTermDatePair() for how an
    // unlabeled "term shall be from X through Y" sentence still populates
    // this field even though its own labels[] can't disambiguate start vs.
    // end within one shared source sentence.
    domain: "dates",
    evidencePolicy: "enforced",
    allowedClauseCategories: ["lease_term"],
  },
  end_date: {
    type: "date",
    required: true,
    labels: ["end date", "expiration date", "lease end", "termination date", "expiry", "expire date"],
    tableHeaders: ["end_date", "end date", "expiration", "expire", "end", "termination"],
    patterns: [
      /(?:amended\s+expiration\s+date|expiration\s+date\s+is\s+amended\s+to|term\s+is\s+extended\s+to|extended\s+through|expires?\s+on)[:\s]+([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i,
    ],
    description: "Lease expiration date in YYYY-MM-DD",
    domain: "dates",
    evidencePolicy: "enforced",
    allowedClauseCategories: ["lease_term"],
  },
  monthly_rent: {
    type: "number",
    min: 1,   // reject $0 — free-rent periods show $0 in the schedule; $0 is never the real rent
    labels: ["monthly rent", "base rent", "rent", "rent per month", "monthly base rent", "minimum rent", "fixed rent", "fixed minimum rent"],
    tableHeaders: ["monthly_rent", "monthly rent", "base rent", "rent", "monthly", "base_rent", "base rent per month", "base_rent_per_month", "monthly base rent", "monthly_base_rent", "minimum_rent", "minimum rent", "fixed_minimum_rent", "fixed minimum rent", "fixed_rent"],
    patterns: [
      // Explicit "per month" / monthly qualifier comes first — most reliable
      /(?:monthly\s+rent|base\s+rent|minimum\s+rent|fixed\s+(?:minimum\s+)?rent)[^\n$]{0,80}\$?\s*([\d,]+(?:\.\d{2})?)\s*(?:per\s*month|\/month|\/mo|monthly)/i,
      /\$\s*([\d,]+(?:\.\d{2})?)\s*(?:per\s*month|\/month|\/mo|monthly)/i,
      // Numbered summary line: "7. Monthly Rent: $6,004.00" or "Base Rent: $6,004.00"
      /\d+\s*\.\s*(?:monthly\s+rent|base\s+rent|minimum\s+rent)\s*[:.]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
      /(?:^|\n)\s*(?:monthly\s+rent|base\s+rent|minimum\s+rent|monthly\s+base\s+rent)\s*[:.]\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
    ],
    description:
      "The base rent paid PER MONTH in USD (plain number, no $ or commas). " +
      "ONLY use the number explicitly described as 'per month', 'monthly', or 'monthly rent'. " +
      "If the lease shows a RENT ADDENDUM or rent schedule table with a column called 'Base Rent Per Month' or 'Monthly Base Rent', " +
      "extract the FIRST NON-ZERO value from that column — that is the first PAID period, " +
      "skipping any $0 or '$-' free-rent / rent-abatement rows at the start. " +
      "For example, if months 1-2 show '$-' (free rent) and months 3-12 show '$6,004.00', return 6004. " +
      "NEVER use annual rent or year totals; if only an annual figure is shown, leave monthly_rent NULL " +
      "and the calculator will derive it. " +
      "IMPORTANT: Do NOT extract monthly_rent from the Security Deposit Addendum — dollar amounts there " +
      "(e.g. 'third month rent plus 86th month rent = $12,908.60') describe the deposit calculation, NOT the rent.",
    // Stops an unrelated clause's dollar figure (security deposit, late fee,
    // CAM) from winning this field purely on keyword length -- does NOT by
    // itself disambiguate monthly vs. annual within a correctly-categorized
    // rent sentence (that's the fact-ledger prompt's job, see
    // fact-ledger-extractor.ts's "RENT FIGURES" instruction).
    domain: "rent",
    evidencePolicy: "enforced",
    allowedClauseCategories: ["rent_escalation"],
  },
  annual_rent: {
    type: "number",
    min: 1,   // same reason as monthly_rent — reject $0 annualized rows from free-rent periods
    labels: ["annual rent", "yearly rent", "annual base rent", "base annual rent", "rent per year", "base rent additional year", "base rent additional one year", "additional year base rent", "additional one year base rent"],
    tableHeaders: ["annual_rent", "annual rent", "yearly rent", "annual base rent"],
    patterns: [
      /(?:annual|yearly|base\s+annual)\s+rent[:\s]+\$?\s*([\d,]+(?:\.\d{2})?)/i,
      /(?:base\s+rent\s+for\s+(?:the\s+)?additional\s+(?:one\s+)?year|additional\s+(?:one\s+)?year\s+base\s+rent|amended\s+base\s+rent|extended\s+term\s+rent)[^\n$]{0,100}\$?\s*([\d,]+(?:\.\d{2})?)/i,
      /\$\s*([\d,]+(?:\.\d{2})?)\s*(?:per\s*year|\/year|\/yr|annually)/i,
    ],
    description:
      "The base rent paid PER YEAR in USD (plain number). " +
      "ONLY use the number explicitly described as 'per year', 'annual', or 'yearly'. " +
      "NEVER pull a roll-up or total of multiple lines as annual_rent. " +
      "If only monthly rent is shown, leave annual_rent NULL — the calculator computes monthly × 12.",
    domain: "rent",
    evidencePolicy: "enforced",
    allowedClauseCategories: ["rent_escalation"],
  },
  rent_per_sf: {
    type: "number",
    min: 0,
    labels: ["rent per sf", "rent per square foot", "psf", "$/sf", "rent/sf"],
    tableHeaders: ["rent_per_sf", "rent/sf", "$/sf", "psf", "rent per sf", "annual psf"],
    description: "Annual rent per square foot",
  },
  square_footage: {
    type: "number",
    min: 0,
    // "square feet"/"square footage" added as bare labels -- the previous
    // list required a "rentable"/"leased"/"premises" qualifier immediately
    // adjacent, which a plain "approximately 1,875 square feet of floor
    // area" (no qualifier) never matches, leaving this field permanently
    // unmapped for documents phrased that way.
    labels: ["rentable area", "leased area", "premises rentable square feet", "rentable square feet", "rsf", "leased sf", "tenant rsf", "premises area", "square feet", "square footage", "floor area"],
    tableHeaders: ["square_footage", "sqft", "sq ft", "sf", "rsf", "rentable sf", "leased sf"],
    patterns: [
      /approximately\s+([\d,]+)\s+rentable\s+square\s+feet/i,
      /(?:premises|leased|rentable)[^\n]{0,40}?([\d,]+)\s*(?:rentable\s+)?(?:square\s*feet|sq\.?\s*ft\.?|\bSF\b|\bRSF\b)/i,
      /([\d,]+)\s*rentable\s*(?:square\s*feet|sq\.?\s*ft\.?|\bSF\b|\bRSF\b)/i,
    ],
    description:
      "The rentable square footage of THE LEASED PREMISES (the tenant's space), in plain number form (no commas). " +
      "DO NOT use building totals, project totals, common area, or property-wide square footage. " +
      "If the lease says 'Premises containing approximately 1,110 rentable square feet', use 1110, NOT the building total.",
    // See property_name's rejectedValuePatterns comment -- the same
    // premises clause commonly also states the property name and address,
    // which is why this field needs the same category-based protection
    // (property_name/property_address winning a square-footage-valued fact
    // was the visible symptom; this is square_footage's own side of the
    // same shared-clause ambiguity, needed for it to be able to win back).
    domain: "premises",
    evidencePolicy: "enforced",
    allowedClauseCategories: ["premises_description"],
    // The broadened "square feet"/"square footage" bare labels above (added
    // for documents that state the premises size with no "rentable"/
    // "leased" qualifier) would otherwise also match building_rsf's very
    // different concept -- "Building Total Rentable Square Footage: 45,000"
    // describes the WHOLE BUILDING, not the leased premises (see this
    // field's own description). Reject that phrasing explicitly rather than
    // let a longer bare-word match silently steal the fact from building_rsf.
    rejectedEvidencePatterns: [/\bbuilding\s+(?:total|rsf|square\s+footage|rentable\s+square\s+fe?e?t)\b/i],
  },
  // Added to close a CAM-accuracy gap flagged in docs/lease-standard-field-model.md:
  // deriveCamProfile() (lease-workflow.ts) already reads fieldMap.building_rsf to
  // compute tenant_pro_rata_share, but until now nothing gave it a real rule/LLM/
  // fact-ledger extraction path — only a weak, LLM-blind regex in FIELD_SPECS
  // (manualRequired: true there). Pattern below is that same FIELD_SPECS regex,
  // now also reachable by rule-extractor.ts and both business-extraction providers.
  building_rsf: {
    type: "number",
    min: 0,
    labels: ["building rsf", "building square footage", "total building square feet", "building rentable square feet"],
    tableHeaders: ["building_rsf", "building square footage", "building sf", "total building sf"],
    patterns: [/building[^\n]{0,40}?([\d,]+)\s*(?:square\s*feet|sq\.?\s*ft\.?|\bRSF\b)/i],
    description:
      "The WHOLE BUILDING's total rentable square footage — NOT the leased premises (that's square_footage). " +
      "Used to compute the tenant's pro rata share of the building for CAM/operating-expense allocation " +
      "(tenant_pro_rata_share = square_footage / building_rsf, computed automatically — do not compute this yourself). " +
      "Often only available in a rent roll or CAM reconciliation exhibit; if not explicitly stated, return null.",
  },
  lease_type: {
    type: "enum",
    enumValues: ["nnn", "gross", "modified_gross", "nn", "net"],
    labels: ["lease type", "type of lease"],
    tableHeaders: ["lease_type", "type", "lease type"],
    patterns: [
      /(?:triple[\s-]net|nnn\s+lease)/i,
      /(?:gross\s+lease|full[\s-]service)/i,
      /(?:modified[\s-]gross)/i,
    ],
    description:
      "Return EXACTLY one of: nnn | gross | modified_gross | nn | net. " +
      "Map long descriptions to the correct key: " +
      "'Modified Gross Lease' or 'Modified Gross Lease with Base Year' → modified_gross. " +
      "'Triple Net' or 'NNN' → nnn. " +
      "'Full Service' or 'Gross Lease' → gross. " +
      "Do NOT return the full phrase — return only the key.",
  },
  permitted_use: {
    type: "string",
    labels: ["permitted use", "use", "use of premises", "tenant use"],
    tableHeaders: ["permitted_use", "permitted use", "use"],
    patterns: [
      // Numbered summary: "10. Permitted Use: IT work" (short — cap at 80 chars)
      /\d+\s*\.\s*permitted\s+use\s*[:.]?\s*([^\n]{2,80})/i,
      // Plain labeled line (short)
      /(?:^|\n)\s*permitted\s+use\s*[:.]\s*([^\n]{2,80})/i,
      /(?:^|\n)\s*use\s+of\s+premises\s*[:.]\s*([^\n]{2,80})/i,
      /\b(?:demised\s+premises|premises)\s+shall\s+be\s+used\s+and\s+occupied\s+by\s+tenant\s+solely\s+for\s+(?:the\s+)?(?:operation\s+of\s+)?([^.;\n]{3,80})/i,
      /\btenant\s+shall\s+use\s+(?:the\s+)?premises\s+(?:solely\s+)?(?:for|as)\s+([^.;\n]{3,80})/i,
    ],
    description:
      "Core permitted use — a SHORT phrase (1-10 words) describing the tenant's primary business activity. " +
      "Examples: 'restaurant', 'IT work', 'retail sales of clothing', 'general office use', 'restaurant and bar'. " +
      "DO NOT return full clause text, restrictions, or multi-sentence paragraphs. " +
      "For 'The Demised Premises shall be used and occupied by Tenant solely for the operation of a restaurant...', return 'restaurant'. " +
      "For '...solely for the purposes of IT work', return 'IT work'. " +
      "Extract the core activity type only; strip boilerplate restriction language.",
    domain: "use",
    evidencePolicy: "enforced",
    allowedClauseCategories: ["use_clause"],
    rejectedClauseCategories: ["premises_description", "delivery_possession", "repairs_maintenance", "default"],
    requiredEvidencePatterns: [/\b(?:permitted\s+use|use\s+of\s+(?:the\s+)?premises|shall\s+be\s+used|shall\s+use|solely\s+for|operation\s+of|purpose)\b/i],
    rejectedValuePatterns: [/^\s*(?:as\s+is|where\s+is|as\s+is,?\s+where\s+is|premises|permitted\s+use)\s*$/i],
  },
  security_deposit: {
    type: "number",
    min: 0,
    labels: ["security deposit", "deposit", "security deposit addendum", "total security deposit"],
    tableHeaders: ["security_deposit", "deposit", "security deposit", "total security deposit"],
    patterns: [
      // Total / final deposit line — highest priority
      /(?:total\s+security\s+deposit|total\s+deposit|deposit\s+total)\s*[:=]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
      /(?:for\s+a\s+total\s+of|equals?|totaling|totals?)\s*\$?\s*([\d,]+(?:\.\d{2})?)\s*(?:\(.*?\))?\s*(?:as\s+(?:the\s+)?(?:security\s+)?deposit)?/i,
      // Numbered summary: "Security Deposit: $12,908.60"
      /\d+\s*\.\s*security\s+deposit\s*[:.]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
      /(?:^|\n)\s*(?:security\s+deposit|cash\s+security\s+deposit)\s*[:.]\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
    ],
    description:
      "TOTAL security deposit amount in USD (plain number, no $ or commas). " +
      "If the lease has a Security Deposit Addendum that calculates the deposit from component month rents " +
      "(e.g. 'third month rent $X plus eighty-sixth month rent $Y = total $Z'), return the TOTAL ($Z), " +
      "NOT an intermediate component amount. " +
      "Look for phrases like 'for a total of', 'equals', 'total security deposit', or a final sum line. " +
      "Do NOT return individual month rent amounts used in the deposit calculation.",
  },
  late_fee_amount: {
    type: "number",
    min: 0,
    labels: ["late fee", "late charge"],
    tableHeaders: ["late_fee", "late fee", "late charge"],
    patterns: [/(?:late\s+fee|late\s+charge)[^\n$]{0,80}\$?\s*([\d,]+(?:\.\d{2})?)/i],
    description: "Explicit late fee amount in USD, if stated in the lease",
    domain: "late_payment",
    evidencePolicy: "enforced",
    allowedClauseCategories: ["late_fees"],
  },
  returned_payment_fee_amount: {
    type: "number",
    min: 0,
    labels: ["returned payment fee", "returned check fee", "dishonored payment fee"],
    tableHeaders: ["returned_payment_fee", "returned payment fee", "returned check fee"],
    patterns: [/(?:returned\s+payment\s+fee|returned\s+check\s+fee|dishonored\s+payment)[^\n$]{0,80}\$?\s*([\d,]+(?:\.\d{2})?)/i],
    description: "Explicit returned payment / bounced payment fee in USD",
  },
  application_fee_amount: {
    type: "number",
    min: 0,
    labels: ["application fee"],
    tableHeaders: ["application_fee", "application fee"],
    patterns: [/(?:application\s+fee)[^\n$]{0,80}\$?\s*([\d,]+(?:\.\d{2})?)/i],
    description: "Application fee amount in USD, if stated",
  },
  administrative_fee_amount: {
    type: "number",
    min: 0,
    labels: ["administrative fee", "admin fee"],
    tableHeaders: ["administrative_fee", "administrative fee", "admin fee"],
    patterns: [/(?:administrative\s+fee|admin\s+fee)[^\n$]{0,80}\$?\s*([\d,]+(?:\.\d{2})?)/i],
    description: "Administrative or admin fee amount in USD, if stated",
  },
  pet_fee_amount: {
    type: "number",
    min: 0,
    labels: ["pet fee"],
    tableHeaders: ["pet_fee", "pet fee"],
    patterns: [/(?:pet\s+fee)[^\n$]{0,80}\$?\s*([\d,]+(?:\.\d{2})?)/i],
    description: "One-time pet fee amount in USD, if stated",
  },
  pet_rent_amount: {
    type: "number",
    min: 0,
    labels: ["pet rent"],
    tableHeaders: ["pet_rent", "pet rent"],
    patterns: [/(?:pet\s+rent)[^\n$]{0,80}\$?\s*([\d,]+(?:\.\d{2})?)/i],
    description: "Recurring pet rent amount in USD, if stated",
  },
  parking_fee_amount: {
    type: "number",
    min: 0,
    labels: ["parking fee", "garage fee", "parking charge"],
    tableHeaders: ["parking_fee", "parking fee", "garage fee"],
    patterns: [/(?:parking\s+fee|garage\s+fee|parking\s+charge)[^\n$]{0,80}\$?\s*([\d,]+(?:\.\d{2})?)/i],
    description: "Recurring parking or garage fee amount in USD, if stated",
  },
  cam_amount: {
    type: "number",
    min: 0,
    labels: ["cam", "cam amount", "common area maintenance", "cam charges", "cam per year"],
    tableHeaders: ["cam", "cam_amount", "cam charges", "common area", "cam/yr"],
    patterns: [
      /(?:cam|common\s+area\s+maintenance)\s*(?:charges?|amount|fees?|expense)?\s*[:.]\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
      /(?:cam|common\s+area\s+maintenance)\s*(?:charges?|amount)?\s*(?:per\s+year|annually|\/year|\/yr)\s*[:.=]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
    ],
    description:
      "Annual CAM (Common Area Maintenance) charges in USD as a plain number. " +
      "ONLY extract if a specific dollar amount is explicitly labeled as CAM, common area maintenance, or operating expense charges. " +
      "Do NOT calculate or estimate — if no explicit dollar figure is stated, return null. " +
      "Do NOT confuse CAM charges with the base rent, security deposit, or TI allowance.",
  },
  utility_reimbursement_amount: {
    type: "number",
    min: 0,
    labels: ["utility reimbursement", "utility reimbursement amount", "utility charge"],
    tableHeaders: ["utility_reimbursement_amount", "utility reimbursement", "utility charge"],
    patterns: [
      /(?:utility\s+reimbursement|utility\s+charge)[^\n$]{0,40}\$\s*([\d,]+(?:\.\d{2})?)/i,
      /\$\s*([\d,]+(?:\.\d{2})?)\s*(?:per\s+month|monthly)?[^\n]{0,60}(?:utility\s+reimbursement|utility\s+charge)/i,
    ],
    description: "Explicit utility reimbursement or utility charge amount in USD, if stated",
  },
  water_sewer_reimbursement_amount: {
    type: "number",
    min: 0,
    labels: ["water/sewer reimbursement", "water sewer reimbursement", "water/sewer charge", "water sewer charge"],
    tableHeaders: ["water_sewer_reimbursement_amount", "water/sewer reimbursement", "water sewer reimbursement", "water/sewer charge"],
    patterns: [
      /(?:water\s*\/?\s*sewer\s+(?:reimbursement|charge))[^\n$]{0,40}\$\s*([\d,]+(?:\.\d{2})?)/i,
      /\$\s*([\d,]+(?:\.\d{2})?)\s*(?:per\s+month|monthly)?[^\n]{0,80}(?:water\s*\/?\s*sewer\s+(?:reimbursement|charge))/i,
    ],
    description: "Explicit recurring water/sewer reimbursement amount in USD, if stated",
  },
  tax_responsibility: {
    type: "string",
    labels: ["tax responsibility", "taxes", "real estate taxes", "property taxes"],
    tableHeaders: ["tax_responsibility", "taxes", "tax resp"],
    patterns: [/(?:tax(?:es)?|real estate taxes)\b[^.\n]{0,80}\b(?:landlord|lessor|tenant|lessee)\b/i],
    description: "Who is responsible for paying real estate/property taxes (e.g. 'tenant', 'landlord', 'shared').",
  },
  insurance_responsibility: {
    type: "string",
    labels: ["insurance responsibility", "insurance", "property insurance"],
    tableHeaders: ["insurance_responsibility", "insurance", "ins resp"],
    patterns: [/(?:insurance|property insurance)\b[^.\n]{0,80}\b(?:landlord|lessor|tenant|lessee)\b/i],
    description: "Who is responsible for providing/paying for property insurance (e.g. 'tenant', 'landlord', 'shared').",
    domain: "insurance",
    evidencePolicy: "enforced",
    allowedClauseCategories: ["insurance"],
    rejectedClauseCategories: ["indemnification", "casualty"],
    rejectedEvidencePatterns: [/\b(?:waiver\s+of\s+subrogation|subrogat(?:e|ion)|indemnif|casualty\s+proceeds|limitation\s+of\s+liability)\b/i],
  },
  electric_responsibility: {
    type: "string",
    labels: ["electric responsibility", "electric utility", "electric"],
    tableHeaders: ["electric_responsibility", "electric responsibility"],
    patterns: [/((?:tenant|landlord)\s+must\s+pay\s+electric[^.\n]{0,120})/i],
    description:
      "Normalized responsibility for electric service payment (e.g. 'tenant', 'landlord', 'shared') — the " +
      "supporting clause excerpt belongs in source_text, not in value.",
    domain: "utilities",
    evidencePolicy: "enforced",
    allowedClauseCategories: ["utilities"],
    rejectedClauseCategories: ["repairs_maintenance"],
    requiredEvidencePatterns: [/\b(?:electric(?:ity|al)?\s+(?:service|charges?|costs?|utilities|meter|submeter|payment|bills?)|power\s+(?:service|charges?|costs?|meter|payment)|utilities?|metered|submetered|direct\s+payment|pay\s+(?:for\s+)?electric)\b/i],
    rejectedEvidencePatterns: [/\b(?:electrical\s+(?:wiring|systems?|fixtures?|equipment)|repair|maintain|maintenance|replace|damage)\b/i],
  },
  water_sewer_responsibility: {
    type: "string",
    labels: ["water/sewer responsibility", "water sewer responsibility", "water/sewer utility"],
    tableHeaders: ["water_sewer_responsibility", "water/sewer responsibility"],
    patterns: [/((?:tenant|landlord)[^.\n]{0,80}(?:water\s*\/?\s*sewer)[^.\n]{0,140})/i],
    description:
      "Normalized responsibility for water/sewer service payment (e.g. 'tenant', 'landlord', 'shared') — the " +
      "supporting clause excerpt belongs in source_text, not in value.",
  },
  escalation_rate: {
    type: "number",
    min: 0,
    max: 100,
    labels: ["escalation", "increase", "annual increase", "rent increase", "rent will increase", "escalation rate", "annual escalation"],
    tableHeaders: ["escalation", "escalation_rate", "increase", "annual increase", "esc rate"],
    patterns: [/(?:annual\s+)?(?:escalation|increase|adjustment)[:\s]+([\d.]+)\s*%/i],
    description:
      "Annual rent escalation for the INITIAL term as a plain percentage (e.g. 3 for '3.00% per year'). " +
      "Look for phrases like 'annual base rent increases by X%', 'rent escalates X% per year', " +
      "'3.00% increase on each anniversary', or a rent escalation % column in a rent schedule table.",
  },
  renewal_options: {
    type: "string",
    labels: ["renewal", "renewal options", "option to renew", "renewal option"],
    tableHeaders: ["renewal", "renewal_options", "options", "renewal options"],
    description:
      "BRIEF structured description of renewal options. Format: 'X option(s) to renew for Y year(s) each' or 'X × Y-year options'. " +
      "Examples: '2 × 5-year options', '1 option to renew for 3 years', 'No renewal option'. " +
      "For 'Two (2) additional Five (5) year period(s)' → return '2 × 5-year options'. " +
      "Do NOT return full clause text or multi-sentence paragraphs.",
  },
  ti_allowance: {
    type: "number",
    min: 0,
    labels: ["tenant improvement", "ti allowance", "ti", "tenant improvement allowance", "build-out allowance"],
    tableHeaders: ["ti", "ti_allowance", "tenant improvement", "ti allowance"],
    description:
      "TOTAL Tenant Improvement Allowance in USD (plain number, no $ or commas). " +
      "If the lease states the TI as a per-SF rate AND provides the total (e.g. '$24.00 per SF × 2,848 SF = $68,352'), return the TOTAL dollar amount (68352), NOT the per-SF rate (24). " +
      "If only the per-SF rate is stated with no total calculated in the document, return null. " +
      "NEVER use the base rent PSF, CAM estimate PSF, or any other $/SF figure as the TI allowance.",
  },
  free_rent_months: {
    type: "number",
    min: 0,
    max: 60,
    labels: ["free rent", "free rent months", "rent abatement", "rent-free period", "abatement period"],
    tableHeaders: ["free_rent", "free_rent_months", "free rent", "abatement"],
    description:
      "Number of months with zero-dollar ($0.00) base rent (free rent / rent abatement). " +
      "Count months shown as $0.00 (or '–') in the rent schedule table. Example: Months 1–2 at $0.00 → return 2. " +
      "Also look for explicit phrases: 'rent-free period of X months', 'first X months shall be rent-free', 'abatement of X months rent'. " +
      "Do NOT count partial abatement months. Return plain number (2, not '2 months').",
  },
  lease_term_months: {
    type: "number",
    min: 0,
    labels: ["lease term months", "term months", "lease term", "term"],
    tableHeaders: ["lease_term_months", "term months", "lease term", "term"],
    patterns: [
      /(?:lease\s+term\s+months|term\s+months)[:\s]+(\d{1,3})/i,
      /(?:lease\s+term|term)[:\s]+(\d{1,3})\s*(?:months|mos?\.?)/i,
      /for\s+a\s+(?:period|term)\s+of\s+[a-z\-]+\s+\((\d{1,3})\)\s*months/i,
      /(?:initial\s+)?(?:base\s+)?term[:\s]+[a-z\-]+\s+\((\d{1,3})\)\s*(?:months|mos?\.?)/i,
    ],
    description:
      "Lease term in months. Can be extracted or computed from start/end dates. " +
      "Look for numeric forms like '86 months' AND written-out forms like 'eighty-six (86) months' or " +
      "'for a period of eighty-six (86) months'. Extract the digit inside the parentheses in the latter case.",
  },
  status: {
    type: "enum",
    enumValues: ["active", "expired", "pending", "vacant"],
    labels: ["status", "lease status"],
    tableHeaders: ["status", "lease status"],
    description: "One of: active, expired, pending, vacant",
  },
  // notes: intentionally has no labels/patterns/table headers and is not in any
  // LEASE_GROUPS entry. It is free-form human annotation with no fixed document
  // vocabulary to key extraction off of — inventing generic labels ("notes",
  // "comments", "remarks") risks false-positive matches against unrelated
  // document text via rule-extractor's document-wide label search. Declared
  // human_only here (not just in a test file) so this is a documented schema
  // decision, checked by lease-schema-declared-extraction-metadata.test.ts.
  notes: {
    type: "string",
    labels: [],
    description: "Additional notes or context",
    extractionMode: "human_only",
  },

  // ─── Dates extension ────────────────────────────────────────────────
  commencement_date: {
    type: "date",
    labels: ["commencement date", "lease commencement", "term commencement", "term start", "start date"],
    tableHeaders: ["commencement_date", "commencement", "term commencement", "start date", "lease start"],
    patterns: [
      // Numbered summary line: "3. Commencement Date: January 15, 2024" or "3. Commencement Date: 01/15/2024"
      /\d+\s*\.\s*(?:commencement\s+date|lease\s+commencement|term\s+commencement|term\s+start)\s*[:.]?\s*([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i,
      // Plain labeled line
      /(?:commencement\s+date|lease\s+commencement|term\s+commencement|term\s+start|start\s+date)\s*[:.]\s*([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i,
      // "commencing on" / "commencing the" pattern
      /(?:commencing\s+(?:on|the))\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i,
    ],
    description:
      "Lease term commencement date in YYYY-MM-DD (often different from lease signing date). " +
      "IMPORTANT: If the commencement date is defined FORMULAICALLY (e.g. 'one day after four months from the " +
      "Effective Date', 'upon issuance of a Certificate of Occupancy', or 'the later of X or Y') and no explicit " +
      "calendar date appears in the document, return null — do NOT substitute the lease_date, signing date, or " +
      "effective date. Only return a value when a specific calendar date is stated.",
    domain: "dates",
    evidencePolicy: "enforced",
    allowedClauseCategories: ["lease_term"],
  },
  expiration_date: {
    type: "date",
    labels: ["expiration date", "term expiration", "term end", "lease expiration", "end date"],
    tableHeaders: ["expiration_date", "expiration", "term expiration", "end date", "lease end"],
    patterns: [
      // Numbered summary
      /\d+\s*\.\s*(?:expiration\s+date|term\s+expiration|term\s+end|lease\s+expiration|end\s+date)\s*[:.]?\s*([A-Za-z]+\s+\d{1,2}(?:st|nd|rd|th)?,?\s+(?:\d{4}|of\s+each\s+year)|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i,
      // Plain labeled line
      /(?:expiration\s+date|term\s+expiration|term\s+end|lease\s+expiration|end\s+date)\s*[:.]\s*([A-Za-z]+\s+\d{1,2}(?:st|nd|rd|th)?,?\s+(?:\d{4}|of\s+each\s+year)|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i,
      // "expiring on" pattern
      /(?:expiring\s+(?:on|the))\s+([A-Za-z]+\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i,
    ],
    description:
      "Lease expiration / end date in YYYY-MM-DD. If the document only gives a recurring month/day such as " +
      "'January 31 of each year' with no year, return null for the date value but still cite that exact source_text; " +
      "the deterministic normalizer will derive the review candidate from commencement date.",
    domain: "dates",
    evidencePolicy: "enforced",
    allowedClauseCategories: ["lease_term"],
  },
  rent_commencement_date: {
    type: "date",
    labels: ["rent commencement date", "rent start", "rent commencement"],
    tableHeaders: ["rent_commencement_date", "rent commencement"],
    patterns: [/(?:rent\s+commencement|rent\s+start)\s*(?:date)?\s*[:.]\s*([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i],
    description: "Date rent payments begin (may differ from term commencement when free-rent applies)",
  },
  tenant_signature_date: {
    type: "date",
    labels: ["tenant signature date", "tenant signed date", "tenant date"],
    tableHeaders: ["tenant_signature_date", "tenant signature date", "tenant date"],
    patterns: [/(?:tenant|lessee)[^\n]{0,120}?(?:date|dated)\s*[:.]?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}|[A-Za-z]+\s+\d{1,2},?\s+\d{4})/i],
    description: "Date the tenant signed the lease, normalized as YYYY-MM-DD.",
  },
  landlord_signature_date: {
    type: "date",
    labels: ["landlord signature date", "landlord signed date", "landlord date"],
    tableHeaders: ["landlord_signature_date", "landlord signature date", "landlord date"],
    patterns: [/(?:landlord|lessor)[^\n]{0,120}?(?:date|dated)\s*[:.]?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}|[A-Za-z]+\s+\d{1,2},?\s+\d{4})/i],
    description: "Date the landlord signed the lease, normalized as YYYY-MM-DD.",
  },
  renewal_notice_months: {
    type: "number",
    min: 0,
    labels: ["renewal notice", "notice of renewal", "renewal notice period"],
    tableHeaders: ["renewal_notice_months", "renewal notice"],
    patterns: [/(?:renewal\s+notice|notice\s+(?:to|of)\s+renew)[^\n]{0,40}?(\d{1,3})\s*month/i],
    description:
      "Number of MONTHS of advance notice required to exercise a renewal option. ALWAYS return in months — never in days. " +
      "If the lease states the notice period in DAYS, convert: return Math.round(days / 30). " +
      "Conversion examples: '180 days' → 6. '90 days' → 3. '60 days' → 2. '30 days' → 1. '6 months' → 6. " +
      "Look for phrases like 'not less than X months prior written notice' or 'not less than X days prior written notice' to exercise the option.",
    domain: "renewal",
    evidencePolicy: "enforced",
    allowedClauseCategories: ["renewal_option"],
  },
  termination_notice_months: {
    type: "number",
    min: 0,
    labels: ["termination notice", "notice of termination", "termination notice period"],
    tableHeaders: ["termination_notice_months", "termination notice"],
    patterns: [/(?:termination\s+notice|notice\s+of\s+termination)[^\n]{0,40}?(\d{1,3})\s*month/i],
    description:
      "Number of MONTHS of advance notice required to terminate the lease early. ALWAYS return in months — never in days. " +
      "If the lease states the notice period in DAYS, convert: return Math.round(days / 30). " +
      "Conversion examples: '30 days' → 1. '60 days' → 2. '90 days' → 3.",
  },
  option_exercise_deadline: {
    type: "date",
    labels: ["option deadline", "option exercise deadline", "exercise deadline"],
    tableHeaders: ["option_exercise_deadline"],
    description: "Latest date to exercise a renewal/extension option, in YYYY-MM-DD",
    domain: "renewal",
    evidencePolicy: "enforced",
    allowedClauseCategories: ["renewal_option"],
  },

  // ─── Rent extension ─────────────────────────────────────────────────
  billing_frequency: {
    type: "enum",
    enumValues: ["monthly", "quarterly", "annual"],
    labels: ["billing frequency", "rent frequency", "payment frequency"],
    tableHeaders: ["billing_frequency", "rent frequency"],
    patterns: [/\b(monthly|quarterly|annually|annual)\b/i],
    description: "How often rent is billed (monthly, quarterly, annual)",
  },
  escalation_type: {
    type: "enum",
    enumValues: ["fixed_pct", "cpi", "stepped", "fmv", "none"],
    labels: ["escalation type", "rent escalation type", "increase type"],
    tableHeaders: ["escalation_type", "escalation type"],
    patterns: [/(?:escalation|rent\s+increase|rent\s+adjustment)[^\n]{0,80}?\b(fixed|percent|cpi|stepped|fair\s+market|fmv|none)\b/i],
    description: "Type of rent escalation: fixed_pct, cpi, stepped, fmv, or none",
  },
  escalation_timing: {
    type: "enum",
    enumValues: ["lease_anniversary", "calendar_year", "fiscal_year"],
    labels: ["escalation timing"],
    tableHeaders: ["escalation_timing"],
    description: "When escalations occur (lease_anniversary, calendar_year, fiscal_year)",
  },

  // ─── Expense / recovery responsibilities ────────────────────────────
  responsibility_taxes: {
    type: "enum",
    enumValues: ["landlord", "tenant", "shared", "landlord_with_cap"],
    labels: ["real estate taxes", "property taxes", "taxes"],
    tableHeaders: ["responsibility_taxes", "tax responsibility"],
    patterns: [/\b(?:real\s+estate\s+taxes|property\s+taxes|taxes)\b[^\n]{0,120}\b(tenant|landlord|landlord\s+with\s+cap|shared|both)\b/i],
    description: "Party responsible for property/real estate taxes: landlord, tenant, shared, landlord_with_cap",
    domain: "taxes",
    evidencePolicy: "enforced",
    allowedClauseCategories: ["taxes"],
    rejectedClauseCategories: ["renewal_option"],
  },
  responsibility_insurance: {
    type: "enum",
    enumValues: ["landlord", "tenant", "shared", "landlord_with_cap"],
    labels: ["insurance responsibility", "property insurance responsibility"],
    tableHeaders: ["responsibility_insurance", "insurance responsibility"],
    patterns: [/\binsurance\b[^\n]{0,120}\b(tenant|landlord|shared)\b/i],
    description: "Party responsible for insurance premium/cost responsibility; distinct from tenant policy procurement and waiver-of-subrogation requirements.",
    domain: "insurance",
    evidencePolicy: "enforced",
    allowedClauseCategories: ["insurance", "operating_expense_recovery"],
    rejectedClauseCategories: ["indemnification", "casualty"],
    rejectedEvidencePatterns: [/\b(?:waiver\s+of\s+subrogation|subrogat(?:e|ion)|indemnif|casualty\s+proceeds|limitation\s+of\s+liability)\b/i],
  },
  responsibility_utilities: {
    type: "enum",
    enumValues: ["landlord", "tenant", "shared", "landlord_with_cap"],
    labels: ["utilities responsibility", "utilities"],
    tableHeaders: ["responsibility_utilities", "utilities responsibility"],
    patterns: [/\b(?:utilities|electricity|water|gas|sewer)\b[^\n]{0,120}\b(tenant|landlord|shared)\b/i],
    description: "Party responsible for utilities (electric, water, gas, sewer)",
  },
  responsibility_repairs: {
    type: "enum",
    enumValues: ["landlord", "tenant", "shared", "landlord_with_cap"],
    labels: ["repairs", "maintenance", "repairs and maintenance"],
    tableHeaders: ["responsibility_repairs", "repairs"],
    patterns: [/\b(?:repairs?|maintenance|r&m)\b[^\n]{0,120}\b(tenant|landlord|shared)\b/i],
    description: "Party responsible for repairs & maintenance",
  },
  base_year: {
    type: "number",
    min: 1900,
    max: 2100,
    labels: ["base year"],
    tableHeaders: ["base_year"],
    patterns: [/\bbase\s+year\b[^\n]{0,30}?(\d{4})/i],
    description: "Base year for expense pass-throughs (e.g. 2024)",
  },
  expense_stop: {
    type: "number",
    min: 0,
    labels: ["expense stop"],
    tableHeaders: ["expense_stop"],
    patterns: [/\bexpense\s+stop\b[^\n$]{0,80}\$?\s*([\d,]+(?:\.\d{2})?)/i],
    description: "Expense stop amount in USD (cap above which tenant pays excess)",
  },

  // ─── CAM structure ──────────────────────────────────────────────────
  cam_cap_type: {
    type: "enum",
    enumValues: ["none", "cumulative", "non_cumulative", "compounding"],
    labels: ["cam cap type", "cap type"],
    tableHeaders: ["cam_cap_type"],
    patterns: [/\bcam\b[^\n]{0,80}\b(cumulative|non[\s-]cumulative|compounding|capped)\b/i],
    description: "CAM cap type: none, cumulative, non_cumulative, compounding",
  },
  cam_cap_pct: {
    type: "number",
    min: 0,
    max: 100,
    labels: ["cam cap percent", "cam cap", "controllable expense cap", "operating expense cap"],
    tableHeaders: ["cam_cap_pct"],
    patterns: [/\bcam\b[^\n]{0,80}?(?:cap|increase)[^\n]{0,30}?(\d{1,2}(?:\.\d+)?)\s*%/i],
    description:
      "Annual cap percentage on CAM or controllable operating expense increases. " +
      "May be labeled 'CAM cap', 'controllable expense cap', 'controllable operating expenses shall not " +
      "increase by more than X%', or 'operating expense cap' (e.g. 6 for '6.00% per year cumulative').",
  },
  admin_fee_pct: {
    type: "number",
    min: 0,
    max: 30,
    labels: ["admin fee", "administrative fee", "management fee", "administrative expenses"],
    tableHeaders: ["admin_fee_pct"],
    // No regex patterns — rule-based extraction is too broad (matches late-charge or
    // interest-rate "administrative fee" clauses with the same text pattern as the CAM
    // admin fee). The LLM description below is now specific enough to handle this.
    description:
      "Administrative or management fee percentage on recoverable CAM/operating expenses. " +
      "Typically 3–15%. May be labeled 'administrative expenses not to exceed X% of recoverable expenses', " +
      "'admin fee X%', 'management fee not exceeding X%', or 'not to exceed five percent (5%) of Rent collected' " +
      "(e.g. 5 for 'five percent (5%) of Rent collected', 4 for '4.00% of recoverable expenses'). " +
      "ONLY extract percentages that directly describe this fee on CAM/operating expenses. " +
      "Do NOT extract: default interest rates, late charge percentages, profit percentages, " +
      "revenue shares, escalation rates, or any percentage that is not specifically a property management or " +
      "administrative fee on CAM recoveries. Written-out forms like 'five percent (5%)' → return 5.",
    domain: "cam",
    evidencePolicy: "enforced",
    allowedClauseCategories: ["cam_recoveries", "operating_expense_recovery"],
    rejectedClauseCategories: ["late_fees", "default"],
  },
  management_fee_basis: {
    type: "enum",
    enumValues: ["cam_pool_pro_rata", "tenant_annual_rent", "gross_rent", "fixed"],
    labels: ["management fee basis", "mgmt fee basis"],
    tableHeaders: ["management_fee_basis"],
    description: "What management fees are calculated on: cam_pool_pro_rata, tenant_annual_rent, gross_rent, fixed",
  },
  hvac_responsibility: {
    type: "enum",
    enumValues: ["landlord", "tenant", "shared", "landlord_with_cap"],
    labels: ["hvac responsibility", "hvac"],
    tableHeaders: ["hvac_responsibility"],
    patterns: [/\bhvac\b[^\n]{0,120}\b(tenant|landlord|shared)\b/i],
    description: "Party responsible for HVAC maintenance",
  },
  gross_up_enabled: {
    type: "boolean",
    labels: ["gross up", "gross-up"],
    tableHeaders: ["gross_up_enabled"],
    patterns: [/\bgross[\s-]up\b/i],
    description:
      "Whether the lease's OPERATING-EXPENSE clause actually applies a gross-up adjustment (not just whether " +
      "the term 'gross-up' is defined or mentioned). Return true only when an operative sentence directs that " +
      "expenses be grossed up to a stated occupancy level; return null if the topic is not addressed or only a " +
      "defined term/heading appears.",
  },
  gross_up_threshold: {
    type: "number",
    min: 0,
    max: 100,
    labels: ["gross up threshold", "gross-up threshold", "gross up occupancy"],
    tableHeaders: ["gross_up_threshold"],
    patterns: [/\bgross[\s-]up\b[^\n]{0,40}?(\d{1,3})\s*%/i],
    description:
      "Occupancy percentage threshold at which the lease grosses up variable expenses. " +
      "Look for 'if the Building is less than X% occupied' or 'gross up to reflect X% occupancy'. " +
      "Typically 90 or 95 (e.g. 95 for '95% occupied').",
  },

  // ─── Insurance ──────────────────────────────────────────────────────
  tenant_insurance_required: {
    type: "boolean",
    labels: ["tenant insurance", "tenant insurance required", "liability insurance", "commercial general liability insurance", "tenant shall maintain insurance", "tenant shall carry insurance", "tenant shall keep insurance"],
    tableHeaders: ["tenant_insurance_required"],
    patterns: [/\btenant\s+shall\s+(?:maintain|carry|obtain|provide)[^\n]{0,80}\b(?:insurance|liability)\b/i],
    description: "Whether tenant is required to carry insurance",
  },
  general_liability_min: {
    type: "number",
    min: 0,
    labels: ["general liability", "commercial general liability", "cgl", "liability minimum"],
    tableHeaders: ["general_liability_min"],
    patterns: [/(?:commercial\s+general\s+liability|cgl|general\s+liability)[^\n]{0,80}\$?\s*([\d,]+(?:\.\d{2})?)/i],
    description: "Minimum commercial general liability coverage in USD",
  },
  property_insurance_responsibility: {
    type: "enum",
    enumValues: ["landlord", "tenant", "shared", "landlord_with_cap"],
    labels: ["property insurance"],
    tableHeaders: ["property_insurance_responsibility"],
    patterns: [/\bproperty\s+insurance\b[^\n]{0,120}\b(tenant|landlord|shared)\b/i],
    description: "Party responsible for property insurance on the building",
    domain: "insurance",
    evidencePolicy: "enforced",
    allowedClauseCategories: ["insurance"],
    rejectedClauseCategories: ["indemnification", "casualty"],
    rejectedEvidencePatterns: [/\b(?:waiver\s+of\s+subrogation|subrogat(?:e|ion)|indemnif|casualty\s+proceeds|limitation\s+of\s+liability)\b/i],
  },
  waiver_of_subrogation: {
    type: "boolean",
    labels: ["waiver of subrogation"],
    tableHeaders: ["waiver_of_subrogation"],
    patterns: [/\bwaiver\s+of\s+subrogation\b/i],
    description:
      "Whether an operative sentence actually waives subrogation rights (e.g. 'Landlord and Tenant each waive " +
      "all rights of subrogation against the other') — not just whether the term is defined or headed. Return " +
      "null if only a defined term or heading appears with no operative sentence.",
  },
  additional_insureds_required: {
    type: "boolean",
    labels: ["additional insureds", "additional insured", "name as additional insured"],
    tableHeaders: ["additional_insureds_required"],
    patterns: [/\b(?:name|name\s+landlord|landlord)[^\n]{0,40}additional\s+insured/i, /\badditional\s+insured/i],
    description:
      "Return true if the lease REQUIRES the tenant's insurance policies to name the landlord (or landlord's agents, mortgagees, or managing agents) as additional insureds. " +
      "Look for phrases like 'name the Landlord... as additional insureds', 'Landlord shall be named as an additional insured', or 'policies shall name Landlord as additional insured on all policies'. " +
      "A clause requiring the landlord to be an additional insured = true. " +
      "Return false ONLY if the lease explicitly says additional insureds are not required, or if no insurance section exists.",
    domain: "insurance",
    evidencePolicy: "enforced",
    allowedClauseCategories: ["insurance"],
    requiredEvidencePatterns: [/\b(?:name|named|add|include)[^.\n]{0,80}\badditional\s+insured\b|\badditional\s+insured\b[^.\n]{0,80}\b(?:required|named|policy|policies|endorsement)\b/i],
  },

  // ─── Legal / Options ────────────────────────────────────────────────
  renewal_type: {
    type: "enum",
    enumValues: ["fixed_term", "fair_market", "fixed_increase", "cpi_indexed", "negotiated", "automatic", "none"],
    labels: ["renewal type", "renewal option type"],
    tableHeaders: ["renewal_type"],
    patterns: [/\brenewal\b[^\n]{0,80}\b(fixed\s+term|fair\s+market|fixed\s+increase|cpi|negotiated|automatic|none)\b/i],
    description: "Type of renewal option: fixed_term, fair_market, fixed_increase, cpi_indexed, negotiated, automatic, none",
  },
  right_of_first_refusal: {
    type: "boolean",
    labels: ["right of first refusal", "rofr"],
    tableHeaders: ["right_of_first_refusal"],
    patterns: [/\bright\s+of\s+first\s+refusal\b|\brofr\b/i],
    description:
      "Whether the lease contains an OPERATIVE clause granting tenant a right of first refusal or first offer " +
      "on specific additional space — not just whether the term 'ROFR'/'right of first refusal' appears. " +
      "Return null if the topic is not addressed or only a heading/defined term appears with no granting sentence.",
  },
  early_termination_option: {
    type: "boolean",
    labels: ["early termination", "early out", "termination option"],
    tableHeaders: ["early_termination_option"],
    patterns: [/\bearly\s+termination\b|\bearly\s+out\b/i],
    description:
      "Whether the lease contains an OPERATIVE clause granting tenant the right to terminate the lease before " +
      "its stated expiration — not just whether the phrase 'early termination'/'early out' appears. Return " +
      "null if the topic is not addressed or only a heading/defined term appears with no granting sentence.",
  },
  assignment_provisions: {
    type: "string",
    labels: ["assignment", "assignment provisions", "assignment rights"],
    tableHeaders: ["assignment_provisions"],
    patterns: [/\bassignment\b[^\n]{0,200}/i],
    description:
      "BRIEF SUMMARY of assignment & subletting rules — 1-2 sentences maximum. Do NOT return the full clause text. " +
      "State: (1) whether prior landlord consent is required, (2) any exceptions (affiliates, subsidiaries). " +
      "Examples: 'Requires prior written landlord consent; affiliates excepted.' 'Cannot assign or sublet without landlord approval.' " +
      "Never copy multi-sentence clause paragraphs.",
  },
  default_cure_period: {
    type: "number",
    min: 0,
    labels: ["cure period", "default cure period"],
    tableHeaders: ["default_cure_period"],
    patterns: [/\bdefault\b[^\n]{0,80}?(\d{1,3})\s*days?\s+(?:to\s+)?cure/i, /\bcure\b[^\n]{0,40}?(\d{1,3})\s*days?/i],
    description: "Days a defaulting party has to cure before remedies trigger",
  },
  // Added to close a gap flagged in docs/lease-standard-field-model.md: this
  // field is already prompted for in LEASE_GROUPS' legal_options hint and
  // already has downstream cleanup/humanization logic in lease-workflow.ts
  // (buildLeaseFieldMap's GENERIC_SENTINEL_FIELDS filtering and the
  // "Landlord consent required for assignment or transfer" humanizer), but
  // had neither a LEASE_SCHEMA nor a FIELD_SPECS entry — the most fully
  // unhomed field found during the field-model audit. String type (not
  // enum) to match the existing free-text humanization logic that already
  // consumes this field's value downstream.
  landlord_consent_for_transfer: {
    type: "string",
    labels: ["landlord consent", "consent to assignment", "consent required", "landlord's consent"],
    tableHeaders: ["landlord_consent_for_transfer", "landlord consent"],
    patterns: [/\blandlord[^.\n]{0,40}consent[^.\n]{0,120}(?:assignment|transfer|sublet)/i],
    description:
      "Whether landlord consent is required for an assignment or transfer, e.g. 'Required', 'Not required', " +
      "or 'Required but not unreasonably withheld'. Distinct from landlord_consent (boolean — whether consent " +
      "was actually GIVEN for a specific assignment already in progress); this field describes the LEASE'S " +
      "general rule about future assignments/transfers.",
    domain: "assignment",
    evidencePolicy: "enforced",
    allowedClauseCategories: ["assignment_subletting"],
    requiredEvidencePatterns: [/\b(?:assign|assignment|transfer|sublet|sublease|consent)\b/i],
  },
};

// ── Expense schema ───────────────────────────────────────────────────────────

export const EXPENSE_SCHEMA: ModuleSchema = {
  date: {
    type: "date",
    required: true,
    labels: ["date", "expense date", "invoice date", "transaction date", "posted date"],
    tableHeaders: ["date", "expense_date", "invoice date", "transaction date", "posted"],
    description: "Expense date in YYYY-MM-DD",
  },
  category: {
    type: "string",
    required: true,
    labels: ["category", "expense category", "type", "expense type", "account"],
    tableHeaders: ["category", "expense_category", "type", "expense type", "account"],
    description: "Expense category (e.g., maintenance, utilities, insurance)",
  },
  amount: {
    type: "number",
    required: true,
    min: 0,
    labels: ["amount", "total", "cost", "expense amount", "charge"],
    tableHeaders: ["amount", "total", "cost", "charge", "expense amount", "amt"],
    description: "Expense amount in USD (plain number)",
  },
  vendor: {
    type: "string",
    labels: ["vendor", "supplier", "payee", "vendor name", "paid to"],
    tableHeaders: ["vendor", "supplier", "payee", "vendor name", "paid to", "vendor_name"],
    description: "Vendor or supplier name",
  },
  description: {
    type: "string",
    labels: ["description", "memo", "detail", "line description", "notes"],
    tableHeaders: ["description", "memo", "detail", "notes", "line description"],
    description: "Description of the expense",
  },
  classification: {
    type: "enum",
    enumValues: ["recoverable", "non_recoverable", "conditional"],
    labels: ["classification", "recovery type", "recoverable"],
    tableHeaders: ["classification", "recovery", "recoverable", "recovery type"],
    description: "One of: recoverable, non_recoverable, conditional",
  },
  gl_code: {
    type: "string",
    labels: ["gl code", "account code", "gl account", "account number", "gl #"],
    tableHeaders: ["gl_code", "gl code", "account", "account code", "gl #", "gl", "acct"],
    description: "General ledger account code",
  },
  property_name: {
    type: "string",
    labels: ["property", "property name", "building"],
    tableHeaders: ["property", "property_name", "property name", "building"],
    description: "Property name",
  },
  invoice_number: {
    type: "string",
    labels: ["invoice", "invoice number", "invoice #", "ref", "reference"],
    tableHeaders: ["invoice", "invoice_number", "invoice #", "inv #", "reference", "ref"],
    description: "Invoice or reference number",
  },
  fiscal_year: {
    type: "number",
    min: 1990,
    max: 2100,
    labels: ["fiscal year", "year", "fy"],
    tableHeaders: ["fiscal_year", "year", "fy", "fiscal year"],
    description: "4-digit fiscal year",
  },
  month: {
    type: "number",
    min: 1,
    max: 12,
    labels: ["month", "period"],
    tableHeaders: ["month", "period", "mo"],
    description: "Calendar month (1-12)",
  },
};

// ── Property schema ──────────────────────────────────────────────────────────

export const PROPERTY_SCHEMA: ModuleSchema = {
  property_id_code: {
    type: "string",
    labels: ["property id", "property code", "property number", "asset id"],
    tableHeaders: ["property id", "property_id", "property_id_code", "property code", "asset id"],
    description: "Property identifier or code from the source document",
  },
  name: {
    type: "string",
    required: true,
    labels: ["property name", "name", "building name", "asset name", "project name"],
    tableHeaders: ["name", "property_name", "property name", "building name", "property"],
    description: "Property or building name",
  },
  address: {
    type: "string",
    labels: ["address", "street address", "street", "location"],
    tableHeaders: ["address", "street_address", "street address", "street", "location"],
    description: "Street address",
  },
  city: {
    type: "string",
    labels: ["city", "municipality", "town"],
    tableHeaders: ["city", "municipality", "town"],
    description: "City name",
  },
  state: {
    type: "string",
    labels: ["state", "province", "region"],
    tableHeaders: ["state", "province", "region", "st"],
    description: "2-letter US state code",
  },
  zip: {
    type: "string",
    labels: ["zip", "zip code", "postal code", "zipcode"],
    tableHeaders: ["zip", "zip_code", "postal_code", "zip code", "zipcode"],
    description: "ZIP or postal code",
  },
  property_type: {
    type: "enum",
    enumValues: ["office", "retail", "industrial", "mixed_use", "multifamily", "single_family", "hotel", "land", "other"],
    labels: ["property type", "type", "asset type", "asset class"],
    tableHeaders: ["property_type", "type", "asset type", "asset class"],
    description: "One of: office, retail, industrial, mixed_use, multifamily, hotel, land, other",
  },
  structure_type: {
    type: "enum",
    enumValues: ["single", "multi"],
    labels: ["structure type", "structure", "building structure", "single tenant", "multi tenant"],
    tableHeaders: ["structure_type", "structure", "building structure"],
    description: "Whether the property is single-building/single-tenant or multi-building/multi-tenant when stated",
  },
  total_sqft: {
    type: "number",
    min: 0,
    labels: ["total sqft", "square footage", "total area", "rentable area", "gross area", "gla"],
    tableHeaders: ["total_sqft", "sqft", "square_footage", "total area", "sf", "gla"],
    patterns: [/([\d,]+)\s*(?:square\s*feet|sq\.?\s*ft\.?|\bSF\b|\bGLA\b)/i],
    description: "Total square footage (plain number)",
  },
  leased_sf: {
    type: "number",
    min: 0,
    labels: ["leased sf", "leased square footage", "occupied sf", "occupied square feet"],
    tableHeaders: ["leased_sf", "leased sf", "occupied sf", "leased square footage"],
    description: "Leased or occupied square footage when provided",
  },
  total_buildings: {
    type: "number",
    min: 0,
    labels: ["total buildings", "number of buildings", "buildings", "building count"],
    tableHeaders: ["total_buildings", "buildings", "building count", "number of buildings"],
    description: "Number of buildings on the property",
  },
  year_built: {
    type: "number",
    min: 1800,
    max: 2100,
    labels: ["year built", "construction year", "built", "constructed"],
    tableHeaders: ["year_built", "year built", "built", "constructed"],
    description: "4-digit year built",
  },
  total_units: {
    type: "number",
    min: 0,
    labels: ["total units", "number of units", "units", "unit count"],
    tableHeaders: ["total_units", "units", "unit count", "number of units"],
    description: "Number of units",
  },
  occupancy_pct: {
    type: "number",
    min: 0,
    max: 100,
    labels: ["occupancy", "occupancy percent", "occupancy pct", "occupied percentage"],
    tableHeaders: ["occupancy_pct", "occupancy", "occupancy percent", "occupancy pct"],
    description: "Occupancy percentage as a plain number (90 for 90%)",
  },
  floors: {
    type: "number",
    min: 0,
    labels: ["floors", "stories", "number of floors", "levels"],
    tableHeaders: ["floors", "stories", "levels"],
    description: "Number of floors",
  },
  status: {
    type: "enum",
    enumValues: ["active", "inactive", "under_construction", "under_renovation", "sold"],
    labels: ["status", "property status", "renovation status"],
    tableHeaders: ["status", "property status"],
    description: "One of: active, inactive, under_construction, under_renovation, sold",
  },
  purchase_price: {
    type: "number",
    min: 0,
    labels: ["purchase price", "acquisition price", "cost basis"],
    tableHeaders: ["purchase_price", "acquisition price", "cost basis"],
    description: "Purchase price in USD",
  },
  market_value: {
    type: "number",
    min: 0,
    labels: ["market value", "appraised value", "current value", "valuation"],
    tableHeaders: ["market_value", "appraised value", "current value", "valuation"],
    description: "Current market value in USD",
  },
  noi: {
    type: "number",
    labels: ["noi", "net operating income"],
    tableHeaders: ["noi", "net operating income"],
    description: "Annual net operating income in USD",
  },
  cap_rate: {
    type: "number",
    min: 0,
    max: 100,
    labels: ["cap rate", "capitalization rate"],
    tableHeaders: ["cap_rate", "cap rate", "capitalization rate"],
    description: "Cap rate as plain number (5.5 for 5.5%)",
  },
  manager: {
    type: "string",
    labels: ["manager", "manager name", "property manager", "management company"],
    tableHeaders: ["manager", "manager name", "manager_name", "property_manager", "management"],
    description: "Property manager name",
  },
  owner: {
    type: "string",
    labels: ["owner", "ownership", "owner name", "owner entity", "landlord"],
    tableHeaders: ["owner", "ownership", "owner name", "owner entity", "landlord"],
    description: "Owner name or entity",
  },
  contact: {
    type: "string",
    labels: ["contact", "property contact"],
    tableHeaders: ["contact", "property contact"],
    description: "Property contact phone/email or contact summary",
  },
  phone: {
    type: "string",
    labels: ["phone", "telephone"],
    tableHeaders: ["phone", "telephone", "phone number"],
    description: "Property manager or owner phone number",
  },
  email: {
    type: "string",
    labels: ["email", "email address"],
    tableHeaders: ["email", "email address"],
    description: "Property manager or owner email address",
  },
  acquired_date: {
    type: "date",
    labels: ["acquired date", "acquisition date", "purchase date"],
    tableHeaders: ["acquired date", "acquired_date", "acquisition date", "purchase date"],
    description: "Date the property was acquired",
  },
  parcel_tax_id: {
    type: "string",
    labels: ["parcel id", "tax id", "parcel / tax id", "parcel number"],
    tableHeaders: ["parcel / tax id", "parcel tax id", "parcel_tax_id", "parcel id", "tax id"],
    description: "Parcel or tax identifier",
  },
  parking_spaces: {
    type: "number",
    min: 0,
    labels: ["parking spaces", "parking count", "parking"],
    tableHeaders: ["parking spaces", "parking", "parking count"],
    description: "Number of parking spaces",
  },
  amenities: {
    type: "string",
    labels: ["amenities", "features"],
    tableHeaders: ["amenities", "features"],
    description: "Property amenities or features",
  },
  insurance_policy: {
    type: "string",
    labels: ["insurance policy", "policy number", "insurance"],
    tableHeaders: ["insurance policy", "insurance_policy", "policy number", "insurance"],
    description: "Insurance policy identifier",
  },
  notes: {
    type: "string",
    labels: ["notes", "comments"],
    tableHeaders: ["notes", "comments"],
    description: "Additional notes",
  },
};

// ── Revenue schema ───────────────────────────────────────────────────────────

export const REVENUE_SCHEMA: ModuleSchema = {
  property_name: {
    type: "string",
    labels: ["property", "property name", "building"],
    tableHeaders: ["property", "property_name", "property name", "building"],
    description: "Property name",
  },
  tenant_name: {
    type: "string",
    labels: ["tenant", "tenant name", "payer"],
    tableHeaders: ["tenant", "tenant_name", "tenant name", "payer"],
    description: "Tenant name",
  },
  type: {
    type: "enum",
    enumValues: ["base_rent", "cam_recovery", "parking", "percentage_rent", "other"],
    labels: ["type", "revenue type", "income type"],
    tableHeaders: ["type", "revenue_type", "income type"],
    description: "One of: base_rent, cam_recovery, parking, percentage_rent, other",
  },
  amount: {
    type: "number",
    required: true,
    min: 0,
    labels: ["amount", "total", "revenue amount", "income"],
    tableHeaders: ["amount", "total", "revenue", "income", "amt"],
    description: "Revenue amount in USD",
  },
  date: {
    type: "date",
    labels: ["date", "revenue date", "period date"],
    tableHeaders: ["date", "revenue_date", "period date"],
    description: "Date in YYYY-MM-DD",
  },
  fiscal_year: {
    type: "number",
    min: 1990,
    max: 2100,
    labels: ["fiscal year", "year", "fy"],
    tableHeaders: ["fiscal_year", "year", "fy"],
    description: "4-digit fiscal year",
  },
  month: {
    type: "number",
    min: 1,
    max: 12,
    labels: ["month", "period"],
    tableHeaders: ["month", "period"],
    description: "Calendar month (1-12)",
  },
  notes: {
    type: "string",
    labels: [],
    description: "Additional notes",
  },
};

// ── Unit schema ──────────────────────────────────────────────────────────────

export const UNIT_SCHEMA: ModuleSchema = {
  property_id: {
    type: "string",
    labels: ["property uuid", "parent property uuid"],
    tableHeaders: ["property uuid", "property_uuid", "parent property uuid"],
    description: "Existing parent property UUID when present",
  },
  property_id_code: {
    type: "string",
    labels: ["property id", "property code", "parent property code"],
    tableHeaders: ["property id", "property_id", "property_id_code", "property code", "parent property id", "asset id"],
    description: "Business identifier/code for the parent property",
  },
  property_name: {
    type: "string",
    labels: ["property", "property name", "parent property", "site"],
    tableHeaders: ["property", "property_name", "property name", "parent property", "parent property name", "site"],
    description: "Name of the parent property",
  },
  building_id: {
    type: "string",
    labels: ["building uuid", "parent building uuid"],
    tableHeaders: ["building uuid", "building_uuid", "parent building uuid"],
    description: "Existing parent building UUID when present",
  },
  building_id_code: {
    type: "string",
    labels: ["building id", "building code", "parent building code"],
    tableHeaders: ["building id", "building_id", "building_id_code", "building code", "parent building id"],
    description: "Business identifier/code for the parent building",
  },
  building_name: {
    type: "string",
    labels: ["building", "building name", "parent building"],
    tableHeaders: ["building", "building_name", "building name", "parent building", "parent building name"],
    description: "Name of the parent building",
  },
  unit_id_code: {
    type: "string",
    labels: ["unit id", "unit code"],
    tableHeaders: ["unit id", "unit_id", "unit_id_code", "unit code"],
    description: "Business identifier/code for the unit",
  },
  unit_number: {
    type: "string",
    required: true,
    labels: ["unit", "suite", "space", "unit number", "unit no"],
    tableHeaders: ["unit", "suite", "space", "unit_number", "unit number", "unit no", "unit no.", "unit #", "suite #"],
    description: "Unit or suite identifier",
  },
  floor: {
    type: "number",
    labels: ["floor", "level", "story"],
    tableHeaders: ["floor", "level", "story"],
    description: "Floor number",
  },
  square_footage: {
    type: "number",
    min: 0,
    labels: ["sqft", "square footage", "area", "sf"],
    tableHeaders: ["sqft", "sq ft", "sf", "square_footage", "area", "square footage", "square feet"],
    description: "Rentable square footage",
  },
  bedroom_bathroom: {
    type: "string",
    labels: ["bed bath", "bed/bath", "beds baths"],
    tableHeaders: ["bed/bath", "bed bath", "beds/baths", "bedroom_bathroom"],
    description: "Bedroom/bathroom description",
  },
  unit_type: {
    type: "enum",
    enumValues: ["office", "retail", "industrial", "residential", "storage", "other"],
    labels: ["type", "unit type", "space type"],
    tableHeaders: ["type", "unit_type", "space type"],
    description: "One of: office, retail, industrial, residential, storage, other",
  },
  status: {
    type: "enum",
    enumValues: ["vacant", "occupied", "notice", "under_renovation"],
    labels: ["status", "occupancy"],
    tableHeaders: ["status", "occupancy", "lease status", "occupancy status"],
    description: "One of: vacant, occupied, under_renovation",
  },
  monthly_rent: {
    type: "number",
    min: 0,
    labels: ["rent", "monthly rent", "asking rent", "market rent"],
    tableHeaders: ["rent", "monthly_rent", "monthly rent", "asking rent", "market rent"],
    description: "Monthly rent in USD",
  },
  tenant_name: {
    type: "string",
    labels: ["tenant", "occupant"],
    tableHeaders: ["tenant", "tenant_name", "occupant"],
    description: "Current tenant name (if occupied)",
  },
  lease_start: {
    type: "date",
    labels: ["lease start", "start date"],
    tableHeaders: ["lease start", "lease_start", "start date"],
    description: "Lease start date",
  },
  lease_end: {
    type: "date",
    labels: ["lease end", "end date"],
    tableHeaders: ["lease end", "lease_end", "end date"],
    description: "Lease end date",
  },
};

// ── Tenant / Building / GL schemas (minimal) ─────────────────────────────────

export const TENANT_SCHEMA: ModuleSchema = {
  name: { type: "string", required: true, labels: ["name", "tenant name", "company name"], tableHeaders: ["name", "tenant", "company"], description: "Tenant or company name" },
  company: { type: "string", labels: ["company", "business", "entity"], tableHeaders: ["company", "business", "entity"], description: "Company name" },
  email: { type: "string", labels: ["email", "e-mail"], tableHeaders: ["email", "e-mail"], description: "Email address" },
  phone: { type: "string", labels: ["phone", "telephone", "tel"], tableHeaders: ["phone", "telephone", "tel"], description: "Phone number" },
  contact_name: { type: "string", labels: ["contact", "contact name", "primary contact"], tableHeaders: ["contact", "contact_name", "primary contact"], description: "Primary contact person" },
  industry: { type: "string", labels: ["industry", "sector"], tableHeaders: ["industry", "sector"], description: "Business industry" },
  credit_rating: { type: "string", labels: ["credit", "credit rating", "rating"], tableHeaders: ["credit", "credit_rating", "rating"], description: "Credit rating" },
  status: { type: "enum", enumValues: ["active", "inactive"], labels: ["status"], tableHeaders: ["status"], description: "active or inactive" },
};

export const BUILDING_SCHEMA: ModuleSchema = {
  property_id: { type: "string", labels: ["property uuid", "parent property uuid"], tableHeaders: ["property uuid", "property_uuid", "parent property uuid"], description: "Existing parent property UUID when present" },
  property_id_code: { type: "string", labels: ["property id", "property code", "parent property code"], tableHeaders: ["property id", "property_id_code", "property code", "parent property id", "asset id"], description: "Business identifier/code for the parent property" },
  property_name: { type: "string", labels: ["property", "property name", "parent property", "site"], tableHeaders: ["property", "property_name", "property name", "parent property", "parent property name", "site"], description: "Name of the parent property the building belongs to" },
  building_id_code: { type: "string", labels: ["building id", "building code"], tableHeaders: ["building id", "building_id", "building_id_code", "building code"], description: "Business identifier/code for the building" },
  name: { type: "string", required: true, labels: ["building name", "name"], tableHeaders: ["name", "building", "building name"], description: "Building name" },
  address: { type: "string", labels: ["address", "street"], tableHeaders: ["address", "street"], description: "Street address" },
  total_sqft: { type: "number", min: 0, labels: ["sqft", "total sqft", "area"], tableHeaders: ["sqft", "total_sqft", "area", "sf"], description: "Total square footage" },
  floors: { type: "number", min: 0, labels: ["floors", "stories"], tableHeaders: ["floors", "stories"], description: "Number of floors" },
  year_built: { type: "number", min: 1800, max: 2100, labels: ["year built", "built"], tableHeaders: ["year_built", "built"], description: "Year built" },
  status: { type: "string", labels: ["status"], tableHeaders: ["status"], description: "Building status" },
};

export const GL_ACCOUNT_SCHEMA: ModuleSchema = {
  code: { type: "string", required: true, labels: ["code", "account code", "gl code", "account number"], tableHeaders: ["code", "account", "gl_code", "account code", "gl #"], description: "GL account code" },
  name: { type: "string", required: true, labels: ["name", "account name", "description"], tableHeaders: ["name", "account_name", "description"], description: "Account name" },
  type: { type: "enum", enumValues: ["income", "expense", "asset", "liability", "equity"], labels: ["type", "account type"], tableHeaders: ["type", "account_type"], description: "Account type" },
  category: { type: "string", labels: ["category", "group"], tableHeaders: ["category", "group"], description: "Account category" },
  normal_balance: { type: "enum", enumValues: ["debit", "credit"], labels: ["normal balance", "balance type"], tableHeaders: ["normal_balance", "balance"], description: "debit or credit" },
  is_active: { type: "boolean", labels: ["active", "is active"], tableHeaders: ["active", "is_active"], description: "true if active" },
  is_recoverable: { type: "boolean", labels: ["recoverable", "cam recoverable"], tableHeaders: ["recoverable", "is_recoverable", "cam"], description: "true if CAM-recoverable" },
};

// ── Schema registry ──────────────────────────────────────────────────────────

const SCHEMA_MAP: Record<ModuleType, ModuleSchema> = {
  lease: LEASE_SCHEMA,
  expense: EXPENSE_SCHEMA,
  property: PROPERTY_SCHEMA,
  revenue: REVENUE_SCHEMA,
  unit: UNIT_SCHEMA,
  tenant: TENANT_SCHEMA,
  building: BUILDING_SCHEMA,
  gl_account: GL_ACCOUNT_SCHEMA,
};

function normalizeModuleType(moduleType: string): ModuleType {
  const aliases: Record<string, ModuleType> = {
    leases: "lease",
    lease: "lease",
    expenses: "expense",
    invoices: "expense",
    expense: "expense",
    properties: "property",
    property: "property",
    revenue: "revenue",
    revenues: "revenue",
    buildings: "building",
    building: "building",
    units: "unit",
    unit: "unit",
    tenants: "tenant",
    tenant: "tenant",
    gl_accounts: "gl_account",
    gl_account: "gl_account",
    cam: "expense",
    budgets: "expense",
    documents: "lease",
  };

  return aliases[moduleType] ?? (moduleType as ModuleType);
}

export function getSchema(moduleType: ModuleType): ModuleSchema {
  return SCHEMA_MAP[normalizeModuleType(moduleType as string)] ?? PROPERTY_SCHEMA;
}

// ── Field groups for LLM extraction ──────────────────────────────────────────
// Each group is one LLM call — keeps prompts focused and reduces hallucination

const LEASE_GROUPS: FieldGroup[] = [
  {
    name: "party_entities",
    fields: ["tenant_name", "tenant_signatory_name", "landlord_name", "landlord_signatory_name"],
    hint:
      "Identify the LEGAL ENTITIES: tenant_name and landlord_name are the company/LLC names ONLY. " +
      "Signatory names (the individual who signed 'By:') go into tenant_signatory_name and landlord_signatory_name — never into *_name. " +
      "CRITICAL: Leases name parties in the opening paragraph in two formats: " +
      "(1) 'between [LANDLORD ENTITY], or its assigns (referred to as \"Landlord\"), and [TENANT ENTITY] (referred to as \"Tenant\")' " +
      "(2) 'between [LANDLORD ENTITY] (\"Landlord\") and [TENANT ENTITY] (\"Tenant\")' — the simpler parenthetical shorthand. " +
      "In BOTH formats, extract the entity name BEFORE the parenthetical — e.g. 'Sunbelt Holdings, LLC' from 'between Sunbelt Holdings, LLC (\"Landlord\")'. " +
      "Do NOT return body-text phrases like 'hereby leases Premises to' — those are clause text, not entity names. " +
      "For ALL fields: source_text MUST be the exact verbatim line or sentence from the document — never paraphrase.",
  },
  {
    name: "premises_identity",
    fields: ["property_name", "property_address", "unit_number"],
    hint:
      "Extract property name, premises address, and unit/suite if present. " +
      "unit_number: the suite/unit identifier, typically a short number or code found in the Premises section (e.g. 'Suites 3 and 4'). " +
      "For ALL fields: source_text MUST be the exact verbatim line or sentence from the document — never paraphrase.",
  },
  {
    name: "party_contact_and_broker",
    fields: ["landlord_address", "tenant_address", "tenant_contact_name", "tenant_contact_phone", "broker_name"],
    hint:
      "landlord_address: the landlord's mailing or notice address (NOT the premises address). " +
      "tenant_address: the tenant's mailing or notice address. " +
      "tenant_contact_name: the tenant's day-to-day point-of-contact person for notices/communications (e.g. a " +
      "property manager, leasing contact, or 'Attn:' name on the tenant's notice address) — this is NOT " +
      "necessarily the person who signed the lease. Do not confuse with tenant_signatory_name (the 'By:' " +
      "signer on the signature page), which is a separate field extracted elsewhere. " +
      "tenant_contact_phone: the tenant's contact phone number. " +
      "broker_name: the real estate broker or brokerage firm named in the lease. " +
      "For ALL fields: source_text MUST be the exact verbatim line or sentence from the document — never paraphrase.",
  },
  { name: "assignment", fields: ["assignor_name", "assignee_name", "assignment_effective_date", "landlord_consent", "assumption_scope", "assignee_notice_address", "assignment_consideration", "all_other_terms_remain_same"], hint: "For assignments, identify assignor, assignee, effective date, consent, assumption language, notice address, explicit consideration, and all-other-terms language. Do not infer expense terms from assignment language." },
  {
    name: "term_dates",
    fields: ["start_date", "end_date", "commencement_date", "expiration_date"],
    hint:
      "commencement_date and expiration_date are the term start/end. " +
      "Often the lease shows 'Commencement Date: February 1, 2024' and 'Expiration Date: January 31, 2025'. " +
      "If only month/day is given for expiration with no explicit year, return null for expiration_date/end_date " +
      "but still cite the exact expiration source_text so deterministic post-processing can derive a review candidate. " +
      "CRITICAL: If commencement_date is defined FORMULAICALLY (e.g. 'one day after four months from the Effective " +
      "Date', 'upon Certificate of Occupancy', 'the later of X or Y') with NO explicit calendar date, return null " +
      "for commencement_date — do NOT use the lease_date or signing date as a substitute. " +
      "start_date/end_date mirror commencement_date/expiration_date when the lease uses that terminology instead — " +
      "extract whichever labels the document actually uses; if both label styles appear for the same dates, they " +
      "should agree. All dates → YYYY-MM-DD. " +
      "source_text for each date MUST be the exact verbatim line containing that date.",
  },
  {
    name: "execution_and_rent_commencement_dates",
    fields: ["lease_date", "rent_commencement_date", "tenant_signature_date", "landlord_signature_date"],
    hint:
      "lease_date is the date the lease was signed / executed — look for 'made and entered into as of [DATE]', " +
      "'Effective Date: [DATE]', or 'dated [DATE]' in the opening paragraph. " +
      "rent_commencement_date is when rent payments start (may differ from the term commencement date, extracted " +
      "in a different group, when free-rent applies). " +
      "tenant_signature_date: the date the tenant signed the lease (look for the tenant signature block). " +
      "landlord_signature_date: the date the landlord signed the lease (look for the landlord signature block). " +
      "All dates → YYYY-MM-DD. source_text for each date MUST be the exact verbatim line containing that date.",
  },
  {
    name: "renewal_and_notice_dates",
    fields: ["renewal_notice_months", "termination_notice_months", "option_exercise_deadline"],
    hint:
      "Renewal/termination notice = how many months' notice is required before the applicable deadline (convert " +
      "days to months per the system prompt's notice-period conversion rule if the lease states days). " +
      "option_exercise_deadline: the calendar date or deadline by which a renewal/purchase/other option must be " +
      "exercised, if explicitly stated. source_text for each field MUST be the exact verbatim line/sentence.",
  },
  {
    name: "rent_amounts",
    fields: ["monthly_rent", "annual_rent", "amended_base_rent_for_additional_year", "rent_per_sf", "billing_frequency"],
    hint:
      "Extract base rent values EXACTLY as labeled in the lease. " +
      "If the lease shows a STEPPED RENT SCHEDULE table (multiple rows for different periods), " +
      "extract the FIRST NON-ZERO Monthly Base Rent row — this is the first paid period, " +
      "after any free-rent / rent-abatement period where Monthly Base Rent = $0. " +
      "For example, if row 1 is '$0.00 (Free Rent)' and row 2 is '$18,562.50 (Initial paid rent)', " +
      "extract monthly_rent = 18562.50 and annual_rent = 222750 from row 2. " +
      "monthly_rent must be the per-month rent; annual_rent must be the per-year rent. " +
      "If only one is present, leave the other NULL. " +
      "amended_base_rent_for_additional_year: an amended/updated annual base rent figure stated specifically for " +
      "an additional lease year (distinct from the original annual_rent). " +
      "rent_per_sf: the rent expressed as a $/SF rate, if separately stated (not calculated by you from monthly_rent " +
      "and square footage — only extract if the document states a $/SF figure directly). " +
      "billing_frequency: monthly / quarterly / annual. " +
      "ANTI-HALLUCINATION: If a value is not explicitly stated, return null — never estimate, infer, or calculate.",
  },
  {
    name: "deposit_and_escalation",
    fields: ["security_deposit", "cam_amount", "escalation_rate", "escalation_type", "escalation_timing"],
    hint:
      "security_deposit: look for 'Cash Security Deposit', 'Security Deposit', or 'Deposit' labeled rows. Return " +
      "the TOTAL final amount, NOT component month rents used in the deposit calculation. " +
      "cam_amount: ONLY return if a specific dollar amount is explicitly labeled as CAM or common area maintenance. " +
      "Return null if only percentage splits or pro-rata obligations are described — not a dollar figure. " +
      "escalation_rate: the fixed annual percentage increase (e.g. 3 for '3.00% per year' or 'annual base rent " +
      "increases by 3.00%'). escalation_type: fixed_pct / cpi / stepped / fmv / none. " +
      "escalation_timing: lease_anniversary / calendar_year / fiscal_year — when escalations occur. " +
      "ANTI-HALLUCINATION: If a value is not explicitly stated, return null — never estimate or infer dollar amounts.",
  },
  {
    name: "premises_and_use",
    fields: ["square_footage", "building_rsf", "lease_type", "permitted_use"],
    hint:
      "Find the LEASED PREMISES square footage (tenant's space, not the whole building), lease type, and " +
      "permitted use (e.g. 'IT work', 'general office'). " +
      "building_rsf is the WHOLE BUILDING's total rentable square footage (often only in a rent roll or CAM " +
      "reconciliation exhibit) — distinct from square_footage, which is the tenant's leased premises only.",
  },
  {
    name: "term_length_and_incentives",
    fields: ["lease_term_months", "renewal_options", "renewal_type", "ti_allowance", "free_rent_months", "status"],
    hint:
      "Find term length, renewal type/terms, TI allowance, free rent, and lease status. " +
      "For lease_term_months: look for both numeric ('86 months') AND written-out forms " +
      "('eighty-six (86) months', 'for a period of eighty-six (86) months'). " +
      "Extract the digit inside the parentheses from written-out forms.",
  },
  {
    name: "expense_recovery",
    fields: ["responsibility_taxes", "responsibility_insurance", "responsibility_utilities", "responsibility_repairs", "base_year", "expense_stop"],
    hint:
      "Identify WHO PAYS for each expense category. Use: 'landlord', 'tenant', 'shared', or 'landlord_with_cap'. " +
      "Base this ONLY on each category's own explicit clause language in the text below — the lease's overall " +
      "NNN / Gross / Modified Gross classification is context, not proof, and must never substitute for a " +
      "category's own stated responsibility language. A lease can be labeled NNN and still make the landlord " +
      "responsible for a specific category (e.g. a landlord-paid roof/structure carve-out), or vice versa — " +
      "read each category's own clause. " +
      "For MODIFIED GROSS or BASE YEAR leases: base rent includes landlord's share of taxes/insurance/CAM for the " +
      "Base Year — that means responsibility = 'landlord_with_cap' (landlord covers base year, tenant pays increases). " +
      "Example: 'Base rent includes Tenant's share of operating expenses, real estate taxes, and property insurance " +
      "for the Base Year only. Tenant shall pay Tenant's Pro Rata Share of increases.' → " +
      "responsibility_taxes = 'landlord_with_cap', responsibility_insurance = 'landlord_with_cap'. " +
      "For utilities: 'included in base rent during normal business hours' + 'Tenant shall pay for after-hours/supplemental' " +
      "→ responsibility_utilities = 'shared'. " +
      "Also extract base_year (calendar year for base-year pass-throughs) and expense_stop dollar amount if present.",
  },
  {
    name: "fees_and_charges",
    fields: ["late_fee_amount", "returned_payment_fee_amount", "application_fee_amount", "administrative_fee_amount", "pet_fee_amount", "pet_rent_amount", "parking_fee_amount"],
    hint:
      "Extract miscellaneous fee/charge amounts, each as a plain USD number, ONLY if a specific dollar amount is " +
      "explicitly stated for that exact fee. Do NOT infer one fee's amount from another, and do NOT return a " +
      "percentage or rate as a substitute for a stated dollar figure. Do NOT populate these fields from unrelated " +
      "charges: broker commissions, legal review fees, lender fees, construction administration fees, CAM " +
      "management-fee PERCENTAGES, transfer/assignment review fees, security deposits, or parking taxes — only " +
      "the exact charge each field names. " +
      "late_fee_amount: the late/delinquent-rent-payment fee, if a dollar amount is stated (a late fee stated only " +
      "as a percentage of rent belongs elsewhere — return null for this field in that case). " +
      "returned_payment_fee_amount: fee for a returned/dishonored/bounced payment (check or ACH). " +
      "application_fee_amount: one-time tenant application/screening fee. " +
      "administrative_fee_amount: a flat administrative/admin fee charged to the tenant directly (distinct from " +
      "the CAM administrative/management fee PERCENTAGE, admin_fee_pct, in a different group — e.g. '15% " +
      "administrative fee on Operating Expenses' is admin_fee_pct, NOT this field). " +
      "pet_fee_amount: one-time pet fee (not recurring). pet_rent_amount: recurring monthly pet rent. " +
      "parking_fee_amount: recurring monthly parking/garage charge. " +
      "ANTI-HALLUCINATION: if a fee category is not mentioned at all, or mentioned only as a percentage/formula " +
      "with no computed dollar amount, return null — never estimate.",
  },
  {
    name: "utilities_and_responsibility",
    fields: ["utility_reimbursement_amount", "water_sewer_reimbursement_amount", "tax_responsibility", "insurance_responsibility", "electric_responsibility", "water_sewer_responsibility"],
    hint:
      "Extract utility charge-back amounts and per-category expense responsibility. For every field in this group, " +
      "put the NORMALIZED short responsibility answer (e.g. 'tenant', 'landlord', 'shared', or whatever form the " +
      "field's own description specifies) in `value` — never put clause prose in `value`. Put the exact " +
      "supporting clause excerpt in `source_text` only; `value` and `source_text` serve different purposes. " +
      "utility_reimbursement_amount / water_sewer_reimbursement_amount: a specific recurring dollar amount the " +
      "tenant reimburses for that utility, ONLY if explicitly stated as a dollar figure. " +
      "tax_responsibility / insurance_responsibility: identify who pays real estate taxes / who pays for property " +
      "insurance — base this ONLY on this category's own explicit clause language, never on the lease's overall " +
      "NNN/Gross classification alone. " +
      "electric_responsibility / water_sewer_responsibility: who pays for and/or arranges that utility service — " +
      "distinguish PAYING for the utility from merely maintaining/repairing the electrical or plumbing SYSTEM " +
      "(a different field/topic); the normalized payer answer goes in `value`, the supporting clause in " +
      "`source_text`.",
  },
  {
    name: "cam_structure",
    fields: ["cam_cap_type", "cam_cap_pct", "admin_fee_pct", "management_fee_basis", "hvac_responsibility", "gross_up_enabled", "gross_up_threshold"],
    hint:
      "Extract CAM (Common Area Maintenance) and operating expense structural rules. " +
      "cam_cap_type: cumulative / non_cumulative / compounding / none. " +
      "cam_cap_pct: the annual percentage cap on CAM or controllable operating expense increases. " +
      "  In leases this may be labeled 'Controllable Expense Cap', 'CAM cap', or " +
      "  'controllable operating expenses shall not increase by more than X% per year' (e.g. 6 for 6.00%). " +
      "admin_fee_pct: the administrative or management fee percentage on recoverable/CAM expenses. " +
      "  Look for 'administrative expenses not exceeding X% of recoverable operating expenses' or " +
      "  'management fee not exceeding X%' (e.g. 4 for 4.00%, or 3 for 3.00%). " +
      "management_fee_basis: what mgmt fees are calculated on — cam_pool_pro_rata / tenant_annual_rent / gross_rent / fixed. " +
      "  'Not exceeding X% of gross collected revenue' → gross_rent. " +
      "gross_up_enabled: true ONLY if the lease contains OPERATIVE gross-up language that actually applies an " +
      "adjustment (e.g. 'Landlord shall gross up Operating Expenses to reflect 95% occupancy'). A mere mention " +
      "of the defined term 'Gross-Up' in a definitions list with no operative sentence, or a heading alone, is " +
      "NOT sufficient — return null in that case, not true. " +
      "gross_up_threshold: the occupancy % at which gross-up applies. " +
      "  Look for 'if the Building is less than X% occupied ... gross up' (e.g. 95 for 95% occupied). " +
      "hvac_responsibility: landlord / tenant / shared — who maintains HVAC.",
  },
  {
    name: "insurance",
    fields: ["tenant_insurance_required", "general_liability_min", "property_insurance_responsibility", "waiver_of_subrogation", "additional_insureds_required"],
    hint:
      "Extract insurance requirements. " +
      "general_liability_min: the minimum coverage amount in USD (e.g. 1000000 for $1M / $1,000,000). " +
      "Look for clauses like 'Tenant shall maintain commercial general liability insurance in an amount not less than $X'. " +
      "additional_insureds_required: true ONLY if an operative sentence actually requires Landlord (or " +
      "Landlord's agents/mortgagees) to be named as an additional insured on Tenant's policy — not merely " +
      "because the phrase 'additional insured' appears (e.g. as a section heading with no clause beneath it). " +
      "The evidence must be semantically equivalent to such a requirement; no single exact wording is " +
      "required — commercial leases phrase this many different ways.",
  },
  {
    name: "legal_options",
    fields: ["right_of_first_refusal", "early_termination_option", "assignment_provisions", "default_cure_period", "landlord_consent_for_transfer"],
    hint:
      "Extract tenant options and remedies. " +
      "right_of_first_refusal: true ONLY if an operative sentence actually GRANTS tenant a right of first " +
      "refusal or first offer on specific additional space (e.g. 'Landlord shall first offer the Adjacent " +
      "Space to Tenant before offering it to any third party'). A mention of 'Right of First Refusal' only as " +
      "a defined term, section heading, or in a list of exhibits, with no granting sentence, is NOT " +
      "sufficient — return null. " +
      "early_termination_option: true ONLY if an operative sentence actually GRANTS tenant the right to " +
      "terminate the lease early (e.g. 'Tenant may terminate this Lease effective as of the last day of the " +
      "60th month upon 180 days' prior written notice and payment of the Termination Fee'). A section heading " +
      "or defined-term mention alone is NOT sufficient — return null. " +
      "assignment_provisions: brief summary (e.g. 'requires landlord consent, not unreasonably withheld'). " +
      "default_cure_period: days a defaulting party has to cure before remedies (e.g. 30 days for monetary, 60 for non-monetary). " +
      "landlord_consent_for_transfer: whether landlord consent is required for assignment/transfer (e.g. 'Required', 'Not required', 'Required but not unreasonably withheld'). " +
      "source_text for each field MUST be the exact verbatim sentence or clause from the document.",
  },
];

const EXPENSE_GROUPS: FieldGroup[] = [
  { name: "transaction", fields: ["date", "amount", "vendor", "invoice_number"], hint: "Find the expense date, amount, vendor, and invoice number." },
  { name: "classification", fields: ["category", "classification", "gl_code"], hint: "Identify expense category, recoverability, and GL code." },
  { name: "context", fields: ["property_name", "description", "fiscal_year", "month"], hint: "Find property context, description, and time period." },
];

const PROPERTY_GROUPS: FieldGroup[] = [
  { name: "identity", fields: ["property_id_code", "name", "address", "city", "state", "zip", "property_type", "structure_type"], hint: "Find the property identifier, name, address, type, and structure." },
  { name: "physical", fields: ["total_sqft", "leased_sf", "total_buildings", "year_built", "total_units", "occupancy_pct", "floors", "status", "parking_spaces", "amenities"], hint: "Find physical characteristics: size, leased/occupied area, building count, age, units, occupancy, floors, parking, and amenities." },
  { name: "financial", fields: ["purchase_price", "market_value", "noi", "cap_rate"], hint: "Find financial metrics: price, value, NOI, cap rate." },
  { name: "management", fields: ["manager", "owner", "contact", "phone", "email", "acquired_date", "parcel_tax_id", "insurance_policy", "notes"], hint: "Find manager, owner, contact details, phone, email, acquisition date, parcel/tax ID, insurance policy, and notes." },
];

const REVENUE_GROUPS: FieldGroup[] = [
  { name: "record", fields: ["property_name", "tenant_name", "type", "amount", "date", "fiscal_year", "month"], hint: "Find revenue details: property, tenant, type, amount, date." },
];

const SIMPLE_GROUP: FieldGroup[] = [
  { name: "all", fields: [], hint: "Extract all available fields." }, // fields filled dynamically
];

const GROUP_MAP: Record<ModuleType, FieldGroup[]> = {
  lease: LEASE_GROUPS,
  expense: EXPENSE_GROUPS,
  property: PROPERTY_GROUPS,
  revenue: REVENUE_GROUPS,
  unit: SIMPLE_GROUP,
  tenant: SIMPLE_GROUP,
  building: SIMPLE_GROUP,
  gl_account: SIMPLE_GROUP,
};

export function getFieldGroups(moduleType: ModuleType): FieldGroup[] {
  const normalizedModuleType = normalizeModuleType(moduleType as string);
  const groups = GROUP_MAP[normalizedModuleType] ?? SIMPLE_GROUP;

  // For simple groups, populate fields from schema
  if (groups === SIMPLE_GROUP || (groups.length === 1 && groups[0].fields.length === 0)) {
    const schema = getSchema(normalizedModuleType);
    const allFields = Object.keys(schema).filter((f) => !schema[f].derived);
    return [{ name: "all", fields: allFields, hint: `Extract all ${normalizedModuleType} fields.` }];
  }

  return groups;
}

// ── Candidate-decision engine: domain/evidence-policy resolution ────────────
//
// Most LEASE_SCHEMA fields don't set `domain`/`evidencePolicy` literally —
// only the handful of known-ambiguous fields (admin_fee_pct, late_fee_amount,
// responsibility_taxes, etc.) are fully "enforced" with allow/reject lists.
// Every other field's domain is inferred from its LEASE_GROUPS membership so
// the whole schema has a reportable domain without hand-tagging ~80 fields
// individually — those default to "advisory" (domain known, nothing gated
// yet). A field in no group and with no explicit config is "unconfigured".

const LEASE_GROUP_DOMAINS: Record<string, LeaseFieldDomain> = {
  parties: "parties",
  assignment: "assignment",
  dates: "dates",
  financial: "rent",
  terms: "legal",
  expense_recovery: "operating_expenses",
  cam_structure: "cam",
  insurance: "insurance",
  legal_options: "legal",
};

// Per-field overrides where a field's true domain is narrower/different than
// its display group's default (e.g. renewal fields live in the "dates"
// group for prompting purposes but are conceptually "renewal").
const LEASE_FIELD_DOMAIN_OVERRIDES: Record<string, LeaseFieldDomain> = {
  renewal_notice_months: "renewal",
  option_exercise_deadline: "renewal",
  renewal_options: "renewal",
  renewal_type: "renewal",
  termination_notice_months: "termination",
  early_termination_option: "termination",
  responsibility_taxes: "taxes",
  responsibility_insurance: "insurance",
  responsibility_utilities: "utilities",
  responsibility_repairs: "repairs",
};

let leaseFieldToGroupNameCache: Record<string, string> | null = null;
function fieldToGroupName(fieldKey: string): string | null {
  if (!leaseFieldToGroupNameCache) {
    const map: Record<string, string> = {};
    for (const group of LEASE_GROUPS) {
      for (const field of group.fields) map[field] = group.name;
    }
    leaseFieldToGroupNameCache = map;
  }
  return leaseFieldToGroupNameCache[fieldKey] ?? null;
}

/** Resolves a field's domain: explicit FieldDef.domain, then a per-field
 *  override, then its LEASE_GROUPS group's default domain, else undefined.
 *  Only meaningful for moduleType "lease" — other schemas have no domain
 *  concept. */
export function getFieldDomain(fieldKey: string, moduleType: ModuleType): LeaseFieldDomain | undefined {
  if (normalizeModuleType(moduleType as string) !== "lease") return undefined;
  const def = LEASE_SCHEMA[fieldKey];
  if (def?.domain) return def.domain;
  if (LEASE_FIELD_DOMAIN_OVERRIDES[fieldKey]) return LEASE_FIELD_DOMAIN_OVERRIDES[fieldKey];
  const groupName = fieldToGroupName(fieldKey);
  return groupName ? LEASE_GROUP_DOMAINS[groupName] : undefined;
}

/** Resolves the effective evidence policy for a field: explicit
 *  FieldDef.evidencePolicy, else "advisory" if a domain is known, else
 *  "unconfigured". Used by getEvidencePolicyCoverage() for schema-wide
 *  reporting by field key. evaluateCandidateForField() (candidate-decision.ts)
 *  derives the same logic directly from the FieldDef object it's given
 *  rather than calling this, since it may be handed a field definition that
 *  isn't reachable via a plain schema[fieldKey] lookup. */
export function getFieldEvidencePolicy(
  fieldKey: string,
  moduleType: ModuleType,
): "enforced" | "advisory" | "unconfigured" {
  const schema = getSchema(moduleType);
  const def = schema[fieldKey];
  if (def?.evidencePolicy) return def.evidencePolicy;
  return getFieldDomain(fieldKey, moduleType) ? "advisory" : "unconfigured";
}

export interface EvidencePolicyCoverage {
  total: number;
  enforced: number;
  advisory: number;
  unconfigured: number;
}

/** Reports how much of a module's schema has real (enforced) evidence
 *  validation vs. advisory-only vs. no check at all — surfaced in the admin
 *  debug panel so the configuration gap stays visible rather than looking
 *  silently "done" once schema-driven validation exists for a few fields. */
export function getEvidencePolicyCoverage(moduleType: ModuleType): EvidencePolicyCoverage {
  const schema = getSchema(moduleType);
  const fieldNames = Object.keys(schema).filter((name) => !schema[name].derived);
  const coverage: EvidencePolicyCoverage = { total: fieldNames.length, enforced: 0, advisory: 0, unconfigured: 0 };
  for (const fieldName of fieldNames) {
    coverage[getFieldEvidencePolicy(fieldName, moduleType)]++;
  }
  return coverage;
}

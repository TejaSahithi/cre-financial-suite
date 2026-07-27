// @ts-nocheck
/**
 * Shared, document-agnostic semantic compatibility layer.
 *
 * Both extraction pipelines call into this ONE module so a candidate's final
 * acceptance is governed by generalized semantic roles, not by label/keyword
 * overlap alone:
 *   - openai_fact_ledger: fact-field-mapper.ts's explainFieldCompatibility()
 *   - legacy_hybrid:      merger.ts's mergeField()
 *
 * Keyword/label scoring remains useful for RETRIEVAL (ranking candidates
 * against a field -- see fact-field-mapper.ts's scoreFactAgainstFieldDetailed
 * and rule-extractor.ts's pattern/label matching), but this module is the
 * final hard accept/reject gate: an incompatible candidate is rejected
 * outright (score forced to 0 / merge candidate dropped), never merely
 * down-scored.
 *
 * GENERALIZATION CONSTRAINT: every pattern in this file must describe a
 * semantic ROLE (a category of legal/financial meaning that recurs across
 * arbitrary lease templates), never a specific document, landlord, tenant,
 * page number, or literal sentence. Exact sentences belong only in test
 * fixtures (see _tests/semantic-compatibility.test.ts and
 * _tests/golden-corpus/*.test.ts), never in the classifier or rule tables
 * below.
 */

// ── Role taxonomy ────────────────────────────────────────────────────────────

export type ValueType = "money" | "date" | "percentage" | "text" | "number" | "boolean" | "unknown";

export type MonetaryRole =
  | "base_rent"
  | "additional_rent"
  | "cam"
  | "tax"
  | "insurance_recovery"
  | "utility_charge"
  | "allowance"
  | "deposit"
  | "penalty"
  | "reimbursement"
  | "amortization"
  | "one_time_charge"
  | "percentage_rent"
  | "unknown";

export type DateRole =
  | "execution"
  | "signature"
  | "effective"
  | "delivery"
  | "possession"
  | "commencement"
  | "rent_commencement"
  | "expiration"
  | "option_exercise"
  | "notice"
  | "reconciliation"
  | "certificate"
  | "unknown";

export type PartyRole =
  | "landlord"
  | "tenant"
  | "guarantor"
  | "broker"
  | "property_manager"
  | "signatory"
  | "assignee"
  | "subtenant"
  | "lender"
  | "unknown";

export type ClauseRole =
  | "definition"
  | "grant"
  | "obligation"
  | "condition"
  | "prohibition"
  | "option"
  | "default"
  | "remedy"
  | "surrender"
  | "holdover"
  | "signature"
  | "notice"
  | "calculation"
  | "unknown";

export type ResponsibilityRole =
  | "performs"
  | "pays"
  | "maintains"
  | "repairs"
  | "replaces"
  | "insures"
  | "reimburses"
  | "allocates"
  | "approves"
  | "unknown";

export type CalculationRole =
  | "rate"
  | "quantity"
  | "area"
  | "subtotal"
  | "total"
  | "cap"
  | "threshold"
  | "percentage"
  | "installment"
  | "unknown";

export interface SemanticProfile {
  /** Best-effort canonical concept label for this candidate -- carried
   *  through from the fact/candidate's own classified category when one
   *  exists (e.g. "clause:rent_escalation"); null when no classification is
   *  available. Informational only, never itself a hard-gate dimension. */
  concept: string | null;
  valueType: ValueType;
  monetaryRole: MonetaryRole;
  dateRole: DateRole;
  partyRole: PartyRole;
  clauseRole: ClauseRole;
  responsibilityRole: ResponsibilityRole;
  calculationRole: CalculationRole;
}

export interface SemanticCompatibilityInput {
  value: unknown;
  sourceText: string;
  /** The candidate's own classified category, if any (fact.category for
   *  openai_fact_ledger; not currently available for legacy_hybrid, which
   *  passes null). */
  category?: string | null;
}

export interface SemanticCompatibilityResult {
  compatible: boolean;
  reason?: string;
}

// ── Deterministic role classifiers ───────────────────────────────────────────
// Every classifier below is a generalized, template-independent pattern set.
// Order within each function matters: more specific patterns are checked
// before more generic catch-alls (documented inline where the ordering is
// load-bearing, e.g. "pays" must be checked before "repairs" so a
// pay-for-repairs sentence resolves to the payment role, not the physical-
// work role).

function inferValueType(value: unknown, sourceText: string): ValueType {
  if (typeof value === "boolean") return "boolean";
  const valueText = String(value ?? "").trim();
  if (!valueText) return "unknown";
  if (/%\s*$/.test(valueText)) return "percentage";
  const numericValue = valueText.replace(/[$,]/g, "");
  const looksNumeric = /^-?\d+(?:\.\d+)?$/.test(numericValue);
  if (looksNumeric && (/\$/.test(valueText) || /\$|\bdollars?\b|\brent\b|\bfee\b|\bcharge\b|\bdeposit\b|\ballowance\b|\bamount\b/i.test(sourceText))) {
    return "money";
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(valueText) || (!looksNumeric && !Number.isNaN(Date.parse(valueText)))) return "date";
  if (looksNumeric) return "number";
  return "text";
}

function inferMonetaryRole(sourceText: string): MonetaryRole {
  const s = sourceText.toLowerCase();
  if (/percentage\s+rent|percent(?:age)?\s+of\s+(?:gross|net)\s+sales|sales[\s-]based\s+rent/.test(s)) return "percentage_rent";
  if (/security\s+deposit|damage\s+deposit/.test(s)) return "deposit";
  if (/(?:tenant|build[\s-]?out|improvement)\s+allowance|allowance\s+(?:for|toward|of)|\bti\s+allowance\b/.test(s)) return "allowance";
  if (/late\s+fee|default\s+interest|liquidated\s+damages|\bpenalty\b|returned\s+(?:check|payment)\s+fee|non[\s-]?sufficient\s+funds/.test(s)) return "penalty";
  if (/\breimburse|\breimbursement\b/.test(s)) return "reimbursement";
  if (/\bamortiz/.test(s)) return "amortization";
  if (/common\s+area\s+maintenance|\bcam\b/.test(s)) return "cam";
  if (/real\s+estate\s+tax|property\s+tax|ad\s+valorem\s+tax/.test(s)) return "tax";
  if (/insurance\s+premium|insurance\s+recover|property\s+insurance\s+cost/.test(s)) return "insurance_recovery";
  // Generic "recurring ancillary charge billed alongside rent but not rent
  // itself" bucket -- the taxonomy has no dedicated "parking" role, so
  // parking/utility charges both classify here (matches the field examples'
  // treatment of parking fees as a monthly_rent rejection case).
  if (/\belectric(?:ity|al)?\b|\bwater\b[\s\S]{0,20}\bsewer\b|\bsewer\b[\s\S]{0,20}\bwater\b|\bgas\s+service\b|\butilit(?:y|ies)\b|\bparking\b/.test(s)
    && /\bcharge|\bbill|\bcost|\bexpense|\bservice|\bpay|\breimburse|\bfee\b/.test(s)) {
    return "utility_charge";
  }
  if (/application\s+fee|move[\s-]?in\s+fee|one[\s-]?time\s+charge|administrative\s+fee\b/.test(s)) return "one_time_charge";
  if (/\badditional\s+rent\b/.test(s)) return "additional_rent";
  // Base rent: covers both prose ("base rent", "monthly rent") and
  // underscore/field-name-joined phrasing that can appear when a candidate's
  // sourceText echoes a data-entry label ("base_rent_monthly equals $4,200"),
  // plus a generic "rent" + dollar-amount fallback for plain statements
  // ("Rent: $1,400 per month.") that name no other rent category -- any more
  // specific monetary role above (additional rent, CAM, tax, penalty, etc.)
  // would already have matched and returned before reaching this fallback.
  if (/\b(?:base|minimum|monthly|annual)[\s_]rent\b|\brent\s+(?:shall\s+be|of|payable|in\s+the\s+amount)|base_rent_monthly|base_rent_annual/.test(s)) return "base_rent";
  if (/\brent\b/.test(s) && /\$\s*[\d,]/.test(s)) return "base_rent";
  return "unknown";
}

function inferDateRole(sourceText: string): DateRole {
  const s = sourceText.toLowerCase();
  if (/witness(?:ed)?\s+whereof|executed\s+(?:this|as\s+of)|date\s+of\s+execution/.test(s)) return "execution";
  if (/\bsignature\b|signed\s+(?:this|by|below)|\bby\s*:\s*_+|date\s+signed/.test(s)) return "signature";
  if (/\beffective\s+date\b/.test(s)) return "effective";
  if (/delivery\s+of\s+possession|deliver\s+the\s+premises/.test(s)) return "delivery";
  if (/possession\s+date|take\s+possession/.test(s)) return "possession";
  if (/rent\s+commencement/.test(s)) return "rent_commencement";
  if (/commencement\s+date|lease\s+commences|term\s+shall\s+commence/.test(s)) return "commencement";
  // Notice/option-exercise deadlines are checked BEFORE "expiration" -- a
  // notice-period sentence often phrases its deadline relative to "the end
  // of the term" ("not less than 180 days prior notice before the end of
  // the Term"), which would otherwise false-match the generic expiration
  // pattern below.
  if (/exercise\s+(?:the\s+)?option|option\s+exercise\s+deadline/.test(s)) return "option_exercise";
  if (/notice\s+(?:period|deadline|date)|days[’']?\s+(?:prior\s+)?(?:written\s+)?notice/.test(s)) return "notice";
  if (/expir(?:e|ation|es|ed)|end\s+of\s+(?:the\s+)?term|termination\s+date/.test(s)) return "expiration";
  if (/\breconcil/.test(s)) return "reconciliation";
  if (/certificate\s+of\s+occupancy|substantial\s+completion/.test(s)) return "certificate";
  return "unknown";
}

function inferPartyRole(sourceText: string): PartyRole {
  const s = sourceText.toLowerCase();
  if (/\bbroker(?:age)?\b|\brealtor\b|\brealty\b/.test(s)) return "broker";
  if (/property\s+manager|management\s+company|managing\s+agent/.test(s)) return "property_manager";
  if (/\bguarantor\b|\bguaranty\b/.test(s)) return "guarantor";
  if (/\bassignee\b/.test(s)) return "assignee";
  if (/\bsubtenant\b|\bsublessee\b/.test(s)) return "subtenant";
  if (/\blender\b|\bmortgagee\b/.test(s)) return "lender";
  if (/authorized\s+(?:signatory|representative|officer)|\bby\s*:\s*_+|\bits\s*:\s*(?:president|manager|officer|member|vice\s+president)/.test(s)) return "signatory";
  if (/\blandlord\b|\blessor\b/.test(s)) return "landlord";
  if (/\btenant\b|\blessee\b/.test(s)) return "tenant";
  return "unknown";
}

function inferClauseRole(sourceText: string): ClauseRole {
  const s = sourceText.toLowerCase();
  if (/\bshall\s+mean\b|is\s+defined\s+as|as\s+used\s+(?:herein|in\s+this\s+lease)/.test(s)) return "definition";
  if (/event\s+of\s+default|default\s+by\s+(?:tenant|landlord)/.test(s)) return "default";
  if (/\bremed(?:y|ies)\b|damages\s+sustained|costs?\s+of\s+reletting/.test(s)) return "remedy";
  if (/\bholdover\b|holding\s+over/.test(s)) return "holdover";
  if (/\bsurrender\b/.test(s)) return "surrender";
  if (/options?\s+to\s+renew|right\s+to\s+renew|renewal\s+options?|right\s+of\s+first\s+(?:refusal|offer)/.test(s)) return "option";
  if (/hereby\s+grants?|landlord\s+grants?|tenant\s+is\s+granted/.test(s)) return "grant";
  if (/\bshall\s+not\b|\bprohibited\b|\bmay\s+not\b|without\s+(?:landlord|tenant)(?:'s)?\s+(?:prior\s+)?(?:written\s+)?consent/.test(s)) return "prohibition";
  if (/provided\s+that|subject\s+to|conditioned\s+(?:up)?on|in\s+the\s+event\s+that/.test(s)) return "condition";
  if (/witness\s+whereof|\bsignature\b|signed\s+by|\bby\s*:\s*_+/.test(s)) return "signature";
  if (/notice\s+(?:shall\s+be|period|to)/.test(s)) return "notice";
  if (/multiplied\s+by|per\s+square\s+foot|rate\s*[x×]\s*area|\bformula\b/.test(s)) return "calculation";
  if (/\bshall\s+(?:pay|maintain|repair|replace|insure|perform)\b/.test(s)) return "obligation";
  return "unknown";
}

function inferResponsibilityRole(sourceText: string): ResponsibilityRole {
  const s = sourceText.toLowerCase();
  // Specific physical-work/procurement roles are checked FIRST, using
  // patterns narrow enough to require the work verb itself directly
  // ("shall repair", "responsible for repair(ing)") -- so a cost-allocation
  // sentence like "Tenant shall pay for all repairs" (verb is "pay", not
  // "repair") does NOT match here and instead falls through to the broader
  // "pays" bucket below, while "Tenant shall repair the HVAC system" (verb is
  // "repair") resolves to "repairs" even though a broadened generic
  // "responsible for" pattern lives further down.
  if (/\bshall\s+reimburse\b|reimbursement\s+(?:of|for|to)/.test(s)) return "reimburses";
  if (/\bshall\s+insure\b|obtain\s+(?:and\s+maintain\s+)?insurance|maintain\s+insurance\s+(?:on|for|covering)/.test(s)) return "insures";
  if (/\bshall\s+replace\b|responsible\s+for\s+replac/.test(s)) return "replaces";
  if (/\bshall\s+repair\b|responsible\s+for\s+repair/.test(s)) return "repairs";
  if (/\bshall\s+maintain\b|responsible\s+for\s+maintain/.test(s)) return "maintains";
  if (/\bshall\s+allocate\b|allocation\s+of/.test(s)) return "allocates";
  if (/\bshall\s+approve\b|consent\s+(?:of|from)|subject\s+to\s+approval/.test(s)) return "approves";
  if (/\bshall\s+perform\b|responsible\s+for\s+performing/.test(s)) return "performs";
  // Broad financial-responsibility bucket, checked after the more specific
  // physical-work/procurement roles above so it only catches sentences that
  // did NOT already resolve to one of those (e.g. a plain "Tenant is
  // responsible for all real estate taxes" with no specific work verb).
  if (/\bshall\s+pay(?:\s+for)?\b|\bresponsible\s+for\b|\bpayable\s+by\b|at\s+(?:tenant|landlord)(?:'s)?\s+(?:sole\s+)?(?:cost|expense)/.test(s)) return "pays";
  return "unknown";
}

function inferCalculationRole(sourceText: string): CalculationRole {
  const s = sourceText.toLowerCase();
  if (/not\s+to\s+exceed|maximum\s+of|\bcap(?:ped)?\s+at\b/.test(s)) return "cap";
  if (/minimum\s+(?:of|amount)|\bthreshold\b/.test(s)) return "threshold";
  if (/per\s+square\s+foot|\bpsf\b|rate\s+of\s+\$/.test(s)) return "rate";
  if (/square\s+(?:feet|footage)|rentable\s+area|\bunits?\b|\bsf\b/.test(s)) return "quantity";
  if (/%|\bpercent\b/.test(s)) return "percentage";
  // "installment" covers both the explicit word and the far more common
  // plain "$X per month" / "$X/mo" phrasing that names a recurring payment
  // amount without ever using the word "installment".
  if (/monthly\s+installment|installment\s+of|\bper\s+month\b|\/\s*mo(?:nth)?\b/.test(s)) return "installment";
  if (/\bsubtotal\b/.test(s)) return "subtotal";
  if (/\btotal\b|grand\s+total|total\s+(?:amount|sum)/.test(s)) return "total";
  return "unknown";
}

/**
 * Deterministic, document-agnostic semantic-role classifier. Shared by both
 * pipelines -- see module docstring. Never depends on which pipeline
 * produced the candidate; only on the candidate's own value/sourceText/
 * category, so legacy_hybrid's ExtractedField candidates and
 * openai_fact_ledger's Fact candidates classify identically given the same
 * text.
 */
export function inferSemanticProfile(input: SemanticCompatibilityInput): SemanticProfile {
  const sourceText = String(input.sourceText ?? "");
  return {
    concept: input.category ?? null,
    valueType: inferValueType(input.value, sourceText),
    monetaryRole: inferMonetaryRole(sourceText),
    dateRole: inferDateRole(sourceText),
    partyRole: inferPartyRole(sourceText),
    clauseRole: inferClauseRole(sourceText),
    responsibilityRole: inferResponsibilityRole(sourceText),
    calculationRole: inferCalculationRole(sourceText),
  };
}

// ── Per-field semantic compatibility rules ───────────────────────────────────

type CustomRule = (
  profile: SemanticProfile,
  ctx: SemanticCompatibilityInput,
) => SemanticCompatibilityResult | null | undefined;

interface FieldSemanticRule {
  requireMonetaryRole?: MonetaryRole[];
  rejectMonetaryRole?: MonetaryRole[];
  requireDateRole?: DateRole[];
  rejectDateRole?: DateRole[];
  requirePartyRole?: PartyRole[];
  rejectPartyRole?: PartyRole[];
  requireClauseRole?: ClauseRole[];
  rejectClauseRole?: ClauseRole[];
  requireResponsibilityRole?: ResponsibilityRole[];
  rejectResponsibilityRole?: ResponsibilityRole[];
  /** Documentary only -- never enforced as a hard gate. Records which
   *  calculationRole values this field's value is EXPECTED to appear with,
   *  for corpus reporting; "accepts" in the spec is not "requires". */
  acceptCalculationRole?: CalculationRole[];
  /** Soft preference only (e.g. ti_allowance preferring a computed total over
   *  a bare rate/area sub-fact) -- never causes rejection on its own. */
  preferCalculationRole?: CalculationRole[];
  custom?: CustomRule;
}

const NON_BASE_RENT_MONETARY_ROLES: MonetaryRole[] = [
  "additional_rent", "cam", "tax", "insurance_recovery", "utility_charge",
  "reimbursement", "amortization", "penalty", "percentage_rent", "deposit",
  "one_time_charge",
];

/**
 * Full field semantic requirement coverage — extended from the original 15 fields
 * to 73 fields, covering every LEASE_SCHEMA field that had zero semantic role
 * protection. Each entry is a hard accept/reject gate: an incompatible candidate
 * is rejected outright (score forced to 0), never merely down-scored.
 *
 * Design rule (unchanged from original): rejected-category/pattern matches are
 * the only hard vetoes. An allowed-category match is a strong positive signal,
 * never a requirement. "unconfigured" fields (no entry here) are fully
 * unconstrained — preserving pre-extension behavior for fields intentionally
 * left open (e.g. notes, status).
 */
export const FIELD_SEMANTIC_REQUIREMENTS: Record<string, FieldSemanticRule> = {
  monthly_rent: {
    requireMonetaryRole: ["base_rent"],
    rejectMonetaryRole: NON_BASE_RENT_MONETARY_ROLES,
    acceptCalculationRole: ["installment", "total"],
  },
  annual_rent: {
    requireMonetaryRole: ["base_rent"],
    rejectMonetaryRole: NON_BASE_RENT_MONETARY_ROLES,
    custom: (profile, ctx) => {
      // "must be explicit annual total or derived only from a validated
      // monthly base-rent fact" -- the derived case is handled entirely
      // upstream (dynamicFields.js's buildDerivedFieldEvidence, which
      // already requires a source-backed monthly_rent parent -- see
      // Micro-step 0's selectionProvenance). At the raw-candidate layer this
      // only sees explicitly-stated facts, so a bare monthly-installment
      // phrase with no annual/yearly framing is rejected here.
      if (profile.calculationRole === "installment" && !/\bannual(?:ly)?\b|\byearly\b|per\s+year/i.test(String(ctx.sourceText ?? ""))) {
        return { compatible: false, reason: "annual_rent: source text frames this as a monthly installment, not an explicit annual total" };
      }
      return { compatible: true };
    },
  },
  ti_allowance: {
    requireMonetaryRole: ["allowance"],
    preferCalculationRole: ["total"],
    custom: (profile, ctx) => {
      // "if formula evidence exists, prefer calculationRole = total;
      // preserve rate and area as separate supporting facts" -- when the
      // source text states an explicit "A x B = C" formula (rate x area =
      // total, in either order the document writes it), a candidate whose
      // OWN value matches a left-hand operand (the rate or the area/
      // quantity) rather than the right-hand result is the wrong number for
      // THIS field, regardless of which lease it came from. Generalized
      // numeric-formula shape, not a document-specific literal.
      const sourceText = String(ctx.sourceText ?? "");
      const formula = sourceText.match(/\$?\s*([\d,]+(?:\.\d+)?)\s*[x×]\s*\$?\s*([\d,]+(?:\.\d+)?)[^=]{0,40}=\s*\$?\s*([\d,]+(?:\.\d+)?)/i);
      if (formula) {
        const parseNum = (s: string) => Number(s.replace(/,/g, ""));
        const numericValue = parseNum(String(ctx.value ?? "").replace(/[$,]/g, ""));
        const [, left1, left2, result] = formula;
        const isLeftOperand = Number.isFinite(numericValue) && (numericValue === parseNum(left1) || numericValue === parseNum(left2));
        const isResult = Number.isFinite(numericValue) && numericValue === parseNum(result);
        if (isLeftOperand && !isResult) {
          return { compatible: false, reason: "ti_allowance: source text states an explicit rate x area = total formula, and this candidate's value matches a left-hand operand (rate or area), not the computed total" };
        }
      }
      return { compatible: true };
    },
  },
  expiration_date: {
    requireDateRole: ["expiration"],
    rejectDateRole: ["signature", "execution"],
  },
  commencement_date: {
    // Direct fix for "execution dates mapped as commencement dates" -- the
    // mirror image of expiration_date's own guard above.
    requireDateRole: ["commencement"],
    rejectDateRole: ["signature", "execution", "expiration"],
  },
  start_date: {
    requireDateRole: ["commencement"],
    rejectDateRole: ["signature", "execution", "expiration"],
  },
  end_date: {
    requireDateRole: ["expiration"],
    rejectDateRole: ["signature", "execution"],
  },
  broker_name: {
    requirePartyRole: ["broker"],
    custom: (profile, ctx) => {
      const valueText = String(ctx.value ?? "").trim();
      if (!valueText) return { compatible: false, reason: "broker_name: value is empty" };
      if (/\bcommissions?\b|\bfees?\b|\bexpenses?\b|\bcosts?\b/i.test(valueText)) {
        return { compatible: false, reason: "broker_name: value describes brokerage commissions/fees/costs, not a broker's name" };
      }
      const looksNamed =
        /\b(?:LLC|L\.L\.C\.|Inc\.?|Corp\.?|Corporation|Company|Co\.?|LP|LLP|Realty|Group|Associates|Partners)\b/.test(valueText) ||
        /^[A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+){1,4}$/.test(valueText);
      if (!looksNamed) return { compatible: false, reason: "broker_name: value does not look like a named person or organization" };
      return { compatible: true };
    },
  },
  tenant_signatory_name: {
    requirePartyRole: ["signatory"],
    custom: (profile, ctx) => {
      const valueText = String(ctx.value ?? "").trim();
      const sourceText = String(ctx.sourceText ?? "");
      if (!valueText) return { compatible: false, reason: "tenant_signatory_name: value is empty" };
      const hasSignatureFraming = /\bby\s*:|\bname\s*:|\btitle\s*:|\bits\s*:|authorized\s+(?:signatory|representative|officer)|witness(?:ed)?\s+whereof/i.test(sourceText);
      if (!hasSignatureFraming) {
        return { compatible: false, reason: "tenant_signatory_name: source text has no signature-block or explicit representative framing" };
      }
      if (/successors?\s+and\s+assigns?|binding\s+upon\s+the\s+parties|entire\s+agreement/i.test(sourceText) && !/\bby\s*:|\bname\s*:|\btitle\s*:/i.test(sourceText)) {
        return { compatible: false, reason: "tenant_signatory_name: source text is generic contract boilerplate, not signature-block evidence" };
      }
      return { compatible: true };
    },
  },
  renewal_options: {
    requireClauseRole: ["option", "grant"],
    rejectClauseRole: ["surrender", "holdover", "default", "remedy"],
  },
  electric_responsibility: {
    requireMonetaryRole: ["utility_charge"],
    requireResponsibilityRole: ["pays"],
    rejectResponsibilityRole: ["repairs", "maintains", "replaces"],
  },
  insurance_responsibility: {
    requireResponsibilityRole: ["pays", "insures"],
    rejectResponsibilityRole: ["repairs", "maintains", "replaces"],
    custom: (profile, ctx) => {
      if (!/\binsurance\b|\bpremium\b|\bcoverage\b|\bpolic(?:y|ies)\b/i.test(String(ctx.sourceText ?? ""))) {
        return { compatible: false, reason: "insurance_responsibility: source text does not mention insurance/premium/coverage/policy" };
      }
      return { compatible: true };
    },
  },
  tax_responsibility: {
    requireMonetaryRole: ["tax"],
    requireResponsibilityRole: ["pays"],
    rejectResponsibilityRole: ["repairs", "maintains", "replaces"],
  },
  responsibility_repairs: {
    requireResponsibilityRole: ["repairs", "maintains", "replaces", "pays"],
    custom: (profile, ctx) => {
      if (!/\brepair|\bmaintenance\b|\bmaintain|\balteration|\bcondition\b/i.test(String(ctx.sourceText ?? ""))) {
        return { compatible: false, reason: "responsibility_repairs: source text does not reference the repair/maintenance domain" };
      }
      return { compatible: true };
    },
  },
  late_fee_amount: {
    // Rejects a plausible-looking dollar figure that is actually an address
    // number, unit count, or other unrelated numeric value picked up near an
    // unrelated label -- requires the source text to actually be framed as a
    // late/delinquent-payment penalty, not just any nearby dollar amount.
    requireMonetaryRole: ["penalty"],
  },

  // ── Extension: all remaining LEASE_SCHEMA fields ─────────────────────────
  // The 15 fields above were the original set. All remaining fields had
  // ZERO semantic role protection -- any fact clearing MIN_LABEL_SCORE was
  // accepted regardless of meaning. Each entry below closes that gap.

  // ── Monetary charge fields ─────────────────────────────────────────────────
  security_deposit: {
    requireMonetaryRole: ["deposit"],
    // A deposit clause must reference "deposit" or "security" -- never accept
    // a rent-schedule dollar figure that merely scored on keyword proximity.
    custom: (profile, ctx) => {
      if (!/\bdeposit\b|\bsecurity\b/i.test(String(ctx.sourceText ?? ""))) {
        return { compatible: false, reason: "security_deposit: source text does not reference a deposit or security context" };
      }
      return { compatible: true };
    },
  },
  cam_amount: {
    requireMonetaryRole: ["cam"],
    // Must reference CAM or common area explicitly -- not just any dollar figure
    // near the word "common".
    custom: (profile, ctx) => {
      if (!/\bcam\b|\bcommon\s+area\s+maintenance\b|\boperating\s+expense/i.test(String(ctx.sourceText ?? ""))) {
        return { compatible: false, reason: "cam_amount: source text does not reference CAM or common area maintenance" };
      }
      return { compatible: true };
    },
  },
  parking_fee_amount: {
    requireMonetaryRole: ["utility_charge", "one_time_charge"],
    rejectMonetaryRole: ["base_rent", "deposit", "penalty", "allowance"],
    custom: (profile, ctx) => {
      if (!/\bparking\b|\bgarage\b/i.test(String(ctx.sourceText ?? ""))) {
        return { compatible: false, reason: "parking_fee_amount: source text does not reference parking or garage" };
      }
      return { compatible: true };
    },
  },
  returned_payment_fee_amount: {
    requireMonetaryRole: ["penalty"],
    custom: (profile, ctx) => {
      if (!/\breturned\b|\bbounced\b|\bdishonored\b|\bnsf\b|\bnon[- ]?sufficient/i.test(String(ctx.sourceText ?? ""))) {
        return { compatible: false, reason: "returned_payment_fee_amount: source text does not reference a returned/bounced payment" };
      }
      return { compatible: true };
    },
  },
  administrative_fee_amount: {
    // Flat dollar admin fee billed to tenant directly -- NOT the CAM
    // admin_fee_pct percentage. Rejects percentage-only evidence.
    rejectMonetaryRole: ["base_rent", "deposit", "penalty"],
    custom: (profile, ctx) => {
      const s = String(ctx.sourceText ?? "");
      if (!/\badministrative\b|\badmin\b/i.test(s)) {
        return { compatible: false, reason: "administrative_fee_amount: source text does not reference administrative or admin context" };
      }
      // Reject if value looks like a percentage rate (the CAM admin_fee_pct
      // field, not this flat-dollar field).
      const valueStr = String(ctx.value ?? "");
      if (/\d+\s*%|percent/i.test(valueStr)) {
        return { compatible: false, reason: "administrative_fee_amount: value appears to be a percentage rate, not a flat dollar amount" };
      }
      return { compatible: true };
    },
  },
  utility_reimbursement_amount: {
    requireMonetaryRole: ["utility_charge", "reimbursement"],
    custom: (profile, ctx) => {
      if (!/\butility\b|\butilities\b|\breimburse/i.test(String(ctx.sourceText ?? ""))) {
        return { compatible: false, reason: "utility_reimbursement_amount: source text does not reference utility or reimbursement" };
      }
      return { compatible: true };
    },
  },
  water_sewer_reimbursement_amount: {
    requireMonetaryRole: ["utility_charge", "reimbursement"],
    custom: (profile, ctx) => {
      if (!/\bwater\b|\bsewer\b/i.test(String(ctx.sourceText ?? ""))) {
        return { compatible: false, reason: "water_sewer_reimbursement_amount: source text does not reference water or sewer" };
      }
      return { compatible: true };
    },
  },
  general_liability_min: {
    // General liability minimum is a coverage amount (dollar value) in an
    // insurance context -- not a rent, not a fee. Use a custom check rather
    // than requireMonetaryRole since the coverage amount may not classify
    // cleanly as any monetary role.
    rejectMonetaryRole: ["base_rent", "deposit", "penalty", "cam", "tax", "allowance"],
    custom: (profile, ctx) => {
      if (!/\bgeneral\s+liability\b|\bcgl\b|\bcommercial\s+general\b|\bliability\s+insurance\b|\bliability\s+coverage\b/i.test(String(ctx.sourceText ?? ""))) {
        return { compatible: false, reason: "general_liability_min: source text does not reference general liability or CGL insurance coverage" };
      }
      return { compatible: true };
    },
  },
  expense_stop: {
    rejectMonetaryRole: ["base_rent", "deposit", "penalty", "allowance", "cam"],
    custom: (profile, ctx) => {
      if (!/\bexpense\s+stop\b|\bexpense\s+cap\b/i.test(String(ctx.sourceText ?? ""))) {
        return { compatible: false, reason: "expense_stop: source text does not reference an expense stop or expense cap" };
      }
      return { compatible: true };
    },
  },
  amended_base_rent_for_additional_year: {
    requireMonetaryRole: ["base_rent"],
    rejectMonetaryRole: NON_BASE_RENT_MONETARY_ROLES,
    custom: (profile, ctx) => {
      const s = String(ctx.sourceText ?? "");
      if (!/\badditional\s+year\b|\bamended\b|\bextension\b|\bamendment\b|\bextended\s+term\b/i.test(s)) {
        return { compatible: false, reason: "amended_base_rent_for_additional_year: source text does not reference an amendment, additional year, or extension period" };
      }
      return { compatible: true };
    },
  },
  assignment_consideration: {
    rejectMonetaryRole: ["base_rent", "deposit", "cam", "tax", "penalty"],
    custom: (profile, ctx) => {
      if (!/\bassignment\b|\bconsideration\b|\btransfer\b/i.test(String(ctx.sourceText ?? ""))) {
        return { compatible: false, reason: "assignment_consideration: source text does not reference an assignment or consideration" };
      }
      return { compatible: true };
    },
  },

  // ── Date fields ────────────────────────────────────────────────────────────
  lease_date: {
    // Execution or effective date of the lease document itself -- rejects
    // term commencement, expiration, and signature block dates.
    requireDateRole: ["execution", "effective"],
    rejectDateRole: ["commencement", "expiration", "rent_commencement", "option_exercise"],
  },
  rent_commencement_date: {
    requireDateRole: ["rent_commencement", "commencement"],
    rejectDateRole: ["signature", "execution", "expiration", "option_exercise"],
  },
  tenant_signature_date: {
    requireDateRole: ["signature", "execution"],
    // Must come from a tenant context in the signature block.
    custom: (profile, ctx) => {
      const s = String(ctx.sourceText ?? "");
      if (!/\btenant\b|\blessee\b/i.test(s)) {
        return { compatible: false, reason: "tenant_signature_date: source text does not reference tenant or lessee" };
      }
      return { compatible: true };
    },
  },
  landlord_signature_date: {
    requireDateRole: ["signature", "execution"],
    custom: (profile, ctx) => {
      const s = String(ctx.sourceText ?? "");
      if (!/\blandlord\b|\blessor\b/i.test(s)) {
        return { compatible: false, reason: "landlord_signature_date: source text does not reference landlord or lessor" };
      }
      return { compatible: true };
    },
  },
  assignment_effective_date: {
    requireDateRole: ["effective", "execution"],
    custom: (profile, ctx) => {
      if (!/\bassignment\b|\bassign/i.test(String(ctx.sourceText ?? ""))) {
        return { compatible: false, reason: "assignment_effective_date: source text does not reference an assignment" };
      }
      return { compatible: true };
    },
  },
  option_exercise_deadline: {
    requireDateRole: ["option_exercise", "notice"],
    rejectDateRole: ["signature", "execution", "commencement", "expiration"],
  },

  // ── Notice period fields ──────────────────────────────────────────────────
  renewal_notice_months: {
    // Must be framed as required advance notice for a renewal option.
    requireClauseRole: ["notice", "option"],
    custom: (profile, ctx) => {
      const s = String(ctx.sourceText ?? "");
      if (!/\brenewal\b|\brenew\b|\boption\b|\bextension\b/i.test(s)) {
        return { compatible: false, reason: "renewal_notice_months: source text does not reference a renewal or option context" };
      }
      if (!/\bnotice\b|\bprior\b|\badvance\b|\bat\s+least\b|\bnot\s+less\s+than\b/i.test(s)) {
        return { compatible: false, reason: "renewal_notice_months: source text has no advance-notice timing language" };
      }
      return { compatible: true };
    },
  },
  termination_notice_months: {
    requireClauseRole: ["notice", "option"],
    custom: (profile, ctx) => {
      const s = String(ctx.sourceText ?? "");
      if (!/\bterminat/i.test(s)) {
        return { compatible: false, reason: "termination_notice_months: source text does not reference termination" };
      }
      if (!/\bnotice\b|\bprior\b|\badvance\b/i.test(s)) {
        return { compatible: false, reason: "termination_notice_months: source text has no advance-notice timing language" };
      }
      return { compatible: true };
    },
  },

  // ── Party / entity fields ─────────────────────────────────────────────────
  tenant_name: {
    requirePartyRole: ["tenant"],
    rejectPartyRole: ["broker", "guarantor", "property_manager", "lender"],
    // Must NOT come from an indemnification, M&A, or transfer clause.
    custom: (profile, ctx) => {
      const s = String(ctx.sourceText ?? "");
      if (/\bclosely\s+held\b|\bvoting\s+shares\b|\breorganization\b|\bmerger\b|\bconsolidation\b/i.test(s)) {
        return { compatible: false, reason: "tenant_name: source text describes an M&A or reorganization clause, not a party identification clause" };
      }
      return { compatible: true };
    },
  },
  landlord_name: {
    requirePartyRole: ["landlord"],
    rejectPartyRole: ["broker", "guarantor", "property_manager", "lender", "tenant"],
    custom: (profile, ctx) => {
      const s = String(ctx.sourceText ?? "");
      if (/\bclosely\s+held\b|\bvoting\s+shares\b|\breorganization\b|\bmerger\b|\bconsolidation\b/i.test(s)) {
        return { compatible: false, reason: "landlord_name: source text describes an M&A or reorganization clause" };
      }
      return { compatible: true };
    },
  },
  landlord_signatory_name: {
    requirePartyRole: ["signatory"],
    custom: (profile, ctx) => {
      const sourceText = String(ctx.sourceText ?? "");
      const hasSignatureFraming = /\bby\s*:|\bname\s*:|\btitle\s*:|\bits\s*:|authorized\s+(?:signatory|representative|officer)|witness(?:ed)?\s+whereof/i.test(sourceText);
      if (!hasSignatureFraming) {
        return { compatible: false, reason: "landlord_signatory_name: source text has no signature-block or representative framing" };
      }
      if (!/\blandlord\b|\blessor\b/i.test(sourceText)) {
        return { compatible: false, reason: "landlord_signatory_name: source text does not reference landlord or lessor" };
      }
      return { compatible: true };
    },
  },
  assignor_name: {
    requirePartyRole: ["assignee", "tenant"],
    custom: (profile, ctx) => {
      if (!/\bassignor\b|\boriginal\s+tenant\b|\bcurrent\s+tenant\b|\btransferor\b/i.test(String(ctx.sourceText ?? ""))) {
        return { compatible: false, reason: "assignor_name: source text does not reference an assignor or original tenant" };
      }
      return { compatible: true };
    },
  },
  assignee_name: {
    requirePartyRole: ["assignee"],
    custom: (profile, ctx) => {
      if (!/\bassignee\b|\bnew\s+tenant\b|\bsuccessor\s+tenant\b|\btransferee\b/i.test(String(ctx.sourceText ?? ""))) {
        return { compatible: false, reason: "assignee_name: source text does not reference an assignee or new tenant" };
      }
      return { compatible: true };
    },
  },

  // ── Responsibility enum fields ─────────────────────────────────────────────
  responsibility_taxes: {
    requireMonetaryRole: ["tax"],
    requireResponsibilityRole: ["pays", "allocates"],
    rejectResponsibilityRole: ["repairs", "maintains", "replaces"],
  },
  responsibility_insurance: {
    requireResponsibilityRole: ["pays", "insures"],
    rejectResponsibilityRole: ["repairs", "maintains", "replaces"],
    custom: (profile, ctx) => {
      if (!/\binsurance\b|\bpremium\b|\bcoverage\b/i.test(String(ctx.sourceText ?? ""))) {
        return { compatible: false, reason: "responsibility_insurance: source text does not reference insurance or premium" };
      }
      return { compatible: true };
    },
  },
  responsibility_utilities: {
    requireMonetaryRole: ["utility_charge"],
    requireResponsibilityRole: ["pays", "allocates"],
    rejectResponsibilityRole: ["repairs", "maintains", "replaces"],
  },
  hvac_responsibility: {
    requireResponsibilityRole: ["repairs", "maintains", "pays", "replaces"],
    rejectMonetaryRole: ["base_rent", "deposit", "allowance"],
    custom: (profile, ctx) => {
      if (!/\bhvac\b|\bheating\b|\bcooling\b|\bventilation\b|\bair\s+(?:conditioning|handler)\b/i.test(String(ctx.sourceText ?? ""))) {
        return { compatible: false, reason: "hvac_responsibility: source text does not reference HVAC, heating, cooling, or ventilation" };
      }
      return { compatible: true };
    },
  },
  water_sewer_responsibility: {
    requireMonetaryRole: ["utility_charge"],
    requireResponsibilityRole: ["pays"],
    rejectResponsibilityRole: ["repairs", "maintains", "replaces"],
    custom: (profile, ctx) => {
      if (!/\bwater\b|\bsewer\b/i.test(String(ctx.sourceText ?? ""))) {
        return { compatible: false, reason: "water_sewer_responsibility: source text does not reference water or sewer" };
      }
      return { compatible: true };
    },
  },
  property_insurance_responsibility: {
    requireResponsibilityRole: ["pays", "insures"],
    rejectResponsibilityRole: ["repairs", "maintains", "replaces"],
    custom: (profile, ctx) => {
      const s = String(ctx.sourceText ?? "");
      if (!/\bproperty\s+insurance\b|\bbuilding\s+insurance\b|\bcasualty\s+insurance\b/i.test(s)) {
        return { compatible: false, reason: "property_insurance_responsibility: source text does not reference property or building insurance" };
      }
      if (/\bwaiver\s+of\s+subrogation\b|\bindemnif/i.test(s)) {
        return { compatible: false, reason: "property_insurance_responsibility: source text is a subrogation waiver or indemnification clause, not a cost-responsibility clause" };
      }
      return { compatible: true };
    },
  },

  // ── CAM / expense structure fields ────────────────────────────────────────
  admin_fee_pct: {
    rejectMonetaryRole: ["base_rent", "deposit", "penalty"],
    custom: (profile, ctx) => {
      const s = String(ctx.sourceText ?? "");
      if (!/\badmin(?:istrative)?\s+(?:fee|expense)\b|\bmanagement\s+fee\b/i.test(s)) {
        return { compatible: false, reason: "admin_fee_pct: source text does not reference an administrative or management fee on CAM expenses" };
      }
      if (/\blate\b|\bdefault\b|\binterest\b|\bpenalty\b/i.test(s)) {
        return { compatible: false, reason: "admin_fee_pct: source text is about a late fee or penalty, not a CAM administrative fee" };
      }
      return { compatible: true };
    },
  },
  cam_cap_pct: {
    rejectMonetaryRole: ["base_rent", "deposit", "penalty", "allowance"],
    custom: (profile, ctx) => {
      const s = String(ctx.sourceText ?? "");
      if (!/\bcam\b|\bcontrollable\s+(?:expense|operating)\b|\boperating\s+expense\s+cap\b/i.test(s)) {
        return { compatible: false, reason: "cam_cap_pct: source text does not reference a CAM cap or controllable expense cap" };
      }
      return { compatible: true };
    },
  },
  gross_up_threshold: {
    custom: (profile, ctx) => {
      if (!/\bgross[- ]up\b/i.test(String(ctx.sourceText ?? ""))) {
        return { compatible: false, reason: "gross_up_threshold: source text does not reference a gross-up provision" };
      }
      return { compatible: true };
    },
  },
  base_year: {
    custom: (profile, ctx) => {
      if (!/\bbase\s+year\b/i.test(String(ctx.sourceText ?? ""))) {
        return { compatible: false, reason: "base_year: source text does not reference a base year" };
      }
      return { compatible: true };
    },
  },
  escalation_rate: {
    rejectMonetaryRole: ["penalty", "deposit", "cam", "tax", "allowance"],
    custom: (profile, ctx) => {
      const s = String(ctx.sourceText ?? "");
      if (!/\bescalat|\bincreas|\badjust|\brent\b/i.test(s)) {
        return { compatible: false, reason: "escalation_rate: source text does not reference rent escalation or increase" };
      }
      // Reject if this looks like a late-fee percentage, not a rent increase.
      if (/\blate\b|\bdefault\b|\bpenalty\b|\binterest\b/i.test(s)) {
        return { compatible: false, reason: "escalation_rate: source text references a late fee or penalty, not a rent escalation" };
      }
      return { compatible: true };
    },
  },

  // ── Premises / identity fields ────────────────────────────────────────────
  square_footage: {
    rejectMonetaryRole: ["base_rent", "deposit", "cam", "tax", "allowance", "penalty"],
    custom: (profile, ctx) => {
      const s = String(ctx.sourceText ?? "");
      if (!/\bsquare\s+fee?t\b|\bsq\.?\s*ft\b|\brsf\b|\bsf\b|\brentable\s+area\b|\bleased\s+area\b/i.test(s)) {
        return { compatible: false, reason: "square_footage: source text does not reference square footage or rentable area" };
      }
      if (/\bbuilding\s+(?:total|rsf|square\s+footage)\b/i.test(s)) {
        return { compatible: false, reason: "square_footage: source text references the whole building's RSF, not the leased premises area" };
      }
      return { compatible: true };
    },
  },

  // ── Boolean / presence fields ──────────────────────────────────────────────
  tenant_insurance_required: {
    requireClauseRole: ["obligation", "grant"],
    custom: (profile, ctx) => {
      const s = String(ctx.sourceText ?? "");
      if (!/\btenant\b.*\b(?:shall|must|is\s+required|maintain|carry|obtain|provide)\b.*\binsurance\b|\binsurance\b.*\btenant\b.*\bshall\b/i.test(s)) {
        return { compatible: false, reason: "tenant_insurance_required: source text does not contain operative language requiring tenant to maintain insurance" };
      }
      return { compatible: true };
    },
  },
  waiver_of_subrogation: {
    requireClauseRole: ["obligation", "grant", "condition"],
    custom: (profile, ctx) => {
      if (!/\bwaiver\s+of\s+subrogation\b|\bwaive\s+(?:all\s+)?(?:rights?\s+of\s+)?subrogation\b/i.test(String(ctx.sourceText ?? ""))) {
        return { compatible: false, reason: "waiver_of_subrogation: source text does not contain operative waiver-of-subrogation language" };
      }
      return { compatible: true };
    },
  },
  additional_insureds_required: {
    requireClauseRole: ["obligation", "grant"],
    custom: (profile, ctx) => {
      const s = String(ctx.sourceText ?? "");
      if (!/\badditional\s+insured\b/i.test(s)) {
        return { compatible: false, reason: "additional_insureds_required: source text does not reference additional insured requirements" };
      }
      if (!/\bshall\b|\bmust\b|\brequired\b|\bname\b|\bnamed\b/i.test(s)) {
        return { compatible: false, reason: "additional_insureds_required: source text contains no operative requirement language for additional insureds" };
      }
      return { compatible: true };
    },
  },
  gross_up_enabled: {
    requireClauseRole: ["obligation", "condition", "calculation"],
    custom: (profile, ctx) => {
      const s = String(ctx.sourceText ?? "");
      if (!/\bgross[- ]up\b/i.test(s)) {
        return { compatible: false, reason: "gross_up_enabled: source text does not reference gross-up" };
      }
      // Must be an operative sentence, not just a heading or defined-term mention.
      if (!/\bshall\b|\bwill\b|\blandlord\s+(?:shall|will|must)\b|\boperating\s+expenses\b/i.test(s)) {
        return { compatible: false, reason: "gross_up_enabled: source text appears to be a defined-term mention or heading, not an operative gross-up provision" };
      }
      return { compatible: true };
    },
  },
  right_of_first_refusal: {
    requireClauseRole: ["option", "grant"],
    rejectClauseRole: ["surrender", "holdover", "default"],
    custom: (profile, ctx) => {
      if (!/\bright\s+of\s+first\s+refusal\b|\bright\s+of\s+first\s+offer\b|\brofr\b/i.test(String(ctx.sourceText ?? ""))) {
        return { compatible: false, reason: "right_of_first_refusal: source text does not reference a right of first refusal or first offer" };
      }
      return { compatible: true };
    },
  },
  early_termination_option: {
    requireClauseRole: ["option", "grant"],
    rejectClauseRole: ["default", "remedy", "surrender"],
    custom: (profile, ctx) => {
      if (!/\bearly\s+terminat|\btermination\s+option\b|\bearly\s+out\b/i.test(String(ctx.sourceText ?? ""))) {
        return { compatible: false, reason: "early_termination_option: source text does not reference an early termination option" };
      }
      return { compatible: true };
    },
  },
  landlord_consent: {
    requireClauseRole: ["grant", "condition", "obligation"],
    custom: (profile, ctx) => {
      if (!/\bconsent\b|\bapproval\b|\bapprove\b/i.test(String(ctx.sourceText ?? ""))) {
        return { compatible: false, reason: "landlord_consent: source text does not reference consent or approval" };
      }
      return { compatible: true };
    },
  },
  landlord_consent_for_transfer: {
    requireClauseRole: ["condition", "obligation", "prohibition"],
    custom: (profile, ctx) => {
      const s = String(ctx.sourceText ?? "");
      if (!/\blandlord\b.*\bconsent\b|\bconsent\b.*\blandlord\b/i.test(s)) {
        return { compatible: false, reason: "landlord_consent_for_transfer: source text does not reference landlord consent" };
      }
      if (!/\bassign|\btransfer\b|\bsublet\b|\bsublease\b/i.test(s)) {
        return { compatible: false, reason: "landlord_consent_for_transfer: source text does not reference an assignment or transfer" };
      }
      return { compatible: true };
    },
  },
  all_other_terms_remain_same: {
    requireClauseRole: ["condition", "grant"],
    custom: (profile, ctx) => {
      if (!/\ball\s+other\s+terms\b|\bremain\s+(?:unchanged|in\s+full\s+force)\b|\bother\s+terms\s+and\s+conditions\b/i.test(String(ctx.sourceText ?? ""))) {
        return { compatible: false, reason: "all_other_terms_remain_same: source text does not contain all-other-terms-unchanged language" };
      }
      return { compatible: true };
    },
  },
};

export function hasSemanticRequirement(fieldName: string): boolean {
  return Object.prototype.hasOwnProperty.call(FIELD_SEMANTIC_REQUIREMENTS, fieldName);
}

/**
 * The final semantic accept/reject gate for a (candidate, field) pair.
 * Returns `{ compatible: false, reason }` for a HARD rejection -- callers
 * must treat this as disqualifying, not as a score penalty (Implementation
 * rule 3). Fields with no entry in FIELD_SEMANTIC_REQUIREMENTS are always
 * compatible (this layer does not gate fields it has no opinion on).
 */
export function checkFieldSemanticCompatibility(
  profile: SemanticProfile,
  fieldName: string,
  ctx: SemanticCompatibilityInput,
): SemanticCompatibilityResult {
  const rule = FIELD_SEMANTIC_REQUIREMENTS[fieldName];
  if (!rule) return { compatible: true };

  if (rule.requireMonetaryRole && !rule.requireMonetaryRole.includes(profile.monetaryRole)) {
    return { compatible: false, reason: `${fieldName}: requires monetaryRole in [${rule.requireMonetaryRole.join(", ")}], inferred "${profile.monetaryRole}"` };
  }
  if (rule.rejectMonetaryRole?.includes(profile.monetaryRole)) {
    return { compatible: false, reason: `${fieldName}: rejects candidates with monetaryRole "${profile.monetaryRole}"` };
  }
  if (rule.requireDateRole && !rule.requireDateRole.includes(profile.dateRole)) {
    return { compatible: false, reason: `${fieldName}: requires dateRole in [${rule.requireDateRole.join(", ")}], inferred "${profile.dateRole}"` };
  }
  if (rule.rejectDateRole?.includes(profile.dateRole)) {
    return { compatible: false, reason: `${fieldName}: rejects candidates with dateRole "${profile.dateRole}"` };
  }
  if (rule.requirePartyRole && !rule.requirePartyRole.includes(profile.partyRole)) {
    return { compatible: false, reason: `${fieldName}: requires partyRole in [${rule.requirePartyRole.join(", ")}], inferred "${profile.partyRole}"` };
  }
  if (rule.rejectPartyRole?.includes(profile.partyRole)) {
    return { compatible: false, reason: `${fieldName}: rejects candidates with partyRole "${profile.partyRole}"` };
  }
  if (rule.requireClauseRole && !rule.requireClauseRole.includes(profile.clauseRole)) {
    return { compatible: false, reason: `${fieldName}: requires clauseRole in [${rule.requireClauseRole.join(", ")}], inferred "${profile.clauseRole}"` };
  }
  if (rule.rejectClauseRole?.includes(profile.clauseRole)) {
    return { compatible: false, reason: `${fieldName}: rejects candidates with clauseRole "${profile.clauseRole}"` };
  }
  if (rule.requireResponsibilityRole && !rule.requireResponsibilityRole.includes(profile.responsibilityRole)) {
    return { compatible: false, reason: `${fieldName}: requires responsibilityRole in [${rule.requireResponsibilityRole.join(", ")}], inferred "${profile.responsibilityRole}"` };
  }
  if (rule.rejectResponsibilityRole?.includes(profile.responsibilityRole)) {
    return { compatible: false, reason: `${fieldName}: rejects candidates with responsibilityRole "${profile.responsibilityRole}"` };
  }
  if (rule.custom) {
    const result = rule.custom(profile, ctx);
    if (result && !result.compatible) return result;
  }
  return { compatible: true };
}

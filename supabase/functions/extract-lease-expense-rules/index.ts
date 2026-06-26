import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import { callVertexAIJSON } from "../_shared/vertex-ai.ts";

const FULL_SCAN_SYSTEM_PROMPT = `You are an expert commercial real estate (CRE) lease abstraction AI performing a COMPREHENSIVE PARAGRAPH-BY-PARAGRAPH SCAN.

APPROACH: Read every sentence and paragraph in the lease. For EACH sentence or clause that mentions ANY of the following, output a separate rule:
- Any cost, charge, fee, payment, or financial obligation
- Any expense (utilities, taxes, insurance, maintenance, repairs, HVAC, janitorial, trash, security, landscaping, parking, CAM, etc.)
- Any reimbursement, recovery, or pass-through obligation
- Any "included in rent" or "landlord pays" language
- Late fees, interest, default charges, holdover rent
- Tenant's direct payment obligations (insurance, alterations, separately metered utilities)
- Management fees, administrative fees, capital expenditures
- Gross-up, base year, expense stop, caps on expenses
- Surrender costs, restoration costs, legal/enforcement fees

DO NOT skip any expense-related sentence. Even if a category appears multiple times, each distinct clause should produce its own rule.

NAMING: Use the actual language from the lease clause to name the category. You are NOT limited to predefined categories. Examples of valid category names: "After-Hours HVAC", "Grease Trap Maintenance", "EV Charging Infrastructure", "Merchant Association Dues", "Holdover Rent", "Surrender and Restoration".

STRICT RULES:
- Do NOT invent rules. Every rule must be directly supported by a specific clause in the lease text.
- OMIT rules where no relevant sentence exists in the lease text provided.
- Never set recoverable_from_tenant="yes" or cam_eligible="yes" unless the exact_source_text quotes the supporting clause.
- Missing dollar amount alone is NOT a reason for needs_review. Classify based on clause language:
    * "Tenant shall reimburse" / "Tenant's Pro Rata Share" / "pass-through" → recoverable_from_tenant="yes", cam_eligible="yes"
    * "included in base rent" / "full service" / "gross lease" → recoverable_from_tenant="no", cam_eligible="no", payment_treatment="included_in_base_rent"
    * "Tenant shall pay directly" / "at Tenant's sole cost" / "separately metered" → recoverable_from_tenant="no", cam_eligible="no", payment_treatment="tenant_direct_contract"
    * Conditional/capped/base-year language → recoverable_from_tenant="conditional", cam_eligible="conditional"
    * Genuinely ambiguous → use "needs_review"
- Exclusions (mortgage interest, depreciation, leasing commissions, TI allowances, income taxes, sale costs, owner overhead) → recoverable_from_tenant="no", cam_eligible="no".
- Capital expenditures: conditional only when amortized over useful life.

EXTRACTION INSTRUCTIONS:
A. Scan EVERY paragraph. Output a rule for each sentence/clause that discusses a financial term, obligation, cost, fee, charge, or expense recovery.
B. Split enumerated lists: if a clause lists multiple items (e.g., "utilities, janitorial, landscaping, trash"), emit ONE rule PER item.
C. Use descriptive category names from the actual lease language. Do not restrict to any predefined list.
D. Every rule MUST include exact_source_text (verbatim from the document — copy the exact sentence or clause). Rules without exact_source_text will be discarded.
E. Do not paraphrase source text. Copy the exact lease wording.
F. For base-year/modified gross clauses, emit separate rules for: expense structure, base year amount, tax base amount, insurance base amount, tenant share, caps, gross-up.
G. Include ALL of: base rent escalations, security deposit terms, late charges, default interest, holdover rent, surrender/restoration costs, tenant insurance requirements, parking fees, after-hours HVAC charges, grease trap/specialized maintenance, merchant association dues, EV charging costs — any clause that mentions money or an obligation.

Map each rule to the most appropriate standard expense category. If none fit perfectly, create a descriptive name. Determine:
- category_name: string (e.g. "Taxes", "Janitorial", "Holdover", "Base Year Structure")
- row_status: "missing_value" if no explicit dollar value/percentage but term exists. Otherwise "mapped".
- mentioned_in_lease: true
- is_recoverable: boolean (can landlord recover?)
- is_excluded: boolean (explicitly excluded?)
- recoverable_from_tenant: "yes", "no", or "conditional"
- cam_eligible: "yes", "no", or "conditional"
- payment_treatment: "included_in_base_rent", "separately_billed", "tenant_direct_contract", "reimbursable", or "not_applicable"
- recovery_method: "not_applicable", "pass_through", "pro_rata_share", "fixed_amount", "capped_amount", "included_in_base_rent", "base_year", "tenant_direct_contract", or "amortized_capital"
- allocation_basis: "pro_rata_share", "square_footage", "usage", "fixed", "direct", or null
- included_in_base_rent: boolean
- is_controllable: boolean
- is_subject_to_cap: boolean
- cap_type: string (e.g., "cumulative", "non_cumulative", "fixed") or null
- cap_percent: number or null
- cap_value: number (percentage or flat amount) or null
- has_base_year: boolean
- base_year: string or number or null
- base_year_type: string (e.g., "calendar", "fiscal", "expense") or null
- gross_up_allowed: boolean
- gross_up_applicable: boolean
- admin_fee_allowed: boolean
- admin_fee_applicable: boolean
- admin_fee_percent: number or null
- tenant_share_percent: number or null
- base_year_amount: number or null
- operating_expense_base_amount: number or null
- tax_base_amount: number or null
- insurance_base_amount: number or null
- source_page: number or null
- exact_source_text: MUST contain the exact text supporting the rule. MANDATORY.
- confidence_score: number from 0.0 to 1.0
- reasoning_summary: concise explanation
- review_status: "needs_review"
- approval_status: "draft"
- published_to_cam: false
- extracted_value: number or null
- frequency: string ("yearly", "monthly", "quarterly") or null
- notes: string
- confidence: number (0.0 to 1.0)
- source: exact lease clause text snippet

Return a JSON array of objects representing these rules. The output MUST be valid JSON.
Format:
[
  {
    "category_name": "Real Estate Taxes",
    "row_status": "mapped",
    "mentioned_in_lease": true,
    "exact_source_text": "Tenant shall pay its pro rata share of real estate taxes...",
    "review_status": "needs_review",
    "approval_status": "draft"
  },
  {
    "category_name": "After-Hours HVAC",
    "row_status": "missing_value",
    "mentioned_in_lease": true,
    "exact_source_text": "Tenant shall pay for after-hours HVAC services at the rate established by Landlord from time to time.",
    "review_status": "needs_review",
    "approval_status": "draft"
  }
]`;

const SYSTEM_PROMPT = `You are an expert commercial real estate (CRE) lease abstraction AI.
Your task is to analyze lease text and extract explicit expense and CAM (Common Area Maintenance) recovery rules.
You will map the findings against standard expense categories.

STRICT RULES:
- Do NOT invent rules. Only emit a rule for a category if the lease text contains a specific clause referring to that category.
- OMIT categories that are not explicitly mentioned in the lease text. Do NOT emit "not_mentioned" or boilerplate rows for unmentioned categories. This is critical to save output tokens.
- Never set recoverable_from_tenant="yes" or cam_eligible="yes" unless the exact_source_text quotes the clause that supports it. If you cannot quote a specific clause, use "conditional" or "needs_review".
- Generic NNN/Gross/Full-Service assumptions are not evidence. The clause must mention the specific category (or a broad operating-expense clause that explicitly enumerates it).
- Missing amount alone is NOT a reason to mark a rule as needs_review/conditional. Classify treatment based on the clause language, even when no dollar figure is present:
    * "Tenant shall reimburse" / "Tenant's Pro Rata Share" / "tenant shall pay … additional rent" / "pass-through" → recoverable_from_tenant="yes", cam_eligible="yes" (when in a CAM/operating-expense/tax/insurance/common-area context)
    * "included in base rent" / "full service" / "gross lease" → recoverable_from_tenant="no", cam_eligible="no", payment_treatment="included_in_base_rent"
    * "Tenant shall contract directly" / "Tenant shall pay directly" / "at Tenant's sole cost" / "separately metered" → recoverable_from_tenant="no", cam_eligible="no", payment_treatment="tenant_direct_contract"
    * "CAM shall not include" / "excluded from CAM/operating expenses" — ONLY when there is NO exception → is_excluded=true. If there IS an exception ("except those required by law", etc.) → recoverable_from_tenant="conditional", cam_eligible="conditional", is_excluded=false.
    * "may be included only if" / "if required by law" / "capped at" / "base year" / "expense stop" / "amortized over useful life" → recoverable_from_tenant="conditional", cam_eligible="conditional"
    * Use "needs_review" ONLY when the clause text is genuinely ambiguous about the treatment.
- Separately metered or premises utilities are tenant_direct_contract and cam_eligible="no"; only common-area utilities listed in a CAM/operating-expense clause may be CAM eligible.
- Exclusions such as mortgage interest, depreciation, leasing commissions, TI allowances, reimbursed costs, fines, income/franchise taxes, sale/financing costs, owner overhead must be recoverable_from_tenant="no" and cam_eligible="no".
- Capital expenditures are conditional only when the lease allows legally required or cost-saving improvements amortized over useful life.

EXTRACTION INSTRUCTIONS:
A. Return only explicitly mentioned rules. Do not output not_mentioned or checklist/template rows. If no expense clauses are present, return [].
B. Split lists into individual rules. If a clause contains a bulleted or comma-separated list of recoverable expenses, excluded expenses, tenant-direct charges, included services, caps, or fees, emit ONE rule PER listed item. Example: "Recoverable expenses include common area utilities, janitorial, landscaping, security, and trash." -> Return FIVE rules.
C. Extract all expense-related terms, not only CAM. Extract: recoverable expense categories, exclusions, tenant-direct charges, included-in-base-rent services, modified gross/base-year provisions, tax/insurance/operating expense base amounts, gross-up, caps, admin/management fees, estimated additional rent, utilities/after-hours HVAC, tenant insurance, late fees/default interest, holdover, parking/EV charging, TI allowance/excess costs, legal/enforcement fees, surrender/restoration costs.
D. Every returned rule must include its category, exact_source_text, and a review_status of "needs_review".
E. Source evidence is mandatory. If exact_source_text is not available, do not return the rule. Do not use premises/address/square-footage text as evidence. Do not paraphrase source text.
F. Base-year/modified gross instructions: For modified gross/base-year clauses, emit separate rules for: expense structure, base year, operating expense base amount, tax base amount, insurance base amount, tenant share, allocation basis, expenses over base year, caps/gross-up/admin/management fees.

Map each rule to the most appropriate standard expense category. If none fit perfectly, create a descriptive name. Determine:
- category_name: string (e.g. "Taxes", "Janitorial", "Holdover", "Base Year Structure")
- row_status: "missing_value" if no explicit dollar value/percentage but term exists. Otherwise "mapped".
- mentioned_in_lease: true
- is_recoverable: boolean
- is_excluded: boolean
- recoverable_from_tenant: "yes", "no", or "conditional"
- cam_eligible: "yes", "no", or "conditional"
- payment_treatment: "included_in_base_rent", "separately_billed", "tenant_direct_contract", "reimbursable", or "not_applicable"
- recovery_method: "not_applicable", "pass_through", "pro_rata_share", "fixed_amount", "capped_amount", "included_in_base_rent", "base_year", "tenant_direct_contract", or "amortized_capital"
- allocation_basis: "pro_rata_share", "square_footage", "usage", "fixed", "direct", or null
- included_in_base_rent: boolean
- is_controllable: boolean
- is_subject_to_cap: boolean
- cap_type: string or null
- cap_percent: number or null
- has_base_year: boolean
- base_year: string or number or null
- gross_up_allowed: boolean
- admin_fee_allowed: boolean
- admin_fee_percent: number or null
- tenant_share_percent: number or null
- base_year_amount: number or null
- operating_expense_base_amount: number or null
- tax_base_amount: number or null
- insurance_base_amount: number or null
- source_page: number or null
- exact_source_text: MUST contain the exact text supporting the rule. MANDATORY.
- confidence_score: number from 0.0 to 1.0
- reasoning_summary: concise explanation
- review_status: "needs_review"
- approval_status: "draft"
- published_to_cam: false
- notes: string

Return a JSON array of objects representing these rules. The output MUST be valid JSON.`;

const MAX_EXPENSE_SOURCE_CHARS = 70000;
const EXPENSE_SOURCE_KEYWORDS =
  /(cam|common\s+area|operating\s+expenses?|additional\s+rent|reimburs|recover|pro\s*rata|tax(?:es)?|assessment|insurance|premium|utilit|electric|water|sewer|gas|hvac|janitorial|trash|security|landscap|snow|parking|maintenance|repair|capital|management|administrative|gross[-\s]?up|base\s+year|expense\s+stop|cap(?:ped)?|tenant'?s\s+share|landlord'?s\s+cost|directly\s+metered|separately\s+metered|fee|charge|cost|pay|reimburse|obligat)/i;

function normalizePromptText(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function buildExpenseFocusedText(sourceText: unknown, fullScan = false) {
  const text = normalizePromptText(sourceText);
  // In full-scan mode, or when text fits within limit, send the entire document.
  // Only apply keyword-based sentence filtering on very large documents.
  if (fullScan || text.length <= MAX_EXPENSE_SOURCE_CHARS) return text.slice(0, MAX_EXPENSE_SOURCE_CHARS);

  const sentences = text.match(/[^.!?]+[.!?]?/g) || [text];
  const selected: string[] = [];
  const seen = new Set<number>();
  for (let index = 0; index < sentences.length; index += 1) {
    if (!EXPENSE_SOURCE_KEYWORDS.test(sentences[index])) continue;
    for (const nearby of [index - 1, index, index + 1]) {
      if (nearby < 0 || nearby >= sentences.length || seen.has(nearby)) continue;
      seen.add(nearby);
      selected.push(normalizePromptText(sentences[nearby]));
    }
  }

  const focused = selected.filter(Boolean).join(" ");
  return focused.length > 2000
    ? focused.slice(0, MAX_EXPENSE_SOURCE_CHARS)
    : text.slice(0, MAX_EXPENSE_SOURCE_CHARS);
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);

    const body = await req.json();
    const sourceText = body.source_text || body.text || body.lease_text;
    const categories = Array.isArray(body.categories) ? body.categories : [];
    const fullScan = body.full_scan === true;

    if (!sourceText) {
      throw new Error("source_text is required.");
    }

    const expenseFocusedText = buildExpenseFocusedText(sourceText, fullScan);
    const activeSystemPrompt = fullScan ? FULL_SCAN_SYSTEM_PROMPT : SYSTEM_PROMPT;

    const userPrompt = fullScan
      ? `Read EVERY paragraph of the following lease document. For each sentence or clause that mentions any cost, fee, charge, expense, payment, or financial obligation — output a separate rule with the EXACT verbatim sentence as exact_source_text.

Lease document:
===================================
${expenseFocusedText}
===================================

Return a JSON array of expense rules found. Each rule must have exact_source_text copied verbatim from the document above.`
      : `Here is the list of expense categories to map:
${JSON.stringify(categories, null, 2)}

Here is the lease text to analyze:
===================================
${expenseFocusedText}
===================================

Extract the expense classification rules${categories.length > 0 ? " for the categories listed above" : ""}.`;

    let result: unknown = null;
    try {
      result = await callVertexAIJSON({
        systemPrompt: activeSystemPrompt,
        userPrompt: userPrompt,
        temperature: 0.1,
        maxOutputTokens: 8192,
      });
    } catch (aiError) {
      const message = aiError instanceof Error ? aiError.message : String(aiError);
      console.error("[extract-lease-expense-rules] AI extraction failed:", message);
      return new Response(JSON.stringify({
        rules: [],
        warning: `AI expense rule extraction failed: ${message}`,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    if (!result) {
      return new Response(JSON.stringify({
        rules: [],
        warning: "AI expense rule extraction returned no rules.",
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    const resultAny = result as any;
    const rules = (Array.isArray(result) ? result : resultAny?.rules || []).map((rule: Record<string, unknown>) => {
      const normalizedRecoverable = normalizeDecision(rule.recoverable_from_tenant, rule.is_recoverable === true ? "yes" : "no");
      const paymentTreatmentText = normalizeText(rule.payment_treatment);
      // cam_eligible may only default to "no" when there is an EXPLICIT exclusion
      // signal: recoverable=no, included in base rent, tenant direct contract, or
      // is_excluded. Otherwise unknown/missing must fall to "conditional" so the
      // row routes through Needs Review instead of being treated as Excluded.
      const hasExplicitExclusion =
        normalizedRecoverable === "no" ||
        Boolean(rule.included_in_base_rent) ||
        paymentTreatmentText === "tenant_direct_contract" ||
        Boolean(rule.is_excluded);
      const camEligibleFallback = hasExplicitExclusion ? "no" : "conditional";
      return ({
        ...rule,
        recoverable_from_tenant: normalizedRecoverable,
        cam_eligible: normalizeDecision(rule.cam_eligible, camEligibleFallback),
        payment_treatment: normalizeText(rule.payment_treatment) || "not_applicable",
        recovery_method: normalizeText(rule.recovery_method) || "not_applicable",
        allocation_basis: normalizeText(rule.allocation_basis) || null,
        included_in_base_rent: Boolean(rule.included_in_base_rent),
        cap_percent: toNullableNumber(rule.cap_percent),
        base_year: rule.base_year ?? rule.base_year_type ?? null,
        gross_up_allowed: Boolean(rule.gross_up_allowed ?? rule.gross_up_applicable),
        gross_up_applicable: Boolean(rule.gross_up_applicable ?? rule.gross_up_allowed),
        admin_fee_allowed: Boolean(rule.admin_fee_allowed ?? rule.admin_fee_applicable),
        admin_fee_applicable: Boolean(rule.admin_fee_applicable ?? rule.admin_fee_allowed),
        source_page: toNullableNumber(rule.source_page),
        tenant_share_percent: toNullableNumber(rule.tenant_share_percent),
        base_year_amount: toNullableNumber(rule.base_year_amount),
        operating_expense_base_amount: toNullableNumber(rule.operating_expense_base_amount),
        tax_base_amount: toNullableNumber(rule.tax_base_amount),
        insurance_base_amount: toNullableNumber(rule.insurance_base_amount),
        exact_source_text: String(rule.exact_source_text || rule.source || "").trim() || null,
        confidence_score: toNullableNumber(rule.confidence_score ?? rule.confidence) ?? 0.7,
        reasoning_summary: String(rule.reasoning_summary || rule.notes || "").trim() || null,
        review_status: "needs_review",
        approval_status: "draft",
        published_to_cam: false,
      });
    });

    return new Response(JSON.stringify({ rules }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (err) {
    const error = err as Error;
    console.error("[extract-lease-expense-rules] Error:", error.message);
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 400,
    });
  }
});

function normalizeText(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function normalizeDecision(value: unknown, fallback = "no"): "yes" | "no" | "conditional" {
  const normalized = normalizeText(value);
  if (["yes", "true", "recoverable", "approved"].includes(normalized)) return "yes";
  if (["conditional", "maybe", "shared", "review"].includes(normalized)) return "conditional";
  if (["no", "false", "non_recoverable", "excluded"].includes(normalized)) return "no";
  return fallback as "yes" | "no" | "conditional";
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(numeric) ? numeric : null;
}

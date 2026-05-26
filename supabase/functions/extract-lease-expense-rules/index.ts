import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import { callVertexAIJSON } from "../_shared/vertex-ai.ts";

const SYSTEM_PROMPT = `You are an expert commercial real estate (CRE) lease abstraction AI.
Your task is to analyze lease text and extract explicit expense and CAM (Common Area Maintenance) recovery rules.
You will map the findings against standard expense categories.

STRICT RULES:
- Do NOT invent rules. Only emit a rule for a category if the lease text contains a specific clause referring to that category.
- If a category in the input list is not mentioned in the lease text, return it with row_status="not_mentioned", recoverable_from_tenant="needs_review", cam_eligible="needs_review", and exact_source_text=null.
- Never set recoverable_from_tenant="yes" or cam_eligible="yes" unless the exact_source_text quotes the clause that supports it. If you cannot quote a specific clause, use "conditional" or "needs_review".
- Generic NNN/Gross/Full-Service assumptions are not evidence. The clause must mention the specific category (or a broad operating-expense clause that explicitly enumerates it).
- Do not attach evidence from the wrong clause. Base rent language is not CAM evidence. Property insurance language is not tenant-insurance evidence. Capital-expenditure interest language is not generic interest/late-fee evidence.
- Separately metered or premises utilities are tenant_direct_contract and cam_eligible="no"; only common-area utilities listed in a CAM/operating-expense clause may be CAM eligible.
- Percentage rent, late fees, generic interest, tenant insurance, alterations, and merchant association dues are not CAM expense rules unless a specific expense-recovery clause supports that category.
- Exclusions such as mortgage interest, depreciation, leasing commissions, vacant-space marketing, TI allowances, reimbursed costs, fines, income/franchise taxes, sale/financing costs, owner overhead, political contributions, tenant-dispute legal fees, and costs for another tenant's premises must be recoverable_from_tenant="no" and cam_eligible="no".
- Capital expenditures are conditional only when the lease allows legally required or cost-saving improvements amortized over useful life; structural/major replacements are generally excluded or needs_review.
- Management fees are not CAM eligible unless the lease says law requires them or tenant gave written approval.
- Administrative fees require the administrative-fee clause and must not be inferred from general CAM language.
- Vacant-unit/gross-up language controls gross_up_allowed/gross_up_applicable; if vacant units remain in denominator and landlord absorbs vacant share, gross-up is not permitted.

For each of the categories provided in the JSON input, determine the following:
- row_status: "not_mentioned", "uncertain", "unmapped", "mapped", or "missing_value". If an expense is explicitly mentioned and has rules (e.g. capped, recoverable) but NO explicit dollar value or percentage is found in the lease text, you MUST set row_status to "missing_value" to prompt the user to manually enter it.
- mentioned_in_lease: boolean (is this category specifically mentioned?)
- is_recoverable: boolean (can the landlord recover this expense?)
- is_excluded: boolean (is this explicitly excluded from recovery?)
- recoverable_from_tenant: "yes", "no", or "conditional"
- cam_eligible: "yes", "no", or "conditional". Use "no" when included in base rent, tenant direct contract, excluded, or not recoverable. Use "conditional" when tenant reimbursement depends on a threshold, base year, cap, audit, exception, or ambiguous clause.
- payment_treatment: "included_in_base_rent", "separately_billed", "tenant_direct_contract", "reimbursable", or "not_applicable"
- recovery_method: "not_applicable", "pass_through", "pro_rata_share", "fixed_amount", "capped_amount", "included_in_base_rent", "base_year", or "tenant_direct_contract"
- allocation_basis: "pro_rata_share", "square_footage", "usage", "fixed", "direct", or null
- included_in_base_rent: boolean
- is_controllable: boolean (is this a controllable expense?)
- is_subject_to_cap: boolean (is there a cap on this expense?)
- cap_type: string (e.g., "cumulative", "non_cumulative", "fixed") or null
- cap_percent: number or null
- cap_value: number (percentage or flat amount) or null
- has_base_year: boolean (is there a base year for this expense?)
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
- exact_source_text: exact lease text supporting the rule, or null
- confidence_score: number from 0.0 to 1.0
- reasoning_summary: concise explanation
- review_status: always "needs_review" for AI-extracted rules
- approval_status: always "draft" for AI-extracted rules
- published_to_cam: always false for AI-extracted rules
- extracted_value: number or null (the explicit dollar amount mentioned for this expense, if any)
- frequency: string ("yearly", "monthly", "quarterly") or null
- notes: string (a brief explanation of your reasoning)
- confidence: number (0.0 to 1.0)
- source: string (the exact lease clause text snippet justifying this rule)

Document-type rules:
- If the document is only an assignment, assumption, consent to assignment, term amendment, rent amendment, estoppel, or abstract summary and does not include expense recovery clauses, return only not_mentioned/needs_review rows with reasoning "original_lease_required". Do not infer CAM/taxes/insurance/utilities from assignment or amendment language.
- Assignment clauses, assumption by assignee, landlord consent, term extension, and base-rent-only amendments do not support lease expense rules.
- For full-service/gross leases, mark expenses included in base rent only when the lease text clearly says base rent includes those expenses.
- For modified gross/base-year leases, extract base_year, base_year_amount, operating_expense_base_amount, tax_base_amount, insurance_base_amount, tenant_share_percent, gross_up_percent, and caps only from explicit clauses.
- Do not output base_year_amount as 0 unless the lease explicitly states zero.

Return a JSON array of objects representing these rules. The output MUST be valid JSON.
Format:
[
  {
    "category_name": "Taxes",
    "row_status": "mapped",
    "mentioned_in_lease": true,
    ...
  }
]`;

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

    if (!sourceText) {
      throw new Error("source_text is required.");
    }

    const userPrompt = `
Here is the list of expense categories to map:
${JSON.stringify(categories, null, 2)}

Here is the lease text to analyze:
===================================
${sourceText}
===================================

Extract the expense classification rules${categories.length > 0 ? " for the categories listed above" : ""}.`;

    const result = await callVertexAIJSON({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: userPrompt,
      temperature: 0.1, // Keep it deterministic
    });

    if (!result) {
      throw new Error("Failed to extract rules from AI.");
    }

    const rules = (Array.isArray(result) ? result : result?.rules || []).map((rule: Record<string, unknown>) => {
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
  } catch (error) {
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

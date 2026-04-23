import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import { callVertexAIJSON } from "../_shared/vertex-ai.ts";

const SYSTEM_PROMPT = `You are an expert commercial real estate (CRE) lease abstraction AI.
Your task is to analyze lease text and extract explicit expense and CAM (Common Area Maintenance) recovery rules.
You will map the findings against standard expense categories.

For each of the categories provided in the JSON input, determine the following:
- row_status: "not_mentioned", "uncertain", "unmapped", "mapped", or "missing_value". If an expense is explicitly mentioned and has rules (e.g. capped, recoverable) but NO explicit dollar value or percentage is found in the lease text, you MUST set row_status to "missing_value" to prompt the user to manually enter it.
- mentioned_in_lease: boolean (is this category specifically mentioned?)
- is_recoverable: boolean (can the landlord recover this expense?)
- is_excluded: boolean (is this explicitly excluded from recovery?)
- is_controllable: boolean (is this a controllable expense?)
- is_subject_to_cap: boolean (is there a cap on this expense?)
- cap_type: string (e.g., "cumulative", "non_cumulative", "fixed") or null
- cap_value: number (percentage or flat amount) or null
- has_base_year: boolean (is there a base year for this expense?)
- base_year_type: string (e.g., "calendar", "fiscal", "expense") or null
- gross_up_applicable: boolean
- admin_fee_applicable: boolean
- admin_fee_percent: number or null
- extracted_value: number or null (the explicit dollar amount mentioned for this expense, if any)
- frequency: string ("yearly", "monthly", "quarterly") or null
- notes: string (a brief explanation of your reasoning)
- confidence: number (0.0 to 1.0)
- source: string (the exact lease clause text snippet justifying this rule)

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
    const { lease_id, source_text, categories } = body;

    if (!lease_id || !source_text || !categories) {
      throw new Error("lease_id, source_text, and categories are required.");
    }

    const userPrompt = `
Here is the list of expense categories to map:
${JSON.stringify(categories, null, 2)}

Here is the lease text to analyze:
===================================
${source_text}
===================================

Extract the expense classification rules for the categories listed above.`;

    const result = await callVertexAIJSON({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: userPrompt,
      temperature: 0.1, // Keep it deterministic
    });

    if (!result) {
      throw new Error("Failed to extract rules from AI.");
    }

    // Wrap the result in a standard payload
    return new Response(JSON.stringify({ rules: result }), {
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

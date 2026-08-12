// @ts-nocheck
/**
 * expense-tools.ts — section 16 "EXPENSE". Consolidates get_expense /
 * get_expense_classification / get_expense_publication_status /
 * get_expense_blockers / get_expense_summary into one tool: they all read
 * the same expense + expense_classifications pair, and a question like "why
 * is this blocked" needs classification + publication status + blockers
 * together anyway.
 */
import { assertPropertyAccess, createUserScopedClient } from "../../supabase.ts";
import type { AssistantTool } from "../assistant-contracts.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function addAmount(map: Record<string, number>, key: string | null | undefined, value: unknown) {
  if (!key) return;
  map[key] = (map[key] ?? 0) + Number(value ?? 0);
}

export const getExpenseListSummaryTool: AssistantTool = {
  name: "get_expense_list_summary",
  description:
    "List and summarize authorized expenses, optionally scoped by property, fiscal year, category, or blocked/classification focus. Use for questions like 'which expenses are blocked', 'largest expense categories', or 'which expenses were excluded from CAM'.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: [],
    properties: {
      property_id: { type: "string", description: "Optional UUID of a property to scope the expense list." },
      fiscal_year: { type: "number", description: "Optional fiscal year." },
      category: { type: "string", description: "Optional category filter." },
      focus: { type: "string", enum: ["overview", "blocked", "awaiting_classification", "largest_categories", "excluded_from_cam"], description: "Optional list focus." },
      limit: { type: "number", description: "Optional result cap; max 25." },
    },
  },
  requiredPages: ["Expenses"],
  scopeType: "none",
  accessType: "business_data",
  async execute(args, ctx) {
    const propertyId = typeof args.property_id === "string" ? String(args.property_id) : null;
    if (propertyId) {
      if (!UUID_RE.test(propertyId)) return { status: "no_data", data: null, message: "The property id is not valid." };
      await assertPropertyAccess(ctx.req, propertyId);
    }

    const client = createUserScopedClient(ctx.req);
    const limit = Math.max(1, Math.min(Number(args.limit ?? 10), 25));
    const focus = String(args.focus ?? "overview");
    let query = client
      .from("expenses")
      .select("id, property_id, lease_id, category, amount, vendor_name, vendor, expense_date, date, fiscal_year, status")
      .eq("org_id", ctx.orgId)
      .limit(300);
    if (propertyId) query = query.eq("property_id", propertyId);
    if (typeof args.fiscal_year === "number") query = query.eq("fiscal_year", Number(args.fiscal_year));
    if (typeof args.category === "string" && args.category.trim()) query = query.ilike("category", `%${String(args.category).trim()}%`);

    const { data: expenses, error } = await query;
    if (error) throw new Error(`Failed to load accessible expenses: ${error.message}`);
    if (!expenses || expenses.length === 0) {
      return { status: "no_data", data: null, message: "No accessible expenses matched that scope." };
    }

    const expenseIds = expenses.map((e: any) => e.id).filter(Boolean);
    const { data: classifications, error: classError } = await client
      .from("expense_classifications")
      .select("id, expense_id, recovery_status, approved_status, condition_reason, exclusion_applied, evidence_text")
      .eq("org_id", ctx.orgId)
      .in("expense_id", expenseIds)
      .limit(300);
    if (classError) throw new Error(`Failed to load accessible expense classifications: ${classError.message}`);

    const classificationByExpense = new Map((classifications ?? []).map((c: any) => [c.expense_id, c]));
    const categoryTotals: Record<string, number> = {};
    const recoveryStatusCounts: Record<string, number> = {};
    const rows = expenses.map((expense: any) => {
      const classification = classificationByExpense.get(expense.id);
      const recoveryStatus = classification?.recovery_status ?? "unclassified";
      addAmount(categoryTotals, expense.category ?? "Uncategorized", expense.amount);
      recoveryStatusCounts[recoveryStatus] = (recoveryStatusCounts[recoveryStatus] ?? 0) + 1;
      const blockers = [];
      if (!classification) blockers.push("missing_classification");
      if (classification?.recovery_status === "needs_review") blockers.push("classification_needs_review");
      if (classification && classification.approved_status !== "approved") blockers.push("classification_not_approved");
      if (!expense.lease_id) blockers.push("missing_lease_link");
      return { expense, classification, recoveryStatus, blockers };
    });

    let selected = rows;
    if (focus === "blocked") selected = rows.filter((row: any) => row.blockers.length > 0);
    if (focus === "awaiting_classification") selected = rows.filter((row: any) => !row.classification);
    if (focus === "excluded_from_cam") selected = rows.filter((row: any) => row.classification?.recovery_status === "non_recoverable" || row.classification?.exclusion_applied);
    selected = selected.sort((a: any, b: any) => Math.abs(Number(b.expense.amount ?? 0)) - Math.abs(Number(a.expense.amount ?? 0))).slice(0, limit);

    const largestCategories = Object.entries(categoryTotals)
      .map(([category, amount]) => ({ category, amount }))
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
      .slice(0, 10);

    return {
      status: "answered",
      data: {
        focus,
        total_matching_expenses: expenses.length,
        total_amount: expenses.reduce((sum: number, expense: any) => sum + Number(expense.amount ?? 0), 0),
        recovery_status_counts: recoveryStatusCounts,
        largest_categories: largestCategories,
        expenses: selected.map((row: any) => ({
          id: row.expense.id,
          property_id: row.expense.property_id,
          lease_id: row.expense.lease_id,
          category: row.expense.category,
          amount: row.expense.amount,
          vendor: row.expense.vendor_name ?? row.expense.vendor,
          date: row.expense.expense_date ?? row.expense.date,
          fiscal_year: row.expense.fiscal_year,
          recovery_status: row.recoveryStatus,
          approved_status: row.classification?.approved_status ?? null,
          blockers: row.blockers,
        })),
      },
      citations: [{ type: "expense_list", label: "Accessible expenses" }],
      ...(expenses.length >= 300 ? { limitations: ["Expense summary is capped at the first 300 authorized rows returned by the platform."] } : {}),
    };
  },
};
export const getExpenseSummaryTool: AssistantTool = {
  name: "get_expense_summary",
  description:
    "Get an actual expense's full picture: amount/category/vendor, its recovery classification (recoverable/non-recoverable/conditional and why), CAM publication status, and any blockers preventing it from being sent to CAM. Use for 'why is this expense blocked/non-recoverable' questions.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["property_id", "expense_id"],
    properties: {
      property_id: { type: "string", description: "UUID of the property the expense belongs to (used for authorization)." },
      expense_id: { type: "string", description: "UUID of the expense." },
    },
  },
  requiredPages: ["LeaseExpenseClassification", "Expenses"],
  scopeType: "property",
  scopeArgKey: "property_id",
  accessType: "business_data",
  async execute(args, ctx) {
    const { data: expense, error } = await ctx.supabaseAdmin
      .from("expenses")
      .select("*")
      .eq("id", String(args.expense_id))
      .eq("org_id", ctx.orgId)
      .maybeSingle();
    if (error) throw new Error(`Failed to load expense: ${error.message}`);
    if (!expense || expense.property_id !== args.property_id) {
      return { status: "no_data", data: null, message: "No expense found for the given id under this property." };
    }

    const { data: classification, error: classError } = await ctx.supabaseAdmin
      .from("expense_classifications")
      .select("*")
      .eq("org_id", ctx.orgId)
      .eq("expense_id", expense.id)
      .maybeSingle();
    if (classError) throw new Error(`Failed to load expense classification: ${classError.message}`);

    // "Sent to CAM" is tracked on cam_expense_inputs (publication_status),
    // linked back to the expense via actual_expense_id — neither `expenses`
    // nor `expense_classifications` carries this flag itself.
    const { data: camInput, error: camInputError } = await ctx.supabaseAdmin
      .from("cam_expense_inputs")
      .select("publication_status, sent_to_cam_at, fiscal_year")
      .eq("org_id", ctx.orgId)
      .eq("actual_expense_id", expense.id)
      .order("sent_to_cam_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (camInputError) throw new Error(`Failed to load CAM publication status: ${camInputError.message}`);

    const blockers: string[] = [];
    if (!classification) {
      blockers.push("Expense has not been classified against a lease recovery policy yet.");
    } else {
      if (classification.recovery_status === "needs_review") blockers.push("Classification is flagged needs_review.");
      if (classification.approved_status !== "approved") blockers.push(`Classification is not approved (status: ${classification.approved_status}).`);
      if (!classification.lease_id) blockers.push("No lease is linked to this expense, so no recovery rule could be applied.");
    }
    if (!expense.lease_id && !classification?.lease_id) blockers.push("Expense has no lease linkage.");
    if (!expense.date && !expense.expense_date) blockers.push("Expense is missing a date.");

    return {
      status: "answered",
      data: {
        expense: {
          id: expense.id,
          category: expense.category,
          amount: expense.amount,
          vendor: expense.vendor_name ?? expense.vendor,
          date: expense.expense_date ?? expense.date,
          fiscal_year: expense.fiscal_year,
        },
        classification: classification
          ? {
              recovery_status: classification.recovery_status,
              approved_status: classification.approved_status,
              cap_applied: classification.cap_applied,
              exclusion_applied: classification.exclusion_applied,
              condition_applied: classification.condition_applied,
              condition_reason: classification.condition_reason,
              rule_source: classification.rule_source,
              evidence_text: classification.evidence_text,
              notes: classification.notes,
            }
          : null,
        cam_publication_status: camInput?.publication_status ?? "not_sent",
        sent_to_cam: camInput?.publication_status === "published",
        blockers,
      },
      citations: classification
        ? [{ type: "expense_classification", label: `Expense classification (${classification.recovery_status})`, entityId: classification.id }]
        : [{ type: "expense_record", label: "Expense record (unclassified)", entityId: expense.id }],
    };
  },
};

export const expenseTools: AssistantTool[] = [getExpenseListSummaryTool, getExpenseSummaryTool];

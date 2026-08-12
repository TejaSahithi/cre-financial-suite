// @ts-nocheck
/**
 * workflow-tools.ts — section 16 "WORKFLOW". Org-scoped (scopeType
 * "organization" — assertPageAccess alone is the gate; get_record_audit_summary
 * additionally relies on AuditLog being restricted to org_admin/auditor roles
 * in src/lib/rbac.js's ROLE_PAGES, so the page-access check alone is a real
 * control here, not just a UX nicety).
 */
import type { AssistantTool } from "../assistant-contracts.ts";

export const getPendingApprovalsSummaryTool: AssistantTool = {
  name: "get_pending_approvals_summary",
  description:
    "Get counts of items currently awaiting approval across the organization (CAM runs pending review/submission, budgets under review, expense classifications needing review). Use for 'what's pending my approval' questions.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: [],
    properties: {
      property_id: { type: "string", description: "Optional property UUID to narrow the count to a single property." },
    },
  },
  requiredPages: ["Approvals", "Workflows"],
  scopeType: "organization",
  accessType: "business_data",
  async execute(args, ctx) {
    const propertyId = args.property_id ? String(args.property_id) : null;

    let camQuery = ctx.supabaseAdmin
      .from("cam_runs")
      .select("id", { count: "exact", head: true })
      .eq("org_id", ctx.orgId)
      .in("status", ["under_review", "submitted"]);
    if (propertyId) camQuery = camQuery.eq("scope_type", "property").eq("scope_id", propertyId);

    let budgetQuery = ctx.supabaseAdmin
      .from("budgets")
      .select("id", { count: "exact", head: true })
      .eq("org_id", ctx.orgId)
      .eq("status", "under_review");
    if (propertyId) budgetQuery = budgetQuery.eq("property_id", propertyId);

    let expenseQuery = ctx.supabaseAdmin
      .from("expense_classifications")
      .select("id", { count: "exact", head: true })
      .eq("org_id", ctx.orgId)
      .eq("recovery_status", "needs_review");
    if (propertyId) expenseQuery = expenseQuery.eq("property_id", propertyId);

    const [cam, budgets, expenses] = await Promise.all([camQuery, budgetQuery, expenseQuery]);
    if (cam.error) throw new Error(`Failed to count pending CAM runs: ${cam.error.message}`);
    if (budgets.error) throw new Error(`Failed to count pending budgets: ${budgets.error.message}`);
    if (expenses.error) throw new Error(`Failed to count pending expense classifications: ${expenses.error.message}`);

    return {
      status: "answered",
      data: {
        cam_runs_pending: cam.count ?? 0,
        budgets_under_review: budgets.count ?? 0,
        expense_classifications_needing_review: expenses.count ?? 0,
      },
      citations: [{ type: "workflow_summary", label: "Pending approvals summary" }],
    };
  },
};

export const getRecordAuditSummaryTool: AssistantTool = {
  name: "get_record_audit_summary",
  description:
    "Get the recent audit trail (who did what, when) for a specific record. Use for 'who approved this' / 'what changed on this record' questions. Requires audit log access.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["entity_type", "entity_id"],
    properties: {
      entity_type: { type: "string", description: "e.g. \"lease\", \"expense\", \"cam_run\", \"budget\"." },
      entity_id: { type: "string", description: "UUID of the record." },
    },
  },
  requiredPages: ["AuditLog"],
  scopeType: "organization",
  accessType: "business_data",
  async execute(args, ctx) {
    const { data: rows, error } = await ctx.supabaseAdmin
      .from("audit_logs")
      .select("action, field_changed, old_value, new_value, user_email, timestamp")
      .eq("org_id", ctx.orgId)
      .eq("entity_type", String(args.entity_type))
      .eq("entity_id", String(args.entity_id))
      .order("timestamp", { ascending: false })
      .limit(20);
    if (error) throw new Error(`Failed to load audit trail: ${error.message}`);
    if (!rows || rows.length === 0) {
      return { status: "no_data", data: null, message: "No audit history recorded for this record." };
    }

    return {
      status: "answered",
      data: { entity_type: args.entity_type, entity_id: args.entity_id, events: rows },
      citations: [{ type: "audit_log", label: `Audit trail: ${args.entity_type}`, entityId: String(args.entity_id) }],
    };
  },
};

export const workflowTools: AssistantTool[] = [getPendingApprovalsSummaryTool, getRecordAuditSummaryTool];

// @ts-nocheck
/**
 * cam-tools.ts — section 16 "CAM". Reads CAM V2's authoritative, immutable
 * run ledger only — never recomputes a CAM figure (section 4, "the LLM must
 * NOT become the authoritative calculator"). get_cam_readiness mirrors the
 * existing get-cam-setup-readiness edge function's own query shape exactly
 * (same tables/RPC), since that function is this repo's proven read-only
 * CAM-setup template.
 *
 * cam_runs has no direct property_id column (it's scoped via
 * recovery_period_id + polymorphic scope_type/scope_id). Every tool here
 * requires property_id explicitly and only accepts runs where
 * scope_type='property' AND scope_id=property_id — the same default
 * convention get-cam-setup-readiness uses. Building/custom-scoped runs are
 * out of scope for V1 (not silently mismatched: they simply return no_data).
 */
import type { AssistantTool } from "../assistant-contracts.ts";

const PROPERTY_ID_PROP = { type: "string", description: "UUID of the property (used for authorization)." };

export const getCamReadinessTool: AssistantTool = {
  name: "get_cam_readiness",
  description:
    "Check whether a property/recovery-period is ready to run CAM, and if not, what's blocking it (missing published expenses, missing policies, pool configuration gaps). Use for 'what is blocking CAM readiness' questions.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["property_id", "recovery_period_id"],
    properties: {
      property_id: PROPERTY_ID_PROP,
      recovery_period_id: { type: "string", description: "UUID of the recovery period." },
    },
  },
  requiredPages: ["CAMSetup", "CAMDashboard"],
  scopeType: "property",
  scopeArgKey: "property_id",
  accessType: "business_data",
  async execute(args, ctx) {
    const propertyId = String(args.property_id);
    const recoveryPeriodId = String(args.recovery_period_id);

    const { data: period, error: periodError } = await ctx.supabaseAdmin
      .from("recovery_periods")
      .select("*")
      .eq("id", recoveryPeriodId)
      .eq("org_id", ctx.orgId)
      .maybeSingle();
    if (periodError) throw new Error(`Failed to load recovery period: ${periodError.message}`);
    if (!period) {
      return { status: "no_data", data: null, message: "No recovery period found for the given id." };
    }

    const { data: readiness, error: readinessError } = await ctx.supabaseAdmin.rpc("evaluate_cam_readiness", {
      p_org_id: ctx.orgId,
      p_property_id: propertyId,
      p_recovery_period_id: recoveryPeriodId,
      p_scope_type: "property",
      p_scope_id: propertyId,
    });
    if (readinessError) throw new Error(`Failed to evaluate readiness: ${readinessError.message}`);

    return {
      status: "answered",
      data: { recovery_period: { id: period.id, label: period.label, start_date: period.start_date, end_date: period.end_date, status: period.status }, readiness },
      citations: [{ type: "cam_readiness", label: `CAM readiness: ${period.label}`, entityId: period.id }],
    };
  },
};

export const getCamRunSummaryTool: AssistantTool = {
  name: "get_cam_run_summary",
  description:
    "Get a CAM run's status and pool-level results (actual pool amount, gross-up, amortization, adjusted pool). Use for 'explain this CAM run' / 'why did the pool total change' questions.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["property_id", "cam_run_id"],
    properties: { property_id: PROPERTY_ID_PROP, cam_run_id: { type: "string", description: "UUID of the CAM run." } },
  },
  requiredPages: ["CAMRun", "CAMDashboard"],
  scopeType: "property",
  scopeArgKey: "property_id",
  accessType: "business_data",
  async execute(args, ctx) {
    const propertyId = String(args.property_id);
    const { data: run, error: runError } = await ctx.supabaseAdmin
      .from("cam_runs")
      .select("*")
      .eq("id", String(args.cam_run_id))
      .eq("org_id", ctx.orgId)
      .eq("scope_type", "property")
      .eq("scope_id", propertyId)
      .maybeSingle();
    if (runError) throw new Error(`Failed to load CAM run: ${runError.message}`);
    if (!run) {
      return { status: "no_data", data: null, message: "No CAM run found for the given id under this property." };
    }

    const { data: poolResults, error: poolError } = await ctx.supabaseAdmin
      .from("cam_run_pool_results")
      .select("*, recovery_pools(name, pool_type)")
      .eq("org_id", ctx.orgId)
      .eq("cam_run_id", run.id);
    if (poolError) throw new Error(`Failed to load CAM pool results: ${poolError.message}`);

    return {
      status: "answered",
      data: {
        cam_run: { id: run.id, status: run.status, run_number: run.run_number, run_type: run.run_type, posted_at: run.posted_at },
        pools: (poolResults ?? []).map((p: any) => ({
          pool_name: p.recovery_pools?.name ?? null,
          actual_amount: p.actual_amount,
          excluded_amount: p.excluded_amount,
          gross_up_adjustment: p.gross_up_adjustment,
          amortization: p.amortization,
          adjusted_pool: p.adjusted_pool,
        })),
      },
      citations: [{ type: "cam_run", label: `CAM run #${run.run_number} (${run.status})`, entityId: run.id }],
    };
  },
};

export const getCamTenantResultTool: AssistantTool = {
  name: "get_cam_tenant_result",
  description:
    "Get a specific tenant's (lease's) CAM result for a run: final recovery amount, estimates billed, due/credit reconciliation, and the calculation lineage (line-by-line explanation of how the recovery was derived). Use for 'why is Tenant A's CAM recovery $X' questions.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["property_id", "cam_run_id", "lease_id"],
    properties: {
      property_id: PROPERTY_ID_PROP,
      cam_run_id: { type: "string", description: "UUID of the CAM run." },
      lease_id: { type: "string", description: "UUID of the tenant's lease." },
    },
  },
  requiredPages: ["CAMLeaseDetail", "CAMRun"],
  scopeType: "property",
  scopeArgKey: "property_id",
  accessType: "business_data",
  async execute(args, ctx) {
    const propertyId = String(args.property_id);
    const { data: run, error: runError } = await ctx.supabaseAdmin
      .from("cam_runs")
      .select("id, status, run_number")
      .eq("id", String(args.cam_run_id))
      .eq("org_id", ctx.orgId)
      .eq("scope_type", "property")
      .eq("scope_id", propertyId)
      .maybeSingle();
    if (runError) throw new Error(`Failed to load CAM run: ${runError.message}`);
    if (!run) {
      return { status: "no_data", data: null, message: "No CAM run found for the given id under this property." };
    }

    const { data: lease, error: leaseError } = await ctx.supabaseAdmin
      .from("leases")
      .select("id, property_id, tenant_name")
      .eq("id", String(args.lease_id))
      .eq("org_id", ctx.orgId)
      .maybeSingle();
    if (leaseError) throw new Error(`Failed to load lease: ${leaseError.message}`);
    if (!lease || lease.property_id !== propertyId) {
      return { status: "no_data", data: null, message: "No lease found for the given id under this property." };
    }

    const { data: leaseResult, error: leaseResultError } = await ctx.supabaseAdmin
      .from("cam_run_lease_results")
      .select("*")
      .eq("org_id", ctx.orgId)
      .eq("cam_run_id", run.id)
      .eq("lease_id", lease.id)
      .maybeSingle();
    if (leaseResultError) throw new Error(`Failed to load CAM lease result: ${leaseResultError.message}`);
    if (!leaseResult) {
      return { status: "no_data", data: null, message: "No CAM result exists yet for this tenant on this run." };
    }

    const { data: lines, error: linesError } = await ctx.supabaseAdmin
      .from("cam_run_calculation_lines")
      .select("sequence, line_type, category, formula_code, input_amount, output_amount, adjustment, explanation")
      .eq("org_id", ctx.orgId)
      .eq("lease_result_id", leaseResult.id)
      .order("sequence", { ascending: true })
      .limit(40);
    if (linesError) throw new Error(`Failed to load calculation lines: ${linesError.message}`);

    return {
      status: "answered",
      data: {
        tenant_name: lease.tenant_name,
        cam_run: { id: run.id, status: run.status, run_number: run.run_number },
        result: {
          status: leaseResult.status,
          final_recovery: leaseResult.final_recovery,
          estimates_billed: leaseResult.estimates_billed,
          amount_due_credit: leaseResult.amount_due_credit,
        },
        calculation_lines: (lines ?? []).map((l: any) => ({
          sequence: l.sequence,
          line_type: l.line_type,
          category: l.category,
          formula_code: l.formula_code,
          input_amount: l.input_amount,
          output_amount: l.output_amount,
          adjustment: l.adjustment,
          explanation: l.explanation,
        })),
      },
      citations: [{ type: "cam_calculation_line", label: `CAM calculation lineage: ${lease.tenant_name ?? lease.id}`, entityId: leaseResult.id }],
    };
  },
};


export const getCamPoolDetailTool: AssistantTool = {
  name: "get_cam_pool_detail",
  description:
    "Get one CAM pool result's persisted ledger detail: source/adjusted amounts, category rules, assigned expenses, participating leases, and calculation lines. Use on CAM Pool Detail or when the user asks which expenses or tenants are in a pool. Never recompute CAM.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["property_id", "cam_run_id", "pool_result_id"],
    properties: {
      property_id: PROPERTY_ID_PROP,
      cam_run_id: { type: "string", description: "UUID of the CAM run." },
      pool_result_id: { type: "string", description: "UUID of the CAM pool result." },
    },
  },
  requiredPages: ["CAMPoolDetail", "CAMRun"],
  scopeType: "property",
  scopeArgKey: "property_id",
  accessType: "business_data",
  async execute(args, ctx) {
    const propertyId = String(args.property_id);
    const camRunId = String(args.cam_run_id);
    const poolResultId = String(args.pool_result_id);

    const { data: run, error: runError } = await ctx.supabaseAdmin
      .from("cam_runs")
      .select("id, status, run_number, run_type, scope_type, scope_id, recovery_period_id, posted_at")
      .eq("id", camRunId)
      .eq("org_id", ctx.orgId)
      .eq("scope_type", "property")
      .eq("scope_id", propertyId)
      .maybeSingle();
    if (runError) throw new Error(`Failed to load CAM run: ${runError.message}`);
    if (!run) {
      return { status: "no_data", data: null, message: "No CAM run found for the given id under this property." };
    }

    const { data: poolResult, error: poolError } = await ctx.supabaseAdmin
      .from("cam_run_pool_results")
      .select("id, pool_id, actual_amount, excluded_amount, gross_up_adjustment, amortization, adjusted_pool, denominator_metrics, created_at, recovery_pools(name, pool_type, scope_type, property_id, default_gross_up_target_pct, recovery_pool_categories(expense_category_id, inclusion_mode, variability_default, controllability_default))")
      .eq("id", poolResultId)
      .eq("org_id", ctx.orgId)
      .eq("cam_run_id", run.id)
      .maybeSingle();
    if (poolError) throw new Error(`Failed to load CAM pool result: ${poolError.message}`);
    if (!poolResult || poolResult.recovery_pools?.property_id !== propertyId) {
      return { status: "no_data", data: null, message: "No CAM pool result found for this run and property." };
    }

    const { data: lines, error: linesError } = await ctx.supabaseAdmin
      .from("cam_run_calculation_lines")
      .select("id, sequence, line_type, category, formula_code, input_amount, output_amount, adjustment, explanation, cam_run_lease_results(lease_id, leases(tenant_name))")
      .eq("org_id", ctx.orgId)
      .eq("cam_run_id", run.id)
      .eq("pool_result_id", poolResult.id)
      .order("sequence", { ascending: true })
      .limit(80);
    if (linesError) throw new Error(`Failed to load CAM pool calculation lines: ${linesError.message}`);

    const { data: participants, error: participantsError } = await ctx.supabaseAdmin
      .from("recovery_pool_lease_participants")
      .select("id, lease_id, status, source, effective_from, effective_to, leases(tenant_name)")
      .eq("org_id", ctx.orgId)
      .eq("pool_id", poolResult.pool_id)
      .order("effective_from", { ascending: true })
      .limit(80);
    if (participantsError) throw new Error(`Failed to load CAM pool participants: ${participantsError.message}`);

    const { data: assignments, error: assignmentsError } = await ctx.supabaseAdmin
      .from("cam_input_pool_assignments")
      .select("id, amount, assignment_method, cam_expense_inputs(id, category, amount, actual_expense_id, fiscal_year, publication_status)")
      .eq("org_id", ctx.orgId)
      .eq("recovery_pool_id", poolResult.pool_id)
      .limit(80);
    if (assignmentsError) throw new Error(`Failed to load CAM pool expense assignments: ${assignmentsError.message}`);

    return {
      status: "answered",
      data: {
        cam_run: { id: run.id, status: run.status, run_number: run.run_number, run_type: run.run_type, posted_at: run.posted_at },
        pool: {
          id: poolResult.id,
          pool_id: poolResult.pool_id,
          name: poolResult.recovery_pools?.name ?? null,
          pool_type: poolResult.recovery_pools?.pool_type ?? null,
          scope_type: poolResult.recovery_pools?.scope_type ?? null,
          default_gross_up_target_pct: poolResult.recovery_pools?.default_gross_up_target_pct ?? null,
          actual_amount: poolResult.actual_amount,
          excluded_amount: poolResult.excluded_amount,
          gross_up_adjustment: poolResult.gross_up_adjustment,
          amortization: poolResult.amortization,
          adjusted_pool: poolResult.adjusted_pool,
          denominator_metrics: poolResult.denominator_metrics,
          categories: (poolResult.recovery_pools?.recovery_pool_categories ?? []).map((c: any) => ({
            expense_category_id: c.expense_category_id,
            inclusion_mode: c.inclusion_mode,
            variability_default: c.variability_default,
            controllability_default: c.controllability_default,
          })),
        },
        assigned_expenses: (assignments ?? []).map((a: any) => ({
          assignment_id: a.id,
          assignment_amount: a.amount,
          assignment_method: a.assignment_method,
          cam_expense_input_id: a.cam_expense_inputs?.id ?? null,
          actual_expense_id: a.cam_expense_inputs?.actual_expense_id ?? null,
          category: a.cam_expense_inputs?.category ?? null,
          source_amount: a.cam_expense_inputs?.amount ?? null,
          fiscal_year: a.cam_expense_inputs?.fiscal_year ?? null,
          publication_status: a.cam_expense_inputs?.publication_status ?? null,
        })),
        participants: (participants ?? []).map((p: any) => ({
          participant_id: p.id,
          lease_id: p.lease_id,
          tenant_name: p.leases?.tenant_name ?? null,
          status: p.status,
          source: p.source,
          effective_from: p.effective_from,
          effective_to: p.effective_to,
        })),
        calculation_lines: (lines ?? []).map((l: any) => ({
          id: l.id,
          sequence: l.sequence,
          tenant_name: l.cam_run_lease_results?.leases?.tenant_name ?? null,
          lease_id: l.cam_run_lease_results?.lease_id ?? null,
          line_type: l.line_type,
          category: l.category,
          formula_code: l.formula_code,
          input_amount: l.input_amount,
          output_amount: l.output_amount,
          adjustment: l.adjustment,
          explanation: l.explanation,
        })),
        caps: { assigned_expenses: 80, participants: 80, calculation_lines: 80 },
      },
      citations: [{ type: "cam_pool_result", label: `CAM pool result: ${poolResult.recovery_pools?.name ?? poolResult.id}`, entityId: poolResult.id }],
    };
  },
};

export const getCamExceptionsSummaryTool: AssistantTool = {
  name: "get_cam_exceptions_summary",
  description:
    "List and summarize a CAM run's persisted exceptions, including blocking/open counts and resolution status. Use for 'what is blocking this run', 'which exceptions remain open', or exception review questions. Never resolve or waive anything.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["property_id", "cam_run_id"],
    properties: {
      property_id: PROPERTY_ID_PROP,
      cam_run_id: { type: "string", description: "UUID of the CAM run." },
      severity: { type: "string", enum: ["blocking", "review_required", "warning", "info"], description: "Optional severity filter." },
      resolution_status: { type: "string", enum: ["open", "resolved", "waived"], description: "Optional resolution-status filter." },
    },
  },
  requiredPages: ["CAMExceptionReview", "CAMRun", "CAMApproval"],
  scopeType: "property",
  scopeArgKey: "property_id",
  accessType: "business_data",
  async execute(args, ctx) {
    const propertyId = String(args.property_id);
    const camRunId = String(args.cam_run_id);

    const { data: run, error: runError } = await ctx.supabaseAdmin
      .from("cam_runs")
      .select("id, status, run_number, run_type, scope_type, scope_id, recovery_period_id, posted_at")
      .eq("id", camRunId)
      .eq("org_id", ctx.orgId)
      .eq("scope_type", "property")
      .eq("scope_id", propertyId)
      .maybeSingle();
    if (runError) throw new Error(`Failed to load CAM run: ${runError.message}`);
    if (!run) {
      return { status: "no_data", data: null, message: "No CAM run found for the given id under this property." };
    }

    const { data: exceptions, error: exceptionsError } = await ctx.supabaseAdmin
      .from("cam_run_exceptions")
      .select("id, severity, code, entity_type, entity_id, message, resolution_status, resolution_note, resolved_by, updated_at, created_at")
      .eq("org_id", ctx.orgId)
      .eq("cam_run_id", run.id)
      .order("created_at", { ascending: true })
      .limit(300);
    if (exceptionsError) throw new Error(`Failed to load CAM exceptions: ${exceptionsError.message}`);

    const all = exceptions ?? [];
    const severityCounts: Record<string, number> = {};
    const resolutionCounts: Record<string, number> = {};
    for (const exc of all) {
      severityCounts[exc.severity] = (severityCounts[exc.severity] ?? 0) + 1;
      resolutionCounts[exc.resolution_status] = (resolutionCounts[exc.resolution_status] ?? 0) + 1;
    }

    let selected = all;
    if (typeof args.severity === "string") selected = selected.filter((exc: any) => exc.severity === args.severity);
    if (typeof args.resolution_status === "string") selected = selected.filter((exc: any) => exc.resolution_status === args.resolution_status);
    const severityRank: Record<string, number> = { blocking: 0, review_required: 1, warning: 2, info: 3 };
    selected = selected
      .sort((a: any, b: any) => (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9) || String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")))
      .slice(0, 80);

    return {
      status: all.length === 0 ? "no_data" : "answered",
      data: all.length === 0
        ? null
        : {
            cam_run: { id: run.id, status: run.status, run_number: run.run_number, run_type: run.run_type, posted_at: run.posted_at },
            total_exceptions: all.length,
            returned_exceptions: selected.length,
            severity_counts: severityCounts,
            resolution_status_counts: resolutionCounts,
            open_blocking_count: all.filter((exc: any) => exc.severity === "blocking" && exc.resolution_status === "open").length,
            exceptions: selected.map((exc: any) => ({
              id: exc.id,
              severity: exc.severity,
              code: exc.code,
              entity_type: exc.entity_type,
              entity_id: exc.entity_id,
              message: exc.message,
              resolution_status: exc.resolution_status,
              resolution_note: exc.resolution_note,
              resolved_by: exc.resolved_by,
              resolved_at: exc.updated_at,
              created_at: exc.created_at,
            })),
          },
      message: all.length === 0 ? "No CAM exceptions were found for this run." : undefined,
      citations: [{ type: "cam_exceptions", label: `CAM run #${run.run_number} exceptions`, entityId: run.id }],
    };
  },
};

export const camTools: AssistantTool[] = [getCamReadinessTool, getCamRunSummaryTool, getCamTenantResultTool, getCamPoolDetailTool, getCamExceptionsSummaryTool];


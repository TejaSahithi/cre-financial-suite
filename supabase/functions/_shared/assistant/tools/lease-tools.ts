// @ts-nocheck
/**
 * lease-tools.ts — section 16 "LEASE". Reads canonical/approved contractual
 * data (section 8.1) — the approved abstract snapshot where present, never
 * raw unreviewed extraction output as if it were confirmed fact.
 *
 * Every tool takes BOTH property_id (authorized by the broker via
 * scopeArgKey before execute() runs) and the specific entity id, then
 * verifies the entity actually belongs to that property before returning
 * anything. This defends against an authorized-for-property-A caller
 * probing a lease_id that actually belongs to property B: the broker only
 * checked property A, so the tool itself must not trust lease_id alone.
 */
import { assertPropertyAccess, createUserScopedClient } from "../../supabase.ts";
import type { AssistantTool } from "../assistant-contracts.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROPERTY_ID_PROP = { type: "string", description: "UUID of the property the lease belongs to (used for authorization)." };
const LEASE_ID_PROP = { type: "string", description: "UUID of the lease." };

/** Waterfalls through the approved abstract snapshot, then reviewed
 * extraction field_reviews, then raw extraction fields — mirrors
 * src/lib/approvedLeaseSnapshot.js's precedence (frontend-only module, not
 * importable from a Deno edge function; re-implemented minimally here for
 * the handful of fields the Assistant needs to explain). */
function resolveApprovedFields(lease: any): { fields: Record<string, unknown>; isApproved: boolean } {
  const snapshot = lease?.abstract_snapshot;
  if (snapshot?.approved && typeof snapshot.approved === "object") {
    return { fields: snapshot.approved, isApproved: true };
  }
  if (snapshot?.fields && typeof snapshot.fields === "object") {
    return { fields: snapshot.fields, isApproved: lease?.abstract_status === "approved" };
  }
  const reviews = lease?.extraction_data?.field_reviews;
  if (reviews && typeof reviews === "object") {
    const fields: Record<string, unknown> = {};
    for (const [key, review] of Object.entries<any>(reviews)) {
      fields[key] = review?.value ?? review;
    }
    return { fields, isApproved: false };
  }
  return { fields: lease?.extraction_data?.fields ?? lease?.extraction_data?.extracted_fields ?? {}, isApproved: false };
}

export const getLeaseSummaryTool: AssistantTool = {
  name: "get_lease_summary",
  description:
    "Get a lease's core contractual summary: tenant, term dates, base rent, square footage, status, and whether its terms are approved/canonical vs. still in AI-extracted/unreviewed draft.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["property_id", "lease_id"],
    properties: { property_id: PROPERTY_ID_PROP, lease_id: LEASE_ID_PROP },
  },
  requiredPages: ["Leases"],
  scopeType: "property",
  scopeArgKey: "property_id",
  accessType: "business_data",
  async execute(args, ctx) {
    const { data: lease, error } = await ctx.supabaseAdmin
      .from("leases")
      .select("*")
      .eq("id", String(args.lease_id))
      .eq("org_id", ctx.orgId)
      .maybeSingle();
    if (error) throw new Error(`Failed to load lease: ${error.message}`);
    if (!lease || lease.property_id !== args.property_id) {
      return { status: "no_data", data: null, message: "No lease found for the given id under this property." };
    }

    const { fields, isApproved } = resolveApprovedFields(lease);

    return {
      status: "answered",
      data: {
        lease_id: lease.id,
        tenant_name: lease.tenant_name,
        status: lease.status,
        abstract_status: lease.abstract_status ?? null,
        is_canonical_approved: isApproved,
        start_date: fields.commencement_date ?? fields.start_date ?? lease.start_date,
        end_date: fields.expiration_date ?? fields.end_date ?? lease.end_date,
        rent_commencement_date: fields.rent_commencement_date ?? null,
        monthly_rent: fields.monthly_rent ?? fields.base_rent ?? lease.monthly_rent,
        square_footage: fields.square_footage ?? lease.square_footage,
        lease_type: lease.lease_type,
      },
      citations: [{
        type: "lease_record",
        label: isApproved ? `Approved lease abstract: ${lease.tenant_name ?? lease.id}` : `Lease record (not yet approved): ${lease.tenant_name ?? lease.id}`,
        entityId: lease.id,
      }],
      ...(isApproved ? {} : { limitations: ["This lease's terms are not yet approved — treat as draft, not contractual fact."] }),
    };
  },
};

export const getLeaseRecoveryPolicyTool: AssistantTool = {
  name: "get_lease_recovery_policy",
  description:
    "Get a lease's materialized recovery/expense policy: caps, exclusions, base year, gross-up, admin fee, and per-step details. Use for CAM-eligibility, recoverability, and 'why is this expense non-recoverable' questions.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["property_id", "lease_id"],
    properties: { property_id: PROPERTY_ID_PROP, lease_id: LEASE_ID_PROP },
  },
  requiredPages: ["LeaseExpenseRules", "CAMSetup"],
  scopeType: "property",
  scopeArgKey: "property_id",
  accessType: "business_data",
  async execute(args, ctx) {
    const { data: lease, error: leaseError } = await ctx.supabaseAdmin
      .from("leases")
      .select("id, property_id, tenant_name")
      .eq("id", String(args.lease_id))
      .eq("org_id", ctx.orgId)
      .maybeSingle();
    if (leaseError) throw new Error(`Failed to load lease: ${leaseError.message}`);
    if (!lease || lease.property_id !== args.property_id) {
      return { status: "no_data", data: null, message: "No lease found for the given id under this property." };
    }

    const { data: policies, error: policyError } = await ctx.supabaseAdmin
      .from("lease_recovery_policies")
      .select("*, lease_recovery_policy_steps(*)")
      .eq("org_id", ctx.orgId)
      .eq("lease_id", lease.id)
      .order("effective_from", { ascending: false });
    if (policyError) throw new Error(`Failed to load recovery policy: ${policyError.message}`);

    if (!policies || policies.length === 0) {
      return { status: "no_data", data: null, message: "No materialized recovery policy exists yet for this lease — its expense rules may not be approved." };
    }

    const approved = policies.find((p: any) => p.status === "approved") ?? policies[0];

    return {
      status: "answered",
      data: {
        lease_id: lease.id,
        tenant_name: lease.tenant_name,
        policy_status: approved.status,
        effective_from: approved.effective_from,
        base_year: approved.base_year ?? null,
        steps: (approved.lease_recovery_policy_steps ?? []).map((s: any) => ({
          step_type: s.step_type,
          category: s.category ?? null,
          cap_type: s.cap_type ?? null,
          cap_value: s.cap_value ?? null,
          exclusion: s.exclusion ?? null,
          source_evidence: s.source_evidence ?? null,
        })),
      },
      citations: [{ type: "lease_recovery_policy", label: `Recovery policy: ${lease.tenant_name ?? lease.id}`, entityId: approved.id }],
      ...(approved.status !== "approved" ? { limitations: [`This recovery policy is in "${approved.status}" status, not yet approved.`] } : {}),
    };
  },
};

export const getLeaseEvidenceTool: AssistantTool = {
  name: "get_lease_evidence",
  description:
    "Get the source-document evidence (page/text citation) supporting a specific lease field, e.g. why a date or rent amount was extracted as it was. Use when the user asks to 'show the evidence' for a lease fact.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["property_id", "lease_id"],
    properties: {
      property_id: PROPERTY_ID_PROP,
      lease_id: LEASE_ID_PROP,
      field_key: { type: "string", description: "Optional specific field key to look up evidence for, e.g. \"commencement_date\". Omit for a general evidence summary." },
    },
  },
  requiredPages: ["LeaseReview"],
  scopeType: "property",
  scopeArgKey: "property_id",
  accessType: "business_data",
  async execute(args, ctx) {
    const { data: lease, error } = await ctx.supabaseAdmin
      .from("leases")
      .select("id, property_id, tenant_name, abstract_snapshot, extraction_data")
      .eq("id", String(args.lease_id))
      .eq("org_id", ctx.orgId)
      .maybeSingle();
    if (error) throw new Error(`Failed to load lease: ${error.message}`);
    if (!lease || lease.property_id !== args.property_id) {
      return { status: "no_data", data: null, message: "No lease found for the given id under this property." };
    }

    const evidenceMap =
      lease.abstract_snapshot?.field_evidence ?? lease.extraction_data?.field_evidence ?? {};
    const fieldKey = args.field_key ? String(args.field_key) : null;
    const entries = fieldKey ? { [fieldKey]: evidenceMap[fieldKey] } : evidenceMap;
    const citations = Object.entries(entries)
      .filter(([, ev]) => ev)
      .slice(0, 10)
      .map(([key, ev]: [string, any]) => ({
        type: "lease_evidence",
        label: `${key}: ${ev?.text ? String(ev.text).slice(0, 160) : "source clause"}`,
        entityId: lease.id,
        page: typeof ev?.page === "number" ? ev.page : undefined,
      }));

    // Source document citation (mirrors src/components/lease-review/SourceFileLink.jsx's
    // findUploadedFileForLease — file identity only, no signed URL: V1 explains
    // evidence, it doesn't serve files).
    const sourceFileId = lease.source_file_id ?? lease.extraction_data?.source_file_id ?? null;
    let sourceDocument: { file_name: string } | null = null;
    if (sourceFileId) {
      const { data: file } = await ctx.supabaseAdmin
        .from("uploaded_files")
        .select("file_name")
        .eq("id", sourceFileId)
        .eq("org_id", ctx.orgId)
        .maybeSingle();
      if (file) sourceDocument = { file_name: file.file_name };
    }
    if (!sourceDocument) {
      const { data: link } = await ctx.supabaseAdmin
        .from("document_links")
        .select("file_id")
        .eq("org_id", ctx.orgId)
        .eq("entity_type", "lease")
        .eq("entity_id", lease.id)
        .eq("link_role", "source")
        .limit(1)
        .maybeSingle();
      if (link?.file_id) {
        const { data: file } = await ctx.supabaseAdmin
          .from("uploaded_files")
          .select("file_name")
          .eq("id", link.file_id)
          .eq("org_id", ctx.orgId)
          .maybeSingle();
        if (file) sourceDocument = { file_name: file.file_name };
      }
    }
    if (sourceDocument) {
      citations.push({ type: "source_document", label: `Source document: ${sourceDocument.file_name}`, entityId: lease.id, page: undefined });
    }

    if (citations.length === 0) {
      return { status: "no_data", data: null, message: "No source-document evidence is recorded for this lease/field." };
    }

    return { status: "answered", data: { lease_id: lease.id, evidence: citations, source_document: sourceDocument }, citations };
  },
};

export const getLeaseRentScheduleTool: AssistantTool = {
  name: "get_lease_rent_schedule",
  description:
    "Get a lease's approved rent schedule: current monthly/annual rent, escalation type/rate, and upcoming rent steps. Use for 'what is the rent' / 'when does rent escalate' questions.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["property_id", "lease_id"],
    properties: { property_id: PROPERTY_ID_PROP, lease_id: LEASE_ID_PROP },
  },
  requiredPages: ["LeaseRentSchedule", "Leases"],
  scopeType: "property",
  scopeArgKey: "property_id",
  accessType: "business_data",
  async execute(args, ctx) {
    const { data: lease, error: leaseError } = await ctx.supabaseAdmin
      .from("leases")
      .select("id, property_id, tenant_name")
      .eq("id", String(args.lease_id))
      .eq("org_id", ctx.orgId)
      .maybeSingle();
    if (leaseError) throw new Error(`Failed to load lease: ${leaseError.message}`);
    if (!lease || lease.property_id !== args.property_id) {
      return { status: "no_data", data: null, message: "No lease found for the given id under this property." };
    }

    const { data: rows, error: scheduleError } = await ctx.supabaseAdmin
      .from("rent_schedules")
      .select("row_type, phase, period_start, period_end, monthly_amount, annual_amount, rent_per_sf, escalation_type, escalation_rate, is_abatement, status")
      .eq("org_id", ctx.orgId)
      .eq("lease_id", lease.id)
      .order("period_start", { ascending: true })
      .limit(60);
    if (scheduleError) throw new Error(`Failed to load rent schedule: ${scheduleError.message}`);
    if (!rows || rows.length === 0) {
      return { status: "no_data", data: null, message: "No rent schedule exists yet for this lease." };
    }

    const approvedRows = rows.filter((r: any) => r.status === "approved");
    const effectiveRows = approvedRows.length > 0 ? approvedRows : rows;
    const today = new Date().toISOString().slice(0, 10);
    const currentRow = effectiveRows.find((r: any) => r.period_start <= today && (!r.period_end || r.period_end >= today)) ?? effectiveRows[0];

    return {
      status: "answered",
      data: {
        lease_id: lease.id,
        tenant_name: lease.tenant_name,
        current_rent: currentRow
          ? { monthly_amount: currentRow.monthly_amount, annual_amount: currentRow.annual_amount, rent_per_sf: currentRow.rent_per_sf, period_start: currentRow.period_start, period_end: currentRow.period_end, escalation_type: currentRow.escalation_type, escalation_rate: currentRow.escalation_rate }
          : null,
        schedule: effectiveRows.slice(0, 20).map((r: any) => ({
          row_type: r.row_type,
          phase: r.phase,
          period_start: r.period_start,
          period_end: r.period_end,
          monthly_amount: r.monthly_amount,
          escalation_type: r.escalation_type,
          escalation_rate: r.escalation_rate,
          is_abatement: r.is_abatement,
        })),
        total_rows: rows.length,
      },
      citations: [{ type: "rent_schedule", label: `Rent schedule: ${lease.tenant_name ?? lease.id}`, entityId: lease.id }],
      ...(approvedRows.length === 0 ? { limitations: ["This lease has no approved rent schedule rows yet — shown rows are unapproved drafts."] } : {}),
    };
  },
};

export const getLeaseCriticalDatesTool: AssistantTool = {
  name: "get_lease_critical_dates",
  description:
    "Get a lease's upcoming/open critical dates (renewal notice, option exercise, expiration, insurance certificate, etc.), each with status and owner. Use for 'what are the important dates' questions.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["property_id", "lease_id"],
    properties: { property_id: PROPERTY_ID_PROP, lease_id: LEASE_ID_PROP },
  },
  requiredPages: ["CriticalDates", "Leases"],
  scopeType: "property",
  scopeArgKey: "property_id",
  accessType: "business_data",
  async execute(args, ctx) {
    const { data: lease, error: leaseError } = await ctx.supabaseAdmin
      .from("leases")
      .select("id, property_id, tenant_name")
      .eq("id", String(args.lease_id))
      .eq("org_id", ctx.orgId)
      .maybeSingle();
    if (leaseError) throw new Error(`Failed to load lease: ${leaseError.message}`);
    if (!lease || lease.property_id !== args.property_id) {
      return { status: "no_data", data: null, message: "No lease found for the given id under this property." };
    }

    const { data: dates, error: datesError } = await ctx.supabaseAdmin
      .from("lease_critical_dates")
      .select("date_type, due_date, status, owner_name, reminder_days_before, note")
      .eq("org_id", ctx.orgId)
      .eq("lease_id", lease.id)
      .order("due_date", { ascending: true })
      .limit(30);
    if (datesError) throw new Error(`Failed to load critical dates: ${datesError.message}`);
    if (!dates || dates.length === 0) {
      return { status: "no_data", data: null, message: "No critical dates are recorded for this lease." };
    }

    return {
      status: "answered",
      data: { lease_id: lease.id, tenant_name: lease.tenant_name, critical_dates: dates },
      citations: [{ type: "critical_dates", label: `Critical dates: ${lease.tenant_name ?? lease.id}`, entityId: lease.id }],
    };
  },
};

export const getLeaseListSummaryTool: AssistantTool = {
  name: "get_lease_list_summary",
  description:
    "List and summarize leases the current user can access, optionally scoped to a property, status, or expiration window. Use for questions like 'which leases expire next year' or 'which leases are active at this property'.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: [],
    properties: {
      property_id: { type: "string", description: "Optional UUID of a property to scope the lease list." },
      status: { type: "string", description: "Optional lease status filter, e.g. active, draft, expired." },
      expiration_start: { type: "string", description: "Optional ISO date lower bound for lease end_date." },
      expiration_end: { type: "string", description: "Optional ISO date upper bound for lease end_date." },
      limit: { type: "number", description: "Optional result cap; max 25." },
    },
  },
  requiredPages: ["Leases"],
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
    let query = client
      .from("leases")
      .select("id, property_id, tenant_id, tenant_name, status, abstract_status, start_date, end_date, monthly_rent, lease_type")
      .eq("org_id", ctx.orgId)
      .limit(200);
    if (propertyId) query = query.eq("property_id", propertyId);
    if (typeof args.status === "string" && args.status.trim()) query = query.eq("status", String(args.status).trim());
    if (typeof args.expiration_start === "string" && args.expiration_start.trim()) query = query.gte("end_date", String(args.expiration_start).trim());
    if (typeof args.expiration_end === "string" && args.expiration_end.trim()) query = query.lte("end_date", String(args.expiration_end).trim());

    const { data: leases, error } = await query;
    if (error) throw new Error(`Failed to load accessible leases: ${error.message}`);
    if (!leases || leases.length === 0) {
      return { status: "no_data", data: null, message: "No accessible leases matched that scope." };
    }

    const byStatus: Record<string, number> = {};
    for (const lease of leases) {
      const key = String(lease.status ?? "unknown");
      byStatus[key] = (byStatus[key] ?? 0) + 1;
    }

    const sorted = [...leases].sort((a: any, b: any) => String(a.end_date ?? "9999-12-31").localeCompare(String(b.end_date ?? "9999-12-31"))).slice(0, limit);

    return {
      status: "answered",
      data: {
        total_matching_leases: leases.length,
        by_status: byStatus,
        leases: sorted.map((lease: any) => ({
          id: lease.id,
          property_id: lease.property_id,
          tenant_id: lease.tenant_id,
          tenant_name: lease.tenant_name,
          status: lease.status,
          abstract_status: lease.abstract_status,
          start_date: lease.start_date,
          end_date: lease.end_date,
          monthly_rent: lease.monthly_rent,
          lease_type: lease.lease_type,
        })),
      },
      citations: [{ type: "lease_list", label: "Accessible leases" }],
      ...(leases.length >= 200 ? { limitations: ["Lease summary is capped at the first 200 authorized rows returned by the platform."] } : {}),
    };
  },
};

export const leaseTools: AssistantTool[] = [
  getLeaseListSummaryTool,
  getLeaseSummaryTool,
  getLeaseRecoveryPolicyTool,
  getLeaseEvidenceTool,
  getLeaseRentScheduleTool,
  getLeaseCriticalDatesTool,
];

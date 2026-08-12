// @ts-nocheck
/**
 * tenant-tools.ts — section 5/16 TENANT coverage (added in the V2 platform
 * coverage pass). `tenants` is org-scoped only (no property_id column) —
 * a tenant can span multiple properties via multiple leases. property-scope
 * authorization is therefore enforced indirectly: the tool first requires a
 * real lease linking (tenant_id, property_id, org_id) before returning
 * anything, and then only returns THIS property's leases for that tenant —
 * never the tenant's leases at other properties the caller wasn't
 * authorized for.
 */
import { assertPropertyAccess, createUserScopedClient } from "../../supabase.ts";
import type { AssistantTool } from "../assistant-contracts.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const getTenantListSummaryTool: AssistantTool = {
  name: "get_tenant_list_summary",
  description:
    "List and summarize tenants the current user can access, optionally scoped to a property or upcoming lease-expiration window. Use for questions like 'which tenants are in this property' or 'which tenants have upcoming lease expirations'.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: [],
    properties: {
      property_id: { type: "string", description: "Optional UUID of a property to scope tenants through leases." },
      expiration_start: { type: "string", description: "Optional ISO date lower bound for lease end_date." },
      expiration_end: { type: "string", description: "Optional ISO date upper bound for lease end_date." },
      limit: { type: "number", description: "Optional result cap; max 25." },
    },
  },
  requiredPages: ["Tenants"],
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
    let leaseQuery = client
      .from("leases")
      .select("id, property_id, tenant_id, tenant_name, status, start_date, end_date, monthly_rent")
      .eq("org_id", ctx.orgId)
      .limit(300);
    if (propertyId) leaseQuery = leaseQuery.eq("property_id", propertyId);
    if (typeof args.expiration_start === "string" && args.expiration_start.trim()) leaseQuery = leaseQuery.gte("end_date", String(args.expiration_start).trim());
    if (typeof args.expiration_end === "string" && args.expiration_end.trim()) leaseQuery = leaseQuery.lte("end_date", String(args.expiration_end).trim());

    const { data: leases, error: leaseError } = await leaseQuery;
    if (leaseError) throw new Error(`Failed to load accessible tenant leases: ${leaseError.message}`);
    if (!leases || leases.length === 0) {
      return { status: "no_data", data: null, message: "No accessible tenants matched that scope." };
    }

    const tenantIds = [...new Set(leases.map((lease: any) => lease.tenant_id).filter(Boolean))];
    const { data: tenants, error: tenantError } = await client
      .from("tenants")
      .select("id, name, company, contact_name, email, phone, industry, status")
      .eq("org_id", ctx.orgId)
      .in("id", tenantIds)
      .limit(300);
    if (tenantError) throw new Error(`Failed to load accessible tenants: ${tenantError.message}`);

    const tenantById = new Map((tenants ?? []).map((tenant: any) => [tenant.id, tenant]));
    const rows = tenantIds.map((tenantId: any) => {
      const tenantLeases = leases.filter((lease: any) => lease.tenant_id === tenantId);
      const tenant = tenantById.get(tenantId) ?? { id: tenantId, name: tenantLeases[0]?.tenant_name };
      return {
        id: tenant.id,
        name: tenant.name,
        company: tenant.company,
        status: tenant.status,
        active_lease_count: tenantLeases.filter((lease: any) => lease.status === "active").length,
        next_expiration: tenantLeases.map((lease: any) => lease.end_date).filter(Boolean).sort()[0] ?? null,
        leases: tenantLeases.slice(0, 5).map((lease: any) => ({ id: lease.id, property_id: lease.property_id, status: lease.status, start_date: lease.start_date, end_date: lease.end_date, monthly_rent: lease.monthly_rent })),
      };
    }).sort((a: any, b: any) => String(a.next_expiration ?? "9999-12-31").localeCompare(String(b.next_expiration ?? "9999-12-31"))).slice(0, limit);

    return {
      status: "answered",
      data: {
        total_matching_tenants: tenantIds.length,
        tenants: rows,
      },
      citations: [{ type: "tenant_list", label: "Accessible tenants" }],
      ...(leases.length >= 300 ? { limitations: ["Tenant summary is based on the first 300 authorized lease rows returned by the platform."] } : {}),
    };
  },
};
export const getTenantSummaryTool: AssistantTool = {
  name: "get_tenant_summary",
  description:
    "Get a tenant's contact info and their lease(s) at a specific property (status, dates, rent). Use for 'tell me about this tenant' questions.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["property_id", "tenant_id"],
    properties: {
      property_id: { type: "string", description: "UUID of the property (used for authorization)." },
      tenant_id: { type: "string", description: "UUID of the tenant." },
    },
  },
  requiredPages: ["Tenants"],
  scopeType: "property",
  scopeArgKey: "property_id",
  accessType: "business_data",
  async execute(args, ctx) {
    const propertyId = String(args.property_id);
    const tenantId = String(args.tenant_id);

    const { data: leases, error: leasesError } = await ctx.supabaseAdmin
      .from("leases")
      .select("id, status, start_date, end_date, monthly_rent, unit_id, lease_type")
      .eq("org_id", ctx.orgId)
      .eq("property_id", propertyId)
      .eq("tenant_id", tenantId)
      .limit(20);
    if (leasesError) throw new Error(`Failed to load tenant leases: ${leasesError.message}`);
    if (!leases || leases.length === 0) {
      // No lease links this tenant to this property under this org — could
      // mean the tenant doesn't exist, belongs to another org, or simply
      // has no lease at THIS property. Same safe no_data shape either way.
      return { status: "no_data", data: null, message: "No tenant found linked to a lease at this property." };
    }

    const { data: tenant, error: tenantError } = await ctx.supabaseAdmin
      .from("tenants")
      .select("id, name, company, contact_name, email, phone, industry, status")
      .eq("org_id", ctx.orgId)
      .eq("id", tenantId)
      .maybeSingle();
    if (tenantError) throw new Error(`Failed to load tenant: ${tenantError.message}`);
    if (!tenant) {
      return { status: "no_data", data: null, message: "No tenant found for the given id." };
    }

    return {
      status: "answered",
      data: {
        tenant: { id: tenant.id, name: tenant.name, company: tenant.company, contact_name: tenant.contact_name, email: tenant.email, phone: tenant.phone, status: tenant.status },
        leases_at_this_property: leases,
      },
      citations: [{ type: "tenant_record", label: `Tenant: ${tenant.name}`, entityId: tenant.id }],
    };
  },
};

export const tenantTools: AssistantTool[] = [getTenantListSummaryTool, getTenantSummaryTool];

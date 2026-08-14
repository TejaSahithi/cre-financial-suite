import { describe, expect, it, vi } from "vitest";

const supabaseMock = vi.hoisted(() => {
  const query = {
    select: vi.fn(() => query),
    order: vi.fn(() => query),
    limit: vi.fn(() => query),
    eq: vi.fn(() => query),
    in: vi.fn(() => query),
    gte: vi.fn(() => query),
    lte: vi.fn(() => query),
    then: vi.fn((resolve) => resolve({ data: [{ charge_key: "lease_charge_calculations:1" }], error: null })),
  };
  return {
    query,
    client: {
      from: vi.fn(() => query),
    },
  };
});

vi.mock("@/services/supabaseClient", () => ({ supabase: supabaseMock.client }));
vi.mock("@/services/edgeFunctions", () => ({ invokeEdgeFunction: vi.fn() }));

describe("leaseFinancialOperationsService lease-charge read model", () => {
  it("reads common lease charges from the projection without writing financial authority", async () => {
    const { listLeaseChargeReadModel } = await import("../leaseFinancialOperationsService");

    const rows = await listLeaseChargeReadModel({
      orgId: "org-1",
      propertyId: "property-1",
      leaseIds: ["lease-1", "lease-2"],
      periodStart: "2026-01-01",
      periodEnd: "2026-12-31",
      statuses: ["calculated", "approved"],
      chargeTypes: ["percentage_rent", "management_fee"],
    });

    expect(rows).toEqual([{ charge_key: "lease_charge_calculations:1" }]);
    expect(supabaseMock.client.from).toHaveBeenCalledWith("lease_charge_read_model");
    expect(supabaseMock.query.select).toHaveBeenCalledWith("*");
    expect(supabaseMock.query.eq).toHaveBeenCalledWith("org_id", "org-1");
    expect(supabaseMock.query.eq).toHaveBeenCalledWith("property_id", "property-1");
    expect(supabaseMock.query.in).toHaveBeenCalledWith("lease_id", ["lease-1", "lease-2"]);
    expect(supabaseMock.query.gte).toHaveBeenCalledWith("period_end", "2026-01-01");
    expect(supabaseMock.query.lte).toHaveBeenCalledWith("period_start", "2026-12-31");
    expect(supabaseMock.query.in).toHaveBeenCalledWith("status", ["calculated", "approved"]);
    expect(supabaseMock.query.in).toHaveBeenCalledWith("charge_type", ["percentage_rent", "management_fee"]);
  });
});

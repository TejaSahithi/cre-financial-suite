import { describe, expect, it } from "vitest";

import {
  buildLeaseYearSchedule,
  buildRentFiscalYearOptions,
  scheduleRowsForLease,
} from "../rentScheduleUtils";

describe("rentScheduleUtils", () => {
  it("prorates a mid-month rent change into the affected month", () => {
    const rows = [
      {
        id: "old-rent",
        lease_id: "lease-1",
        status: "approved",
        phase: "contracted",
        period_start: "2026-01-01",
        period_end: "2026-06-14",
        monthly_amount: 1000,
      },
      {
        id: "new-rent",
        lease_id: "lease-1",
        status: "approved",
        phase: "contracted",
        period_start: "2026-06-15",
        period_end: "2026-12-31",
        monthly_amount: 1200,
      },
    ];

    const schedule = buildLeaseYearSchedule({}, scheduleRowsForLease(rows, "lease-1", { projectionMode: "contracted_only" }), 2026, { projectionMode: "contracted_only" });

    expect(schedule.months[0]).toMatchObject({ month: "Jan", amount: 1000, isPartial: false });
    expect(schedule.months[5]).toMatchObject({ month: "Jun", amount: 1106.67, hasChange: true });
    expect(schedule.months[11]).toMatchObject({ month: "Dec", amount: 1200, isPartial: false });
    expect(schedule.total).toBe(13306.67);
  });

  it("includes approved extension rows only when projection mode allows renewals", () => {
    const rows = [
      {
        lease_id: "lease-1",
        status: "approved",
        phase: "contracted",
        period_start: "2026-01-01",
        period_end: "2026-12-31",
        monthly_amount: 1000,
      },
      {
        lease_id: "lease-1",
        status: "approved",
        phase: "approved_extension",
        period_start: "2027-01-01",
        period_end: "2027-12-31",
        monthly_amount: 1300,
      },
    ];

    const contractedOnly = buildLeaseYearSchedule({}, scheduleRowsForLease(rows, "lease-1", { projectionMode: "contracted_only" }), 2027, { projectionMode: "contracted_only" });
    const withRenewals = buildLeaseYearSchedule({}, scheduleRowsForLease(rows, "lease-1", { projectionMode: "include_approved_renewals" }), 2027, { projectionMode: "include_approved_renewals" });

    expect(contractedOnly.total).toBe(0);
    expect(withRenewals.total).toBe(15600);
  });

  it("uses approved abstract preview dates when no stored rent schedule exists", () => {
    const schedule = buildLeaseYearSchedule(
      {
        rent_commencement_date: "2026-03-15",
        lease_end: "2026-05-14",
        monthly_rent: 3100,
      },
      [],
      2026,
    );

    expect(schedule.months[2]).toMatchObject({ month: "Mar", amount: 1700, isPartial: true });
    expect(schedule.months[3]).toMatchObject({ month: "Apr", amount: 3100, isPartial: false });
    expect(schedule.months[4]).toMatchObject({ month: "May", amount: 1400, isPartial: true });
    expect(schedule.total).toBe(6200);
  });
  it("applies approved abstract annual escalation when no stored rent schedule exists", () => {
    const leaseRow = {
      rent_commencement_date: "2026-02-01",
      lease_end: "2030-12-31",
      monthly_rent: 27600,
      escalation_rate: 3,
      escalation_timing: "lease_anniversary",
    };

    const fy2028 = buildLeaseYearSchedule(leaseRow, [], 2028);
    const fy2029 = buildLeaseYearSchedule(leaseRow, [], 2029);

    expect(fy2028.source).toBe("approved abstract preview (escalated)");
    expect(fy2028.months[0]).toMatchObject({ month: "Jan", amount: 28428 });
    expect(fy2028.months[1]).toMatchObject({ month: "Feb", amount: 29280.84 });
    expect(fy2028.total).toBe(350517.24);
    expect(fy2029.months[0]).toMatchObject({ month: "Jan", amount: 29280.84 });
    expect(fy2029.months[1]).toMatchObject({ month: "Feb", amount: 30159.27 });
    expect(fy2029.total).toBe(361032.81);
  });
  it("includes lease-active historical fiscal years in the selector options", () => {
    const years = buildRentFiscalYearOptions({
      selectedYear: 2025,
      currentYear: 2026,
      leaseRows: [
        {
          rent_commencement_date: "2019-03-01",
          lease_end: "2023-12-31",
        },
      ],
    });

    expect(years).toEqual(expect.arrayContaining([2019, 2020, 2021, 2022, 2023, 2025, 2026, 2027, 2028]));
  });
});

// @ts-nocheck
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  approvedFieldValue,
  baseMonthlyRentFromLease,
  normalizedLeaseDates,
} from "../_shared/rent-schedule.ts";

Deno.test("rent schedule reads approved snapshot fields before raw extraction", () => {
  const lease = {
    monthly_rent: "9999",
    commencement_date: "1900-01-01",
    expiration_date: "1900-12-31",
    extraction_data: {
      fields: {
        monthly_rent: { value: "8888" },
        expiration_date: { value: "2099-12-31" },
      },
    },
    abstract_snapshot: {
      approved: {
        monthly_rent: { value: "1400", review_status: "accepted" },
        commencement_date: { value: "2024-02-01", review_status: "accepted" },
      },
      fields: {
        expiration_date: { value: "2025-01-31", review_status: "pending" },
      },
    },
  };

  assertEquals(approvedFieldValue(lease, "monthly_rent"), "1400");
  assertEquals(baseMonthlyRentFromLease(lease), 1400);

  const dates = normalizedLeaseDates(lease);
  assertEquals(dates.leaseStart?.toISOString().slice(0, 10), "2024-02-01");
  assertEquals(dates.leaseEnd, null);
});

Deno.test("rent schedule does not use lease date as lease or rent commencement", () => {
  const lease = {
    abstract_snapshot: {
      approved: {
        lease_date: { value: "2024-01-09", review_status: "accepted" },
        monthly_rent: { value: "1400", review_status: "accepted" },
      },
    },
  };

  const dates = normalizedLeaseDates(lease);
  assertEquals(dates.leaseStart, null);
  assertEquals(dates.rentStart, null);
});

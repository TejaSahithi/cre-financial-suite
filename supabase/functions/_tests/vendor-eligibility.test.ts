import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { canVendorPerformService } from "../_shared/vendors/vendor-eligibility.ts";

Deno.test("vendor eligibility approves verified current service credentials", () => {
  const result = canVendorPerformService({
    vendorId: "vendor-1",
    serviceType: "hvac",
    jurisdiction: "TN",
    asOfDate: "2026-08-13",
    credentials: [{
      vendor_id: "vendor-1",
      service_type: "HVAC",
      jurisdiction: "tn",
      status: "verified",
      effective_date: "2026-01-01",
      expiration_date: "2027-01-01",
    }],
  });

  assertEquals(result.eligible, true);
  assertEquals(result.status, "eligible");
});

Deno.test("vendor eligibility blocks missing matching credentials", () => {
  const result = canVendorPerformService({
    vendorId: "vendor-1",
    serviceType: "plumbing",
    jurisdiction: "TN",
    asOfDate: "2026-08-13",
    credentials: [{ vendor_id: "vendor-1", service_type: "hvac", status: "verified" }],
  });

  assertEquals(result.eligible, false);
  assertEquals(result.reasonCodes, ["VENDOR_CREDENTIAL_REQUIRED"]);
});

Deno.test("vendor eligibility detects expired credentials", () => {
  const result = canVendorPerformService({
    vendorId: "vendor-1",
    serviceType: "hvac",
    asOfDate: "2026-08-13",
    credentials: [{ vendor_id: "vendor-1", service_type: "hvac", status: "verified", expiration_date: "2026-01-01" }],
  });

  assertEquals(result.eligible, false);
  assertEquals(result.status, "expired");
});

Deno.test("vendor eligibility allows non-regulated services without credentials", () => {
  const result = canVendorPerformService({
    vendorId: "vendor-1",
    serviceType: "janitorial",
    asOfDate: "2026-08-13",
    credentials: [],
  });

  assertEquals(result.eligible, true);
  assertEquals(result.status, "not_required");
});

Deno.test("vendor eligibility blocks regulated HVAC work when credential is missing", () => {
  const result = canVendorPerformService({
    vendorId: "vendor-1",
    serviceType: "HVAC replacement",
    asOfDate: "2026-08-13",
    credentials: [],
  });

  assertEquals(result.eligible, false);
  assertEquals(result.status, "blocked");
  assertEquals(result.reasonCodes, ["VENDOR_CREDENTIAL_REQUIRED"]);
});

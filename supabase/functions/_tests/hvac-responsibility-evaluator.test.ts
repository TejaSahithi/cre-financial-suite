import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { evaluateHvacResponsibility } from "../_shared/lease-responsibilities/hvac-responsibility-evaluator.ts";

Deno.test("HVAC evaluator resolves tenant responsibility", () => {
  const result = evaluateHvacResponsibility({ text: "Tenant shall maintain and repair the HVAC system at Tenant's sole cost." });
  assertEquals(result.status, "resolved");
  assertEquals(result.responsibility, "tenant");
});

Deno.test("HVAC evaluator resolves landlord responsibility", () => {
  const result = evaluateHvacResponsibility({ text: "Landlord shall maintain and repair the HVAC equipment serving the Premises." });
  assertEquals(result.status, "resolved");
  assertEquals(result.responsibility, "landlord");
});

Deno.test("HVAC evaluator resolves tenant threshold responsibility", () => {
  const result = evaluateHvacResponsibility({ text: "Tenant shall be responsible for HVAC repairs up to $1,500 per occurrence." });
  assertEquals(result.status, "resolved");
  assertEquals(result.responsibility, "tenant_up_to_threshold");
  assertEquals(result.thresholdAmount, 1500);
});

Deno.test("HVAC evaluator resolves landlord maintenance program charged to tenant", () => {
  const result = evaluateHvacResponsibility({ text: "Landlord shall maintain an HVAC service contract and Tenant shall reimburse Landlord for the maintenance program costs." });
  assertEquals(result.status, "resolved");
  assertEquals(result.responsibility, "landlord_maintenance_program_charged_to_tenant");
});

Deno.test("HVAC evaluator captures replacement responsibility", () => {
  const result = evaluateHvacResponsibility({ text: "Landlord shall replace any failed HVAC unit and perform capital HVAC replacements." });
  assertEquals(result.status, "resolved");
  assertEquals(result.responsibility, "landlord");
  assertEquals(result.replacementResponsibility, "landlord");
});

Deno.test("HVAC evaluator fails closed for ambiguous clauses", () => {
  const result = evaluateHvacResponsibility({ text: "HVAC obligations shall be handled as provided in the Lease." });
  assertEquals(result.status, "review_required");
  assertEquals(result.responsibility, "review_required");
  assertEquals(result.reasonCodes, ["HVAC_RESPONSIBILITY_NOT_DETERMINISTIC"]);
});

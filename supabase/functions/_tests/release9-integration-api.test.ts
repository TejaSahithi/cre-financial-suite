import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildIntegrationApiResponse } from "../_shared/integrations/public-api.ts";

Deno.test("Release 9 integration API uses cursor pagination", () => {
  const response = buildIntegrationApiResponse("leases", [{ id: "b" }, { id: "a" }, { id: "c" }], { limit: 2 });
  assertEquals(response.data.map((row) => row.id), ["a", "b"]);
  assertEquals(response.nextCursor, "b");
});

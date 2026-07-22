import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildCitations, buildLineage } from "../_shared/copilot/citation-builder.ts";

Deno.test("Release 11 citations expose evidence and amendment lineage", () => {
  const nodes = [{ id: "n1", nodeType: "amendment_effect", key: "base_rent", value: "$20", status: "approved", confidence: 0.9, documentFamilyId: "fam", amendmentSourceId: "amd-1", evidence: [{ id: "e1", documentId: "d1", page: 6, text: "rent changed" }] }];
  assertEquals(buildCitations(nodes)[0].amendmentSourceId, "amd-1");
  assertEquals(buildLineage(nodes).amendmentPrecedenceApplied, true);
});
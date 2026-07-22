// @ts-nocheck

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildDefinitionRecords, normalizeDefinedTerm } from "../_shared/extraction/document-semantics/definitions.ts";
import { resolveDefinedTermsInText } from "../_shared/extraction/document-semantics/defined-term-resolver.ts";

const blocks = [
  { blockId: "b1", text: '"Premises" means Suite 200 containing approximately 10,000 rentable square feet.', pageNumber: 1, sectionKey: "1.1", documentId: "base" },
  { blockId: "b2", text: 'In this First Amendment, "Expansion Premises" means Suite 250.', pageNumber: 3, sectionKey: "A-1", documentId: "amendment" },
  { blockId: "b3", text: "Tenant shall occupy the Premises and the Expansion Premises.", pageNumber: 4, sectionKey: "A-2", documentId: "amendment" },
];

Deno.test("Release 6 definitions normalize terms without collapsing distinct legal terms", () => {
  assertEquals(normalizeDefinedTerm('the "Premises"').normalized, "premises");
  assertEquals(normalizeDefinedTerm("Expansion Premises").normalized, "expansion premises");
});

Deno.test("Release 6 definitions detect scoped terms and resolve local usage", () => {
  const definitions = buildDefinitionRecords(blocks);
  assert(definitions.some((definition) => definition.termNormalized === "premises"));
  assert(definitions.some((definition) => definition.termNormalized === "expansion premises"));

  const resolutions = resolveDefinedTermsInText({ text: blocks[2].text, definitions, sourceDocumentId: "amendment" });
  assertEquals(resolutions.find((item) => item.term === "Premises")?.status, "resolved");
  assertEquals(resolutions.find((item) => item.term === "Expansion Premises")?.status, "resolved");
});

Deno.test("Release 6 definitions mark materially conflicting definitions", () => {
  const definitions = buildDefinitionRecords([
    { blockId: "b1", text: '"Rent" means Base Rent.', pageNumber: 1, sectionKey: "1.1" },
    { blockId: "b2", text: '"Rent" means Additional Rent only.', pageNumber: 2, sectionKey: "1.1" },
  ]);

  assertEquals(definitions.filter((definition) => definition.termNormalized === "rent").every((definition) => definition.definitionStatus === "conflicting"), true);
});
// @ts-nocheck

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildDefinitionRecords } from "../_shared/extraction/document-semantics/definitions.ts";
import { parseCrossReferences } from "../_shared/extraction/document-semantics/cross-reference-parser.ts";
import { resolveCrossReferences } from "../_shared/extraction/document-semantics/cross-reference-resolver.ts";

const blocks = [
  { blockId: "h1", text: "Section 5.1 Renewal Option", heading: "Section 5.1 Renewal Option", sectionKey: "5.1", pageNumber: 5 },
  { blockId: "d1", text: '"Premises" means Suite 200.', sectionKey: "1.1", pageNumber: 1 },
  { blockId: "r1", text: 'Tenant may renew as provided in Section 5.1 and the "Premises" definition.', sectionKey: "4.2", pageNumber: 4 },
];

Deno.test("Release 6 cross references parse and resolve section references", () => {
  const refs = resolveCrossReferences({ references: parseCrossReferences(blocks), blocks, definitions: buildDefinitionRecords(blocks) });
  const sectionRef = refs.find((ref) => ref.referenceType === "section" && ref.sourceBlockId === "r1" && ref.targetSectionKey === "5.1");
  assert(sectionRef);
  assertEquals(sectionRef.resolutionStatus, "resolved");
  assertEquals(sectionRef.targetBlockId, "h1");
});

Deno.test("Release 6 cross references resolve defined term references", () => {
  const refs = resolveCrossReferences({ references: parseCrossReferences(blocks), blocks, definitions: buildDefinitionRecords(blocks) });
  const termRef = refs.find((ref) => ref.referenceType === "defined_term" && ref.targetLabel === "Premises");
  assert(termRef);
  assertEquals(termRef.resolutionStatus, "resolved");
  assert(termRef.targetDefinitionId);
});

Deno.test("Release 6 cross references leave missing targets unresolved", () => {
  const refs = resolveCrossReferences({ references: parseCrossReferences([{ blockId: "x", text: "See Section 99.9.", pageNumber: 1 }]), blocks: [], definitions: [] });
  assertEquals(refs[0].resolutionStatus, "unresolved");
});
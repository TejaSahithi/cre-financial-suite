// @ts-nocheck

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { classifyDocumentFamily } from "../_shared/extraction/document-semantics/document-family-classifier.ts";
import { buildDocumentFamilyMember, orderDocumentFamilyMembers } from "../_shared/extraction/document-semantics/document-family-builder.ts";

Deno.test("Release 6 document family classifier uses document text, not filename alone", () => {
  const filenameOnly = classifyDocumentFamily({ filename: "first-amendment.pdf", blocks: [] });
  assertEquals(filenameOnly.documentRole, "unknown");
  assert(filenameOnly.reasonCodes.includes("filename_only_signal_rejected"));

  const amendment = classifyDocumentFamily({
    filename: "doc.pdf",
    blocks: [{ blockId: "b1", text: "This First Amendment to Lease dated January 1, 2025 amends that certain Lease Agreement dated May 1, 2024.", pageNumber: 1 }],
  });
  assertEquals(amendment.documentRole, "amendment");
  assertEquals(amendment.sequenceNumber, 1);
});

Deno.test("Release 6 document family chronology orders base lease before amendments", () => {
  const base = buildDocumentFamilyMember({ uploadedFileId: "base", fallbackFamilyId: "family-1", classification: { documentRole: "base_lease", referencedBaseLeaseDate: null, effectiveDate: "2024-05-01", executionDate: null, sequenceNumber: null, candidateFamilyIds: ["family-1"], confidence: 0.9, reasonCodes: [] } });
  const amendment = buildDocumentFamilyMember({ uploadedFileId: "amendment", fallbackFamilyId: "family-1", classification: { documentRole: "amendment", referencedBaseLeaseDate: "2024-05-01", effectiveDate: "2025-01-01", executionDate: null, sequenceNumber: 1, candidateFamilyIds: ["family-1"], confidence: 0.9, reasonCodes: [] } });

  assertEquals(orderDocumentFamilyMembers([amendment.member, base.member]).map((member) => member.uploadedFileId), ["base", "amendment"]);
});
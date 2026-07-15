// @ts-nocheck
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildExtractionPlan } from "../_shared/extraction/document-intelligence-v3/profile-planner.ts";
import {
  buildPackageKey,
  buildRelatedDocumentCoverageFromPackageGraph,
  emptyPackageGraph,
  rankCandidateDocuments,
} from "../_shared/extraction/document-intelligence-v3/package-graph.ts";

Deno.test("package graph: package key priority is lease_id, uploaded_file_id, then content_hash", () => {
  assertEquals(buildPackageKey({ leaseId: "lease-1", uploadedFileId: "uf-1", contentHash: "hash-1" }), "lease:lease-1");
  assertEquals(buildPackageKey({ uploadedFileId: "uf-1", contentHash: "hash-1" }), "upload:uf-1");
  assertEquals(buildPackageKey({ contentHash: "hash-1" }), "content:hash-1");
});

Deno.test("package graph: assignment profile creates original_lease requirement coverage, base lease does not", () => {
  const assignmentPlan = buildExtractionPlan("assignment_assumption");
  const assignmentCoverage = buildRelatedDocumentCoverageFromPackageGraph(emptyPackageGraph(), assignmentPlan.related_documents_needed);
  assertEquals(assignmentCoverage.related_documents_needed, ["original_lease"]);
  assertEquals(assignmentCoverage.related_documents_missing, ["original_lease"]);

  const basePlan = buildExtractionPlan("base_lease");
  const baseCoverage = buildRelatedDocumentCoverageFromPackageGraph(emptyPackageGraph(), basePlan.related_documents_needed);
  assertEquals(baseCoverage.related_documents_needed, []);
  assertEquals(baseCoverage.related_documents_missing, []);
});

Deno.test("package graph: unknown documents do not inherit base lease related-document requirements", () => {
  const plan = buildExtractionPlan("unknown_cre_document");
  const coverage = buildRelatedDocumentCoverageFromPackageGraph(emptyPackageGraph(), plan.related_documents_needed);
  assertEquals(coverage.related_documents_needed, []);
  assertEquals(coverage.related_documents_missing, []);
});

Deno.test("package graph: same lease_id is a strong candidate but not confirmed", () => {
  const candidates = rankCandidateDocuments({
    currentDocument: { id: "doc-2", lease_id: "lease-1", document_profile: "assignment_assumption" },
    existingDocuments: [
      { id: "doc-1", lease_id: "lease-1", document_profile: "base_lease", uploaded_file_id: "uf-1" },
      { id: "doc-2", lease_id: "lease-1", document_profile: "assignment_assumption", uploaded_file_id: "uf-2" },
    ],
    requiredDocumentTypes: ["original_lease"],
  });
  assertEquals(candidates.length, 1);
  assert(candidates[0].score >= 85);
  assertEquals(candidates[0].status, "candidate_found");
});

Deno.test("package graph: duplicate content_hash produces candidate_found coverage, not present/confirmed coverage", () => {
  const candidates = rankCandidateDocuments({
    currentDocument: { id: "doc-2", content_hash: "sha256:abc", document_profile: "assignment_assumption" },
    existingDocuments: [
      { id: "doc-1", content_hash: "sha256:abc", document_profile: "base_lease", uploaded_file_id: "uf-1" },
    ],
    requiredDocumentTypes: ["original_lease"],
  });
  assertEquals(candidates.length, 1);
  assert(candidates[0].matched_signals.includes("content_hash_duplicate"));

  const coverage = buildRelatedDocumentCoverageFromPackageGraph({
    related_document_requirements: [
      {
        required_document_type: "original_lease",
        status: "candidate_found",
        reason: "Original lease required.",
      },
    ],
  }, ["original_lease"]);
  assertEquals(coverage.related_documents_needed, ["original_lease"]);
  assertEquals(coverage.related_documents_candidate_found, ["original_lease"]);
  assertEquals(coverage.related_documents_present, []);
  assertEquals(coverage.related_documents_missing, []);
});

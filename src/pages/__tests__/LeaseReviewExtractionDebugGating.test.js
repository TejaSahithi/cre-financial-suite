import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// This repo's Vitest setup runs in Node (no jsdom/@testing-library/react),
// so LeaseReview.jsx cannot be mounted. Matching the existing source-level
// page tests, this asserts the superadmin gate around ExtractionDebugPanel
// and the Phase 8 diagnostics-only boundary.
describe("LeaseReview Extraction Debug tab gating (Task G.1)", () => {
  const source = readFileSync(resolve(process.cwd(), "src/pages/LeaseReview.jsx"), "utf8");

  it("imports ExtractionDebugPanel, which hosts the Document Intelligence v3 Diagnostics section", () => {
    expect(source).toContain('import ExtractionDebugPanel from "@/components/lease-review/ExtractionDebugPanel";');
  });

  it("computes isSuperAdminUser from isSuperAdmin(user)", () => {
    expect(source).toContain("const isSuperAdminUser = isSuperAdmin(user);");
  });

  it("hides extraction diagnostics tabs from the tab list for non-superadmins", () => {
    expect(source).toContain('if (["extraction_debug", "extraction_timeline"].includes(tab.key) && !isSuperAdminUser) return null;');
  });

  it("only renders <ExtractionDebugPanel> inside an isSuperAdminUser-gated block", () => {
    const panelIndex = source.indexOf("<ExtractionDebugPanel lease={leaseFull} />");
    expect(panelIndex).toBeGreaterThan(-1);

    const precedingSource = source.slice(0, panelIndex);
    const lastGateIndex = precedingSource.lastIndexOf("{isSuperAdminUser && (");
    expect(lastGateIndex).toBeGreaterThan(-1);

    const between = source.slice(lastGateIndex, panelIndex);
    expect(between).not.toContain("</TabsContent>");
  });

  it("renders Phase 9 and Phase 10 diagnostics only inside ExtractionDebugPanel", () => {
    const debugSource = readFileSync(resolve(process.cwd(), "src/components/lease-review/ExtractionDebugPanel.jsx"), "utf8");
    expect(debugSource).toContain("Profile Ensemble");
    expect(debugSource).toContain("Extraction Plan");
    expect(debugSource).toContain("Modules To Run");
    expect(debugSource).toContain("Modules Skipped");
    expect(debugSource).toContain("Coverage Diagnostics");
    expect(debugSource).toContain("Processing Coverage");
    expect(debugSource).toContain("Evidence Coverage");
    expect(debugSource).toContain("Expected Information Coverage");
    expect(debugSource).toContain("Related Document Coverage");
    expect(debugSource).toContain("Validation Coverage");
    expect(debugSource).toContain("Overall Coverage");
    expect(debugSource).toContain("Importance Diagnostics");
    expect(debugSource).toContain("Critical/high Missing Fields");
    expect(debugSource).toContain("Unmapped High-importance Claims");
    expect(debugSource).toContain("Document Package Graph");
    expect(debugSource).toContain("Related Document Requirements");
    expect(debugSource).toContain("Candidate Related Documents");
    expect(debugSource).toContain("Temporal / Supersession Diagnostics");
    expect(debugSource).toContain("Supersession Candidates");
    expect(debugSource).toContain("Current Truth Candidates");
    expect(debugSource).toContain("V3 Approval Advisory Simulation");
    expect(debugSource).toContain("would_block_approval");
    expect(debugSource).toContain("Recommended Actions");
    expect(debugSource).toContain("V3 Advisory Audit / Current Review Comparison");
    expect(debugSource).toContain("Load v3 Advisory Audit");
    expect(debugSource).toContain("fetchDocumentIntelligenceV3AdvisoryAudit");
    expect(debugSource).toContain("Run Batch Advisory Audit");
    expect(debugSource).toContain("V3 Batch Advisory Audit Report");
    expect(debugSource).toContain("fetchDocumentIntelligenceV3AdvisoryAuditBatch");
  });
  it("keeps Document Intelligence v3 diagnostics out of approval and business-row logic", () => {
    expect(source).not.toContain("fetchDocumentIntelligenceV3Readiness");
    expect(source).not.toContain("document-intelligence-v3-readiness");
    expect(source).not.toContain("v3Diagnostics");
    expect(source).not.toContain("evidence_sufficiency");
    expect(source).not.toContain("importance_summary");
    expect(source).not.toContain("Coverage Diagnostics");
    expect(source).not.toContain("Document Package Graph");
    expect(source).not.toContain("Temporal / Supersession Diagnostics");
    expect(source).not.toContain("V3 Approval Advisory Simulation");
    expect(source).not.toContain("approval_advisory");
    expect(source).not.toContain("document-intelligence-v3-approval-advisory");
    expect(source).not.toContain("document-intelligence-v3-advisory-audit");
    expect(source).not.toContain("V3 Advisory Audit / Current Review Comparison");
    expect(source).not.toContain("document-intelligence-v3-advisory-audit-batch");
    expect(source).not.toContain("V3 Batch Advisory Audit Report");
    expect(source).toContain("const canApprove = approvalBlockers.length === 0;");
    expect(source).toContain("approveLeaseWorkflow({");
  });
});




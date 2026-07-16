import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeEdgeFunctionMock } = vi.hoisted(() => ({
  invokeEdgeFunctionMock: vi.fn(),
}));

vi.mock("@/services/edgeFunctions", () => ({
  invokeEdgeFunction: invokeEdgeFunctionMock,
}));

import {
  fetchDocumentIntelligenceV3Readiness,
  fetchDocumentIntelligenceV3AdvisoryAudit,
  fetchDocumentIntelligenceV3AdvisoryAuditBatch,
} from "../documentIntelligenceV3Service";

describe("fetchDocumentIntelligenceV3Readiness", () => {
  beforeEach(() => {
    invokeEdgeFunctionMock.mockReset();
  });

  it("calls document-intelligence-v3-readiness with uploaded_file_id when run_id is not available (Task 7)", async () => {
    invokeEdgeFunctionMock.mockResolvedValue({ readiness: { available: true, run_id: "run-1" } });

    const result = await fetchDocumentIntelligenceV3Readiness({ uploadedFileId: "uf-1" });

    expect(invokeEdgeFunctionMock).toHaveBeenCalledWith("document-intelligence-v3-readiness", {
      uploaded_file_id: "uf-1",
      run_id: null,
    });
    expect(result).toEqual({ error: false, readiness: { available: true, run_id: "run-1" } });
  });

  it("passes run_id through when supplied", async () => {
    invokeEdgeFunctionMock.mockResolvedValue({ readiness: { available: true, run_id: "run-2" } });

    await fetchDocumentIntelligenceV3Readiness({ uploadedFileId: null, runId: "run-2" });

    expect(invokeEdgeFunctionMock).toHaveBeenCalledWith("document-intelligence-v3-readiness", {
      uploaded_file_id: null,
      run_id: "run-2",
    });
  });

  it("returns a non-throwing success response (Task G.2)", async () => {
    invokeEdgeFunctionMock.mockResolvedValue({ readiness: { available: false } });
    const result = await fetchDocumentIntelligenceV3Readiness({ uploadedFileId: "uf-1" });
    expect(result.error).toBe(false);
    expect(result.readiness.available).toBe(false);
  });

  it("catches an endpoint failure and returns {error:true} instead of throwing (Task G.7)", async () => {
    invokeEdgeFunctionMock.mockRejectedValue(new Error("Function returned an error: internal failure"));

    let thrown = null;
    let result = null;
    try {
      result = await fetchDocumentIntelligenceV3Readiness({ uploadedFileId: "uf-1" });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeNull();
    expect(result).toEqual({ error: true, message: "Function returned an error: internal failure" });
  });

  it("short-circuits with a clear message when neither uploadedFileId nor runId is given, without calling the edge function", async () => {
    const result = await fetchDocumentIntelligenceV3Readiness({});
    expect(result.error).toBe(true);
    expect(invokeEdgeFunctionMock).not.toHaveBeenCalled();
  });
});
describe("fetchDocumentIntelligenceV3AdvisoryAudit", () => {
  beforeEach(() => {
    invokeEdgeFunctionMock.mockReset();
  });

  it("calls document-intelligence-v3-advisory-audit with source identifiers", async () => {
    invokeEdgeFunctionMock.mockResolvedValue({ advisory_audit: { audit_id: "audit-1" } });

    const result = await fetchDocumentIntelligenceV3AdvisoryAudit({ uploadedFileId: "uf-1", leaseId: "lease-1" });

    expect(invokeEdgeFunctionMock).toHaveBeenCalledWith("document-intelligence-v3-advisory-audit", {
      uploaded_file_id: "uf-1",
      run_id: null,
      lease_id: "lease-1",
      persist_snapshot: false,
    });
    expect(result).toEqual({ error: false, advisoryAudit: { audit_id: "audit-1" } });
  });

  it("short-circuits when no uploadedFileId, runId, or leaseId is available", async () => {
    const result = await fetchDocumentIntelligenceV3AdvisoryAudit({});
    expect(result.error).toBe(true);
    expect(invokeEdgeFunctionMock).not.toHaveBeenCalled();
  });

  it("catches endpoint failures without throwing", async () => {
    invokeEdgeFunctionMock.mockRejectedValue(new Error("audit failed"));
    const result = await fetchDocumentIntelligenceV3AdvisoryAudit({ runId: "run-1" });
    expect(result).toEqual({ error: true, message: "audit failed" });
  });
});
describe("fetchDocumentIntelligenceV3AdvisoryAuditBatch", () => {
  beforeEach(() => {
    invokeEdgeFunctionMock.mockReset();
  });

  it("calls document-intelligence-v3-advisory-audit-batch with source identifier arrays", async () => {
    invokeEdgeFunctionMock.mockResolvedValue({ batch_audit: { total: 1 } });

    const result = await fetchDocumentIntelligenceV3AdvisoryAuditBatch({ uploadedFileIds: ["uf-1"], leaseIds: ["lease-1"], limit: 25 });

    expect(invokeEdgeFunctionMock).toHaveBeenCalledWith("document-intelligence-v3-advisory-audit-batch", {
      uploaded_file_ids: ["uf-1"],
      run_ids: [],
      lease_ids: ["lease-1"],
      limit: 25,
    });
    expect(result).toEqual({ error: false, batchAudit: { total: 1 } });
  });

  it("does not call the endpoint when no ids are available", async () => {
    const result = await fetchDocumentIntelligenceV3AdvisoryAuditBatch({});
    expect(result).toEqual({ error: false, batchAudit: null });
    expect(invokeEdgeFunctionMock).not.toHaveBeenCalled();
  });

  it("catches endpoint failures without throwing", async () => {
    invokeEdgeFunctionMock.mockRejectedValue(new Error("batch failed"));
    const result = await fetchDocumentIntelligenceV3AdvisoryAuditBatch({ runIds: ["run-1"] });
    expect(result).toEqual({ error: true, message: "batch failed" });
  });
});


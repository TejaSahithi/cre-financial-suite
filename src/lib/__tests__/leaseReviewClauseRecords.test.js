import { describe, it, expect } from "vitest";
import { normalizeClauseRecords, computeFallbackClauseRows } from "@/lib/leaseReviewFieldNormalizer";

describe("normalizeClauseRecords / computeFallbackClauseRows", () => {
  it("finds clauses stored under workflow_output.lease_clauses", () => {
    const lease = {
      extraction_data: {
        workflow_output: {
          lease_clauses: [
            { clause_type: "renewal_option", clause_title: "Renewal Option", clause_text: "Tenant has two 5-year renewal options at fair market rent.", source_page: 8, confidence_score: 0.9 },
          ],
        },
      },
    };
    // Note: computeFallbackClauseRows also feeds lease_clauses through
    // collectExtractedDocumentItems() as one of its own sources (ported
    // verbatim from SpecializedTables.jsx's original fallbackClauses, not
    // rewritten in this pass) — the same clause can legitimately appear via
    // both the direct clauseRows path and the discoveredRows path, since the
    // two lists are deduped independently, not against each other. Assert
    // presence, not an exact row count.
    const rows = normalizeClauseRecords(lease);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some((r) => r.clauseType === "renewal_option" && r.sourcePage === 8)).toBe(true);
  });

  it("also finds clauses when they only exist under workflow_output.clause_records (not lease_clauses) — the documented 0/20 gap", () => {
    const lease = {
      extraction_data: {
        workflow_output: {
          clause_records: [
            {
              item_id: "cr-1",
              item_type: "cam_recoveries",
              label: "CAM Recoveries",
              source_text: "Tenant shall pay its pro rata share of common area maintenance costs.",
              source_page: 5,
              confidence: 0.77,
            },
          ],
        },
      },
    };
    const rows = normalizeClauseRecords(lease);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.sourceText?.includes("common area maintenance"))).toBe(true);
  });

  it("finds clauses nested under uploaded_files.ui_review_payload's metadata/record fallback tree", () => {
    const lease = {
      uploaded_files: {
        ui_review_payload: {
          metadata: {
            workflow_output: {
              lease_clauses: [
                { clause_type: "insurance_requirements", clause_title: "Insurance", clause_text: "Tenant shall maintain commercial general liability insurance of not less than $1,000,000.", source_page: 14 },
              ],
            },
          },
        },
      },
    };
    const rows = normalizeClauseRecords(lease);
    expect(rows.some((r) => r.clauseType === "insurance_requirements")).toBe(true);
  });

  it("returns an empty array, not a throw, for a lease with no clause data anywhere", () => {
    expect(computeFallbackClauseRows({})).toEqual([]);
    expect(normalizeClauseRecords({})).toEqual([]);
  });

  it("filters out clauses with no real, non-generic source text", () => {
    const lease = {
      extraction_data: {
        workflow_output: {
          lease_clauses: [
            { clause_type: "default", clause_title: "Default", clause_text: "unknown" },
          ],
        },
      },
    };
    expect(normalizeClauseRecords(lease)).toEqual([]);
  });
});

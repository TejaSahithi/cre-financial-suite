import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Release 7 source hardening checks", () => {
  it("rerunnable semantic persistence deletes scoped records before insert", () => {
    const files = [
      "supabase/functions/_shared/extraction/document-semantics/definitions.ts",
      "supabase/functions/_shared/extraction/document-semantics/cross-reference-resolver.ts",
      "supabase/functions/_shared/extraction/document-semantics/amendment-effect-extractor.ts",
      "supabase/functions/document-intelligence-v4-review-payload/index.ts",
    ];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source).toContain(".delete()");
      expect(source.indexOf(".delete()")).toBeLessThan(source.indexOf(".insert("));
      expect(source).toContain("organization_id");
    }
  });

  it("Release 6 semantic tables remain tenant-isolated by migration policy", () => {
    const migration = readFileSync("supabase/migrations/20260860000000_document_semantics_release6.sql", "utf8");
    for (const table of ["document_definitions", "document_cross_references", "document_family_members", "document_amendment_effects", "document_semantic_search_records", "document_semantic_review_resolutions", "document_semantic_rollout_configs"]) {
      expect(migration).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
      expect(migration).toContain(table);
    }
    expect(migration).toContain("public.get_my_org_ids");
  });

  it("Lease Review semantic panels are lazy loaded behind a boundary", () => {
    const leaseReview = readFileSync("src/pages/LeaseReview.jsx", "utf8");
    const drawer = readFileSync("src/components/lease-review/FieldDrawerIntelligence.jsx", "utf8");
    expect(leaseReview).toContain("lazy(() => import(\"@/components/lease-review/DocumentFamilyTimeline\"))");
    expect(leaseReview).toContain("<SemanticPanelBoundary>");
    expect(drawer).toContain("lazy(() => import(\"@/components/lease-review/AmendmentLineage\"))");
    expect(drawer).toContain("<SemanticPanelBoundary fallback={null}>");
  });
});
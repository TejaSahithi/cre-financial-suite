// @ts-nocheck
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildDateDependencyKey } from "../_shared/extraction/lease-financial-schedule/date-dependencies/date-dependency-key.ts";
import { validateDateDependency } from "../_shared/extraction/lease-financial-schedule/date-dependencies/date-dependency-validation.ts";
import { buildLeaseTermKey } from "../_shared/extraction/lease-financial-schedule/terms/lease-term-key.ts";
import { validateLeaseTermCandidate } from "../_shared/extraction/lease-financial-schedule/terms/lease-term-validation.ts";
import {
  getLeaseFinancialScheduleMode,
  isFinancialScheduleAtLeastShadow,
} from "../_shared/extraction/lease-financial-schedule/feature-mode.ts";

const orgId = "org-p4-2";
const leaseId = "lease-p4-2";
const packageId = "package-p4-2";
const uploadedFileId = "file-p4-2";
const extractionRunId = "run-p4-2";
const generationId = "generation-p4-2";

Deno.test("P4.2 integrated flow: P2/P3 effective claims feed P4.1 expressions, then P4.2 graph and terms without resolving dates", async () => {
  const expressions = [
    { id: "expr-commencement", orgId, leaseId, packageId, uploadedFileId, extractionRunId, generationId, expressionStatus: "unresolved" },
    { id: "expr-delivery", orgId, leaseId, packageId, uploadedFileId, extractionRunId, generationId, expressionStatus: "extracted" },
    { id: "expr-expiration", orgId, leaseId, packageId, uploadedFileId, extractionRunId, generationId, expressionStatus: "needs_review" },
  ];
  const context = { orgId, leaseId, packageId, uploadedFileId, extractionRunId, generationId, activeGenerationId: generationId, expressions };
  const dependency = {
    orgId,
    leaseId,
    packageId,
    uploadedFileId,
    extractionRunId,
    generationId,
    sourceExpressionId: "expr-commencement",
    targetExpressionId: "expr-delivery",
    dependencyType: "event_anchor",
    dependencyStatus: "valid",
    sourcePackageEffectiveClaimId: "package-effective-delivery-date",
    producerType: "validation_engine",
    producerName: "p4.2-integrated-test",
  };
  const term = {
    orgId,
    leaseId,
    packageId,
    uploadedFileId,
    extractionRunId,
    generationId,
    termType: "initial_term",
    termStatus: "needs_review",
    originType: "derived",
    instanceKey: "initial-1",
    startExpressionId: "expr-commencement",
    endExpressionId: "expr-expiration",
    sourcePackageEffectiveClaimId: "package-effective-term",
    sourceClaimIds: ["claim-expiration", "claim-commencement"],
    producerType: "validation_engine",
    producerName: "p4.2-integrated-test",
    metadata: { expression_contract: "lease-date-expressions-v1" },
  };

  assertEquals(validateDateDependency(dependency, context), { valid: true, status: "valid", errorCodes: [] });
  assertEquals(validateLeaseTermCandidate(term, context), { valid: true, status: "valid", errorCodes: [] });
  assertEquals((await buildDateDependencyKey(dependency)).length, 64);
  assertEquals((await buildLeaseTermKey(term)).length, 64);
});

Deno.test("P4.2 feature-mode boundary: default remains off and source has no P4.2 runtime call site", async () => {
  assertEquals(getLeaseFinancialScheduleMode({ get: () => undefined }), "off");
  assertEquals(isFinancialScheduleAtLeastShadow({ get: () => undefined }), false);

  const runtimeSources = await Promise.all([
    Deno.readTextFile("supabase/functions/normalize-pdf-output/index.ts").catch(() => ""),
    Deno.readTextFile("supabase/functions/parse-pdf-docling/index.ts").catch(() => ""),
    Deno.readTextFile("supabase/functions/ingest-file/index.ts").catch(() => ""),
  ]);
  const runtimeText = runtimeSources.join("\n");
  assert(!runtimeText.includes("persist_lease_date_expression_dependencies"));
  assert(!runtimeText.includes("persist_lease_term_candidates"));
  assert(!runtimeText.includes("lease_term_candidates"));
  assertStringIncludes(await Deno.readTextFile("supabase/migrations/20260849000000_lease_date_dependency_and_term_candidates_p4_2.sql"), "LEASE_FINANCIAL_SCHEDULE_MODE");
});

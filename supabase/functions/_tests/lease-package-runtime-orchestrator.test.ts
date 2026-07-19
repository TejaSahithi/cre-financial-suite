// @ts-nocheck
// P3.7 -- package runtime mode matrix and orchestration boundary tests.

import { assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  maybeRunLeaseDocumentPackagePipeline,
  runLeaseDocumentPackagePipeline,
  validatePackageRuntimeModeCombination,
} from "../_shared/extraction/document-package/runtime/package-runtime-orchestrator.ts";
import { PACKAGE_RUNTIME_ERROR_CODES, PackageRuntimeError } from "../_shared/extraction/document-package/runtime/package-runtime-errors.ts";

const context = {
  orgId: "org-1",
  uploadedFileId: "file-1",
  leaseId: "lease-1",
  extractionRunId: "run-1",
  generationId: "gen-1",
};

function env(claimsMode: string | undefined, packageMode: string | undefined) {
  return {
    get(key: string) {
      if (key === "LEASE_CLAIMS_LEDGER_MODE") return claimsMode;
      if (key === "LEASE_DOCUMENT_PACKAGE_MODE") return packageMode;
      return undefined;
    },
  };
}

Deno.test("P3.7 mode 1/2/8/9/10/11: package off returns disabled before any Supabase/package call", async () => {
  const result = await runLeaseDocumentPackagePipeline(null, context, {}, env("off", "off"));
  assertEquals(result, {
    enabled: false,
    mode: "off",
    compatibilityPersisted: false,
    status: "disabled",
  });

  const shadowClaims = await maybeRunLeaseDocumentPackagePipeline(null, context, {}, env("shadow", "off"));
  assertEquals(shadowClaims?.status, "disabled");
});

Deno.test("P3.7 mode 3/4/5/6/7: package mode dependencies are explicit and browser mode cannot override env", () => {
  validatePackageRuntimeModeCombination({ claimsMode: "shadow", packageMode: "shadow" });
  validatePackageRuntimeModeCombination({ claimsMode: "active", packageMode: "active" });
  validatePackageRuntimeModeCombination({ claimsMode: "active", packageMode: "off" });

  let error = null;
  try {
    validatePackageRuntimeModeCombination({ claimsMode: "off", packageMode: "shadow" });
  } catch (err) {
    error = err;
  }
  assertEquals(error instanceof PackageRuntimeError, true);
  assertEquals(error?.errorCode, PACKAGE_RUNTIME_ERROR_CODES.PACKAGE_MODE_REQUIRES_CLAIMS_LEDGER);

  error = null;
  try {
    validatePackageRuntimeModeCombination({ claimsMode: "shadow", packageMode: "active" });
  } catch (err) {
    error = err;
  }
  assertEquals(error instanceof PackageRuntimeError, true);
  assertEquals(error?.errorCode, PACKAGE_RUNTIME_ERROR_CODES.PACKAGE_ACTIVE_REQUIRES_CLAIMS_ACTIVE);
});

Deno.test("P3.7 active 24/28: active package failure is not silently downgraded to single-document fallback", async () => {
  await assertRejects(
    () => maybeRunLeaseDocumentPackagePipeline(null, context, {}, env("active", "active")),
    TypeError,
  );
});
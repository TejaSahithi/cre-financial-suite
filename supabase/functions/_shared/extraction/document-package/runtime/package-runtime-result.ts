// @ts-nocheck
import type { LeaseDocumentPackageMode } from "../feature-mode.ts";
import type { PackageRuntimeResult } from "./package-runtime-types.ts";

export function disabledPackageRuntimeResult(): PackageRuntimeResult {
  return {
    enabled: false,
    mode: "off",
    compatibilityPersisted: false,
    status: "disabled",
  };
}

export function failedPackageRuntimeResult(mode: LeaseDocumentPackageMode, errorCode: string): PackageRuntimeResult {
  return {
    enabled: mode !== "off",
    mode,
    compatibilityPersisted: false,
    status: "failed",
    errorCode,
  };
}

// @ts-nocheck

import type { CanonicalDocumentLayout } from "./canonical-layout.ts";
import type { CanonicalLayoutResolutionResult } from "./canonical-layout-resolver.ts";

export interface LayoutProvenanceDescription {
  layoutSource: "azure_native" | "legacy_lossy";
  layoutFidelity: "full" | "degraded";
  geometryAvailable: boolean;
  geometryUnavailableReason: string | null;
  schemaVersion: string | null;
  adapterVersion: string | null;
  canonicalLayoutHash: string | null;
  azureModelId: string | null;
  azureApiVersion: string | null;
}

export function describeLayoutProvenance(args: {
  layout: CanonicalDocumentLayout | null | undefined;
  resolution?: CanonicalLayoutResolutionResult | null;
  canonicalLayoutHash?: string | null;
  schemaVersion?: string | null;
  adapterVersion?: string | null;
}): LayoutProvenanceDescription {
  const layout = args.layout ?? null;
  const release3 = (layout?.metadata as any)?.canonical_layout_v3 ?? {};
  const isAzureNative =
    layout?.provider === "azure_document_intelligence" ||
    layout?.layout_provider === "azure_document_intelligence" ||
    args.resolution?.source === "azure_analyze_result" ||
    args.resolution?.source === "provided_canonical_layout" && args.resolution?.fidelity === "lossless" ||
    release3.layoutSource === "azure_native";
  const geometryAvailable = hasUsableGeometry(layout);
  const layoutSource = isAzureNative ? "azure_native" : "legacy_lossy";
  let geometryUnavailableReason: string | null = null;
  if (!geometryAvailable) {
    geometryUnavailableReason = isAzureNative
      ? "azure_native_source_but_zero_eligible_elements_have_geometry"
      : "legacy_layout_does_not_preserve_geometry";
  }

  return {
    layoutSource,
    layoutFidelity: isAzureNative && geometryAvailable ? "full" : "degraded",
    geometryAvailable,
    geometryUnavailableReason,
    schemaVersion: args.schemaVersion ?? release3.schemaVersion ?? (layout?.schema_version != null ? String(layout.schema_version) : null),
    adapterVersion: args.adapterVersion ?? release3.adapterVersion ?? null,
    canonicalLayoutHash: args.canonicalLayoutHash ?? release3.canonicalLayoutHash ?? null,
    azureModelId: layout?.provider_model_id ?? release3.azureModelId ?? null,
    azureApiVersion: layout?.provider_api_version ?? layout?.layout_api_version ?? release3.azureApiVersion ?? null,
  };
}

export function hasUsableGeometry(layout: CanonicalDocumentLayout | null | undefined): boolean {
  if (!layout) return false;
  for (const page of layout.pages ?? []) {
    for (const block of page.blocks ?? []) {
      if (isValidPolygon(block.polygon)) return true;
    }
    for (const table of page.tables ?? []) {
      if (isValidPolygon(table.polygon)) return true;
      for (const cell of table.cells ?? []) {
        if (isValidPolygon(cell.polygon)) return true;
      }
    }
  }
  return false;
}

export function isValidPolygon(value: unknown): boolean {
  return Array.isArray(value) && value.length >= 6 && value.length % 2 === 0 && value.every((n) => Number.isFinite(Number(n)));
}

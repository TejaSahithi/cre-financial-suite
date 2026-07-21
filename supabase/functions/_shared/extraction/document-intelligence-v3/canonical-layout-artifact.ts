// @ts-nocheck

import type { CanonicalDocumentLayout } from "./canonical-layout.ts";

export const CANONICAL_LAYOUT_V3_SCHEMA_VERSION = "canonical-layout-v3";
export const CANONICAL_LAYOUT_V3_ADAPTER_VERSION = "azure-native-v1";

export interface CanonicalLayoutArtifactMetadata {
  schemaVersion: string;
  adapterVersion: string;
  layoutSource: "azure_native";
  azureModelId: string | null;
  azureApiVersion: string | null;
  generatedAt: string;
  uploadedFileId: string;
  generationId: string | null;
  documentContentHash: string | null;
  canonicalLayoutHash: string;
}

export interface BuildCanonicalLayoutArtifactInput {
  layout: CanonicalDocumentLayout;
  uploadedFileId: string;
  orgId: string;
  generationId?: string | null;
  azureModelId?: string | null;
  azureApiVersion?: string | null;
  generatedAt?: string | null;
}

export interface CanonicalLayoutArtifactResult {
  layout: CanonicalDocumentLayout;
  metadata: CanonicalLayoutArtifactMetadata;
  hash: string;
}

export async function sha256HexUtf8(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function buildCanonicalLayoutArtifact(
  input: BuildCanonicalLayoutArtifactInput,
): Promise<CanonicalLayoutArtifactResult> {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const documentContentHash = await sha256HexUtf8(String(input.layout.text_projection ?? ""));
  const baseLayout: CanonicalDocumentLayout = {
    ...input.layout,
    uploaded_file_id: input.uploadedFileId,
    document_id: input.layout.document_id ?? input.uploadedFileId,
    org_id: input.orgId,
    content_hash: input.layout.content_hash ?? documentContentHash,
    provider_model_id: input.layout.provider_model_id ?? input.azureModelId ?? null,
    provider_api_version: input.layout.provider_api_version ?? input.azureApiVersion ?? null,
    metadata: {
      ...(input.layout.metadata ?? {}),
      generated_at: generatedAt,
      release3_schema_version: CANONICAL_LAYOUT_V3_SCHEMA_VERSION,
      release3_adapter_version: CANONICAL_LAYOUT_V3_ADAPTER_VERSION,
      layout_source: "azure_native",
    },
  };
  const hash = await computeCanonicalLayoutHash(baseLayout);
  const metadata: CanonicalLayoutArtifactMetadata = {
    schemaVersion: CANONICAL_LAYOUT_V3_SCHEMA_VERSION,
    adapterVersion: CANONICAL_LAYOUT_V3_ADAPTER_VERSION,
    layoutSource: "azure_native",
    azureModelId: input.azureModelId ?? baseLayout.provider_model_id ?? null,
    azureApiVersion: input.azureApiVersion ?? baseLayout.provider_api_version ?? null,
    generatedAt,
    uploadedFileId: input.uploadedFileId,
    generationId: input.generationId ?? null,
    documentContentHash,
    canonicalLayoutHash: hash,
  };

  return {
    layout: {
      ...baseLayout,
      metadata: {
        ...baseLayout.metadata,
        canonical_layout_v3: metadata,
      },
    },
    metadata,
    hash,
  };
}

export async function computeCanonicalLayoutHash(layout: CanonicalDocumentLayout): Promise<string> {
  return await sha256HexUtf8(stableStringify(normalizeLayoutForHash(layout)));
}

function normalizeLayoutForHash(layout: CanonicalDocumentLayout): Record<string, unknown> {
  return {
    schema_version: layout.schema_version ?? null,
    provider: layout.provider ?? null,
    layout_provider: layout.layout_provider ?? null,
    provider_model_id: layout.provider_model_id ?? null,
    provider_api_version: layout.provider_api_version ?? null,
    content_hash: layout.content_hash ?? null,
    text_projection: layout.text_projection ?? "",
    pages: (layout.pages ?? []).map((page, pageIndex) => ({
      page_number: page.page_number,
      fallback_index: pageIndex,
      width: page.page_width ?? null,
      height: page.page_height ?? null,
      unit: page.page_unit ?? null,
      blocks: (page.blocks ?? []).map((block, blockIndex) => ({
        block_id: block.block_id,
        fallback_index: blockIndex,
        page_number: block.page_number,
        reading_order_index: block.reading_order_index ?? null,
        kind: block.kind ?? null,
        role: block.role ?? null,
        text: block.text ?? "",
        polygon: normalizeNumberArray(block.polygon),
        bounding_regions: normalizeBoundingRegions(block.bounding_regions),
      })),
      tables: (page.tables ?? []).map((table, tableIndex) => ({
        table_id: table.table_id,
        fallback_index: tableIndex,
        page_number: table.page_number ?? null,
        rows: table.rows ?? null,
        row_count: table.row_count ?? null,
        column_count: table.column_count ?? null,
        polygon: normalizeNumberArray(table.polygon),
        bounding_regions: normalizeBoundingRegions(table.bounding_regions),
        cells: (table.cells ?? []).map((cell, cellIndex) => ({
          cell_id: cell.cell_id,
          fallback_index: cellIndex,
          row_index: cell.row_index,
          column_index: cell.column_index,
          row_span: cell.row_span ?? null,
          column_span: cell.column_span ?? null,
          kind: cell.kind ?? null,
          text: cell.text ?? "",
          polygon: normalizeNumberArray(cell.polygon),
          bounding_regions: normalizeBoundingRegions(cell.bounding_regions),
        })),
      })),
    })),
  };
}

function normalizeBoundingRegions(regions: any): Array<Record<string, unknown>> {
  return (Array.isArray(regions) ? regions : []).map((region) => ({
    page_number: region?.page_number ?? null,
    polygon: normalizeNumberArray(region?.polygon),
  }));
}

function normalizeNumberArray(value: unknown): number[] {
  return (Array.isArray(value) ? value : []).map((n) => Number(n));
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

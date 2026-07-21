// @ts-nocheck
/**
 * Canonical document parser — `parseDocument()`
 *
 * ONE entry point, used by every edge function that needs structured
 * parsing output (parse-document-azure, normalize-pdf-output, the retry
 * path, future review-approve refreshes). Azure Document Intelligence is
 * the only parser backend; no other function may call it directly.
 */

import type { DoclingOutput } from "./types.ts";
import { analyzeWithAzureLayout, getAzureDocumentIntelligenceConfig } from "../azure/document-intelligence.ts";
import { normalizeAzureLayoutToDoclingOutput } from "./azure-layout-adapter.ts";
import { resolveExtractionProvider } from "./extraction-provider.ts";

export async function parseDocument(
  fileBytes: Uint8Array | null,
  fileName: string,
  mimeType: string = "application/pdf",
  options: { fileUrl?: string; providerOverride?: string | null } = {},
): Promise<DoclingOutput> {
  const provider = resolveExtractionProvider(options.providerOverride);
  const config = getAzureDocumentIntelligenceConfig();

  console.log(
    `[parser] Azure Document Intelligence parse file="${fileName}" mime=${mimeType} provider=${provider.mode}`,
  );

  const analyzeResult = await analyzeWithAzureLayout({
    fileBytes: fileBytes ?? null,
    fileUrl: options.fileUrl,
    mimeType,
  });

  return normalizeAzureLayoutToDoclingOutput(analyzeResult, {
    apiVersion: config.apiVersion,
    modelId: config.modelId,
  });
}

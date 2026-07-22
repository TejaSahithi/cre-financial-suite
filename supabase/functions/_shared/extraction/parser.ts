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
import { analyzeWithAzureLayoutAndProvenance } from "./provenance/transport/azure.ts";
import type { ProvenanceContext } from "./provenance/types.ts";
import { normalizeAzureLayoutToDoclingOutput } from "./azure-layout-adapter.ts";
import { azureAnalyzeResultToCanonicalLayout } from "./azure/azure-to-canonical-layout.ts";
import { buildCanonicalLayoutArtifact } from "./document-intelligence-v3/canonical-layout-artifact.ts";
import { isDocumentIntelligenceV3Enabled } from "./document-intelligence-v3/feature-flag.ts";
import { resolveExtractionProvider } from "./extraction-provider.ts";

export async function parseDocument(
  fileBytes: Uint8Array | null,
  fileName: string,
  mimeType: string = "application/pdf",
  options: {
    fileUrl?: string;
    providerOverride?: string | null;
    uploadedFileId?: string | null;
    orgId?: string | null;
    generationId?: string | null;
    /** P1.4: optional extraction-provenance identity for the Azure call.
     * Undefined for any caller without stage/run provenance (tests, the
     * dry-run comparison path, review-approve refreshes) -- those keep
     * calling Azure exactly as before. */
    provenance?: { supabaseAdmin: any; context: ProvenanceContext };
  } = {},
): Promise<DoclingOutput> {
  const provider = resolveExtractionProvider(options.providerOverride);
  const config = getAzureDocumentIntelligenceConfig();

  console.log(
    `[parser] Azure Document Intelligence parse file="${fileName}" mime=${mimeType} provider=${provider.mode}`,
  );

  const azureArgs = {
    fileBytes: fileBytes ?? null,
    fileUrl: options.fileUrl,
    mimeType,
  };
  const analyzeResult = options.provenance
    ? await analyzeWithAzureLayoutAndProvenance(
      options.provenance.supabaseAdmin,
      { ...options.provenance.context, operation: "azure_layout_analyze" },
      azureArgs,
    )
    : await analyzeWithAzureLayout(azureArgs);

  const doclingOutput = normalizeAzureLayoutToDoclingOutput(analyzeResult, {
    apiVersion: config.apiVersion,
    modelId: config.modelId,
  });

  if (isDocumentIntelligenceV3Enabled()) {
    try {
      const canonicalLayout = azureAnalyzeResultToCanonicalLayout(analyzeResult as any, {
        uploadedFileId: options.uploadedFileId ?? null,
        orgId: options.orgId ?? null,
        modelId: config.modelId,
        apiVersion: config.apiVersion,
      });
      const artifact = await buildCanonicalLayoutArtifact({
        layout: canonicalLayout,
        uploadedFileId: options.uploadedFileId ?? "unknown-uploaded-file",
        orgId: options.orgId ?? "unknown-org",
        generationId: options.generationId ?? null,
        azureModelId: config.modelId,
        azureApiVersion: config.apiVersion,
      });
      (doclingOutput as any)._canonical_layout_v3 = artifact.layout;
      (doclingOutput as any)._canonical_layout_v3_hash = artifact.hash;
      (doclingOutput as any)._canonical_layout_v3_schema_version = artifact.metadata.schemaVersion;
      (doclingOutput as any)._canonical_layout_v3_adapter_version = artifact.metadata.adapterVersion;
    } catch (error) {
      console.warn(
        "[parser] canonical_layout_v3 build failed; continuing legacy parse path: " +
        ((error as Error)?.message ?? error),
      );
      (doclingOutput as any)._canonical_layout_v3 = null;
      (doclingOutput as any)._canonical_layout_v3_hash = null;
    }
  }

  return doclingOutput;
}

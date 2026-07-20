// @ts-nocheck
/**
 * @deprecated Compatibility wrapper. Use ./document-ocr.ts for the Azure
 * Document Intelligence + OpenAI implementation.
 */
export {
  extractDocumentWithAzureAndOpenAI as extractDocumentWithVision,
  extractVisibleKeyValues,
  runDocumentOCR as runVisionOCR,
} from "./document-ocr.ts";
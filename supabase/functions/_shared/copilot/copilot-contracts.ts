// @ts-nocheck

export const COPILOT_SCHEMA_VERSION = "copilot-response-v1";
export const COPILOT_ALGORITHM_VERSION = "release11-grounded-copilot-v1";

export type CopilotScope = "lease" | "portfolio" | "field" | "amendment" | "workflow";
export type CopilotIntent = "lease_expiration_search" | "cam_cap_search" | "rent_change_explanation" | "current_field_value" | "amendment_explanation" | "executive_summary" | "blocked_review_explanation" | "unsupported";

export interface KnowledgeGraphNode {
  id: string;
  organizationId: string;
  nodeType: "canonical_field" | "semantic_record" | "reviewer_override" | "amendment_effect" | "portfolio_fact" | "workflow_state";
  key: string;
  value: unknown;
  status: "approved" | "reviewed" | "needs_review" | "stale";
  generationId: string | null;
  documentFamilyId: string | null;
  sourceDocumentId: string | null;
  amendmentSourceId: string | null;
  confidence: number | null;
  evidence: Array<{ id: string; documentId: string; page: number | null; text: string | null; sourceStatus?: string }>;
  metadata: Record<string, unknown>;
}

export interface CopilotGroundedAnswer {
  schemaVersion: string;
  answer: string;
  supported: boolean;
  confidence: number | null;
  citations: Array<Record<string, unknown>>;
  lineage: Record<string, unknown>;
  limitations: string[];
}
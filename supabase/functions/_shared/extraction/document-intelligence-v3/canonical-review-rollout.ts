// @ts-nocheck

import {
  isCanonicalReviewPayloadEnabled,
  isCanonicalReviewPayloadStrictEnabled,
} from "./feature-flag.ts";

export type CanonicalReviewRolloutMode = "legacy" | "shadow" | "canonical_hybrid" | "canonical_strict";
export type CanonicalReviewRolloutSource = "organization_config" | "environment" | "default";

export interface CanonicalReviewRolloutDecision {
  orgId: string | null;
  mode: CanonicalReviewRolloutMode;
  source: CanonicalReviewRolloutSource;
  uiAuthority: "legacy" | "canonical";
  builderSourceMode: "legacy" | "canonical_hybrid" | "canonical_strict";
  strict: boolean;
  diagnostics: {
    configuredMode: CanonicalReviewRolloutMode | null;
    environmentMode: CanonicalReviewRolloutMode | null;
    reasonCodes: string[];
  };
}

export interface EnvLike {
  get(key: string): string | undefined;
}

const MODES = new Set(["legacy", "shadow", "canonical_hybrid", "canonical_strict"]);

export function normalizeCanonicalReviewRolloutMode(value: unknown): CanonicalReviewRolloutMode | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/-/g, "_");
  if (normalized === "hybrid") return "canonical_hybrid";
  if (normalized === "strict") return "canonical_strict";
  if (MODES.has(normalized)) return normalized as CanonicalReviewRolloutMode;
  return null;
}

function envRolloutMode(env: EnvLike): CanonicalReviewRolloutMode | null {
  const explicit = normalizeCanonicalReviewRolloutMode(env.get("CANONICAL_REVIEW_ROLLOUT_MODE"));
  if (explicit) return explicit;
  const shadow = String(env.get("ENABLE_CANONICAL_REVIEW_PAYLOAD_SHADOW") ?? "").trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(shadow)) return "shadow";
  if (!isCanonicalReviewPayloadEnabled(env)) return null;
  return isCanonicalReviewPayloadStrictEnabled(env) ? "canonical_strict" : "canonical_hybrid";
}

export function resolveCanonicalReviewRollout(args: {
  orgId?: string | null;
  organizationConfig?: { mode?: string | null; enabled?: boolean | null; document_family?: string | null } | null;
  env?: EnvLike;
} = {}): CanonicalReviewRolloutDecision {
  const env = args.env ?? Deno.env;
  const reasonCodes: string[] = [];
  const configuredMode = args.organizationConfig?.enabled === false ? "legacy" : normalizeCanonicalReviewRolloutMode(args.organizationConfig?.mode);
  const environmentMode = envRolloutMode(env);

  let mode: CanonicalReviewRolloutMode = "legacy";
  let source: CanonicalReviewRolloutSource = "default";

  if (configuredMode) {
    mode = configuredMode;
    source = "organization_config";
  } else if (environmentMode) {
    mode = environmentMode;
    source = "environment";
  } else {
    reasonCodes.push("legacy_default_for_unconfigured_organization");
  }

  if (mode === "canonical_strict" && source === "default") {
    mode = "legacy";
    reasonCodes.push("strict_requires_explicit_configuration");
  }

  return {
    orgId: args.orgId ?? null,
    mode,
    source,
    uiAuthority: mode === "canonical_hybrid" || mode === "canonical_strict" ? "canonical" : "legacy",
    builderSourceMode: mode === "canonical_strict" ? "canonical_strict" : mode === "canonical_hybrid" || mode === "shadow" ? "canonical_hybrid" : "legacy",
    strict: mode === "canonical_strict",
    diagnostics: {
      configuredMode,
      environmentMode,
      reasonCodes,
    },
  };
}

export async function fetchCanonicalReviewRolloutConfig(args: {
  supabaseAdmin: any;
  orgId: string;
  documentFamily?: string | null;
}): Promise<Record<string, unknown> | null> {
  try {
    const family = args.documentFamily ?? null;
    let query = args.supabaseAdmin
      .from("canonical_review_rollout_configs")
      .select("mode, enabled, document_family, reason, updated_at")
      .eq("org_id", args.orgId)
      .eq("enabled", true);

    if (family) {
      query = query.or(`document_family.eq.${family},document_family.eq.default,document_family.is.null`);
    }

    const { data, error } = await query.order("document_family", { ascending: true }).limit(10);
    if (error) {
      console.warn(`[canonical-review-rollout] config unavailable; falling back to default rollout: ${error.message}`);
      return null;
    }
    const rows = Array.isArray(data) ? data : [];
    return rows.find((row: any) => family && row.document_family === family) ?? rows.find((row: any) => row.document_family == null || row.document_family === "default") ?? null;
  } catch (error: any) {
    console.warn(`[canonical-review-rollout] config read threw; falling back to default rollout: ${error?.message ?? error}`);
    return null;
  }
}

export async function resolveCanonicalReviewRolloutForOrg(args: {
  supabaseAdmin: any;
  orgId: string;
  documentFamily?: string | null;
  env?: EnvLike;
}): Promise<CanonicalReviewRolloutDecision> {
  const organizationConfig = await fetchCanonicalReviewRolloutConfig(args);
  return resolveCanonicalReviewRollout({ orgId: args.orgId, organizationConfig, env: args.env });
}

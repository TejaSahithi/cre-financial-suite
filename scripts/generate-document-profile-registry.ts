// @ts-nocheck
/**
 * P3.1 — generates the deterministic SQL snapshot of the TS document
 * profile registry (supabase/functions/_shared/extraction/document-package/
 * profile-registry.ts) for insertion into
 * lease_document_profile_registry_versions / lease_document_profiles.
 *
 * Mirrors scripts/generate-lease-claim-registry-snapshot.ts exactly. Run
 * whenever profile-registry.ts changes, and paste the emitted SQL into a
 * new additive migration.
 *
 * Usage: deno run --allow-read scripts/generate-document-profile-registry.ts
 */
import { DOCUMENT_PROFILES, computeDocumentProfileRegistryHash } from "../supabase/functions/_shared/extraction/document-package/profile-registry.ts";
import { DOCUMENT_PROFILE_REGISTRY_VERSION } from "../supabase/functions/_shared/extraction/document-package/profile-registry-version.ts";

function sqlString(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlStringArray(values) {
  if (!values || values.length === 0) return "'{}'";
  const escaped = values.map((v) => String(v).replace(/"/g, '\\"'));
  return `'{${escaped.map((v) => `"${v}"`).join(",")}}'`;
}

async function main() {
  const registryHash = await computeDocumentProfileRegistryHash();

  const lines = [];
  lines.push(`INSERT INTO public.lease_document_profile_registry_versions (registry_version, registry_hash) VALUES`);
  lines.push(`  (${sqlString(DOCUMENT_PROFILE_REGISTRY_VERSION)}, ${sqlString(registryHash)});`);
  lines.push("");
  lines.push(`INSERT INTO public.lease_document_profiles`);
  lines.push(`  (registry_version, profile_key, display_name, allowed_relationship_roles, supports_segmentation, expected_claim_signals, permitted_override_domains, requires_base_document, introduced_in)`);
  lines.push(`VALUES`);

  const rows = DOCUMENT_PROFILES.map((p) => {
    const values = [
      sqlString(DOCUMENT_PROFILE_REGISTRY_VERSION),
      sqlString(p.profileKey),
      sqlString(p.displayName),
      sqlStringArray(p.allowedRelationshipRoles),
      p.supportsSegmentation ? "true" : "false",
      sqlStringArray(p.expectedClaimSignals),
      sqlStringArray(p.permittedOverrideDomains),
      p.requiresBaseDocument ? "true" : "false",
      sqlString(p.introducedIn),
    ];
    return `  (${values.join(", ")})`;
  });

  lines.push(rows.join(",\n") + ";");

  console.log(lines.join("\n"));
  console.error(`-- generated ${DOCUMENT_PROFILES.length} profile rows for registry_version=${DOCUMENT_PROFILE_REGISTRY_VERSION}, hash=${registryHash}`);
}

await main();

// @ts-nocheck
/**
 * P2.1 — generates the deterministic SQL snapshot of the TS claim concept
 * registry (supabase/functions/_shared/extraction/claims/concept-registry.ts)
 * for insertion into lease_claim_registry_versions / lease_claim_concepts.
 *
 * The TS registry is the authoring source; this script's output is a
 * generated artifact, never a second independently-maintained registry
 * (round-2 external review correction #1). Run it whenever the TS registry
 * changes, and paste the emitted SQL into the next additive migration.
 *
 * Usage: deno run --allow-read scripts/generate-lease-claim-registry-snapshot.ts
 */
import {
  CLAIM_CONCEPTS,
  computeRegistryHash,
} from "../supabase/functions/_shared/extraction/claims/concept-registry.ts";
import { CLAIMS_REGISTRY_VERSION } from "../supabase/functions/_shared/extraction/claims/registry-version.ts";

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
  const registryHash = await computeRegistryHash();

  const lines = [];
  lines.push(`INSERT INTO public.lease_claim_registry_versions (registry_version, registry_hash) VALUES`);
  lines.push(`  (${sqlString(CLAIMS_REGISTRY_VERSION)}, ${sqlString(registryHash)});`);
  lines.push("");
  lines.push(`INSERT INTO public.lease_claim_concepts`);
  lines.push(`  (registry_version, concept_key, domain, value_type, cardinality, instance_strategy, evidence_required, projection_field_key, compatibility_section, aliases, normalization_strategy, comparison_strategy, active, introduced_in)`);
  lines.push(`VALUES`);

  const rows = CLAIM_CONCEPTS.map((c) => {
    const values = [
      sqlString(CLAIMS_REGISTRY_VERSION),
      sqlString(c.conceptKey),
      sqlString(c.domain),
      sqlString(c.valueType),
      sqlString(c.cardinality),
      sqlString(c.instanceStrategy),
      c.evidenceRequired ? "true" : "false",
      c.projectionFieldKey ? sqlString(c.projectionFieldKey) : "NULL",
      c.compatibilitySection ? sqlString(c.compatibilitySection) : "NULL",
      sqlStringArray(c.aliases),
      sqlString(c.normalizationStrategy),
      sqlString(c.comparisonStrategy),
      c.active ? "true" : "false",
      sqlString(c.introducedIn),
    ];
    return `  (${values.join(", ")})`;
  });

  lines.push(rows.join(",\n") + ";");

  console.log(lines.join("\n"));
  console.error(`-- generated ${CLAIM_CONCEPTS.length} concept rows for registry_version=${CLAIMS_REGISTRY_VERSION}, hash=${registryHash}`);
}

await main();

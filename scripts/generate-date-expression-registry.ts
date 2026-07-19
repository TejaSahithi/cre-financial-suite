// @ts-nocheck
/**
 * P4.1 - generates the deterministic SQL snapshot of the TS date-expression
 * registry for insertion into lease_date_expression_registry_versions /
 * lease_date_expression_types.
 *
 * Usage: deno run --allow-read scripts/generate-date-expression-registry.ts
 */
import { DATE_EXPRESSION_TYPES, computeDateExpressionRegistryHash } from "../supabase/functions/_shared/extraction/lease-financial-schedule/date-expressions/date-expression-registry.ts";
import { DATE_EXPRESSION_REGISTRY_VERSION } from "../supabase/functions/_shared/extraction/lease-financial-schedule/date-expressions/date-expression-registry-version.ts";

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
  const registryHash = await computeDateExpressionRegistryHash();

  const lines = [];
  lines.push("INSERT INTO public.lease_date_expression_registry_versions (registry_version, registry_hash) VALUES");
  lines.push(`  (${sqlString(DATE_EXPRESSION_REGISTRY_VERSION)}, ${sqlString(registryHash)});`);
  lines.push("");
  lines.push("INSERT INTO public.lease_date_expression_types");
  lines.push("  (registry_version, expression_type, display_name, description, required_components, allowed_anchor_types, operands_permitted, offsets_permitted, recurrence_permitted, requires_dependency_processing, fixed_resolved_date_permitted, validation_rules, introduced_in)");
  lines.push("VALUES");

  const rows = DATE_EXPRESSION_TYPES.map((entry) => {
    const values = [
      sqlString(DATE_EXPRESSION_REGISTRY_VERSION),
      sqlString(entry.expressionType),
      sqlString(entry.displayName),
      sqlString(entry.description),
      sqlStringArray(entry.requiredComponents),
      sqlStringArray(entry.allowedAnchorTypes),
      entry.operandsPermitted ? "true" : "false",
      entry.offsetsPermitted ? "true" : "false",
      entry.recurrencePermitted ? "true" : "false",
      entry.requiresDependencyProcessing ? "true" : "false",
      entry.fixedResolvedDatePermitted ? "true" : "false",
      sqlStringArray(entry.validationRules),
      sqlString(entry.introducedIn),
    ];
    return `  (${values.join(", ")})`;
  });

  lines.push(rows.join(",\n") + ";");

  console.log(lines.join("\n"));
  console.error(`-- generated ${DATE_EXPRESSION_TYPES.length} date-expression rows for registry_version=${DATE_EXPRESSION_REGISTRY_VERSION}, hash=${registryHash}`);
}

await main();

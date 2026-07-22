#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const migration = await readFile("supabase/migrations/20260860000000_document_semantics_release6.sql", "utf8");
const tables = [
  "document_definitions",
  "document_cross_references",
  "document_family_members",
  "document_amendment_effects",
  "document_semantic_search_records",
  "document_semantic_review_resolutions",
  "document_semantic_rollout_configs",
];
const failures = [];
for (const table of tables) {
  if (!migration.includes(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`)) failures.push(`${table}: RLS not enabled`);
  if (!migration.includes(table) || !migration.includes("organization_id")) failures.push(`${table}: organization_id policy surface missing`);
}
if (!migration.includes("auth.uid()") && !migration.includes("public.get_my_org_ids")) failures.push("No organization-scoped policy helper detected");
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`Release 7 tenant-isolation static check passed for ${tables.length} semantic tables.`);
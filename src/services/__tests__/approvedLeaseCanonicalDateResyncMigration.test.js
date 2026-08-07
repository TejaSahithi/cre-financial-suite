import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20269900000050_resync_approved_lease_canonical_dates_from_evidence.sql",
);

describe("approved lease canonical date resync migration", () => {
  const sql = readFileSync(migrationPath, "utf8");

  it("reads approved lease dates from approved snapshot, field reviews, and extraction payloads", () => {
    expect(sql).toContain("ARRAY['approved', v_key]");
    expect(sql).toContain("ARRAY['field_reviews', v_key]");
    expect(sql).toContain("ARRAY['workflow_output', 'lease_fields', v_key]");
    expect(sql).toContain("NEW.extraction_data");
    expect(sql).toContain("NEW.extracted_fields");
  });

  it("still refuses unresolved natural-language dates", () => {
    expect(sql).toContain("v_value !~ '^\\d{4}-\\d{2}-\\d{2}$'");
  });

  it("re-triggers approved leases so existing rows are re-synced generically", () => {
    expect(sql).toContain("BEFORE INSERT OR UPDATE OF status, abstract_status, abstract_snapshot, extraction_data, extracted_fields");
    expect(sql).toContain("UPDATE public.leases");
    expect(sql).toContain("SET abstract_snapshot = COALESCE(abstract_snapshot, '{}'::jsonb)");
    expect(sql).toContain("COALESCE(abstract_status, '') = 'approved'");
  });
});

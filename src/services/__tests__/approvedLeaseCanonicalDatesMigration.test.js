import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20269900000041_approved_lease_canonical_dates.sql",
);

describe("approved lease canonical date migration", () => {
  const sql = readFileSync(migrationPath, "utf8");

  it("syncs approved commencement and expiration dates to both canonical column pairs", () => {
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.sync_approved_lease_canonical_dates()");
    expect(sql).toContain("NEW.commencement_date := v_commencement;");
    expect(sql).toContain("NEW.start_date := v_commencement;");
    expect(sql).toContain("NEW.expiration_date := v_expiration;");
    expect(sql).toContain("NEW.end_date := v_expiration;");
  });

  it("uses only approved snapshot values and does not parse unresolved natural-language dates", () => {
    expect(sql).toContain("p_snapshot #> ARRAY['approved', v_key]");
    expect(sql).toContain("v_status NOT IN ('accepted', 'edited', 'approved', 'reviewed')");
    expect(sql).toContain("v_value !~ '^\\d{4}-\\d{2}-\\d{2}$'");
  });

  it("runs automatically on approved lease persistence", () => {
    expect(sql).toContain("CREATE TRIGGER tr_sync_approved_lease_canonical_dates");
    expect(sql).toContain("BEFORE INSERT OR UPDATE OF status, abstract_status, abstract_snapshot");
    expect(sql).toContain("EXECUTE FUNCTION public.sync_approved_lease_canonical_dates()");
  });
});

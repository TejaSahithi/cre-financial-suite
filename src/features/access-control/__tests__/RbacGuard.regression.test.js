import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(
  path.resolve(process.cwd(), "src/features/access-control/RbacGuard.jsx"),
  "utf8",
);

describe("RbacGuard mandatory setup page access", () => {
  it("bypasses page permissions for mandatory authenticated setup pages", () => {
    expect(source).toMatch(/MANDATORY_SETUP_PAGES/);
    expect(source).toMatch(
      /PUBLIC_PAGES\.includes\(pageName\)\s*\|\|\s*MANDATORY_SETUP_PAGES\.includes\(pageName\)/,
    );
  });
});

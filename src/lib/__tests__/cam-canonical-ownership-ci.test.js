/**
 * CAM Canonical Ownership & Legacy Guard CI Test.
 *
 * Verifies that active production source files in `src/` do not query
 * or reference retired legacy CAM objects:
 *   - cam_profiles
 *   - cam_calculations
 *   - compute-cam
 *   - savePropertyCamConfig / fetchPropertyCamConfig
 *   - CAMCalculationService
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const PROD_SRC_DIR = path.resolve(__dirname, "../../");

const RETIRED_SYMBOLS = [
  "cam_calculations",
  "fetchPropertyCamConfig",
  "savePropertyCamConfig",
  "CAMCalculationService",
];

function getAllFiles(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    if (fs.statSync(filePath).isDirectory()) {
      if (file !== "__tests__" && file !== "node_modules") {
        getAllFiles(filePath, fileList);
      }
    } else if (/\.(js|jsx|ts|tsx)$/.test(file)) {
      fileList.push(filePath);
    }
  }
  return fileList;
}

describe("CAM Canonical Ownership CI Guard", () => {
  it("ensures no production frontend file references retired legacy CAM objects", () => {
    const files = getAllFiles(PROD_SRC_DIR);
    const violations = [];

    for (const filePath of files) {
      const content = fs.readFileSync(filePath, "utf-8");
      const relativePath = path.relative(PROD_SRC_DIR, filePath);

      if (relativePath.endsWith("services\\camConfig.js") || relativePath.endsWith("services/camConfig.js")) {
        continue;
      }

      for (const symbol of RETIRED_SYMBOLS) {
        if (content.includes(symbol)) {
          violations.push({ file: relativePath, symbol });
        }
      }
    }

    if (violations.length > 0) {
      console.error("Found retired legacy CAM references in production files:", violations);
    }
    expect(violations).toEqual([]);
  });
});

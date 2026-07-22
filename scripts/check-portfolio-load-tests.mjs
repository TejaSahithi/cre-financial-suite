import fs from "node:fs";
const required = [
  "load-tests/portfolio-summary.js",
  "load-tests/portfolio-critical-dates.js",
  "load-tests/portfolio-search.js",
  "load-tests/rent-roll-reconciliation.js"
];
const missing = required.filter((file) => !fs.existsSync(file));
if (missing.length) {
  console.error(`Missing Release 8 load tests: ${missing.join(", ")}`);
  process.exit(1);
}
for (const file of required) {
  const text = fs.readFileSync(file, "utf8");
  for (const token of ["options", "thresholds", "organization", "portfolio"]) {
    if (!text.includes(token)) {
      console.error(`${file} missing ${token}`);
      process.exit(1);
    }
  }
}
console.log(`Release 8 portfolio load-test definitions present: ${required.length}`);

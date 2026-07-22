#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { normalizeBenchmarkArtifact } from "./lease-intelligence-benchmark-lib.mjs";

const [input, output] = process.argv.slice(2);
if (!input) {
  console.error("Usage: node scripts/normalize-benchmark-artifact.mjs <input.json> [output.json]");
  process.exit(1);
}
const artifact = JSON.parse(await readFile(input, "utf8"));
const normalized = `${JSON.stringify(normalizeBenchmarkArtifact(artifact), null, 2)}\n`;
if (output) await writeFile(output, normalized);
else process.stdout.write(normalized);
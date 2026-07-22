#!/usr/bin/env node
import fs from "node:fs";
const files = ["ingestion-scale", "review-endurance", "portfolio-large-scale", "event-throughput", "webhook-backlog", "api-rate-limit", "export-scale"].map((name) => `load-tests/release10/${name}.js`);
const missing = files.filter((file) => !fs.existsSync(file));
console.log(JSON.stringify({ schemaVersion: "release-10-load-test-inventory-v1", status: missing.length ? "not_ready" : "ready", missing }, null, 2));
if (missing.length) process.exitCode = 1;
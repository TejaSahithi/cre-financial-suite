#!/usr/bin/env node
import fs from "node:fs";
const requiredFiles = [
  "supabase/functions/_shared/copilot/copilot-contracts.ts",
  "supabase/functions/_shared/copilot/intent-parser.ts",
  "supabase/functions/_shared/copilot/retrieval-engine.ts",
  "supabase/functions/_shared/copilot/prompt-builder.ts",
  "supabase/functions/_shared/copilot/citation-builder.ts",
  "supabase/functions/_shared/copilot/answer-validator.ts",
  "supabase/functions/_shared/copilot/hallucination-checker.ts",
  "supabase/functions/_shared/copilot/copilot-orchestrator.ts",
  "docs/release-11-copilot-readiness.md",
  "src/components/copilot/GroundedCopilotPanel.jsx",
];
const requiredTests = [
  "release11-intent-parser.test.ts",
  "release11-retrieval-engine.test.ts",
  "release11-prompt-builder.test.ts",
  "release11-citation-builder.test.ts",
  "release11-answer-validator.test.ts",
  "release11-hallucination-checker.test.ts",
  "release11-copilot-orchestrator.test.ts",
].map((name) => `supabase/functions/_tests/${name}`);
const requiredFlags = ["ENABLE_COPILOT_RELEASE11", "ENABLE_COPILOT_LEASE_QA", "ENABLE_COPILOT_PORTFOLIO_QA", "ENABLE_COPILOT_EXECUTIVE_SUMMARIES", "ENABLE_COPILOT_WORKFLOW_ASSIST", "ENABLE_COPILOT_GROUNDED_PROMPTS", "ENABLE_COPILOT_HALLUCINATION_CHECKS"];
function read(file) { return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""; }
const missingFiles = [...requiredFiles, ...requiredTests].filter((file) => !fs.existsSync(file));
const flags = read("supabase/functions/_shared/extraction/document-intelligence-v3/feature-flag.ts");
const missingFlags = requiredFlags.filter((flag) => !flags.includes(flag));
const failingGates = [];
if (missingFiles.length) failingGates.push("release11_files_missing");
if (missingFlags.length) failingGates.push("release11_flags_missing");
const status = failingGates.length ? "not_ready" : "ready_for_grounded_copilot_review";
console.log(JSON.stringify({ schemaVersion: "release-11-copilot-readiness-check-v1", status, missingFiles, missingFlags, failingGates, note: status === "not_ready" ? "Release 11 remains gated until grounding controls are restored." : "Copilot controls are present; production activation still requires OpenAI provider review and human signoff." }, null, 2));
if (status !== "ready_for_grounded_copilot_review") process.exitCode = 1;
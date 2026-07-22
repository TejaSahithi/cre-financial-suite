// @ts-nocheck
import { COPILOT_ALGORITHM_VERSION } from "./copilot-contracts.ts";
import { selectEvidence } from "./retrieval-engine.ts";

export function buildCopilotPrompt(args) {
  const evidence = selectEvidence(args.nodes || []);
  if (!args.nodes?.length || !evidence.length) return { prompt: null, evidence, reasonCodes: ["insufficient_grounding"] };
  const facts = args.nodes.map((node) => ({ id: node.id, type: node.nodeType, key: node.key, value: node.value, status: node.status, confidence: node.confidence, generationId: node.generationId }));
  const prompt = JSON.stringify({ algorithmVersion: COPILOT_ALGORITHM_VERSION, instruction: "Answer only from provided facts. If unsupported, say the information is unavailable in reviewed canonical data.", question: args.question, intent: args.intent, facts, evidence }, null, 2);
  return { prompt, evidence, reasonCodes: ["prompt_built_from_grounded_facts"] };
}
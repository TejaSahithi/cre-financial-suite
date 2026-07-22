// @ts-nocheck
import { parseCopilotIntent } from "./intent-parser.ts";
import { retrieveKnowledgeGraph } from "./retrieval-engine.ts";
import { buildCopilotPrompt } from "./prompt-builder.ts";
import { validateCopilotAnswer, unsupportedAnswer } from "./answer-validator.ts";
import { checkForHallucination } from "./hallucination-checker.ts";

export function buildGroundedCopilotResponse(args) {
  const intent = parseCopilotIntent(args.question, args.scope);
  if (intent.intent === "unsupported") return unsupportedAnswer(intent.reasonCodes);
  const retrieval = retrieveKnowledgeGraph({ ...args, intent: intent.intent });
  if (retrieval.blocked || !retrieval.nodes.length) return unsupportedAnswer(retrieval.reasonCodes);
  const prompt = buildCopilotPrompt({ question: intent.normalizedQuestion, intent: intent.intent, nodes: retrieval.nodes });
  if (!prompt.prompt) return unsupportedAnswer(prompt.reasonCodes);
  const draftAnswer = args.draftAnswer || `Grounded answer for ${intent.intent} using ${retrieval.nodes.length} reviewed fact(s).`;
  const hallucination = checkForHallucination(draftAnswer, retrieval.nodes);
  if (!hallucination.passed) return unsupportedAnswer(hallucination.reasonCodes);
  return validateCopilotAnswer({ answer: draftAnswer, nodes: retrieval.nodes });
}
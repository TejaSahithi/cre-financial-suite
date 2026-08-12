// @ts-nocheck
/**
 * response-shaper.ts — grounding + leakage guard applied to the model's
 * "final" turn before it's returned to the client (sections 21-22, 6, 29).
 *
 * Consolidates what the spec describes as separate citation-builder /
 * lineage-builder / response-validator / leakage-validator files: in this
 * V1 they're one small, focused pass over the turn history rather than four
 * near-empty modules, since all four only need the same input (the tool
 * calls made this turn) to do their job.
 *
 * The one guard that matters most: a "final" answer citing a dollar figure
 * MUST be backed by at least one successfully-authorized business-data tool
 * call this turn. Without that, the answer is either hallucinated or (in a
 * prompt-injection attempt — section 28 scenario K) the model trying to
 * comply with an instruction embedded in the user's message rather than
 * with a real, authorized retrieval. Either way it's suppressed here,
 * server-side — never left to the model's own restraint.
 */
import type { AssistantCitation, AssistantNavigationAction, AssistantResponseStatus } from "../assistant-contracts.ts";
import type { ToolBrokerOutcome } from "../tools/tool-broker.ts";

export interface ShapedFinalResponse {
  status: AssistantResponseStatus;
  answer: string;
  citations: AssistantCitation[];
  navigation: AssistantNavigationAction[];
  limitations: string[];
}

const DOLLAR_FIGURE_RE = /\$\s?\d[\d,]*(\.\d+)?/;

export function shapeFinalResponse(
  finalDecision: { status: AssistantResponseStatus; answer: string; citations: AssistantCitation[]; navigation: AssistantNavigationAction[]; limitations: string[] },
  toolOutcomes: ToolBrokerOutcome[],
): ShapedFinalResponse {
  const groundedBusinessDataCall = toolOutcomes.some(
    (o) => o.authorized && o.result?.status === "answered",
  );

  const toolCitations = toolOutcomes.flatMap((o) => o.result?.citations ?? []);
  const toolNavigation = toolOutcomes.flatMap((o) => o.result?.navigation ?? []);
  const toolLimitations = toolOutcomes.flatMap((o) => (o.result as any)?.limitations ?? []);

  const mergedCitations = dedupeByLabel([...(finalDecision.citations ?? []), ...toolCitations]);
  const mergedNavigation = dedupeByLabel([...(finalDecision.navigation ?? []), ...toolNavigation]);
  const mergedLimitations = [...new Set([...(finalDecision.limitations ?? []), ...toolLimitations])];

  if (finalDecision.status === "answered" && DOLLAR_FIGURE_RE.test(finalDecision.answer) && !groundedBusinessDataCall) {
    return {
      status: "insufficient_evidence",
      answer:
        "I don't have a verified, authorized data source for that figure, so I won't state a number I can't back up. I can explain how this is calculated in the platform, or you can try a more specific question referencing a property, lease, or run.",
      citations: [],
      navigation: mergedNavigation,
      limitations: ["Suppressed an unverified financial figure with no grounded tool result backing it."],
    };
  }

  return {
    status: finalDecision.status,
    answer: finalDecision.answer,
    citations: mergedCitations,
    navigation: mergedNavigation,
    limitations: mergedLimitations,
  };
}

function dedupeByLabel<T extends { label: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item.label)) continue;
    seen.add(item.label);
    out.push(item);
  }
  return out;
}

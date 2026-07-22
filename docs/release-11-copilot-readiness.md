# Release 11 Copilot Readiness

Release 11 introduces an explainable AI copilot over reviewed canonical and portfolio data. The copilot is not a system of record and must never invent lease facts.

Grounding requirements:

- retrieve from approved or reviewed canonical fields, semantic records, reviewer overrides, amendment effects, workflow state, and portfolio facts;
- reject stale generations;
- enforce organization-scoped permissions before retrieval;
- build prompts from selected facts and evidence only;
- include citations, lineage, confidence, reviewer status, amendment source, and document family;
- return transparent limitations when evidence is missing;
- run hallucination checks before returning an answer.

UI surfaces:

- Ask about this lease;
- Ask about this portfolio;
- Explain this field;
- Explain this amendment;
- Show evidence;
- Generate executive summary.

Activation gates:

- `npm run check:release11-readiness`
- `deno test --no-check --fail-fast supabase/functions/_tests/release11-*.test.ts`
- Releases 1-10 regression slices remain green.

Production use still requires OpenAI provider review, security signoff, and organization-scoped rollout approval.
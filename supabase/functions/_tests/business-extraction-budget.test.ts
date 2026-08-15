// @ts-nocheck
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { __test__ } from "../_shared/extraction/business-extraction-orchestrator.ts";

function withEnv(name: string, value: string | undefined, fn: () => void) {
  const previous = Deno.env.get(name);
  try {
    if (value === undefined) Deno.env.delete(name);
    else Deno.env.set(name, value);
    fn();
  } finally {
    if (previous === undefined) Deno.env.delete(name);
    else Deno.env.set(name, previous);
  }
}

Deno.test("lease OpenAI total budget defaults near the Edge-safe ceiling", () => {
  withEnv("LEASE_OPENAI_TOTAL_BUDGET_MS", undefined, () => {
    assertEquals(__test__.openAiTotalBudgetMs(), 140_000);
  });
});

Deno.test("lease OpenAI total budget env override is bounded", () => {
  withEnv("LEASE_OPENAI_TOTAL_BUDGET_MS", "145000", () => {
    assertEquals(__test__.openAiTotalBudgetMs(), 145_000);
  });
  withEnv("LEASE_OPENAI_TOTAL_BUDGET_MS", "300000", () => {
    assertEquals(__test__.openAiTotalBudgetMs(), 145_000);
  });
  withEnv("LEASE_OPENAI_TOTAL_BUDGET_MS", "1000", () => {
    assertEquals(__test__.openAiTotalBudgetMs(), 60_000);
  });
});

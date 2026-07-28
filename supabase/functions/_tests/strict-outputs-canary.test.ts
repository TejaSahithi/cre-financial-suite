// @ts-nocheck
// Strict Structured Outputs pilot — canary gate tests.
//
// Covers shouldRunStrictOutputsShadow's flag + org-allowlist + sample-rate
// logic in isolation, using the injectable EnvLike convention every other
// mode flag in this codebase already follows (no real Deno.env mutation
// needed).

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  getLeaseStrictOutputsMode,
  isLeaseStrictOutputsActive,
  shouldRunStrictOutputsShadow,
} from "../_shared/extraction/openai-fact-ledger/llm-strict-outputs-mode.ts";

function fakeEnv(vars: Record<string, string>) {
  return { get: (key: string) => vars[key] };
}

// ── Flag itself ───────────────────────────────────────────────────────────

Deno.test("getLeaseStrictOutputsMode: unset resolves to off (opposite default from LLM_PRIMARY_MAPPING_MODE)", () => {
  assertEquals(getLeaseStrictOutputsMode(fakeEnv({})), "off");
});

Deno.test("getLeaseStrictOutputsMode: an unrecognized value also resolves to off, not thrown", () => {
  assertEquals(getLeaseStrictOutputsMode(fakeEnv({ LEASE_STRICT_OUTPUTS_V1: "yes-please" })), "off");
});

Deno.test("isLeaseStrictOutputsActive: true only when explicitly 'active'", () => {
  assert(!isLeaseStrictOutputsActive(fakeEnv({})));
  assert(isLeaseStrictOutputsActive(fakeEnv({ LEASE_STRICT_OUTPUTS_V1: "active" })));
});

// ── Canary gate ───────────────────────────────────────────────────────────

Deno.test("shouldRunStrictOutputsShadow: false whenever the top-level flag is off, regardless of allowlist/sample-rate", () => {
  const env = fakeEnv({
    LEASE_STRICT_OUTPUTS_ORG_ALLOWLIST: "org-1",
    LEASE_STRICT_OUTPUTS_SAMPLE_RATE: "1",
  });
  assert(!shouldRunStrictOutputsShadow({ orgId: "org-1", generationId: "gen-1" }, env));
});

Deno.test("shouldRunStrictOutputsShadow: org on the allowlist -> true regardless of sample rate", () => {
  const env = fakeEnv({
    LEASE_STRICT_OUTPUTS_V1: "active",
    LEASE_STRICT_OUTPUTS_ORG_ALLOWLIST: "org-1, org-2",
    LEASE_STRICT_OUTPUTS_SAMPLE_RATE: "0",
  });
  assert(shouldRunStrictOutputsShadow({ orgId: "org-1", generationId: "gen-1" }, env));
  assert(shouldRunStrictOutputsShadow({ orgId: "org-2", generationId: "gen-2" }, env));
});

Deno.test("shouldRunStrictOutputsShadow: org not on the allowlist and no sample rate set -> false", () => {
  const env = fakeEnv({
    LEASE_STRICT_OUTPUTS_V1: "active",
    LEASE_STRICT_OUTPUTS_ORG_ALLOWLIST: "org-1",
  });
  assert(!shouldRunStrictOutputsShadow({ orgId: "org-99", generationId: "gen-1" }, env));
});

Deno.test("shouldRunStrictOutputsShadow: sample rate 0 -> always false for a non-allowlisted org", () => {
  const env = fakeEnv({ LEASE_STRICT_OUTPUTS_V1: "active", LEASE_STRICT_OUTPUTS_SAMPLE_RATE: "0" });
  for (let i = 0; i < 20; i++) {
    assert(!shouldRunStrictOutputsShadow({ orgId: "org-x", generationId: `gen-${i}` }, env));
  }
});

Deno.test("shouldRunStrictOutputsShadow: sample rate 1 -> always true", () => {
  const env = fakeEnv({ LEASE_STRICT_OUTPUTS_V1: "active", LEASE_STRICT_OUTPUTS_SAMPLE_RATE: "1" });
  for (let i = 0; i < 20; i++) {
    assert(shouldRunStrictOutputsShadow({ orgId: "org-x", generationId: `gen-${i}` }, env));
  }
});

Deno.test("shouldRunStrictOutputsShadow: deterministic on generation_id -- same input always yields the same decision", () => {
  const env = fakeEnv({ LEASE_STRICT_OUTPUTS_V1: "active", LEASE_STRICT_OUTPUTS_SAMPLE_RATE: "0.5" });
  const first = shouldRunStrictOutputsShadow({ orgId: "org-x", generationId: "gen-stable-id" }, env);
  for (let i = 0; i < 10; i++) {
    assertEquals(shouldRunStrictOutputsShadow({ orgId: "org-x", generationId: "gen-stable-id" }, env), first);
  }
});

Deno.test("shouldRunStrictOutputsShadow: a fixed sample rate produces a mixed, roughly-proportionate set of decisions across many generation IDs", () => {
  const env = fakeEnv({ LEASE_STRICT_OUTPUTS_V1: "active", LEASE_STRICT_OUTPUTS_SAMPLE_RATE: "0.5" });
  let admitted = 0;
  const total = 500;
  for (let i = 0; i < total; i++) {
    if (shouldRunStrictOutputsShadow({ orgId: "org-x", generationId: `generation-${i}` }, env)) admitted++;
  }
  assert(admitted > total * 0.3 && admitted < total * 0.7, `expected roughly half of ${total} generations admitted at sample_rate=0.5, got ${admitted}`);
});

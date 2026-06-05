/**
 * Tests for the runWithConcurrency bounded-parallelism helper.
 *
 * The helper lives in supabase/functions/_shared/extraction/llm-extractor.ts
 * (a Deno module not importable by Vitest directly).  We replicate the
 * algorithm here so the test suite stays in the Vite/Vitest boundary while
 * fully exercising the contract the production code relies on.
 *
 * CONTRACT:
 *   1. At most `limit` workers run simultaneously.
 *   2. Output array is in the same order as the input array.
 *   3. A failing worker does not cancel or skip other workers.
 *   4. The concurrency default is 3; env var LLM_GROUP_CONCURRENCY overrides it
 *      (capped at MAX_ALLOWED_CONCURRENCY = 3).
 */

import { describe, it, expect } from "vitest";

// ── Pure copy of the production algorithm ────────────────────────────────────
// Keep in sync with supabase/functions/_shared/extraction/llm-extractor.ts

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runLane() {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      try {
        results[idx] = { status: "fulfilled", value: await worker(items[idx], idx) };
      } catch (err) {
        results[idx] = { status: "rejected", reason: err };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => runLane()),
  );
  return results;
}

const MAX_ALLOWED_CONCURRENCY = 3;

function resolveConcurrencyLimit(envValue) {
  if (!envValue) return MAX_ALLOWED_CONCURRENCY;
  const parsed = parseInt(envValue, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return MAX_ALLOWED_CONCURRENCY;
  return Math.min(parsed, MAX_ALLOWED_CONCURRENCY);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns a worker that takes `delayMs` and resolves with `value`. */
function makeDelayedWorker(delayMs, value) {
  return () => new Promise((resolve) => setTimeout(() => resolve(value), delayMs));
}

/** Returns a worker that takes `delayMs` and then rejects with `message`. */
function makeFailingWorker(delayMs, message) {
  return () =>
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(message)), delayMs),
    );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runWithConcurrency", () => {
  describe("concurrency limit is respected", () => {
    it("never runs more than `limit` workers simultaneously", async () => {
      let active = 0;
      let maxObserved = 0;
      const LIMIT = 2;
      const ITEMS = [1, 2, 3, 4, 5];

      const worker = (_item) =>
        new Promise((resolve) => {
          active += 1;
          maxObserved = Math.max(maxObserved, active);
          setTimeout(() => {
            active -= 1;
            resolve(null);
          }, 10);
        });

      await runWithConcurrency(ITEMS, LIMIT, worker);

      expect(maxObserved).toBeLessThanOrEqual(LIMIT);
    });

    it("runs all items even when limit equals 1 (fully serial)", async () => {
      const order = [];
      const ITEMS = ["a", "b", "c"];

      await runWithConcurrency(ITEMS, 1, async (item) => {
        order.push(item);
      });

      expect(order).toEqual(["a", "b", "c"]);
    });

    it("does not spawn more lanes than there are items", async () => {
      let active = 0;
      let maxObserved = 0;
      const LIMIT = 3;
      const ITEMS = [1]; // only 1 item

      const worker = () =>
        new Promise((resolve) => {
          active += 1;
          maxObserved = Math.max(maxObserved, active);
          setTimeout(() => {
            active -= 1;
            resolve(null);
          }, 5);
        });

      await runWithConcurrency(ITEMS, LIMIT, worker);
      expect(maxObserved).toBe(1);
    });
  });

  describe("output order is stable", () => {
    it("returns results in input order even when slower items finish last", async () => {
      // Item 0 is slowest, item 1 is fastest — output must still be [0, 1, 2]
      const delays = [40, 5, 20];
      const ITEMS = [0, 1, 2];

      const results = await runWithConcurrency(ITEMS, 3, async (item) => {
        await new Promise((r) => setTimeout(r, delays[item]));
        return `result-${item}`;
      });

      expect(results.map((r) => r.value)).toEqual([
        "result-0",
        "result-1",
        "result-2",
      ]);
    });

    it("status is fulfilled for every successful item", async () => {
      const results = await runWithConcurrency([10, 20, 30], 3, async (n) => n * 2);
      expect(results.every((r) => r.status === "fulfilled")).toBe(true);
      expect(results.map((r) => r.value)).toEqual([20, 40, 60]);
    });
  });

  describe("failed group does not fail all groups", () => {
    it("a rejected worker does not prevent other workers from running", async () => {
      const completed = [];
      const ITEMS = ["ok-1", "bad", "ok-2", "ok-3"];

      const results = await runWithConcurrency(ITEMS, 2, async (item) => {
        if (item === "bad") throw new Error("simulated group failure");
        completed.push(item);
        return item;
      });

      // The three good items all ran
      expect(completed.sort()).toEqual(["ok-1", "ok-2", "ok-3"]);

      // The failing item is rejected, others are fulfilled
      expect(results[0].status).toBe("fulfilled");
      expect(results[1].status).toBe("rejected");
      expect(results[2].status).toBe("fulfilled");
      expect(results[3].status).toBe("fulfilled");
    });

    it("reports the original error on the rejected slot", async () => {
      const ITEMS = ["a", "b"];

      const results = await runWithConcurrency(ITEMS, 2, async (item) => {
        if (item === "b") throw new Error("vertex quota exceeded");
        return "ok";
      });

      expect(results[1].status).toBe("rejected");
      expect(results[1].reason.message).toBe("vertex quota exceeded");
    });

    it("partial extraction: fulfilled results still contain field data", async () => {
      const groups = ["parties", "dates", "financial"];
      // "dates" group will fail
      const results = await runWithConcurrency(groups, 3, async (group) => {
        if (group === "dates") throw new Error("429 quota");
        return { group, fields: { [`${group}_field`]: "value" } };
      });

      const succeeded = results
        .filter((r) => r.status === "fulfilled")
        .map((r) => r.value.group);

      expect(succeeded).toEqual(["parties", "financial"]);
    });
  });

  describe("env override works", () => {
    it("defaults to MAX_ALLOWED_CONCURRENCY (3) when env var is absent", () => {
      expect(resolveConcurrencyLimit(undefined)).toBe(3);
    });

    it("respects LLM_GROUP_CONCURRENCY=1", () => {
      expect(resolveConcurrencyLimit("1")).toBe(1);
    });

    it("respects LLM_GROUP_CONCURRENCY=2", () => {
      expect(resolveConcurrencyLimit("2")).toBe(2);
    });

    it("respects LLM_GROUP_CONCURRENCY=3", () => {
      expect(resolveConcurrencyLimit("3")).toBe(3);
    });

    it("caps LLM_GROUP_CONCURRENCY=5 to MAX_ALLOWED_CONCURRENCY (3)", () => {
      expect(resolveConcurrencyLimit("5")).toBe(3);
    });

    it("treats non-numeric value as default (3)", () => {
      expect(resolveConcurrencyLimit("banana")).toBe(3);
    });

    it("treats zero as default (3)", () => {
      expect(resolveConcurrencyLimit("0")).toBe(3);
    });

    it("treats negative value as default (3)", () => {
      expect(resolveConcurrencyLimit("-1")).toBe(3);
    });

    it("env=1 is observed as a concurrency constraint during actual execution", async () => {
      const limit = resolveConcurrencyLimit("1");
      let maxObserved = 0;
      let active = 0;
      const ITEMS = [1, 2, 3, 4];

      await runWithConcurrency(ITEMS, limit, () =>
        new Promise((resolve) => {
          active++;
          maxObserved = Math.max(maxObserved, active);
          setTimeout(() => {
            active--;
            resolve(null);
          }, 5);
        }),
      );

      expect(maxObserved).toBe(1);
    });

    it("env=2 is observed as a concurrency constraint during actual execution", async () => {
      const limit = resolveConcurrencyLimit("2");
      let maxObserved = 0;
      let active = 0;
      const ITEMS = [1, 2, 3, 4, 5];

      await runWithConcurrency(ITEMS, limit, () =>
        new Promise((resolve) => {
          active++;
          maxObserved = Math.max(maxObserved, active);
          setTimeout(() => {
            active--;
            resolve(null);
          }, 10);
        }),
      );

      expect(maxObserved).toBeLessThanOrEqual(2);
    });
  });

  describe("vertex 429 detection pattern", () => {
    it("identifies a 429 error string by content", () => {
      const errMsg = "Vertex AI API error 429: Quota exceeded for quota metric";
      const isQuota =
        errMsg.includes("429") ||
        /quota|rate.?limit|resource.?exhausted/i.test(errMsg);
      expect(isQuota).toBe(true);
    });

    it("identifies a rate-limit error string without 429 code", () => {
      const errMsg = "RESOURCE_EXHAUSTED: The model is overloaded.";
      const isQuota =
        errMsg.includes("429") ||
        /quota|rate.?limit|resource.?exhausted/i.test(errMsg);
      expect(isQuota).toBe(true);
    });

    it("does not false-positive on a normal extraction error", () => {
      const errMsg = "JSON parse failed after 2048 tokens";
      const isQuota =
        errMsg.includes("429") ||
        /quota|rate.?limit|resource.?exhausted/i.test(errMsg);
      expect(isQuota).toBe(false);
    });
  });
});

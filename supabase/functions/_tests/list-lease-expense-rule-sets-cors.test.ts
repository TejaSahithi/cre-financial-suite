// @ts-nocheck
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const root = new URL("../..", import.meta.url);
const functionSource = await Deno.readTextFile(
  new URL("functions/list-lease-expense-rule-sets/index.ts", root),
);
const configSource = await Deno.readTextFile(new URL("config.toml", root));

const browserRuleFunctions = [
  "list-lease-expense-rule-sets",
  "save-lease-expense-rule-set",
  "approve-lease-expense-rule",
  "reject-lease-expense-rule",
  "mark-lease-expense-rule-not-applicable",
  "publish-lease-expense-rule-to-cam",
  "sync-approved-lease-expense-rules",
  "update-lease-expense-rule",
  "update-lease-expense-rule-amount",
  "update-lease-expense-rule-set-status",
];

Deno.test("lease expense rule browser functions allow preflight through the gateway", () => {
  for (const functionName of browserRuleFunctions) {
    const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const block = configSource.match(
      new RegExp(`\\[functions\\.${escapedName}\\]([\\s\\S]*?)(?=\\n\\[functions\\.|$)`),
    )?.[1] ?? "";
    assert(block, `${functionName} config block must exist`);
    assertEquals(
      /verify_jwt\s*=\s*false/.test(block),
      true,
      `${functionName} must let its OPTIONS handler run`,
    );
  }
});

Deno.test("list-lease-expense-rule-sets answers OPTIONS before user authorization", () => {
  const optionsIndex = functionSource.indexOf('req.method === "OPTIONS"');
  const authIndex = functionSource.indexOf("await verifyUser(req)");
  assert(optionsIndex >= 0, "OPTIONS handler must exist");
  assert(authIndex >= 0, "user authorization must exist");
  assert(optionsIndex < authIndex, "OPTIONS must return before user authorization");
  assertEquals(functionSource.includes('headers: corsHeaders'), true);
  assertEquals(functionSource.includes("await assertPageAccess("), true);
});

Deno.test("sync-approved-lease-expense-rules answers OPTIONS before user authorization", async () => {
  const syncSource = await Deno.readTextFile(
    new URL("functions/sync-approved-lease-expense-rules/index.ts", root),
  );
  const optionsIndex = syncSource.indexOf('req.method === "OPTIONS"');
  const authIndex = syncSource.indexOf("await verifyUser(req)");
  assert(optionsIndex >= 0, "OPTIONS handler must exist");
  assert(authIndex >= 0, "user authorization must exist");
  assert(optionsIndex < authIndex, "OPTIONS must return before user authorization");
  assertEquals(syncSource.includes('headers: corsHeaders'), true);
  assertEquals(syncSource.includes("await assertPageAccess("), true);
});

Deno.test("rule list and save require an approved abstract state", async () => {
  const saveSource = await Deno.readTextFile(
    new URL("functions/save-lease-expense-rule-set/index.ts", root),
  );
  for (const source of [functionSource, saveSource]) {
    for (const state of ["approved", "budget_ready"]) {
      assert(source.includes(`"${state}"`), `approved state ${state} must be recognized`);
    }
    assert(source.includes("abstract_approved_at"));
    assertEquals(source.includes('"active", "executed", "signed"'), false);
  }
});

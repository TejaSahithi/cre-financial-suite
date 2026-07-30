// @ts-nocheck
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const root = new URL("../..", import.meta.url);
const functionSource = await Deno.readTextFile(
  new URL("functions/list-lease-expense-rule-sets/index.ts", root),
);
const configSource = await Deno.readTextFile(new URL("config.toml", root));

Deno.test("list-lease-expense-rule-sets allows the browser preflight through the gateway", () => {
  const block = configSource.match(
    /\[functions\.list-lease-expense-rule-sets\]([\s\S]*?)(?=\n\[functions\.|$)/,
  )?.[1] ?? "";
  assert(block, "function config block must exist");
  assertEquals(/verify_jwt\s*=\s*false/.test(block), true);
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

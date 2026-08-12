// @ts-nocheck
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const root = new URL("../..", import.meta.url);
const configSource = await Deno.readTextFile(new URL("config.toml", root));
const functionSource = await Deno.readTextFile(new URL("functions/assistant-chat-v1/index.ts", root));

function configBlock(functionName: string): string {
  const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return configSource.match(new RegExp(`\\[functions\\.${escapedName}\\]([\\s\\S]*?)(?=\\n\\[functions\\.|$)`))?.[1] ?? "";
}

Deno.test("assistant-chat-v1 allows browser preflight through the Supabase gateway", () => {
  const block = configBlock("assistant-chat-v1");
  assert(block, "assistant-chat-v1 config block must exist");
  assertEquals(/verify_jwt\s*=\s*false/.test(block), true, "OPTIONS must reach the function CORS handler");
});

Deno.test("assistant-chat-v1 answers OPTIONS before resolving user context", () => {
  const optionsIndex = functionSource.indexOf('req.method === "OPTIONS"');
  const authIndex = functionSource.indexOf("await resolveAssistantContext(req)");
  assert(optionsIndex >= 0, "OPTIONS handler must exist");
  assert(authIndex >= 0, "POST user context resolution must exist");
  assert(optionsIndex < authIndex, "OPTIONS must return before user authorization");
  assertEquals(functionSource.includes('headers: corsHeaders'), true);
});
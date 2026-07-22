import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { RELEASE10_RLS_TABLES, RELEASE10_APPEND_ONLY_TABLES, RELEASE10_FEATURE_FLAGS } from "../_shared/enterprise-control/control-plane-diagnostics.ts";

Deno.test("Release 10 security contract inventories RLS append-only and feature flags", () => {
  assertEquals(RELEASE10_RLS_TABLES.includes("enterprise_audit_events"), true);
  assertEquals(RELEASE10_APPEND_ONLY_TABLES.includes("enterprise_audit_events"), true);
  assertEquals(RELEASE10_FEATURE_FLAGS.includes("ENABLE_BROAD_GA"), true);
});
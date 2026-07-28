// @ts-nocheck
// Phase 6A feature flag tests (canonical-expense-obligations-mode.ts).

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  getLeaseCanonicalExpenseObligationsMode,
  isLeaseCanonicalExpenseObligationsActive,
  shouldBuildCanonicalExpenseObligations,
} from "../_shared/extraction/openai-fact-ledger/canonical-expense-obligations-mode.ts";

Deno.test("canonical-expense-obligations-mode: defaults to off, invalid values resolve to off, never throws", () => {
  const originalValue = Deno.env.get("LEASE_CANONICAL_EXPENSE_OBLIGATIONS_V1");
  try {
    Deno.env.delete("LEASE_CANONICAL_EXPENSE_OBLIGATIONS_V1");
    assertEquals(getLeaseCanonicalExpenseObligationsMode(), "off");
    assertEquals(isLeaseCanonicalExpenseObligationsActive(), false);
    Deno.env.set("LEASE_CANONICAL_EXPENSE_OBLIGATIONS_V1", "bogus-value");
    assertEquals(getLeaseCanonicalExpenseObligationsMode(), "off");
    Deno.env.set("LEASE_CANONICAL_EXPENSE_OBLIGATIONS_V1", "active");
    assertEquals(getLeaseCanonicalExpenseObligationsMode(), "active");
    assertEquals(isLeaseCanonicalExpenseObligationsActive(), true);
  } finally {
    if (originalValue == null) Deno.env.delete("LEASE_CANONICAL_EXPENSE_OBLIGATIONS_V1");
    else Deno.env.set("LEASE_CANONICAL_EXPENSE_OBLIGATIONS_V1", originalValue);
  }
});

Deno.test("shouldBuildCanonicalExpenseObligations: false when active but org not admitted, true once allowlisted", () => {
  const originalFlag = Deno.env.get("LEASE_CANONICAL_EXPENSE_OBLIGATIONS_V1");
  const originalAllowlist = Deno.env.get("LEASE_CANONICAL_EXPENSE_OBLIGATIONS_ORG_ALLOWLIST");
  try {
    Deno.env.set("LEASE_CANONICAL_EXPENSE_OBLIGATIONS_V1", "active");
    Deno.env.delete("LEASE_CANONICAL_EXPENSE_OBLIGATIONS_ORG_ALLOWLIST");
    assertEquals(shouldBuildCanonicalExpenseObligations({ orgId: "some-org", generationId: "gen-1" }), false);
    Deno.env.set("LEASE_CANONICAL_EXPENSE_OBLIGATIONS_ORG_ALLOWLIST", "some-org");
    assertEquals(shouldBuildCanonicalExpenseObligations({ orgId: "some-org", generationId: "gen-1" }), true);
  } finally {
    if (originalFlag == null) Deno.env.delete("LEASE_CANONICAL_EXPENSE_OBLIGATIONS_V1"); else Deno.env.set("LEASE_CANONICAL_EXPENSE_OBLIGATIONS_V1", originalFlag);
    if (originalAllowlist == null) Deno.env.delete("LEASE_CANONICAL_EXPENSE_OBLIGATIONS_ORG_ALLOWLIST"); else Deno.env.set("LEASE_CANONICAL_EXPENSE_OBLIGATIONS_ORG_ALLOWLIST", originalAllowlist);
  }
});

Deno.test("shouldBuildCanonicalExpenseObligations: false when flag is off regardless of allowlist", () => {
  const originalFlag = Deno.env.get("LEASE_CANONICAL_EXPENSE_OBLIGATIONS_V1");
  const originalAllowlist = Deno.env.get("LEASE_CANONICAL_EXPENSE_OBLIGATIONS_ORG_ALLOWLIST");
  try {
    Deno.env.delete("LEASE_CANONICAL_EXPENSE_OBLIGATIONS_V1");
    Deno.env.set("LEASE_CANONICAL_EXPENSE_OBLIGATIONS_ORG_ALLOWLIST", "some-org");
    assertEquals(shouldBuildCanonicalExpenseObligations({ orgId: "some-org", generationId: "gen-1" }), false);
  } finally {
    if (originalFlag == null) Deno.env.delete("LEASE_CANONICAL_EXPENSE_OBLIGATIONS_V1"); else Deno.env.set("LEASE_CANONICAL_EXPENSE_OBLIGATIONS_V1", originalFlag);
    if (originalAllowlist == null) Deno.env.delete("LEASE_CANONICAL_EXPENSE_OBLIGATIONS_ORG_ALLOWLIST"); else Deno.env.set("LEASE_CANONICAL_EXPENSE_OBLIGATIONS_ORG_ALLOWLIST", originalAllowlist);
  }
});

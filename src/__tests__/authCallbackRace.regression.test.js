import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Regression guard for a confirmed magic-link login defect: App.jsx's
// "Supabase Hash Error Interceptor" effect used to strip ANY non-empty URL
// hash on mount (except on /AcceptInvite) via window.history.replaceState,
// unconditionally -- including a successful magic-link/OAuth redirect's
// #access_token=... fragment. That effect runs before AuthProvider's own
// mount effect (it sits deeper in the component tree, and React commits
// effects bottom-up), so the hash was gone before Supabase's client
// (detectSessionInUrl: true) ever got a chance to read it: confirmed live,
// zero /auth/v1/user requests ever fired on a real magic-link redirect.
//
// There is no React Testing Library / component mounting convention in this
// repo (see CreateBudget.write-path.test.js's own note: no test anywhere
// calls render()), so — matching that established pattern rather than
// introducing a new, heavier one for two files — this asserts the fix's
// structural invariants directly against the source. Real behavioral
// coverage of the shared predicate itself lives in
// src/services/__tests__/authCallbackHash.test.js.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_PATH = path.join(ROOT, "App.jsx");
const AUTH_CONTEXT_PATH = path.join(ROOT, "lib", "AuthContext.jsx");
const SUPABASE_CLIENT_PATH = path.join(ROOT, "services", "supabaseClient.js");

const appSource = readFileSync(APP_PATH, "utf8");
const authContextSource = readFileSync(AUTH_CONTEXT_PATH, "utf8");
const supabaseClientSource = readFileSync(SUPABASE_CLIENT_PATH, "utf8");

describe("App.jsx: auth callback data is not stripped prematurely", () => {
  it("no longer unconditionally strips the hash for the non-error (success) case", () => {
    // The old bug: an `else` branch that called replaceState for ANY
    // non-empty hash lacking error_code. That branch must be gone.
    expect(appSource).not.toMatch(/else\s+if\s*\(\s*pathNoSlash\s*!==\s*['"]AcceptInvite['"]\s*\)\s*\{\s*window\.history\.replaceState/);
  });

  it("only calls history.replaceState inside the error_code branch", () => {
    const hashEffectMatch = appSource.match(/Supabase Hash Error Interceptor[\s\S]*?\n\s*\}, \[navigateToLogin\]\);/);
    expect(hashEffectMatch, "expected to find the Supabase Hash Error Interceptor effect").toBeTruthy();
    const effectBody = hashEffectMatch[0];

    // Exactly one replaceState call in the whole effect, and it must appear
    // after the early-return guard for a missing error_code (i.e. it is
    // unreachable unless errorCode is truthy).
    const replaceStateCalls = effectBody.match(/window\.history\.replaceState/g) ?? [];
    expect(replaceStateCalls.length).toBe(1);

    const guardIndex = effectBody.search(/if\s*\(\s*!errorCode\s*\)\s*return;/);
    const replaceStateIndex = effectBody.indexOf("window.history.replaceState");
    expect(guardIndex, "expected an `if (!errorCode) return;` guard before the replaceState call").toBeGreaterThan(-1);
    expect(replaceStateIndex).toBeGreaterThan(guardIndex);
  });

  it("still exits early for AcceptInvite (that page consumes its own hash) and for an empty hash", () => {
    expect(appSource).toMatch(/pathNoSlash === ['"]AcceptInvite['"]\s*\)\s*return;/);
    expect(appSource).toMatch(/if\s*\(!hash\)\s*return;/);
  });

  it("still surfaces the existing error toast + navigateToLogin for a genuinely failed callback (error_code present) — unchanged", () => {
    expect(appSource).toMatch(/otp_expired/);
    expect(appSource).toMatch(/otp_disabled/);
    expect(appSource).toMatch(/import\(['"]sonner['"]\)\.then\(\(\{ toast \}\) => toast\.error/);
    expect(appSource).toMatch(/navigateToLogin\(\);/);
  });
});

describe("AuthContext.jsx: URL is cleaned only after Supabase establishes the session (or a bounded failure)", () => {
  it("imports and uses the shared auth-callback-hash predicate (no second/duplicate implementation)", () => {
    expect(authContextSource).toMatch(/isSupabaseAuthCallbackHash/);
    expect(authContextSource).toMatch(/from ['"]@\/services\/auth['"]/);
  });

  it("does not manually parse or persist access_token/refresh_token itself", () => {
    // The fix must rely on supabase-js's own detectSessionInUrl + session
    // storage, not hand-roll a second token-parsing/persistence path.
    expect(authContextSource).not.toMatch(/localStorage\.setItem\(.*access_token/);
    expect(authContextSource).not.toMatch(/setSession\(/);
  });

  it("cleans the callback hash inside the onAuthStateChange handler, gated on SIGNED_IN/INITIAL_SESSION with a real session", () => {
    const handlerMatch = authContextSource.match(/const unsubscribe = onAuthStateChange\(\(event, session\) => \{[\s\S]*?\n {4}\}\);/);
    expect(handlerMatch, "expected to find the onAuthStateChange handler").toBeTruthy();
    const handlerBody = handlerMatch[0];

    expect(handlerBody).toMatch(/event === ['"]SIGNED_IN['"]/);
    expect(handlerBody).toMatch(/event === ['"]INITIAL_SESSION['"]/);
    expect(handlerBody).toMatch(/&&\s*session\s*\)/);
    expect(handlerBody).toMatch(/cleanCallbackHash\(\)/);
    // The cleanup call must be inside the session-established branch, not
    // unconditional at the top of the handler.
    const gateIndex = handlerBody.search(/hadPendingAuthCallback[\s\S]*?&&\s*session\s*\)/);
    const cleanupIndex = handlerBody.indexOf("cleanCallbackHash()");
    expect(gateIndex).toBeGreaterThan(-1);
    expect(cleanupIndex).toBeGreaterThan(gateIndex);
  });

  it("arms a bounded timeout for a pending callback and surfaces the existing auth-error UI (toast) if it never resolves — does not silently strip to an empty login state", () => {
    expect(authContextSource).toMatch(/AUTH_CALLBACK_TIMEOUT_MS/);
    expect(authContextSource).toMatch(/window\.setTimeout\(/);
    expect(authContextSource).toMatch(/setAuthError\(\{\s*type:\s*['"]auth_required['"]/);
    expect(authContextSource).toMatch(/import\(['"]sonner['"]\)\.then\(\(\{ toast \}\) => toast\.error/);
  });

  it("clears the pending timeout on unmount (no leaked timer)", () => {
    expect(authContextSource).toMatch(/window\.clearTimeout\(callbackTimeoutId\)/);
  });

  it("does not arm the pending-callback timeout on the AcceptInvite route (that page owns its own hash)", () => {
    expect(authContextSource).toMatch(/pathNoSlash !== ['"]AcceptInvite['"]\s*&&\s*isSupabaseAuthCallbackHash/);
  });
});

describe("Regression: session persistence and normal login are unaffected by this fix", () => {
  it("supabase client still persists sessions across refresh (persistSession/autoRefreshToken/detectSessionInUrl unchanged)", () => {
    expect(supabaseClientSource).toMatch(/persistSession:\s*true/);
    expect(supabaseClientSource).toMatch(/autoRefreshToken:\s*true/);
    expect(supabaseClientSource).toMatch(/detectSessionInUrl:\s*true/);
  });

  it("AuthContext's normal (non-callback) SIGNED_IN/TOKEN_REFRESHED/SIGNED_OUT handling is untouched", () => {
    expect(authContextSource).toMatch(/resetProfileCache\(\{ preserveInFlight: true \}\)/);
    expect(authContextSource).toMatch(/fetchProfile\(false\)/);
    expect(authContextSource).toMatch(/event === ['"]SIGNED_OUT['"]/);
  });

  it("AuthenticatedApp's routing logic (ordinary authenticated page landing) is untouched by this fix", () => {
    expect(appSource).toMatch(/getUserRoutingState/);
    expect(appSource).toMatch(/isAuthenticated && user/);
  });
});

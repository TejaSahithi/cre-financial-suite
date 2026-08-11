import { describe, expect, it } from "vitest";
import { isSupabaseAuthCallbackHash } from "../auth";

// Regression coverage for the magic-link auth callback fix: App.jsx used to
// strip ANY non-empty URL hash on mount (except on /AcceptInvite), including
// a successful magic-link redirect's #access_token=... fragment, before
// Supabase's client (detectSessionInUrl: true) ever got a chance to read it
// -- silently breaking magic-link login with no error surfaced. The fix
// (App.jsx + AuthContext.jsx) hinges on both files agreeing on exactly which
// hashes are Supabase auth callbacks versus ordinary app hashes; this
// predicate is that single shared definition, tested directly here.
describe("isSupabaseAuthCallbackHash", () => {
  it("recognizes a successful magic-link/OAuth callback (access_token present)", () => {
    expect(isSupabaseAuthCallbackHash("#access_token=abc.def.ghi&refresh_token=xyz&expires_in=3600&token_type=bearer&type=magiclink")).toBe(true);
  });

  it("recognizes a failed callback (error_code present)", () => {
    expect(isSupabaseAuthCallbackHash("#error=access_denied&error_code=otp_expired&error_description=Link+expired")).toBe(true);
  });

  it("recognizes a bare error param even without error_code", () => {
    expect(isSupabaseAuthCallbackHash("#error=server_error")).toBe(true);
  });

  it("does not treat an empty hash as a callback", () => {
    expect(isSupabaseAuthCallbackHash("")).toBe(false);
    expect(isSupabaseAuthCallbackHash(null)).toBe(false);
    expect(isSupabaseAuthCallbackHash(undefined)).toBe(false);
  });

  it("does not treat an ordinary app anchor hash as a callback (normal non-auth hash routing is unaffected)", () => {
    expect(isSupabaseAuthCallbackHash("#section-2")).toBe(false);
    expect(isSupabaseAuthCallbackHash("#tab=billing")).toBe(false);
  });

  it("works whether or not the leading # is included", () => {
    expect(isSupabaseAuthCallbackHash("access_token=abc")).toBe(true);
  });
});

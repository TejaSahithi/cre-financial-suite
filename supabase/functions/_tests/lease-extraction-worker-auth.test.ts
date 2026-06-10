// @ts-nocheck
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildInternalFunctionHeaders,
  classifyDownstreamError,
  getMissingWorkerConfig,
  isAuthorizedWorkerCall,
  UNAUTHORIZED_WORKER_RESPONSE,
} from "../lease-extraction-worker/auth.ts";

const env = {
  get(key: string) {
    return {
      SUPABASE_SERVICE_ROLE_KEY: "service-role-token-without-sub",
      WORKER_INTERNAL_SECRET: "worker-secret",
    }[key];
  },
};

function req(headers: Record<string, string>) {
  return new Request("https://example.test/functions/v1/lease-extraction-worker", {
    method: "POST",
    headers,
  });
}

Deno.test("lease-extraction-worker auth accepts service-role bearer token without a user sub claim", () => {
  assertEquals(
    isAuthorizedWorkerCall(req({ Authorization: "Bearer service-role-token-without-sub" }), env),
    true,
  );
});

Deno.test("lease-extraction-worker auth accepts valid x-worker-secret", () => {
  assertEquals(isAuthorizedWorkerCall(req({ "x-worker-secret": "worker-secret" }), env), true);
});

Deno.test("lease-extraction-worker auth rejects anon or user token without worker secret", () => {
  assertEquals(isAuthorizedWorkerCall(req({ Authorization: "Bearer anon-or-user-token" }), env), false);
});

Deno.test("lease-extraction-worker auth rejects missing or incorrect worker secret", () => {
  assertEquals(isAuthorizedWorkerCall(req({}), env), false);
  assertEquals(isAuthorizedWorkerCall(req({ "x-worker-secret": "wrong-secret" }), env), false);
});

Deno.test("lease-extraction-worker unauthorized response is structured and stable", () => {
  assertEquals(UNAUTHORIZED_WORKER_RESPONSE, {
    ok: false,
    error_code: "UNAUTHORIZED_WORKER_CALL",
    message: "Unauthorized worker call",
  });
});

Deno.test("lease-extraction-worker builds downstream headers with service role as bearer and apikey", () => {
  const headers = buildInternalFunctionHeaders("org-123", env);
  assertEquals(headers.Authorization, "Bearer service-role-token-without-sub");
  assertEquals(headers.apikey, "service-role-token-without-sub");
  assertEquals(headers["x-worker-secret"], "worker-secret");
  assertEquals(headers["x-internal-service-key"], "service-role-token-without-sub");
  assertEquals(headers["x-internal-org-id"], "org-123");
});

Deno.test("lease-extraction-worker never uses worker secret as bearer token", () => {
  const headers = buildInternalFunctionHeaders("org-123", env);
  assertEquals(headers.Authorization === "Bearer worker-secret", false);
});

Deno.test("lease-extraction-worker detects missing required server config", () => {
  const missingServiceRoleEnv = {
    get(key: string) {
      return {
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "",
        WORKER_INTERNAL_SECRET: "worker-secret",
      }[key];
    },
  };

  assertEquals(getMissingWorkerConfig(missingServiceRoleEnv), ["SUPABASE_SERVICE_ROLE_KEY"]);
});

Deno.test("lease-extraction-worker maps downstream 401 and 403 to DOWNSTREAM_AUTH_FAILED", () => {
  assertEquals(classifyDownstreamError(401), {
    error_code: "DOWNSTREAM_AUTH_FAILED",
    retryable: false,
  });
  assertEquals(classifyDownstreamError(403), {
    error_code: "DOWNSTREAM_AUTH_FAILED",
    retryable: false,
  });
});

Deno.test("lease-extraction-worker marks downstream auth failures as terminal, not retryable queued work", () => {
  const classified = classifyDownstreamError(401);
  assertEquals(classified.error_code, "DOWNSTREAM_AUTH_FAILED");
  assertEquals(classified.retryable, false);
});

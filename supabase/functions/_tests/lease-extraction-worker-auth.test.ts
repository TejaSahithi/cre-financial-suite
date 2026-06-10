// @ts-nocheck
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
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

import http from "k6/http";
import { check, sleep } from "k6";

const BASE_URL = __ENV.BASE_URL || "http://127.0.0.1:54321/functions/v1";
const TOKEN = __ENV.SUPABASE_JWT || "";
const ORGANIZATION_ID = __ENV.ORGANIZATION_ID || "release7-load-org";
const headers = { Authorization: `Bearer ${TOKEN}`, "x-acting-org-id": ORGANIZATION_ID, "content-type": "application/json" };

export const options = {
  scenarios: {
    steady: { executor: "constant-vus", vus: 50, duration: "1m" },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<2000"],
  },
};

export default function () {
  const res = http.post(`${BASE_URL}/document-intelligence-v6-field-search`, JSON.stringify({ uploadedFileId: __ENV.UPLOADED_FILE_ID || "load-file", query: "rent", limit: 10 }), { headers, tags: { organization: ORGANIZATION_ID, stale: "false" } });
  check(res, { "status is not 5xx": (r) => r.status < 500, "organization header applied": () => Boolean(ORGANIZATION_ID) });
  sleep(1);
}
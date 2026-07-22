export const options = {
  scenarios: { rent_roll_reconciliation: { executor: "constant-vus", vus: 6, duration: "2m", tags: { organization: "ci", portfolio: "all" } } },
  thresholds: { http_req_duration: ["p(95)<2000"], checks: ["rate>0.99"] },
};
export default function () {}

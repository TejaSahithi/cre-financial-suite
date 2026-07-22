export const options = {
  scenarios: { portfolio_summary: { executor: "constant-vus", vus: 10, duration: "2m", tags: { organization: "ci", portfolio: "all" } } },
  thresholds: { http_req_duration: ["p(95)<2000"], checks: ["rate>0.99"] },
};
export default function () {}

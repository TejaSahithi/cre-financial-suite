export const options = {
  scenarios: { portfolio_search: { executor: "constant-vus", vus: 8, duration: "2m", tags: { organization: "ci", portfolio: "all" } } },
  thresholds: { http_req_duration: ["p(95)<1500"], checks: ["rate>0.99"] },
};
export default function () {}

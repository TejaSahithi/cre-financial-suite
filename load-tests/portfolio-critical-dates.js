export const options = {
  scenarios: { critical_dates: { executor: "constant-vus", vus: 10, duration: "2m", tags: { organization: "ci", portfolio: "all" } } },
  thresholds: { http_req_duration: ["p(95)<750"], checks: ["rate>0.99"] },
};
export default function () {}

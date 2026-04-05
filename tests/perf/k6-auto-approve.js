/**
 * k6 load test: Auto-approve latency
 *
 * Target: p95 < 200ms for auto-approved submissions
 * Run: k6 run --env API_KEY=<key> --env BASE_URL=http://localhost:3000 tests/perf/k6-auto-approve.js
 */
import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Rate } from "k6/metrics";

const autoApproveLatency = new Trend("auto_approve_latency", true);
const successRate = new Rate("success_rate");

export const options = {
  scenarios: {
    auto_approve: {
      executor: "constant-vus",
      vus: 100,
      duration: "30s",
    },
  },
  thresholds: {
    auto_approve_latency: ["p(95)<200"],
    success_rate: ["rate>0.99"],
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const API_KEY = __ENV.API_KEY;

export default function () {
  const payload = JSON.stringify({
    channel: "load-test",
    content_type: "text/plain",
    content: { text: `Auto-approve test ${Date.now()}-${__VU}-${__ITER}` },
  });

  const res = http.post(`${BASE_URL}/api/v1/submissions`, payload, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
  });

  const passed = check(res, {
    "status is 200 or 201": (r) => r.status === 200 || r.status === 201,
    "has submission id": (r) => {
      try {
        return !!JSON.parse(r.body).id;
      } catch {
        return false;
      }
    },
  });

  successRate.add(passed);
  autoApproveLatency.add(res.timings.duration);

  sleep(0.1);
}

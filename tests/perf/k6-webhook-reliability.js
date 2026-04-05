/**
 * k6 load test: Webhook delivery reliability
 *
 * Target: >= 99% delivery rate for 1000 submissions with callbacks
 * Run: k6 run --env API_KEY=<key> --env BASE_URL=http://localhost:3000 --env WEBHOOK_URL=http://mock:4000/webhook tests/perf/k6-webhook-reliability.js
 */
import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Counter } from "k6/metrics";

const deliveryRate = new Rate("delivery_rate");
const totalSubmissions = new Counter("total_submissions");

export const options = {
  scenarios: {
    webhook_reliability: {
      executor: "shared-iterations",
      vus: 50,
      iterations: 1000,
      maxDuration: "5m",
    },
  },
  thresholds: {
    delivery_rate: ["rate>=0.99"],
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const API_KEY = __ENV.API_KEY;
const WEBHOOK_URL = __ENV.WEBHOOK_URL || "http://localhost:4000/webhook";

export default function () {
  const payload = JSON.stringify({
    channel: "webhook-test",
    content_type: "text/plain",
    content: { text: `Webhook test ${Date.now()}-${__VU}-${__ITER}` },
    callback_url: WEBHOOK_URL,
  });

  const res = http.post(`${BASE_URL}/api/v1/submissions`, payload, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
  });

  totalSubmissions.add(1);

  const submitted = check(res, {
    "submission accepted": (r) => r.status === 200 || r.status === 201,
  });

  if (!submitted) {
    deliveryRate.add(false);
    return;
  }

  // Wait for async processing
  let body;
  try {
    body = JSON.parse(res.body);
  } catch {
    deliveryRate.add(false);
    return;
  }

  // Poll for webhook delivery status
  sleep(2);
  const pollRes = http.get(`${BASE_URL}/api/v1/submissions/${body.id}`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });

  let delivered = false;
  if (pollRes.status === 200) {
    try {
      const pollBody = JSON.parse(pollRes.body);
      // Check if the submission was decided (webhook fires on decision)
      delivered = pollBody.status !== "pending" && pollBody.callback_status === "delivered";
    } catch {
      // ignore
    }
  }

  deliveryRate.add(delivered);
}

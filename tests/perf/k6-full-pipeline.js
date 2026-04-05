/**
 * k6 load test: Full pipeline throughput
 *
 * Target: p95 < 15s for full pipeline (rules + guardrails + AI review)
 * Run: k6 run --env API_KEY=<key> --env BASE_URL=http://localhost:3000 tests/perf/k6-full-pipeline.js
 */
import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Rate } from "k6/metrics";

const pipelineLatency = new Trend("pipeline_latency", true);
const decisionRate = new Rate("decision_rate");

export const options = {
  scenarios: {
    full_pipeline: {
      executor: "constant-vus",
      vus: 50,
      duration: "60s",
    },
  },
  thresholds: {
    pipeline_latency: ["p(95)<15000"],
    decision_rate: ["rate>0.95"],
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const API_KEY = __ENV.API_KEY;

export default function () {
  // Submit content
  const payload = JSON.stringify({
    channel: "pipeline-test",
    content_type: "text/plain",
    content: { text: `Pipeline test ${Date.now()}-${__VU}-${__ITER}` },
  });

  const submitRes = http.post(`${BASE_URL}/api/v1/submissions`, payload, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
  });

  if (submitRes.status !== 200 && submitRes.status !== 201) {
    decisionRate.add(false);
    return;
  }

  let body;
  try {
    body = JSON.parse(submitRes.body);
  } catch {
    decisionRate.add(false);
    return;
  }

  const submissionId = body.id;
  const startTime = Date.now();

  // Poll for decision (max 15s)
  let decided = false;
  for (let i = 0; i < 30; i++) {
    sleep(0.5);
    const pollRes = http.get(`${BASE_URL}/api/v1/submissions/${submissionId}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });

    if (pollRes.status === 200) {
      try {
        const pollBody = JSON.parse(pollRes.body);
        if (pollBody.status !== "pending") {
          decided = true;
          pipelineLatency.add(Date.now() - startTime);
          break;
        }
      } catch {
        // ignore parse errors
      }
    }
  }

  decisionRate.add(decided);
}

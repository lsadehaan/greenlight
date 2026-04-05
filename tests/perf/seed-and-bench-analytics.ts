#!/usr/bin/env npx tsx
/**
 * Analytics performance benchmark
 *
 * Seeds 100k submissions and benchmarks the analytics summary endpoint.
 * Target: < 500ms query time
 *
 * Usage:
 *   E2E_BASE_URL=http://localhost:3000 E2E_API_KEY=<key> \
 *   DATABASE_URL=postgresql://greenlight:greenlight@localhost:5432/greenlight \
 *   npx tsx tests/perf/seed-and-bench-analytics.ts
 */
import pg from "pg";

const BASE_URL = process.env.E2E_BASE_URL || "http://localhost:3000";
const API_KEY = process.env.E2E_API_KEY || "";
const DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://greenlight:greenlight@localhost:5432/greenlight";
const SEED_COUNT = 100_000;
const BATCH_SIZE = 5000;

async function seedSubmissions(pool: pg.Pool): Promise<void> {
  console.log(`Seeding ${SEED_COUNT} submissions...`);

  const channels = ["email", "slack", "api", "webhook"];
  const statuses = ["approved", "rejected", "pending"];
  const decidedByOptions = ["rules", "ai", "human", null];

  let seeded = 0;
  while (seeded < SEED_COUNT) {
    const batchCount = Math.min(BATCH_SIZE, SEED_COUNT - seeded);
    const values: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    for (let i = 0; i < batchCount; i++) {
      const channel = channels[Math.floor(Math.random() * channels.length)];
      const status = statuses[Math.floor(Math.random() * statuses.length)];
      const decidedBy = status === "pending" ? null : decidedByOptions[Math.floor(Math.random() * 3)];
      const createdAt = new Date(Date.now() - Math.random() * 180 * 24 * 3600 * 1000);
      const decidedAt = status !== "pending" ? new Date(createdAt.getTime() + Math.random() * 3600000) : null;

      // Use a dummy api_key_id (first key in table)
      values.push(
        `(gen_random_uuid(), $${paramIdx++}, $${paramIdx++}, 'text/plain', '{"text":"seed"}'::jsonb, $${paramIdx++}::submission_status, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`,
      );
      params.push(
        // api_key_id will be set below
        "00000000-0000-0000-0000-000000000000", // placeholder
        channel,
        status,
        decidedBy,
        decidedAt,
        createdAt,
      );
    }

    // Get first api key id
    const keyResult = await pool.query("SELECT id FROM api_key LIMIT 1");
    if (keyResult.rows.length === 0) {
      throw new Error("No API keys found. Create one first.");
    }
    const apiKeyId = keyResult.rows[0].id;

    // Replace placeholder with real api_key_id
    for (let i = 0; i < params.length; i += 6) {
      params[i] = apiKeyId;
    }

    await pool.query(
      `INSERT INTO submission (id, api_key_id, channel, content_type, content, status, decided_by, decided_at, created_at)
       VALUES ${values.join(", ")}`,
      params,
    );

    seeded += batchCount;
    process.stdout.write(`\r  Seeded ${seeded}/${SEED_COUNT}`);
  }
  console.log("\n  Done seeding.");
}

async function benchmarkAnalytics(): Promise<void> {
  console.log("Benchmarking analytics summary endpoint...");

  const runs = 10;
  const latencies: number[] = [];

  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    const res = await fetch(`${BASE_URL}/api/v1/analytics/summary`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    const elapsed = performance.now() - start;

    if (res.status !== 200) {
      console.error(`  Run ${i + 1}: HTTP ${res.status}`);
      continue;
    }

    latencies.push(elapsed);
    console.log(`  Run ${i + 1}: ${elapsed.toFixed(1)}ms`);
  }

  if (latencies.length === 0) {
    console.error("All runs failed!");
    process.exit(1);
  }

  latencies.sort((a, b) => a - b);
  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const p50 = latencies[Math.floor(latencies.length * 0.5)];
  const p95 = latencies[Math.floor(latencies.length * 0.95)];
  const max = latencies[latencies.length - 1];

  console.log("\nResults:");
  console.log(`  Avg: ${avg.toFixed(1)}ms`);
  console.log(`  p50: ${p50.toFixed(1)}ms`);
  console.log(`  p95: ${p95.toFixed(1)}ms`);
  console.log(`  Max: ${max.toFixed(1)}ms`);
  console.log(`  Target: p95 < 500ms — ${p95 < 500 ? "PASS" : "FAIL"}`);

  if (p95 >= 500) {
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  try {
    await seedSubmissions(pool);
  } finally {
    await pool.end();
  }

  await benchmarkAnalytics();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";

const SINGLETON_ID = "00000000-0000-0000-0000-000000000001";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL environment variable is required");
}

const pool = new pg.Pool({ connectionString: databaseUrl });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function seed(): Promise<void> {
  await prisma.reviewConfig.upsert({
    where: { id: SINGLETON_ID },
    update: {},
    create: {
      id: SINGLETON_ID,
      defaultReviewMode: "human_only",
      aiConfidenceThreshold: 0.8,
      aiReviewerTimeoutMs: 10000,
      guardrailPipelineEnabled: false,
    },
  });

  console.log("Seeded default review_config row.");
}

try {
  await seed();
} catch (err) {
  console.error("Seed failed:", err);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
  await pool.end();
}
